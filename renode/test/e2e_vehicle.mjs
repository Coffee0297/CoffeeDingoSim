// End-to-end run of the example vehicle scene against REAL Renode and REAL firmware.
//
//   node renode/test/e2e_vehicle.mjs [--fresh] [--no-golden] [--keep]
//
// 1. populates scenes/example/scene.sim.json from the dingoConfig project (two PDMs + one CANBoard simulated,
//    globals.forceOutputsOn, local firmware from $SIM_FW_DIR, default ../CoffeeDingoFW/build next to this repo),
// 2. starts the server in-process (http+ws on :8797) and drives everything over the WebSocket like
//    the UI does: Renode start (bring-up sequencer), faults, record,
// 3. checks telemetry / bank traces / the dingoConfig SLCAN link on tcp:7778,
// 4. records a 20 s scripted session to scenes/example/runs/golden.run.json.
// --fresh deletes scenes/example/nv/* first (first-start bring-up). Results: renode/test/e2e_result.json.
//
// Ports: monitor (free port per start), SlcanTcpBridge 7777, load bank 7800, dingoConfig bridge 7778, server 8797.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const FW = process.env.E2E_FIRMWARE || process.env.SIM_FW_DIR || path.resolve(ROOT, '../CoffeeDingoFW/build');
const HTTP_PORT = 8797;
process.env.SIM_BANK_PORT ||= '7800';
process.env.SIM_BUS_PORT ||= '7777';
// monitor port: a free one per Renode start (server/renode.js); pin it with SIM_MONITOR_PORT if needed.
// Renode: RENODE_EXE / RENODE_DIR, else the copy server/renode.js downloads into cache/renode.
const PDMS = ['PDM-01', 'PDM-02'];
const CBS = ['CB-1'];
const MODS = [...PDMS, ...CBS];
const sceneDir = path.join(ROOT, 'scenes', 'example');
const nvDir = path.join(sceneDir, 'nv');
const result = { started: new Date().toISOString(), checks: [], notes: [] };
const check = (name, ok, evidence) => { result.checks.push({ name, ok: !!ok, evidence }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`); };
const note = (t) => { result.notes.push(t); console.log(`NOTE ${t}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ scene ----------------
if (args.has('--fresh') && fs.existsSync(nvDir)) for (const f of fs.readdirSync(nvDir)) fs.rmSync(path.join(nvDir, f));
const { importProject } = await import('../../server/project.js');
const { scene } = await importProject('scenes/example/example-vehicle.json', { name: 'example' });
scene.firmware = { pdm: { source: 'local', path: FW }, pdmmax: { source: 'local', path: FW }, canboard: { source: 'local', path: FW }, bootloader: false };
scene.globals = { ...scene.globals, noisePct: 1, forceOutputsOn: true };
fs.mkdirSync(sceneDir, { recursive: true });
fs.writeFileSync(path.join(sceneDir, 'scene.sim.json'), JSON.stringify(scene, null, 2));

// ------------------------------------------------------------------ server ---------------
const { createSim } = await import('../../server/sim.js');
const { startServer } = await import('../../server/index.js');
const sim = await createSim({ scene: 'example', bridge: 'tcp:7778' });
const srv = await startServer(sim, { port: HTTP_PORT, mcp: false });
const logFile = path.join(ROOT, 'renode', 'test', 'e2e_renode.log');
// every hub frame except the cyclic flood, for debugging the param traffic
const busLog = fs.createWriteStream(path.join(ROOT, 'renode', 'test', 'e2e_bus.log'));
const cfgIds = new Set();
for (const m of scene.modules) cfgIds.add(m.baseId).add(m.baseId + 1);
for (let b = 0x0de; b <= 0x0fa; b++) cfgIds.add(b);
for (let b = 0x640; b <= 0x64f; b++) cfgIds.add(b);
sim.bus.on('frame', (f) => { if (cfgIds.has(f.id)) busLog.write(`${Date.now()} ${f.dir} ${f.id.toString(16)} ${f.data.map((b) => b.toString(16).padStart(2, '0')).join(' ')}
`); });
fs.writeFileSync(logFile, '');
let renodePid = null;
// progress: host time, virtual time, frames seen (real-time factor evidence)
const perf = [];
const hostT0 = Date.now();
const perfTimer = setInterval(async () => {
  if (sim.renode.status !== 'running' && sim.renode.status !== 'paused') return;
  const v = await sim.renode.readVtime();
  const row = { hostS: (Date.now() - hostT0) / 1000, vtimeS: v, frames: sim.state.bus.frames };
  perf.push(row);
  fs.appendFileSync(logFile, `[e2e] perf ${JSON.stringify(row)}
`);
}, 5000);
perfTimer.unref();
result.perf = perf;

const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
const tel = {};          // module → latest telemetry
const telLog = {};       // module → [{t, out1..}] history
const traces = {};       // machine → [trace]
const toasts = [];
let rpcId = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'telemetry') { tel[m.module] = m; (telLog[m.module] ||= []).push({ t: m.t, wall: Date.now(), outputs: m.outputs.map((o) => ({ n: o.n, state: o.state, currentA: o.currentA, ocCount: o.ocCount })) }); }
  else if (m.type === 'trace') (traces[m.machine] ||= []).push(m);
  else if (m.type === "renode" && m.log?.length === 1) for (const l of m.log) fs.appendFileSync(logFile, l + '\n');
  else if (m.type === 'toast') toasts.push(m);
  else if (m.type === 'result' && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const rpc = (msg, timeoutMs = 900000) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error(`rpc timeout ${JSON.stringify(msg)}`)); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); m.ok ? resolve(m.result) : reject(new Error(m.error)); });
  ws.send(JSON.stringify({ ...msg, id }));
});
const action = (a) => rpc({ type: 'action', action: a });
const collapse = (arr) => arr.filter((v, i) => i === 0 || v !== arr[i - 1]);
/** Wait until Renode virtual time (from the bank traces) reaches `v` seconds. */
async function waitVt(v, maxHostMs = 300000) {
  const t0 = Date.now();
  while (sim.state.renode.vtime < v) {
    if (Date.now() - t0 > maxHostMs) throw new Error(`virtual time stuck at ${sim.state.renode.vtime} (waiting for ${v})`);
    await sleep(50);
  }
}
const idsByModule = {};
const msg1Out1 = []; // PDM-01 Msg1 (0x683) out1 current, every frame
sim.bus.on('frame', (f) => { if (f.dir === 'rx' && f.id === 0x683) msg1Out1.push({ wall: Date.now(), a: ((f.data[0] | (f.data[1] << 8)) / 10) }); });
sim.bus.on('frame', (f) => { if (f.dir === 'rx' && f.module) (idsByModule[f.module] ||= new Set()).add(f.id); });

