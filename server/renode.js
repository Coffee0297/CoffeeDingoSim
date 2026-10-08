// Renode lifecycle: locate/download the portable build, generate the per-scene .resc, spawn it
// headless with a telnet monitor, and drive it (start/pause/RunFor/reset/sleep/wake).
//
// Launch (probed on Renode 1.16.1.8972 portable, see --help):
//   renode.exe -P <monitorPort> --disable-gui --plain          (no script argument)
// then over the monitor: include @<abs path of the generated .resc>. A script passed on the command
// line hides its errors; included over telnet they come back on the monitor and go to the log.
// `--disable-gui` (alias `--disable-xwt`) hides the monitor window; `-P` exposes the monitor over
// telnet; `--plain` removes ANSI colour codes from the log. `--console` is NOT passed: it moves the
// monitor onto stdin/stdout, which competes with the telnet monitor when spawned with pipes. The
// flags are picked from the --help text at first start (`probeFlags`), so a build that renamed
// them still works.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ROOT, CACHE_DIR, sceneDir } from './state.js';
import { BOARD } from './firmware.js';

/** Object.assign that keeps getters live (copies property descriptors). */
const mixin = (target, src) => Object.defineProperties(target, Object.getOwnPropertyDescriptors(src));

export const RENODE_URL = 'https://builds.renode.io/renode-latest.windows-portable-dotnet.zip';
// Windows: the portable Renode is downloaded once into cache/ (gitignored); RENODE_DIR / RENODE_EXE override.
const WIN_TOOLS = CACHE_DIR;
/** An ephemeral TCP port that is free right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

export const DEFAULTS = { monitorPort: 1234, bridgePort: 7777, bankPort: 7800, hub: 'vehicle' };

// ---------------------------------------------------------------- install -----------------

/** Search `dir` (two levels deep) for the Renode executable. */
export function findRenodeExe(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const names = process.platform === 'win32' ? ['renode.exe', 'Renode.exe'] : ['renode', 'Renode'];
  const scan = (d, depth) => {
    for (const n of names) { const p = path.join(d, n); if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; }
    if (depth <= 0) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { const r = scan(path.join(d, e.name), depth - 1); if (r) return r; }
    }
    return null;
  };
  return scan(dir, 2);
}

