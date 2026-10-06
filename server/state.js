// Central mutable state of the simulator process plus the broadcast bus that the
// WebSocket handler, the MCP server and the CI runner all subscribe to.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCENES_DIR = process.env.SIM_SCENES_DIR || path.join(ROOT, 'scenes');
export const CACHE_DIR = process.env.SIM_CACHE_DIR || path.join(ROOT, 'cache');

const LOG_RING = 500;
const TRACE_RING = 3000; // 300 s of 10 Hz traces per machine

/** @typedef {{status:string, vtime:number, log:string[], exe?:string, pid?:number, error?:string}} RenodeState */

export const events = new EventEmitter();
events.setMaxListeners(50);

export const state = {
  sceneName: null,
  /** @type {any} */ scene: null,
  /** per module id: last assembled telemetry (docs/interfaces.md §8 `telemetry` message without `type`) */
  modules: {},
  /** per machine: ring of bank trace objects */
  traces: {},
  /** @type {RenodeState} */
  renode: { status: 'stopped', vtime: 0, log: [] },
  bank: { connected: false, machines: [] },
  bus: { connected: false, frames: 0 },
  bridge: { mode: 'none', connected: false, clients: 0, filterId: -1 },
  recording: null,
  battery: { v: 12.6, totalA: 0 },
};

/** Push a server→UI message to every subscriber (ws clients, tests, ci). */
export function broadcast(msg) {
  events.emit('broadcast', msg);
}

/** Convenience: broadcast a toast and log it. */
export function toast(level, text) {
  broadcast({ type: 'toast', level, text });
  if (level === 'error' || level === 'warn') console.error(`[${level}] ${text}`);
  else console.log(`[info] ${text}`);
}

export function sceneDir(name = state.sceneName) {
  return path.join(SCENES_DIR, name);
}
export function scenePath(name = state.sceneName) {
  return path.join(sceneDir(name), 'scene.sim.json');
}

/** Empty scene skeleton (docs/interfaces.md §3). */
export function emptyScene(name) {
  return { version: 1, name, project: null, firmware: {}, modules: [], nodes: [], edges: [], globals: { noisePct: 1 } };
}

/** Load `scenes/<name>/scene.sim.json` (or an empty scene) and make it current. */
export function loadScene(name) {
  const p = scenePath(name);
  let scene;
  if (fs.existsSync(p)) {
    scene = JSON.parse(fs.readFileSync(p, 'utf8'));
    scene.name ??= name;
  } else {
    scene = emptyScene(name);
  }
  state.sceneName = name;
  state.scene = scene;
  return scene;
}

/** Replace the current scene, persist it and broadcast `scene`. */
export function setScene(scene, { persist = true, announce = true } = {}) {
  state.scene = scene;
  state.sceneName = scene.name || state.sceneName || 'default';
  if (persist) saveScene(scene);
  if (announce) broadcast({ type: 'scene', scene });
  events.emit('scene', scene);
  return scene;
}

export function saveScene(scene = state.scene) {
  const dir = sceneDir(scene.name || state.sceneName);
  fs.mkdirSync(path.join(dir, 'nv'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.writeFileSync(scenePath(scene.name || state.sceneName), JSON.stringify(scene, null, 2));
}

/** Find a module by id, a node by id, or the edges touching a node. */
export function findModule(id) {
  return state.scene?.modules?.find((m) => m.id === id) || null;
}
export function findNode(id) {
  return state.scene?.nodes?.find((n) => n.id === id) || null;
}
export function edgesOf(nodeId) {
  return (state.scene?.edges || []).filter((e) => e.from?.node === nodeId || e.to?.node === nodeId);
}

/** Merge a telemetry update for a module and broadcast it. */
export function setTelemetry(moduleId, patch) {
  const cur = state.modules[moduleId] || { module: moduleId, t: 0, outputs: [], inputs: [], positions: [], asleep: false };
  const next = { ...cur, ...patch, module: moduleId };
  state.modules[moduleId] = next;
  broadcast({ type: 'telemetry', ...next });
  return next;
}

/** Store a bank trace (ring) and broadcast the `trace` message. */
export function pushTrace(trace) {
  const ring = (state.traces[trace.machine] ||= []);
  ring.push(trace);
  if (ring.length > TRACE_RING) ring.splice(0, ring.length - TRACE_RING);
  if (typeof trace.t === 'number' && trace.t > state.renode.vtime) state.renode.vtime = trace.t;
  broadcast({ type: 'trace', machine: trace.machine, t: trace.t, i: trace.i, peak: trace.peak, on: trace.on, duty: trace.duty, do: trace.do, di: trace.di, mV: trace.mV });
}

/** Patch renode status and broadcast it (log is sent as the tail only). */
export function setRenode(patch) {
  Object.assign(state.renode, patch);
  broadcast({ type: 'renode', status: state.renode.status, vtime: state.renode.vtime, log: state.renode.log.slice(-20), error: state.renode.error });
}

/** Append a Renode log line (ring of 500) and broadcast it incrementally. */
export function renodeLog(line) {
  if (process.env.SIM_RENODE_LOG) { try { fs.appendFileSync(process.env.SIM_RENODE_LOG, `${new Date().toISOString()} ${line}
`); } catch { /* ignore */ } }
  const log = state.renode.log;
  log.push(line);
  if (log.length > LOG_RING) log.splice(0, log.length - LOG_RING);
  broadcast({ type: 'renode', status: state.renode.status, vtime: state.renode.vtime, log: [line] });
}

/** Runs recorded for the current scene, newest first. */
export function listRuns(name = state.sceneName) {
  const dir = path.join(sceneDir(name), 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.run.json'))
    .sort()
    .reverse()
    .map((f) => {
      let meta = {};
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        meta = { golden: !!j.golden, actions: j.actions?.length ?? 0, durationS: j.durationS ?? null, firmware: j.firmware ?? null };
      } catch { /* unreadable run file: list it anyway */ }
      return { name: f, ...meta };
    });
}

/** The `snapshot` message body (docs/interfaces.md §8). `components` is filled by the caller. */
export function snapshot(components = []) {
  return {
    type: 'snapshot',
    scene: state.scene,
    renode: { status: state.renode.status, vtime: state.renode.vtime, log: state.renode.log.slice(-100), error: state.renode.error },
    modules: state.modules,
    components,
    runs: listRuns(),
    bank: state.bank,
    bus: state.bus,
    bridge: state.bridge,
    recording: state.recording ? { startedAt: state.recording.startedAt, actions: state.recording.actions.length } : null,
    battery: state.battery,
  };
}

/** Reset everything (tests). */
export function resetState() {
  state.sceneName = null;
  state.scene = null;
  state.modules = {};
  state.traces = {};
  state.renode = { status: 'stopped', vtime: 0, log: [] };
  state.bank = { connected: false, machines: [] };
  state.bus = { connected: false, frames: 0 };
  state.bridge = { mode: 'none', connected: false, clients: 0, filterId: -1 };
  state.recording = null;
  state.battery = { v: 12.6, totalA: 0 };
}