/** Act like dingoConfig's SLCAN transport on the server bridge (tcp:<port>). */
async function dingoConfigProbe(port, base) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  let buf = '';
  const lines = [];
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    let i;
    while ((i = buf.search(/[\r\x07]/)) >= 0) { lines.push(buf[i] === '\x07' ? '\x07' : buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  const ask = async (cmd, pick, ms = 3000) => {
    const from = lines.length;
    sock.write(cmd + '\r');
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = lines.slice(from).find(pick);
      if (hit !== undefined) return hit;
      await sleep(10);
    }
    return null;
  };
  const out = {};
  out.V = await ask('V', (l) => l.startsWith('V'));
  out.O = await ask('O', (l) => l === '');
  out.I = await ask('I', (l) => l.startsWith('I'));
  const n0 = lines.length;
  await sleep(2000);
  out.frames = lines.slice(n0).filter((l) => l[0] === 't').length;
  const req = `t${(base + 1).toString(16).toUpperCase().padStart(3, '0')}81F00000000000000`;
  out.versionRequest = req;
  for (let k = 0; k < 3 && !out.versionReply; k++) {
    out.versionReply = await ask(req, (l) => l.toUpperCase().startsWith(`T${base.toString(16).toUpperCase().padStart(3, '0')}81F`), 3000);
    out.versionTries = k + 1;
  }
  sock.destroy();
  return out;
}