function onPath(cmd) {
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const d of (process.env.PATH || '').split(sep)) {
    const p = path.join(d, cmd);
    if (d && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Locate Renode: RENODE_EXE, RENODE_DIR, then cache/renode; on Windows the portable zip is downloaded and
 * extracted into cache/renode when absent.
 * Linux: `RENODE_DIR` or `renode` on PATH.
 * @param {{onStatus?:(s:string)=>void, onLog?:(l:string)=>void}} [cb]
 * @returns {Promise<string>} path to the executable
 */
export async function ensureRenode({ onStatus = () => {}, onLog = () => {} } = {}) {
  if (process.env.RENODE_EXE && fs.existsSync(process.env.RENODE_EXE)) return process.env.RENODE_EXE;
  const envDir = process.env.RENODE_DIR && findRenodeExe(process.env.RENODE_DIR);
  if (envDir) return envDir;
  if (process.platform !== 'win32') {
    const p = onPath('renode');
    if (p) return p;
    throw new Error('Renode not found: install it (e.g. the renode Docker image) and put `renode` on PATH or set RENODE_DIR');
  }
  const installDir = path.join(WIN_TOOLS, 'renode');
  const found = findRenodeExe(installDir);
  if (found) return found;

  onStatus('downloading');
  const dlDir = path.join(WIN_TOOLS, 'renode-dl');
  fs.mkdirSync(dlDir, { recursive: true });
  const zip = path.join(dlDir, 'renode-latest.windows-portable-dotnet.zip');
  if (!fs.existsSync(zip)) {
    onLog(`downloading ${RENODE_URL}`);
    const res = await fetch(RENODE_URL);
    if (!res.ok) throw new Error(`Renode download failed: HTTP ${res.status}`);
    fs.writeFileSync(zip + '.part', Buffer.from(await res.arrayBuffer()));
    fs.renameSync(zip + '.part', zip);
  }
  fs.mkdirSync(installDir, { recursive: true });
  onLog(`extracting to ${installDir}`);
  await new Promise((resolve, reject) =>
    execFile('tar', ['-xf', zip, '-C', installDir], (err) => {
      if (!err) return resolve();
      // fallback: PowerShell Expand-Archive
      execFile('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${installDir}'`], (e2) => (e2 ? reject(e2) : resolve()));
    }));
  const exe = findRenodeExe(installDir);
  if (!exe) throw new Error(`Renode extracted but no executable found in ${installDir}`);
  return exe;
}

/** Run `--help` once and choose the headless flags the build understands. */
export async function probeFlags(exe) {
  const help = await new Promise((resolve) => {
    execFile(exe, ['--help'], { timeout: 60000 }, (_e, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`));
  });
  return flagsFromHelp(help);
}

/** Pure: pick flags from a --help text. */
export function flagsFromHelp(help) {
  const flags = [];
  if (/--disable-gui/.test(help)) flags.push('--disable-gui');
  else if (/--disable-xwt/.test(help)) flags.push('--disable-xwt');
  if (/--plain/.test(help)) flags.push('--plain');
  return flags;
}

// ---------------------------------------------------------------- .resc generation ------

/** Calibration words per kind (`sysbus WriteWord` = 16-bit). */
export const CAL_WORDS = {
  pdm: [[0x1fff7a2a, 1500], [0x1fff7a2c, 943], [0x1fff7a2e, 1194]],
  pdmmax: [[0x1fff7a2a, 1500], [0x1fff7a2c, 943], [0x1fff7a2e, 1194]],
  canboard: [[0x1ffff7ba, 1500], [0x1ffff7b8, 943], [0x1ffff7c2, 1194]],
};

const tpl = (s, vars) => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const fwd = (p) => String(p).split('\\').join('/');

/** Monitor macro name of a module's reset macro (`reset_PDM_01`). */
export const resetMacroName = (id) => `reset_${String(id).replace(/[^A-Za-z0-9]/g, '_')}`;
/** Private CAN hub of a module created isolated (`iso_PDM_01`). */
export const isoHubName = (id) => `iso_${String(id).replace(/[^A-Za-z0-9]/g, '_')}`;

function readTemplate(name) {
  const p = path.join(ROOT, 'renode', 'templates', name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

/** `sysbus WriteWord …` lines of a board kind's factory calibration words. */
export function calWordLines(kind) {
  return (CAL_WORDS[kind] || CAL_WORDS.pdm).map(([a, v]) => `sysbus WriteWord 0x${a.toString(16).toUpperCase()} ${v}`).join('\n');
}

/** Pure: the board .repl text with the load bank's NDJSON `port:` set to `bankPort`. */
export function replWithBankPort(text, bankPort) {
  return text.replace(/(loadBank:\s*Miscellaneous\.ProfetLoadBank[^\n]*\n(?:[ \t]+[^\n]*\n)*?[ \t]+port:\s*)\d+/, `$1${bankPort}`);
}

/**
 * Render the scene's .resc from renode/templates (car.resc.hbs + `<board>.resc.hbs`) and write it to
 * `<outDir>/<scene>.resc`, plus one `<board>.repl` copy per board with the bank port filled in.
 * Modules whose board has no template are skipped (listed in `skipped`); a scene without the car
 * template throws. Every path in the output is absolute.
 * @param {any} scene
 * @param {Record<string,string>} firmwarePaths kind → elf
 * @param {{outDir?:string, nvDir?:string, hub?:string, bridgePort?:number, bankPort?:number, monitorPort?:number,
 *          only?:string[], isolate?:Iterable<string>}} [opt]
 *   only: module ids to simulate (default all); isolate: module ids created OFF the CAN hub (the
 *   bring-up sequencer connects them one at a time, see server/bringup.js)
 * @returns {{path:string, text:string, modules:string[], skipped:{id:string, reason:string}[], isolated:string[]}}
 */
export function generateResc(scene, firmwarePaths, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const name = scene.name || 'scene';
  const carT = readTemplate('car.resc.hbs');
  if (!carT) throw new Error('renode/templates/car.resc.hbs is missing');
  const nvDir = path.resolve(o.nvDir || path.join(sceneDir(name), 'nv'));
  const outDir = path.resolve(o.outDir || path.join(CACHE_DIR, 'generated'));
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(nvDir, { recursive: true });
  const isolate = new Set(o.isolate || []);
  const only = o.only ? new Set(o.only) : null;
  const skipped = [], used = [], isolated = [];
  const repls = new Map();
  const machines = [];
  for (const m of scene.modules || []) {
    if (only && !only.has(m.id)) continue;
    const board = BOARD[m.kind];
    const mt = board && readTemplate(`${board}.resc.hbs`);
    const srcRepl = board && path.join(ROOT, 'renode', 'platforms', `${board}.repl`);
    if (!mt || !fs.existsSync(srcRepl)) { skipped.push({ id: m.id, reason: `no renode/templates/${board}.resc.hbs or platforms/${board}.repl` }); continue; }
    if (!firmwarePaths[m.kind]) { skipped.push({ id: m.id, reason: `no firmware for ${m.kind}` }); continue; }
    if (!repls.has(board)) {
      const out = path.join(outDir, `${name}.${board}.repl`);
      fs.writeFileSync(out, replWithBankPort(fs.readFileSync(srcRepl, 'utf8'), o.bankPort));
      repls.set(board, out);
    }
    const off = isolate.has(m.id);
    if (off) isolated.push(m.id);
    used.push(m.id);
    machines.push(tpl(mt, {
      name: m.id, kind: m.kind, board, baseId: m.baseId,
      repl: fwd(repls.get(board)),
      models: fwd(path.join(ROOT, 'renode', 'models')),
      modelsAnchor: fwd(srcRepl),
      elf: fwd(path.resolve(firmwarePaths[m.kind])),
      nv: fwd(path.join(nvDir, `${m.id}.bin`)),
      hub: o.hub, bankPort: o.bankPort, bridgePort: o.bridgePort,
      calWords: calWordLines(m.kind),
      macro: resetMacroName(m.id),
      canConnect: off
        ? [`# no bring-up marker yet: on a private hub until the server moves it to "${o.hub}" alone to set its`,
          '# base id (a bxCAN with no hub at all flags a dominant-bit error on every TX and the firmware stops answering)',
          `emulation CreateCANHub "${isoHubName(m.id)}"`,
          `connector Connect sysbus.can1 ${isoHubName(m.id)}`].join('\n')
        : `connector Connect sysbus.can1 ${o.hub}`,
    }));
  }
  if (!machines.length) throw new Error(`scene ${name}: no module can be simulated (${skipped.map((s) => `${s.id}: ${s.reason}`).join('; ') || 'no modules'})`);
  const text = tpl(carT, {
    scene: name, hub: o.hub, bridgePort: o.bridgePort, bankPort: o.bankPort, monitorPort: o.monitorPort,
    models: fwd(path.join(ROOT, 'renode', 'models')), modelsAnchor: fwd(path.join(ROOT, 'renode', 'platforms', 'canboard_v2.repl')),
    machines: machines.join('\n'),
  });
  const out = path.join(outDir, `${name}.resc`);
  fs.writeFileSync(out, text);
  return { path: out, text, modules: used, skipped, isolated };
}

/** Lines of monitor output that mean a script command failed. */
export function monitorErrors(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter((l) =>
    /^(There was an error|Error|Could not|Couldn't|No such|Unknown|Invalid|Parsing error|Syntax error)\b|\berror E\d+|exception|does not exist|not found/i.test(l)
    && !/^coffeesim_load: compiled/.test(l));
}

// ---------------------------------------------------------------- monitor client ---------

/** Strip ANSI escapes and telnet IAC negotiation from monitor output. */
export function cleanMonitor(s) {
  return s
    .replace(/\xff[\xfb-\xfe]./gs, '')
    .replace(/\xff[\xf0-\xfa]/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\r/g, '');
}

/** Telnet monitor client: serialised commands, each resolved with the text before the next `) ` prompt. */
/** The top-level monitor prompt (no machine selected). */
export const MONITOR_PROMPT = /\(monitor\) $/;

export function createMonitor({ host = '127.0.0.1', port = DEFAULTS.monitorPort, timeoutMs = 30000 } = {}) {
  const em = new EventEmitter();
  let sock = null;
  let buf = '';
  let queue = Promise.resolve();
  let pending = null;
  const isPrompt = (b) => b.endsWith(') ');
  const debug = process.env.SIM_MONITOR_DEBUG ? (...a) => console.error('[monitor-debug]', ...a) : () => {};

  function connect(retries = 60, delayMs = 500) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        // Renode's telnet listener has been seen bound to IPv6 loopback only on some starts (it logs
        // "Monitor available" while 127.0.0.1 refuses for minutes): alternate the two loopbacks.
        const h = host === '127.0.0.1' && n % 2 === 1 ? '::1' : host;
        const s = net.createConnection({ host: h, port });
        s.once('connect', () => {
          sock = s;
          s.on('data', (d) => {
            buf += cleanMonitor(d.toString('latin1'));
            if (pending?.done?.(buf)) {
              const text = buf.replace(/\n?\([^\n]*\) $/, '');
              buf = '';
              const p = pending; pending = null; p.resolve(text);
            } else if (!pending && isPrompt(buf)) { em.emit('output', buf); buf = ''; }
          });
          s.on('close', () => { sock = null; em.emit('close'); if (pending) { pending.reject(new Error('monitor closed')); pending = null; } });
          s.on('error', () => {});
          // Require a real prompt before any command goes out. After a Renode restart a socket can be
          // accepted but never served (seen as two ESTABLISHED monitor sockets and an `include` that
          // hangs for 10 min): poke with a newline, and if no prompt arrives drop it and reconnect.
          const first = { resolve: () => { clearTimeout(t1); clearTimeout(t2); resolve(); }, reject, done: isPrompt };
          pending = first;
          const t1 = setTimeout(() => { if (pending === first) { try { s.write(String.fromCharCode(10)); } catch { /* gone */ } } }, 3000);
          const t2 = setTimeout(() => {
            if (pending !== first) return;
            pending = null; sock = null; s.removeAllListeners('close'); s.destroy();
            if (n <= 0) reject(new Error('monitor connected but never showed a prompt'));
            else setTimeout(() => attempt(n - 1), delayMs);
          }, 8000);
        });
        s.once('error', (e) => {
          s.destroy();
          if (n <= 0) reject(e); else setTimeout(() => attempt(n - 1), delayMs);
        });
      };
      attempt(retries);
    });
  }

  /**
   * Send one monitor command; resolves with its output (prompt removed). A reply is complete at the
   * first prompt AFTER the monitor's echo of the command (so a late prompt of an earlier command
   * cannot complete it) that matches `until` (default: any prompt). Commands that run a script or
   * macro switching machines inside pass `until: MONITOR_PROMPT`.
   */
  function cmd(line, callTimeoutMs = timeoutMs, { until = null } = {}) {
    const run = () => new Promise((resolve, reject) => {
      if (!sock) return reject(new Error('monitor not connected'));
      const echo = line.trim();
      let t = null;
      const me = {
        done: (b) => {
          const at = b.indexOf(echo);
          if (at < 0) return false;
          const rest = b.slice(at + echo.length);
          return isPrompt(rest) && (!until || until.test(rest));
        },
        resolve: (txt) => { clearTimeout(t); debug('<<', JSON.stringify(txt.slice(-300))); const at = txt.indexOf(echo); resolve((at >= 0 ? txt.slice(at + echo.length) : txt).trim()); },
        reject: (e) => { clearTimeout(t); reject(e); },
      };
      t = setTimeout(() => { if (pending === me) { pending = null; reject(new Error(`monitor timeout: ${line}`)); } }, callTimeoutMs);
      pending = me;
      buf = '';
      debug('>>', line);
      sock.write(line + '\n');
    });
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  return mixin(em, { connect, cmd, close() { if (pending) { pending.reject?.(new Error('monitor closed')); pending = null; } sock?.destroy(); sock = null; }, get connected() { return !!sock; } });
}

// ---------------------------------------------------------------- controller -------------

/** `H:M:S` for `emulation RunFor`. */
export function runForArg(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = (s % 60).toFixed(6).replace(/\.?0+$/, '');
  return `${hh}:${mm}:${ss || '0'}`;
}

/** Parse `emulation GetTimeSourceInfo` → elapsed virtual seconds (null when absent). */
export function parseVtime(out) {
  const m = /Elapsed Virtual Time:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(out || '');
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

/**
 * Renode controller bound to state callbacks.
 *
 * Start sequence: spawn `renode -P <monitorPort> --disable-gui --plain` (no script on the command
 * line: Renode does not report errors of a startup script), connect the telnet monitor, then
 * `include @<abs generated .resc>` and scan its output for errors (`monitorErrors`), which are also
 * copied into the log stream. `start` follows unless `paused`.
 * @param {{onStatus?:(patch:object)=>void, onLog?:(line:string)=>void, inject?:(frame:object)=>void,
 *          monitorPort?:number, bridgePort?:number, bankPort?:number, spawnImpl?:Function,
 *          exe?:string, includeTimeoutMs?:number}} [opts]
 */
export function createRenode(opts = {}) {
  const onStatus = opts.onStatus || (() => {});
  const onLog = opts.onLog || (() => {});
  const fixedMonitorPort = opts.monitorPort || Number(process.env.SIM_MONITOR_PORT) || 0;
  // A fresh Renode often cannot take the previous instance's monitor port for minutes after a restart
  // (it logs "Monitor available" while every connect is refused), so unless a port is pinned each start
  // gets a free one.
  let monitorPort = fixedMonitorPort || DEFAULTS.monitorPort;
  const bridgePort = opts.bridgePort || Number(process.env.SIM_BUS_PORT) || DEFAULTS.bridgePort;
  const bankPort = opts.bankPort || Number(process.env.SIM_BANK_PORT) || DEFAULTS.bankPort;
  let proc = null;
  let monitor = null;
  let flags = null;
  let status = 'stopped';
  let vtime = 0;
  let scene = null;
  let generated = null;
  let freeRunning = false; // emulation started with `start` (not a RunFor step)

  const set = (s, extra = {}) => { status = s; onStatus({ status: s, vtime, ...extra }); };
  const logLines = (chunk) => { for (const l of cleanMonitor(chunk.toString('utf8')).split('\n')) if (l.trim()) onLog(l); };
  const need = () => { if (!monitor) throw new Error('Renode is not running'); return monitor; };

  async function readVtime() {
    try {
      const v = parseVtime(await monitor.cmd('emulation GetTimeSourceInfo'));
      if (v !== null) vtime = v;
    } catch { /* keep last */ }
    return vtime;
  }

  /** Run a monitor command, copy its output to the log, throw on error lines. */
  async function checked(line, timeoutMs, o) {
    const out = await need().cmd(line, timeoutMs, o);
    for (const l of out.split('\n')) if (l.trim()) onLog(`[monitor] ${l}`);
    const errs = monitorErrors(out);
    if (errs.length) throw new Error(`${line}: ${errs.join(' | ')}`);
    return out;
  }

  /**
   * Start Renode for a scene: ensure install, generate .resc, spawn with only the monitor, include
   * the script over telnet, `start` unless paused.
   * @param {any} sc @param {Record<string,string>} firmwarePaths
   * @param {{paused?:boolean, isolate?:Iterable<string>, only?:string[]}} [o]
   */
  async function start(sc, firmwarePaths, o = {}) {
    if (proc) await stop();
    scene = sc;
    freeRunning = false;
    vtime = 0;   // a new Renode process starts at 0: a stale value froze the UI clock and tripped the bring-up stall watchdog
    try {
      const exe = opts.exe || await ensureRenode({ onStatus: (s) => set(s), onLog });
      flags ||= await probeFlags(exe);
      monitorPort = fixedMonitorPort || await freePort();
      generated = generateResc(sc, firmwarePaths, { monitorPort, bridgePort, bankPort, isolate: o.isolate, only: o.only, nvDir: o.nvDir });
      for (const s of generated.skipped) onLog(`[sim] ${s.id} not simulated: ${s.reason}`);
      set('starting', { exe, resc: generated.path });
      const args = ['-P', String(monitorPort), ...flags];
      onLog(`[sim] ${exe} ${args.join(' ')}`);
      const me = (opts.spawnImpl || spawn)(exe, args, { cwd: path.dirname(exe), windowsHide: true });
      proc = me;
      me.stdout?.on('data', logLines);
      me.stderr?.on('data', logLines);
      me.on('exit', (code) => {
        onLog(`[sim] Renode exited (${code})`);
        if (proc !== me) return;
        proc = null; monitor?.close(); monitor = null;
        set(code === 0 || status === 'stopped' ? 'stopped' : 'error', code ? { error: `Renode exited with code ${code}` } : {});
      });
      me.on('error', (e) => { onLog(`[sim] spawn error: ${e.message}`); set('error', { error: e.message }); });
      monitor = createMonitor({ port: monitorPort });
      monitor.on('output', (t) => t.split('\n').forEach((l) => l.trim() && onLog(`[monitor] ${l}`)));
      await monitor.connect(240, 500);
      onLog(`[sim] include @${fwd(generated.path)}`);
      await checked(`include @${fwd(generated.path)}`, opts.includeTimeoutMs ?? 600000, { until: MONITOR_PROMPT });
      if (!o.paused) { await monitor.cmd('start'); freeRunning = true; }
      set(o.paused ? 'paused' : 'running', { error: undefined, pid: proc?.pid });
      return { resc: generated.path, modules: generated.modules, isolated: generated.isolated, skipped: generated.skipped, pid: proc?.pid };
    } catch (e) {
      set('error', { error: e.message });
      onLog(`[sim] start failed: ${e.message}`);
      throw e;
    }
  }

  async function stop() {
    if (monitor) { try { await Promise.race([monitor.cmd('quit'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* ignore */ } }
    monitor?.close(); monitor = null;
    if (proc) {
      const p = proc; proc = null;
      await new Promise((resolve) => {
        if (p.exitCode !== null && p.exitCode !== undefined) return resolve();
        if (typeof p.once !== 'function') { try { p.kill(); } catch { /* ignore */ } return resolve(); }
        // quit normally; kill after 5 s, and in both cases wait for the exit so the monitor / bridge /
        // bank ports are free before a new Renode is started
        let t2 = null;
        const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } t2 = setTimeout(resolve, 10000); }, 5000);
        p.once('exit', () => { clearTimeout(t); clearTimeout(t2); resolve(); });
      });
    }
    freeRunning = false;
    set('stopped');
  }

  /** Kill the Renode process without asking it to quit (it may be wedged). */
  async function kill() {
    monitor?.close(); monitor = null;
    freeRunning = false;
    if (proc) {
      const p = proc; proc = null;
      await new Promise((resolve) => {
        if (p.exitCode !== null && p.exitCode !== undefined) return resolve();
        if (typeof p.once !== 'function') { try { p.kill(); } catch { /* ignore */ } return resolve(); }
        const t = setTimeout(resolve, 10000);
        p.once('exit', () => { clearTimeout(t); resolve(); });
        try { p.kill('SIGKILL'); } catch { /* ignore */ }
      });
    }
    set('stopped');
  }

  return {
    get status() { return status; },
    get vtime() { return vtime; },
    get monitor() { return monitor; },
    get pid() { return proc?.pid ?? null; },
    get freeRunning() { return freeRunning; },
    get generated() { return generated; },
    start, stop, kill, readVtime,
    /** Read-only CPU snapshot of one module (diagnosing a module that went silent): PC, halted, instructions run. */
    async inspect(module, read = []) {
      const ask = async (c) => cleanMonitor(await need().cmd(c)).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('(')).pop() ?? '';
      if (!generated?.modules?.includes(module)) throw new Error(`inspect: no simulated module ${module}`);
      await checked(`mach set "${module}"`);
      try {
        return { module, pc: await ask('cpu PC'), halted: await ask('cpu IsHalted'), basepri: await ask('cpu BasePri'), primask: await ask('cpu PRIMASK'), xpsr: await ask('cpu XProgramStatusRegister'), instructions: await ask('cpu ExecutedInstructions'),
          // read-only: addresses are numbers, formatted here, never raw monitor text
          read: Object.fromEntries(await Promise.all([].concat(read).filter(Number.isFinite).map(async (a) => ['0x' + a.toString(16), await ask(`sysbus ReadDoubleWord 0x${a.toString(16)}`)]))) };
      } finally { await need().cmd('mach clear'); }
    },
    /** Wake a wedged core (README sharp edge 18): re-pend `irq` through NVIC STIR, the only NVIC write here. */
    async nudge(module, irq) {
      if (!generated?.modules?.includes(module)) throw new Error(`nudge: no simulated module ${module}`);
      if (!Number.isInteger(irq) || irq < 0 || irq > 239) throw new Error(`nudge: bad IRQ ${irq}`);
      await checked(`mach set "${module}"`);
      try { await checked(`sysbus WriteDoubleWord 0xE000EF00 ${irq}`); } finally { await need().cmd('mach clear'); }
    },
    /** Per-receiver delivery counters of the paced vehicle hub (renode/models/PacedCANHub.cs). */
    async hubStats(watch) { if (Number.isInteger(watch)) await need().cmd(`${DEFAULTS.hub} WatchId ${watch}`); return cleanMonitor(await need().cmd(`${DEFAULTS.hub} Stats`)); },
    async pause() { await need().cmd('pause'); freeRunning = false; await readVtime(); set('paused'); },
    async resume() { await need().cmd('start'); freeRunning = true; set('running'); },
    /** Advance virtual time by `seconds` (pauses a running emulation first; returns when done). */
    async runFor(seconds) {
      const m = need();
      if (freeRunning) { await m.cmd('pause'); freeRunning = false; }
      set('running');
      await m.cmd(`emulation RunFor "${runForArg(seconds)}"`, 600000);
      await readVtime();
      set('paused');
      return vtime;
    },
    /**
     * Reset one module: runs the generated `reset_<id>` macro (mach set, machine Reset, LoadELF,
     * chibiosFix Install, cal words). `machine Reset` alone would leave the CPU without firmware.
     */
    async reset(module) {
      if (!scene?.modules?.some((x) => x.id === module)) throw new Error(`unknown module ${module}`);
      if (generated && !generated.modules.includes(module)) throw new Error(`${module} is not simulated`);
      const running = freeRunning;
      if (running) await need().cmd('pause');
      try { await checked(`runMacro $${resetMacroName(module)}`, 120000, { until: MONITOR_PROMPT }); } finally { if (running) await need().cmd('start'); }
      onLog(`[sim] ${module} reset`);
    },
    /** Attach a module's CAN controller to the hub (bring-up of a module created isolated). */
    async connectCan(module, hub = DEFAULTS.hub) {
      if (!generated?.isolated?.includes(module)) return;   // generated on the hub already
      await checked(`mach set "${module}"`);
      try {
        if (generated?.isolated?.includes(module)) await checked(`connector Disconnect sysbus.can1 ${isoHubName(module)}`);
        await checked(`connector Connect sysbus.can1 ${hub}`);
      } finally { await need().cmd('mach clear'); }
    },
    /** Sleep via the firmware param protocol (`[32,'Q','U','I','T',0,0,0]` on base+1). */
    sleep(module) {
      const mod = scene?.modules?.find((x) => x.id === module);
      if (!mod) throw new Error(`unknown module ${module}`);
      opts.inject?.({ id: mod.baseId + 1, dlc: 8, data: [32, 0x51, 0x55, 0x49, 0x54, 0, 0, 0] });
    },
    /** Wake: any hub frame triggers the bank's PB8 wake pulse; send a harmless Version request. */
    wake(module) {
      const mod = scene?.modules?.find((x) => x.id === module);
      if (!mod) throw new Error(`unknown module ${module}`);
      opts.inject?.({ id: mod.baseId + 1, dlc: 8, data: [31, 0, 0, 0, 0, 0, 0, 0] });
    },
    /** Raw monitor command (MCP / debugging). */
    cmd(line, timeoutMs, o) { return need().cmd(line, timeoutMs, o); },
  };
}
