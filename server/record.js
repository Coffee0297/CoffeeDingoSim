// Record / replay / golden runs. A run file = the UI action stream stamped with Renode
// virtual time (relative to the start of the recording) plus the decoded telemetry stream.
import fs from 'node:fs';
import path from 'node:path';
import { sceneDir, ROOT } from './state.js';

/** `2026-10-06T10-00-00.run.json` from a Date. */

/** Firmware selection with local paths made relative to the repo, so a recorded run is portable. */
function portableFirmware(fw) {
  if (!fw || typeof fw !== 'object') return fw;
  const out = {};
  for (const [k, v] of Object.entries(fw)) {
    out[k] = v && typeof v === 'object' && typeof v.path === 'string' && path.isAbsolute(v.path)
      ? { ...v, path: path.relative(ROOT, v.path).split(path.sep).join('/') }
      : v;
  }
  return out;
}

export function runFileName(d = new Date()) {
  return d.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-') + '.run.json';
}

export function runsDir(sceneName) {
  return path.join(sceneDir(sceneName), 'runs');
}

/** Read a run by file name (relative to the scene's runs/) or absolute path. */
export function readRun(sceneName, name) {
  const p = path.isAbsolute(name) || name.includes('/') || name.includes('\\') ? path.resolve(name) : path.join(runsDir(sceneName), name);
  if (!fs.existsSync(p)) throw new Error(`run not found: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Recorder bound to a vtime source.
 * @param {{getVtime:()=>number, getSceneName:()=>string, getFirmware?:()=>any}} ctx
 */
export function createRecorder(ctx) {
  let cur = null;
  const rel = () => Math.round(((ctx.getVtime() || 0) - cur.t0) * 1000) / 1000;

  return {
    get active() { return !!cur; },
    get current() { return cur; },
    start(meta = {}) {
      cur = { version: 1, scene: ctx.getSceneName(), startedAt: new Date().toISOString(), t0: ctx.getVtime() || 0, firmware: portableFirmware(ctx.getFirmware?.() ?? null), golden: false, actions: [], telemetry: [], events: [], ...meta };
      return cur;
    },
    /** Log a UI action (no-op when not recording). */
    // renode runfor steps only advance time (CI and scripted sessions); replays re-issue no renode actions
    action(action) { if (cur && !(action.kind === 'renode' && (cur.replaying || action.cmd === 'runfor'))) cur.actions.push({ t: rel(), action }); },
    telemetry(msg) {
      if (!cur) return;
      cur.telemetry.push({ t: rel(), module: msg.module, outputs: (msg.outputs || []).map((o) => ({ n: o.n, state: o.state, currentA: o.currentA, ocCount: o.ocCount, duty: o.duty })), asleep: !!msg.asleep });
    },
    event(ev) { if (cur) cur.events.push({ t: rel(), ...ev }); },
    /** Stop and write the run file; returns its name. */
    stop({ name } = {}) {
      if (!cur) return null;
      const run = cur; cur = null;
      run.durationS = Math.max(rel0(run, ctx), run.actions.at(-1)?.t ?? 0, run.telemetry.at(-1)?.t ?? 0);
      delete run.t0; delete run.replaying;
      const dir = runsDir(run.scene);
      fs.mkdirSync(dir, { recursive: true });
      const file = name || runFileName();
      fs.writeFileSync(path.join(dir, file), JSON.stringify(run));
      return file;
    },
  };
}
function rel0(run, ctx) { return Math.round(((ctx.getVtime() || 0) - run.t0) * 1000) / 1000; }

/**
 * Replay a run: re-issue its actions at their virtual times, advancing Renode by `stepS` `RunFor`
 * steps (deterministic regardless of host speed), while recording a new run.
 * @param {{recorder:any, apply:(a:any)=>any, runFor:(s:number)=>Promise<any>, sceneName:string}} ctx
 * @returns {Promise<string>} the new run's file name
 */
export async function replay(run, ctx, { stepS = 0.1, onProgress } = {}) {
  const actions = [...(run.actions || [])].sort((a, b) => a.t - b.t);
  const duration = run.durationS ?? actions.at(-1)?.t ?? 0;
  ctx.recorder.start({ replayOf: run.name || run.startedAt, replaying: true });
  let t = 0, i = 0;
  const eps = 1e-9;
  while (t <= duration + eps) {
    while (i < actions.length && actions[i].t <= t + eps) {
      const a = actions[i++].action;
      if (a.kind !== 'renode') { ctx.recorder.action(a); ctx.apply(a); }
    }
    if (t >= duration - eps) break;
    const step = Math.min(stepS, duration - t);
    await ctx.runFor(step);
    t = Math.round((t + step) * 1e6) / 1e6;
    onProgress?.(t, duration);
  }
  return ctx.recorder.stop();
}

/** Mark a run golden (flag in the file + copy to runs/golden.run.json). */
export function markGolden(sceneName, name) {
  const dir = runsDir(sceneName);
  const run = readRun(sceneName, name);
  run.golden = true;
  run.name = name;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(run));
  fs.writeFileSync(path.join(dir, 'golden.run.json'), JSON.stringify(run));
  return run;
}

// ---------------------------------------------------------------- diff -------------------

const collapse = (arr) => arr.filter((v, i) => i === 0 || v !== arr[i - 1]);

function perOutput(run) {
  /** module → n → {states:[], i:[], oc:0} ; module → sleep transitions */
  const mods = {};
  for (const s of run.telemetry || []) {
    const m = (mods[s.module] ||= { outputs: {}, sleep: [] });
    m.sleep.push(s.asleep ? 'asleep' : 'awake');
    for (const o of s.outputs || []) {
      const e = (m.outputs[o.n] ||= { states: [], i: [], oc: 0 });
      e.states.push(o.state);
      e.i.push(Number(o.currentA) || 0);
      e.oc = Math.max(e.oc, Number(o.ocCount) || 0);
    }
  }
  return mods;
}
const rms = (a) => (a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : 0);

/**
 * Diff a run against a golden run.
 * @param {any} golden @param {any} run
 * @param {{tolPct?:number, floorA?:number}} [o] current tolerance in % (default 10) and an absolute floor in A
 * @returns {{ok:boolean, rows:Array<{module:string, n:number|null, what:string, golden:any, run:any, ok:boolean}>, modules:Record<string,any>}}
 */
export function diffRuns(golden, run, { tolPct = 10, floorA = 0.2 } = {}) {
  const g = perOutput(golden), r = perOutput(run);
  const rows = [];
  const modules = {};
  for (const id of [...new Set([...Object.keys(g), ...Object.keys(r)])].sort()) {
    const gm = g[id] || { outputs: {}, sleep: [] }, rm = r[id] || { outputs: {}, sleep: [] };
    const res = (modules[id] = { ok: true, outputs: [] });
    if (!g[id] || !r[id]) {
      rows.push({ module: id, n: null, what: 'present', golden: !!g[id], run: !!r[id], ok: false });
      res.ok = false;
      continue;
    }
    const gs = collapse(gm.sleep), rs = collapse(rm.sleep);
    const sleepOk = gs.join() === rs.join();
    if (!sleepOk) { rows.push({ module: id, n: null, what: 'sleep', golden: gs.join('→'), run: rs.join('→'), ok: false }); res.ok = false; }
    for (const n of [...new Set([...Object.keys(gm.outputs), ...Object.keys(rm.outputs)])].map(Number).sort((a, b) => a - b)) {
      const go = gm.outputs[n] || { states: [], i: [], oc: 0 }, ro = rm.outputs[n] || { states: [], i: [], oc: 0 };
      const gSeq = collapse(go.states), rSeq = collapse(ro.states);
      const gr = rms(go.i), rr = rms(ro.i);
      const diffPct = gr === 0 && rr === 0 ? 0 : (Math.abs(gr - rr) / Math.max(gr, rr)) * 100;
      const statesOk = gSeq.join() === rSeq.join();
      const ocOk = go.oc === ro.oc;
      const iOk = diffPct <= tolPct || Math.abs(gr - rr) <= floorA;
      const o = { n, ok: statesOk && ocOk && iOk, states: { golden: gSeq, run: rSeq, ok: statesOk }, oc: { golden: go.oc, run: ro.oc, ok: ocOk }, rmsA: { golden: round(gr), run: round(rr), diffPct: round(diffPct), ok: iOk } };
      res.outputs.push(o);
      if (!statesOk) rows.push({ module: id, n, what: 'states', golden: gSeq.join('→'), run: rSeq.join('→'), ok: false });
      if (!ocOk) rows.push({ module: id, n, what: 'ocCount', golden: go.oc, run: ro.oc, ok: false });
      if (!iOk) rows.push({ module: id, n, what: 'rmsA', golden: round(gr), run: `${round(rr)} (${round(diffPct)}%)`, ok: false });
      if (!o.ok) res.ok = false;
    }
  }
  return { ok: rows.every((x) => x.ok), tolPct, rows, modules };
}
const round = (v) => Math.round(v * 100) / 100;

/** Plain-text table of a diff (CI output). */
export function formatDiff(diff) {
  if (diff.ok) return `golden diff: OK (tolerance ${diff.tolPct}%)`;
  const head = ['module', 'out', 'what', 'golden', 'run'];
  const body = diff.rows.map((r) => [r.module, r.n ?? '-', r.what, String(r.golden), String(r.run)]);
  const w = head.map((h, i) => Math.min(60, Math.max(h.length, ...body.map((b) => String(b[i]).length))));
  const line = (cells) => cells.map((c, i) => String(c).slice(0, 60).padEnd(w[i])).join(' | ');
  return [`golden diff: ${diff.rows.length} difference(s)`, line(head), w.map((x) => '-'.repeat(x)).join('-+-'), ...body.map(line)].join('\n');
}