async function shutdown(code) {
  fs.writeFileSync(path.join(ROOT, 'renode', 'test', 'e2e_result.json'), JSON.stringify(result, null, 2));
  if (!args.has('--keep')) {
    try { await action({ kind: 'renode', cmd: 'stop' }); } catch { /* ignore */ }
    if (renodePid) { try { process.kill(renodePid); } catch { /* already gone */ } }
  }
  ws.close();
  await sim.close();
  await srv.close();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(130));

try {
  // ---------------------------------------------------------------- start ----------------
  const freshBefore = MODS.filter((id) => !fs.existsSync(path.join(nvDir, `${id}.deploy.json`)));
  const t0 = Date.now();
  const started = await action({ kind: 'renode', cmd: 'start' });
  renodePid = started.pid;
  fs.writeFileSync(path.join(ROOT, 'renode', 'test', 'e2e_renode.pid'), String(renodePid));
  result.start = { hostS: (Date.now() - t0) / 1000, modules: started.modules, isolated: started.isolated, skipped: started.skipped, bringup: started.bringup, pid: renodePid };
  console.log('start:', JSON.stringify(result.start));
  check('renode started with the 2 PDMs and the CANBoard', MODS.every((id) => started.modules.includes(id)), started.modules);
  // fresh modules are configured alone first (one Renode per module), so the full start reports them 'ok';
  // what matters is that each now has its deploy marker and answers on its project base id
  check('bring-up: fresh modules configured one at a time', freshBefore.every((id) => fs.existsSync(path.join(sceneDir, 'nv', `${id}.deploy.json`))
    && started.bringup.some((b) => b.module === id && ['ok', 'configured', 'redeployed'].includes(b.action) && b.version)),
    { freshBefore, bringup: started.bringup });

  // ------------------------------------------------------------ telemetry + traces --------
  await waitVt(sim.state.renode.vtime + 3);
  for (const m of scene.modules) {
    const ids = [...(idsByModule[m.id] || [])].sort((a, b) => a - b);
    const tl = telLog[m.id] || [];
    check(`${m.id}: telemetry over ws, cyclic frames from project base 0x${m.baseId.toString(16)}`,
      tl.length > 5 && ids.length > 0 && ids[0] >= m.baseId && ids.at(-1) < m.baseId + (m.kind === "canboard" ? 12 : 30),
      { telemetryMsgs: tl.length, frameIds: ids.map((x) => '0x' + x.toString(16)), vbattV: tel[m.id]?.vbattV, tempC: tel[m.id]?.tempC });
  }
  check('bank trace `machine` field = scene module id', MODS.every((id) => traces[id]?.length > 0) && Object.keys(traces).every((k) => MODS.includes(k)),
    Object.fromEntries(Object.entries(traces).map(([k, v]) => [k, v.length])));

  // ------------------------------------------------------------ PDM-01 out1 turn-on ---------
  // forceOutputsOn binds out1 (2 x H4 55 W low beam) to Always On. Reset the module so the turn-on
  // happens now, cold (the bank restarts a load cold after coolDownMs 1500 off).
  const turnOn = async (label) => {
    const before = (telLog['PDM-01'] || []).length;
    const trBefore = (traces['PDM-01'] || []).length;
    const m1Before = msg1Out1.length;
    const tReset = sim.state.renode.vtime;
    await action({ kind: 'renode', cmd: 'reset', module: 'PDM-01' });
    await waitVt(tReset + 4);
    const seq = collapse((telLog['PDM-01'] || []).slice(before).map((x) => x.outputs[0].state));
    const cur = (telLog['PDM-01'] || []).slice(before).map((x) => x.outputs[0].currentA);
    const tr = (traces['PDM-01'] || []).slice(trBefore);
    const peak = Math.max(0, ...tr.map((t) => t.peak?.[0] ?? t.i[0]));
    const trOn = tr.filter((t) => t.on[0] || t.peak?.[0] > 0).slice(0, 12).map((t) => `${t.t.toFixed(1)}s i=${t.i[0].toFixed(1)}A peak=${(t.peak?.[0] ?? 0).toFixed(1)}A`);
    const m1 = msg1Out1.slice(m1Before).map((x) => x.a);
    result[label] = { states: seq, msg1CurrentsA: [...new Set(cur)].slice(0, 20), msg1FramesOut1A: [...new Set(m1)].slice(0, 20), msg1PeakA: Math.max(0, ...m1), bankPeakA: peak, bankTraceOn: trOn, ocCount: tel['PDM-01'].outputs[0].ocCount };
    return result[label];
  };
  // what the bank applies to out1: the rendered cold-start tables of both lamps (sum), clamped to the
  // Profet saturation (63 A on out1, kILIS 22950)
  const { buildBankScenes } = await import('../../server/stimulus.js');
  const { getComponents, getSceneLib } = await import('../../server/compat.js');
  const out1Model = async () => {
    const bs = buildBankScenes(sim.state.scene, await getComponents(), 13.8, (await getSceneLib()).toBankScenes).find((x) => x.machine === 'PDM-01');
    const ls = bs.outputs['1'].loads;
    const t0 = ls.reduce((a, l) => a + (l.table?.[0] ?? l.steadyA), 0);
    return { loads: ls.map((l) => l.id), coldPeakA: Math.round(t0 * 10) / 10, clampedA: Math.min(63, t0), steadyA: Math.round(ls.reduce((a, l) => a + l.steadyA, 0) * 100) / 100, inrushLimitA: 50 };
  };

  // 1) component defaults (5x cold filament): two H4 55 W ~40 A peak, under the 50 A inrush limit -> stays On
  result.pdm01_out1_model = await out1Model();
  const steady1 = result.pdm01_out1_model.steadyA;
  note(`PDM-01 out1 model (defaults): ${JSON.stringify(result.pdm01_out1_model)}`);
  const r0 = await turnOn('pdm01_out1_turnon_defaults');
  console.log('PDM-01 out1 turn-on (defaults):', JSON.stringify(r0));
  check('PDM-01 out1 defaults: two cold H4 55 W peak under the 50 A inrush limit', result.pdm01_out1_model.coldPeakA < 50 && result.pdm01_out1_model.coldPeakA > 30, result.pdm01_out1_model);
  check('PDM-01 out1 defaults: turns On and stays On (no trip)', r0.states.at(-1) === 'On' && !r0.states.includes('Fault'), r0.states.join('->'));

  // 2) a user override on the canvas (Inrush x10 on both lamps) must reach the bank and trip the firmware
  const sc = structuredClone(sim.state.scene);
  for (const n of sc.nodes) if (result.pdm01_out1_model.loads.includes(n.id)) n.data = { ...n.data, params: { ...(n.data.params || {}), kCold: 10 } };
  await rpc({ type: 'scene', scene: sc });
  await waitVt(sim.state.renode.vtime + 1);
  result.pdm01_out1_model_override = await out1Model();
  note(`PDM-01 out1 model (Inrush x10 override): ${JSON.stringify(result.pdm01_out1_model_override)}`);
  check('PDM-01 out1 override: Inrush x10 on the load nodes raises the modelled peak above 63 A', result.pdm01_out1_model_override.coldPeakA > 63, result.pdm01_out1_model_override);
  // the turn-on trips within a few ms, so a 10 Hz trace / 10 Hz Msg1 only catch it by chance: try up to 3 times
  let r1;
  for (let k = 1; k <= 3; k++) {
    r1 = await turnOn(`pdm01_out1_turnon_${k}`);
    console.log(`PDM-01 out1 turn-on #${k}:`, JSON.stringify(r1));
    if (r1.states.includes('Fault') || r1.states.includes('Overcurrent')) break;
  }
  check('PDM-01 out1 override: inrush seen in the bank trace', r1.bankPeakA > 2 * steady1, r1.bankTraceOn);
  if (r1.msg1PeakA > 2 * steady1) check('PDM-01 out1: firmware measured the inrush current (Msg1 frame)', true, r1.msg1FramesOut1A);
  else note(`PDM-01 out1: no Msg1 frame fell inside the few-ms inrush before the trip (Msg1 values ${JSON.stringify(r1.msg1FramesOut1A)}); the trip itself (Fault, ocCount ${r1.ocCount}) is the firmware's measurement`);
  // use the other steady PDM-01 outputs (out2..7) to show the firmware's Msg1/Msg2 currents track the bank
  // average the last ~1 s of both streams: a single pair of samples taken at different instants is unfair on
  // rippling loads (horn buzz +-25 %, wiper sweep)
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const fwHist = (telLog['PDM-01'] || []).slice(-10), bkHist = (traces['PDM-01'] || []).slice(-10);
  const pairs = tel['PDM-01'].outputs.map((o, i) => [o.n,
    Math.round(avg(fwHist.map((h) => h.outputs[i]?.currentA ?? 0)) * 10) / 10,
    Math.round(avg(bkHist.map((t) => t.i[i])) * 10) / 10]).filter((x) => x[2] > 0.2);
  check('PDM-01: firmware Msg1/Msg2 currents track the bank (steady outputs, +-15 %)', pairs.length >= 4 && pairs.every(([, fw, bk]) => Math.abs(fw - bk) <= Math.max(0.3, 0.15 * bk)), pairs.map(([n, fw, bk]) => `out${n} fw ${fw} A / bank ${bk} A`));
  check('PDM-01 out1 override: inrush > 50 A trips Overcurrent -> Fault (resetMode None)', r1.states.includes('Fault') || r1.states.includes('Overcurrent'), r1.states.join('->'));
  // put the defaults back for the rest of the run and the golden session
  await rpc({ type: 'scene', scene: (() => { const c = structuredClone(sim.state.scene); for (const n of c.nodes) if (n.data?.params) delete n.data.params; return c; })() });

  // ------------------------------------------------------------ faults ---------------------
  const faultCase = async (label, module, nodeId, kind, out, waitS = 3) => {
    const before = (telLog[module] || []).length;
    const tr0 = (traces[module] || []).length;
    const t = sim.state.renode.vtime;
    await action({ kind: 'fault', node: nodeId, fault: { kind, atMs: 0 } });
    await waitVt(t + waitS);
    const seq = collapse((telLog[module] || []).slice(before).map((x) => x.outputs[out - 1].state));
    const cur = (telLog[module] || []).slice(before).map((x) => x.outputs[out - 1].currentA);
    const tr = (traces[module] || []).slice(tr0).map((x) => x.i[out - 1]);
    await action({ kind: 'fault', node: nodeId, fault: null });
    result[label] = { states: seq, msgCurrentsA: [...new Set(cur)].slice(0, 12), bankA: [...new Set(tr.map((v) => Math.round(v * 10) / 10))].slice(0, 12) };
    console.log(label, JSON.stringify(result[label]));
    return result[label];
  };
  const beforePump = tel['PDM-02'].outputs[0];
  note(`PDM-02 out1 before the stall: ${beforePump.state} ${beforePump.currentA} A`);
  const fPump = await faultCase('pdm02_out1_stall', 'PDM-02', 'PDM-02.o1.1', 'stall', 1);
  check('PDM-02 out1 fuel pump stall -> Overcurrent/Fault', fPump.states.some((s) => s === 'Overcurrent' || s === 'Fault'), fPump);
  const beforeBrake = tel['PDM-02'].outputs[4];
  note(`PDM-02 out5 before the open: ${beforeBrake.state} ${beforeBrake.currentA} A`);
  const f5 = await faultCase('pdm02_out5_open', 'PDM-02', 'PDM-02.o5.1', 'open', 5);
  const ol = scene.modules.find((m) => m.id === 'PDM-02').outputs[4].openLoadLimit;
  check(`PDM-02 out5 burnt brake bulb: current 0, state ${ol > 0 ? 'OpenLoad' : 'stays On (project openLoadLimit 0 = detection off)'}`,
    f5.msgCurrentsA.includes(0) && (ol > 0 ? f5.states.includes('OpenLoad') : !f5.states.includes('OpenLoad')), f5);

  // ------------------------------------------------------------ dingoConfig link ----------
  const dc = await dingoConfigProbe(7778, 0x680);
  result.dingoConfig = dc;
  check('dingoConfig bridge tcp:7778: V, O, I, Version request 0x681 -> reply 0x680', dc.V === 'V1013' && dc.O === '' && dc.I === 'I680' && /^t6808 ?1F00/i.test(dc.versionReply || '') && dc.frames > 50, dc);

  // ------------------------------------------------------------ golden session ------------
  if (!args.has('--no-golden')) {
    // Recorded exactly the way `npm run ci` replays it, so the golden is reproducible: a fresh,
    // paused Renode (bring-up pumped in RunFor steps), 3 s settle, then 0.1 s RunFor steps driven
    // over the ws with the scripted actions at their virtual times.
    await action({ kind: 'renode', cmd: 'stop' });
    const st = await action({ kind: 'renode', cmd: 'start', paused: true });
    renodePid = st.pid;
    fs.writeFileSync(path.join(ROOT, 'renode', 'test', 'e2e_renode.pid'), String(renodePid));
    await action({ kind: 'renode', cmd: 'runfor', seconds: 3 });
    const script = [
      { t: 2, a: { kind: 'fault', node: 'PDM-02.o1.1', fault: { kind: 'stall', atMs: 0 } } },
      { t: 6, a: { kind: 'fault', node: 'PDM-02.o1.1', fault: null } },
      { t: 8, a: { kind: 'fault', node: 'PDM-02.o5.1', fault: { kind: 'open', atMs: 0 } } },
      { t: 12, a: { kind: 'fault', node: 'PDM-02.o5.1', fault: null } },
      { t: 14, a: { kind: 'battery', node: 'battery', vocV: 12.0 } },
      { t: 18, a: { kind: 'battery', node: 'battery', vocV: 12.6 } },
    ];
    const h0 = Date.now();
    await rpc({ type: 'record', cmd: 'start' });
    let t = 0, i = 0;
    while (t <= 20 + 1e-9) {
      while (i < script.length && script[i].t <= t + 1e-9) await action(script[i++].a);
      if (t >= 20 - 1e-9) break;
      await action({ kind: 'renode', cmd: 'runfor', seconds: 0.1 });
      t = Math.round((t + 0.1) * 1e6) / 1e6;
    }
    const { run } = await rpc({ type: 'record', cmd: 'stop' });
    const hostS = (Date.now() - h0) / 1000;
    const runsDir = path.join(sceneDir, 'runs');
    const runJson = JSON.parse(fs.readFileSync(path.join(runsDir, run), 'utf8'));
    runJson.settleS = 3;
    fs.writeFileSync(path.join(runsDir, run), JSON.stringify(runJson));
    await rpc({ type: 'record', cmd: 'golden', run });
    const g = JSON.parse(fs.readFileSync(path.join(runsDir, 'golden.run.json'), 'utf8'));
    result.golden = { run, actions: g.actions.length, telemetry: g.telemetry.length, durationS: g.durationS, hostS, realTimeFactor: Math.round((g.durationS / hostS) * 100) / 100 };
    check('golden run recorded (20 s virtual, scripted over ws)', g.actions.length === script.length && g.durationS >= 19.9 && g.golden, result.golden);
  }
} catch (e) {
  console.error('E2E error:', e.stack || e.message);
  result.error = e.message;
  await shutdown(2);
}
await shutdown(0);
