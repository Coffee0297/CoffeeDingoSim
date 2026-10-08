// The simulator core: owns the bank/bus/bridge links, the stimulus engine, Renode and the recorder,
// and exposes one function per UI/MCP/CI operation. index.js (ws + REST), mcp.js and ci.js are thin
// wrappers over this object.
import fs from 'node:fs';
import path from 'node:path';
import * as S from './state.js';
import { createBank } from './bank.js';
import { createBus } from './bus.js';
import { createBridge } from './bridge.js';
import { createStimulus } from './stimulus.js';
import { createRenode } from './renode.js';
import { resolveFirmware, listReleases } from './firmware.js';
import { createRecorder, replay as replayRun, readRun, markGolden, diffRuns } from './record.js';
import { importProject } from './project.js';
import { getComponents } from './compat.js';
import { bringUp, modulesToIsolate, waitBoot } from './bringup.js';

const BUS_MSGS_PER_S = 20;

/**
 * @param {{scene?:string, bankPort?:number, busPort?:number, bridge?:string, links?:boolean,
 *          sleepAfterMs?:number, tickMs?:number, renode?:any}} [opts]
 */
export async function createSim(opts = {}) {
  const { state, broadcast, toast } = S;
  const comps = await getComponents();
  const sceneName = opts.scene || process.env.SIM_SCENE || 'example';
  S.loadScene(sceneName);

  const bankPort = opts.bankPort || Number(process.env.SIM_BANK_PORT) || 7800;
  const busPort = opts.busPort || Number(process.env.SIM_BUS_PORT) || 7777;
  const bank = createBank({ port: bankPort });
  const bus = await createBus({ port: busPort, getTime: () => state.renode.vtime, sleepAfterMs: opts.sleepAfterMs });
  const bridgeMode = opts.bridge || process.env.SIM_BRIDGE || state.scene?.globals?.bridge || 'tcp:7778';
  const firstPdmBase = () => {
    const mods = state.scene?.modules || [];
    return (mods.find((m) => m.kind === 'pdm' || m.kind === 'pdmmax') || mods[0])?.baseId ?? null;
  };
  // Several dingoConfig transports can run at once, comma-separated: e.g. `tcp:7778,serial:COM5` serves the
  // fork over TCP and the original dingoConfig over a virtual COM pair on the same simulated bus.
  const bridgeModes = String(bridgeMode).split(',').map((m) => m.trim()).filter(Boolean);
  const bridges = bridgeModes.map((mode) => createBridge({ mode, getBaseId: firstPdmBase, toHub: (line) => bus.writeLine(line) }));
  const bridge = bridges[0];

  let saveTimer = null;
  const persistSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { S.saveScene(); } catch (e) { toast('error', `scene save failed: ${e.message}`); } }, 500); saveTimer.unref?.(); };

  const stim = await createStimulus({
    bank, bus,
    getScene: () => state.scene,
    getTraces: () => state.traces,
    getTelemetry: (id) => state.modules[id],
    broadcast,
    onSceneMutated: persistSoon,
    tickMs: opts.tickMs,
  });

  let firmwarePaths = null;
  const renode = opts.renode || createRenode({
    bankPort, bridgePort: busPort, monitorPort: opts.monitorPort,
    onStatus: (p) => S.setRenode(p),
    onLog: (l) => S.renodeLog(l),
    inject: (f) => bus.inject(f, 'sim'),
  });
  const recorder = createRecorder({ getVtime: () => state.renode.vtime, getSceneName: () => state.sceneName, getFirmware: () => state.scene?.firmware ?? null });

  // ------------------------------------------------------------ link wiring --------------
  // Renode drops both links on every stop/restart (and per module during first-start bring-up), so a drop
  // is only worth a warning when the link stays down while Renode is meant to be running.
  const linkWatch = (label) => {
    let timer = null, warned = false;
    return {
      down() {
        clearTimeout(timer);
        timer = setTimeout(() => { if (['running', 'paused'].includes(state.renode.status)) { warned = true; toast('warn', `${label} lost (no reconnect for 5 s)`); } }, 5000);
      },
      up() { clearTimeout(timer); if (warned) { warned = false; toast('info', `${label} reconnected`); } },
    };
  };
  const bankLink = linkWatch('load bank link'), busLink = linkWatch('CAN bus bridge');
  bank.on('connect', () => { state.bank.connected = true; bankLink.up(); stim.pushBankScenes(); stim.pushLevels(); });
  bank.on('disconnect', () => { state.bank.connected = false; bankLink.down(); });
  bank.on('hello', (m) => {
    const list = state.bank.machines.filter((x) => x.machine !== m.machine);
    state.bank.machines = [...list, { machine: m.machine, board: m.board, outputs: m.outputs }];
    // Renode creates the machines one by one after our link is up: hand each new bank its loads
    bank.resendScene(m.machine);
  });
  bank.on('machines', (m) => { state.bank.machines = m.items || []; });
  const bankErrors = new Set();
  bank.on('bankError', (m) => { if (!bankErrors.has(m.msg)) { bankErrors.add(m.msg); S.renodeLog(`[bank] ${m.msg}`); } });
  bank.on('trace', (t) => {
    S.pushTrace(t);
    if (typeof t.t === 'number') state.renode.vtime = Math.max(state.renode.vtime, t.t);
  });
  bank.on('event', (ev) => {
    recorder.event(ev);
    if (ev.what === 'sleep') S.setTelemetry(ev.machine, { asleep: true });
    toast('info', `${ev.machine}: ${ev.what}`);
  });

  bus.on('connect', () => { state.bus.connected = true; busLink.up(); });
  bus.on('disconnect', () => { state.bus.connected = false; busLink.down(); });
  bus.on('line', (l) => { for (const b of bridges) b.fromHub(l); });
  bus.on('telemetry', (t) => {
    const was = state.modules[t.module]?.silent;
    S.setTelemetry(t.module, t);
    recorder.telemetry(t);
    if (t.silent && !was && !t.asleep) diagnoseSilent(t.module);
  });
  // A module that stops sending CAN without going to sleep: read its CPU once and say why. Exception
  // 3 = HardFault (the firmware has no handler or watchdog: it sits there with its outputs latched).
  const EXC = { 2: 'NMI', 3: 'HardFault', 4: 'MemManage', 5: 'BusFault', 6: 'UsageFault', 11: 'SVCall', 14: 'PendSV', 15: 'SysTick' };
  // A CPU stuck in a fault handler is reset, as a watchdog would on a real module (the firmware has none):
  // seen as a rare UsageFault INVSTATE on ChibiOS's ISR-exit path, and a wedged core (renode/README.md 17, 18).
  const FAULTS = new Set([2, 3, 4, 5, 6]);
  async function diagnoseSilent(module) {
    if (renode.status !== 'running') return;   // Renode stopping/stopped: every module goes quiet, nothing to diagnose
    let why = 'no CAN frames for 2 s of vehicle time';
    let fault = false;
    try {
      const c = await renode.inspect(module, [0xE000ED28, 0xE000ED10]);   // CFSR, SCR
      const ipsr = Number(c.xpsr) & 0x1ff;
      fault = FAULTS.has(ipsr);
      why += ipsr ? `; CPU stuck in ${EXC[ipsr] ?? (ipsr >= 16 ? `IRQ ${ipsr - 16}` : `exception ${ipsr}`)} at PC ${c.pc}${fault ? `, CFSR ${c.read?.['0xe000ed28']}` : ''}`
                  : `; CPU in thread mode at PC ${c.pc} (BASEPRI ${c.basepri}, PRIMASK ${c.primask})`;
      // Wedged core: ChibiOS's idle loop never WFIs, so outside deep sleep (SCR.SLEEPDEEP) the instruction
      // counter must advance with virtual time. Seen frozen at an ISR's first instruction (renode/README.md).
      if (!fault && c.halted !== 'True' && !(Number(c.read?.['0xe000ed10']) & 4)) {
        const t0 = await renode.readVtime();
        await new Promise((r) => setTimeout(r, 500));
        const c2 = await renode.inspect(module);
        if (c2.instructions === c.instructions && (await renode.readVtime()) > t0) {
          why += ', CPU not executing (wedged)';
          fault = true;
          if (ipsr >= 16) {   // try waking it first: keeps the module's state, and tells us if the kick works
            await renode.nudge(module, ipsr - 16);
            await new Promise((r) => setTimeout(r, 500));
            if ((await renode.inspect(module)).instructions !== c.instructions) { fault = false; why += `; woken by re-pending IRQ ${ipsr - 16}`; }
          }
        }
      }
    } catch (e) { why += ` (CPU not readable: ${e.message})`; }
    S.renodeLog(`[sim] ${module} stopped sending: ${why}`);
    if (state.modules[module]?.silent) S.setTelemetry(module, { silentWhy: why });
    if (!fault) { toast('warn', `${module} stopped sending CAN — ${why}`); return; }
    toast('warn', `${module} crashed (${why}) — reset, as a watchdog would`);
    try { await api.resetModule(module); S.renodeLog(`[sim] ${module} reset after the fault`); }
    catch (e) { S.renodeLog(`[sim] ${module} reset after the fault failed: ${e.message}`); }
  }

  let busWindow = 0, busCount = 0, busDropped = 0;
  bus.on('frame', (f) => {
    state.bus.frames++;
    if (f.dir === 'rx') stim.onFrame(f);
    const now = Date.now();
    if (now - busWindow >= 1000) { busWindow = now; busCount = 0; }
    if (busCount >= BUS_MSGS_PER_S) { busDropped++; return; }
    busCount++;
    broadcast({ type: 'bus', frame: { id: f.id, ext: f.ext, dlc: f.dlc, data: f.data, dir: f.dir, module: f.module ?? undefined, source: f.source }, dropped: busDropped });
    busDropped = 0;
  });

  const clientCount = new Map();
  bridges.forEach((b, i) => {
    b.on('clients', (n) => {
      clientCount.set(i, n);
      const total = [...clientCount.values()].reduce((a, c) => a + c, 0);
      state.bridge.clients = total; state.bridge.connected = total > 0;
      toast('info', `dingoConfig link ${bridgeModes[i]}: ${n} client(s)`);
    });
    b.on('filter', (id) => { state.bridge.filterId = id; });
    b.on('error', (e) => { if (e.code !== 'EADDRINUSE') toast('warn', `bridge ${bridgeModes[i]}: ${e.message}`); });
  });

  function applySceneSideEffects() {
    bus.setModules(state.scene?.modules || []);
    stim.pushBankScenes();
  }

  // ------------------------------------------------------------ operations ---------------
  let bridgeRetry = [];
  const api = {
    state, bank, bus, bridge, renode, recorder, stim, comps,

    snapshot: () => S.snapshot(comps.listComponents()),

    /** Start TCP links (bank, bus) and the bridge transport. Never throws. */
    async startLinks() {
      bank.start();
      bus.start();
      stim.start();
      // A busy port usually means another CoffeeDingoSim (or a CI run) is still up: keep retrying instead of
      // giving up, so the dingoConfig link appears as soon as the port frees, and say so loudly.
      const up = new Set();
      const tryBridge = async (b, mode) => {
        try {
          const d = await b.start();
          if (d.mode !== 'none') { up.add(d.mode); toast('info', `dingoConfig bridge ready on ${d.mode}`); }
        } catch (e) {
          toast('warn', `bridge ${mode} unavailable: ${e.message}` +
            (e.code === 'EADDRINUSE' ? ' — another CoffeeDingoSim is probably running; retrying every 5 s' : ''));
          if (e.code === 'EADDRINUSE') bridgeRetry.push(setTimeout(() => tryBridge(b, mode), 5000));
        }
        state.bridge.mode = up.size ? [...up].join(',') : 'none';
      };
      for (let i = 0; i < bridges.length; i++) await tryBridge(bridges[i], bridgeModes[i]);
    },
    async stopLinks() { for (const t of bridgeRetry) clearTimeout(t); bridgeRetry = []; stim.stop(); bank.stop(); bus.stop(); for (const b of bridges) await b.stop(); },

    /** Full scene replace (UI `scene` message, POST /api/scene). */
    setScene(scene) {
      if (!scene || typeof scene !== 'object') throw new Error('scene must be an object');
      scene.name ||= state.sceneName;
      S.setScene(scene);
      applySceneSideEffects();
      return scene;
    },
    loadScene(name) {
      const sc = S.loadScene(name);
      applySceneSideEffects();
      broadcast({ type: 'scene', scene: sc });
      return sc;
    },
    /** Import a dingoConfig project into the current scene (keeps firmware/globals). */
    async populate(projectPath) {
      const { scene, notes } = await importProject(projectPath || state.scene?.project?.path, { ...state.scene, name: state.sceneName });
      api.setScene(scene);
      for (const n of notes) toast('info', typeof n === 'string' ? n : n.text);
      return { scene, notes };
    },

    /** UI `action` (docs/interfaces.md §8). Renode actions return a promise. */
    async action(a) {
      if (!a || !a.kind) throw new Error('action.kind required');
      recorder.action(a);
      if (a.kind === 'renode') return api.renodeCmd(a);
      const r = stim.apply(a);
      if (!r.ok) toast('warn', r.error);
      return r;
    },

    async ensureFirmware(override) {
      S.setRenode({ status: 'downloading' });
      firmwarePaths = await resolveFirmware(state.scene, { override });
      for (const [k, p] of Object.entries(firmwarePaths)) S.renodeLog(`[sim] firmware ${k}: ${p}`);
      return firmwarePaths;
    },

    async renodeCmd({ cmd, seconds, module, firmware, paused, read, watch } = {}) {
      try {
        switch (cmd) {
          case 'start': return await api.startRenode({ firmware, paused });
          case 'stop': return await renode.stop();
          case 'pause': return await renode.pause();
          case 'resume': return await renode.resume();
          case 'runfor': { const v = await renode.runFor(seconds ?? 1); state.renode.vtime = v || state.renode.vtime; return { vtime: state.renode.vtime }; }
          case 'reset': return await api.resetModule(module);
          case 'sleep': return renode.sleep(module);
          case 'wake': return renode.wake(module);
          case 'inspect': return await renode.inspect(module, read);
          case 'hubstats': return await renode.hubStats(watch);
          default: throw new Error(`unknown renode cmd ${cmd}`);
        }
      } catch (e) {
        toast('error', `renode ${cmd}: ${e.message}`);
        throw e;
      }
    },

    /**
     * Start Renode for the current scene and bring every simulated module onto its project base id
     * (server/bringup.js). Modules without a deploy marker are created off the hub and configured
     * one at a time; the others boot on the hub together. `paused` (CI): the emulation never
     * free-runs; virtual time is pumped in RunFor steps during the bring-up and stays paused after.
     *
     * Watchdog: Renode 1.16.1 with seven machines has been seen to stop advancing virtual time
     * during boot (every machine waiting, `pause` never returns). If virtual time stalls for
     * `stallMs` during the bring-up, Renode is killed and started again (up to `attempts` times).
     */
    async startRenode({ firmware, paused, bringup = true, attempts = 3, stallMs = 15000 } = {}) {
      if (!state.scene?.modules?.length) throw new Error('scene has no modules — populate from a project first');
      await api.ensureFirmware(firmware);
      applySceneSideEffects();
      const nvDir = path.join(S.sceneDir(state.sceneName), 'nv');
      fs.mkdirSync(nvDir, { recursive: true });
      const only = Array.isArray(state.scene.globals?.simModules) ? state.scene.globals.simModules : null;
      const candidates = state.scene.modules.filter((m) => !only || only.includes(m.id));
      // First start of a module (no deploy marker / FRAM image): every fresh module boots on the factory base
      // id, so they can't share the bus. Bring each one up ALONE on the hub (a Renode with only that machine),
      // move it to its project base id, burn, stop; the full start below then finds them all configured.
      // (Creating them on a private hub and moving them over left the bxCAN deaf to the shared hub.)
      if (bringup) {
        for (const id of modulesToIsolate(candidates, nvDir)) {
          S.renodeLog(`[bringup] ${id}: first start, configuring it alone on the bus`);
          state.renode.vtime = 0;
          const r1 = await renode.start(state.scene, firmwarePaths, { paused: !!paused, isolate: [], only: [id], nvDir });
          let pumping1 = !!paused;
          const pump1 = pumping1 ? (async () => { while (pumping1) await renode.runFor(0.2); })().catch(() => {}) : null;
          try { await api.bringUpStarted(r1, { isolate: [id], nvDir }); }
          finally { pumping1 = false; await pump1; await renode.stop(); }
        }
      }
      for (let attempt = 1; ; attempt++) {
        const isolate = bringup ? modulesToIsolate(candidates, nvDir) : [];
        state.renode.vtime = 0; // a new Renode process starts at virtual time 0
        for (const k of Object.keys(state.modules)) delete state.modules[k];   // no stale outputs / asleep from the last run
        const r = await renode.start(state.scene, firmwarePaths, { paused: !!paused, isolate, only, nvDir });
        if (!bringup) return r;
        let pumping = !!paused, stalled = false;
        const pump = pumping ? (async () => { while (pumping) await renode.runFor(0.2); })().catch(() => {}) : null;
        // watchdog on the bank traces' virtual time
        let lastV = -1, lastChange = Date.now();
        let rejectStall;
        const stall = new Promise((_, rej) => { rejectStall = rej; });
        const dog = setInterval(() => {
          const v = state.renode.vtime;
          if (v !== lastV) { lastV = v; lastChange = Date.now(); return; }
          if (Date.now() - lastChange > stallMs) { stalled = true; rejectStall(new Error(`virtual time stalled at ${v.toFixed(2)} s`)); }
        }, 500);
        try {
          const bu = api.bringUpStarted(r, { isolate, nvDir });
          bu.catch(() => {}); // when the watchdog wins, this one fails later (monitor closed)
          return await Promise.race([bu, stall]);
        } catch (e) {
          if (!stalled || attempt >= attempts) throw e;
          S.renodeLog(`[sim] ${e.message} during bring-up (attempt ${attempt}/${attempts}): restarting Renode`);
          toast('warn', `Renode stalled during bring-up, restarting (${attempt}/${attempts})`);
          await renode.kill();
        } finally {
          clearInterval(dog);
          pumping = false;
          stall.catch(() => {});
          await pump;
        }
      }
    },

    /**
     * Reset one module (generated reset macro) and wait until it answers Version on its base id
     * again; a module that comes back silent is reset once more (open Renode issue).
     */
    async resetModule(module, { tries = 2, bootMs = 12000 } = {}) {
      const m = state.scene?.modules?.find((x) => x.id === module);
      for (let k = 1; k <= tries; k++) {
        await renode.reset(module);
        if (!m || !bus.connected || !renode.freeRunning) return { module, answered: null }; // paused: nothing would answer
        const ver = await waitBoot(bus, m, m.baseId, { totalMs: bootMs });
        if (ver) return { module, answered: true, tries: k };
        S.renodeLog(`[sim] ${module} silent after reset ${k}/${tries}`);
      }
      toast('warn', `${module} does not answer after ${tries} resets`);
      return { module, answered: false, tries };
    },

    /** Bring-up after renode.start (see startRenode); returns the start result plus the report. */
    async bringUpStarted(r, { isolate, nvDir }) {
      const t0 = Date.now();
      while (!bus.connected && Date.now() - t0 < 30000) await new Promise((res) => setTimeout(res, 100));
      if (!bus.connected) throw new Error(`SLCAN bridge :${busPort} did not accept the bus link`);
      const log = (l) => S.renodeLog(l);
      if (isolate.length) log(`[bringup] first start for ${isolate.join(', ')}: configuring one at a time`);
      const report = await bringUp({ bus, renode, scene: state.scene, simulated: r.modules, isolated: isolate?.length ? isolate : r.isolated, nvDir, log, reset: (id) => renode.reset(id) });
      for (const x of report) if (x.action !== 'ok') toast('info', `${x.module}: ${x.action} (base 0x${(state.scene.modules.find((m) => m.id === x.module)?.baseId ?? 0).toString(16)})`);
      stim.pushBankScenes();
      stim.pushLevels();
      return { ...r, bringup: report };
    },

    /** UI `record` message. */
    async record({ cmd, run, golden, tolPct } = {}) {
      switch (cmd) {
        case 'start': recorder.start(); toast('info', 'recording'); return { recording: true };
        case 'stop': { const name = recorder.stop(); toast('info', `saved run ${name}`); broadcast({ type: 'runs', runs: S.listRuns() }); return { run: name }; }
        case 'replay': {
          const src = readRun(state.sceneName, run);
          const name = await replayRun({ ...src, name: run }, { recorder, apply: (a) => stim.apply(a), runFor: (s) => api.renodeCmd({ cmd: 'runfor', seconds: s }) });
          broadcast({ type: 'runs', runs: S.listRuns() });
          toast('info', `replay saved as ${name}`);
          return { run: name };
        }
        case 'golden': markGolden(state.sceneName, run); broadcast({ type: 'runs', runs: S.listRuns() }); return { golden: run };
        case 'diff': {
          const g = readRun(state.sceneName, golden || 'golden.run.json');
          const r = readRun(state.sceneName, run);
          const diff = diffRuns(g, r, { tolPct });
          broadcast({ type: 'diff', run, golden: golden || 'golden.run.json', diff });
          return diff;
        }
        default: throw new Error(`unknown record cmd ${cmd}`);
      }
    },

    listRuns: () => S.listRuns(),
    getRun: (name) => readRun(state.sceneName, name),
    listReleases: () => listReleases(),

    /** Bank traces for a module (optionally one output, since vtime). */
    trace(module, output, since = 0) {
      const ring = (state.traces[module] || []).filter((t) => t.t >= since);
      if (!output) return ring;
      return ring.map((t) => ({ t: t.t, i: t.i?.[output - 1], on: t.on?.[output - 1], duty: t.duty?.[output - 1] }));
    },

    async close() {
      clearTimeout(saveTimer);
      await api.stopLinks();
      if (renode.status && renode.status !== 'stopped') { try { await renode.stop(); } catch { /* ignore */ } }
    },
  };

  applySceneSideEffects();
  if (opts.links !== false) await api.startLinks();
  return api;
}

/** Ensure the scenes dir exists for a fresh clone. */
export function ensureDirs() {
  fs.mkdirSync(path.join(S.CACHE_DIR, 'generated'), { recursive: true });
}
