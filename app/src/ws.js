// ws.js — the client store. One WebSocket to `/ws` (docs/interfaces.md §8), Svelte stores for the
// slow-changing state (scene, telemetry, Renode, runs, toasts) and plain ring buffers for the
// 10 Hz traces (chart.js `pushTrace`), with a `traceTick` counter so canvases can redraw.
//
// `?mock=1` in the URL swaps the socket for ./mock.js so the whole UI works without a server.
//
// Contract extensions this client understands beyond §8 (all optional, server may omit):
//   { type:'engine', node, rpm, cltC, oilBar, speedKph, gear }        — engine readouts
//   { type:'wiper',  node, angleDeg, run, speed, park }               — wiper node readouts
//   { type:'runs',   runs:[...] }                                     — runs list push (else GET /api/runs)
//   { type:'diff',   run, golden, summary:{pass,fail}, rows:[{module,output,metric,expected,actual,ok}] }
//   renode.log is treated as *incremental* lines to append (capped at 500 in the UI).

import { writable, get } from 'svelte/store';
import { pushTrace } from './chart.js';

export const HORIZON_S = 30;
export const isMock = typeof location !== 'undefined' && new URLSearchParams(location.search).has('mock');

export const connection = writable(isMock ? 'mock' : 'connecting'); // connecting|open|closed|mock
export const scene = writable(null);
export const components = writable([]);
export const modules = writable({});          // moduleId → latest telemetry message
export const renode = writable({ status: 'stopped', vtime: 0, log: [] });
export const keypadLeds = writable({});       // keypad node id → [{key,color,blink}]
export const toasts = writable([]);           // [{id, level, text}]
export const bus = writable([]);              // last 200 frames
export const runs = writable([]);
export const diff = writable(null);
export const engineLive = writable({});       // node id → engine readouts
export const wiperLive = writable({});        // node id → wiper readouts
export const traceTick = writable(0);         // bumps on every trace / telemetry sample

/** machine → ring buffers. `__battery` aggregates V and ΣA across machines. */
export const traces = Object.create(null);

export function traceFor(machine, outputs = 8) {
  let tr = traces[machine];
  if (!tr) {
    tr = traces[machine] = {
      model: Array.from({ length: outputs }, () => []),   // [[t, A]] from bank trace `i`
      on: Array.from({ length: outputs }, () => []),      // [[t, 0|1]]
      meas: Array.from({ length: outputs }, () => []),    // [[t, A]] from telemetry currentA
      state: Array.from({ length: outputs }, () => []),   // [[t, 'On']]
      vbatt: [], temp: [],
      do: [], di: [], mV: [],                             // CANBoard: arrays of [[t, v]] per channel
      lastT: 0, lastSum: 0,
    };
  }
  return tr;
}

function ensureChannels(arr, n) {
  while (arr.length < n) arr.push([]);
}

const batteryAgg = () => (traces.__battery ||= { v: [], a: [] });

let tickPending = false;
function bumpTick() {
  if (tickPending) return;
  tickPending = true;
  (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16))(() => {
    tickPending = false;
    traceTick.update((n) => n + 1);
  });
}

let toastSeq = 0;
export function toast(level, text, ttlMs = 5000) {
  const id = ++toastSeq;
  toasts.update((list) => [...list, { id, level, text }].slice(-6));
  setTimeout(() => dismissToast(id), ttlMs);
}
export function dismissToast(id) {
  toasts.update((list) => list.filter((t) => t.id !== id));
}

/** Server → UI dispatcher (also used by the mock). */
export function handle(msg) {
  switch (msg.type) {
    case 'snapshot':
      if (msg.scene) scene.set(msg.scene);
      if (Array.isArray(msg.components)) components.set(msg.components);
      if (Array.isArray(msg.runs)) runs.set(msg.runs);
      if (msg.modules && typeof msg.modules === 'object') modules.set(msg.modules);
      if (msg.renode) renode.update((r) => ({ ...r, ...msg.renode, log: [...r.log, ...(msg.renode.log || [])].slice(-500) }));
      break;
    case 'scene':
      scene.set(msg.scene);
      break;
    case 'telemetry': {
      modules.update((m) => ({ ...m, [msg.module]: msg }));
      const tr = traceFor(msg.module, Math.max(8, msg.outputs?.length || 0));
      const t = msg.t ?? tr.lastT;
      for (const o of msg.outputs || []) {
        const k = o.n - 1;
        if (k < 0) continue;
        ensureChannels(tr.meas, k + 1); ensureChannels(tr.state, k + 1);
        if (o.currentA != null) pushTrace(tr.meas[k], t, o.currentA, HORIZON_S);
        if (o.state) pushTrace(tr.state[k], t, o.state, HORIZON_S);
      }
      bumpTick();
      break;
    }
    case 'trace': {
      const tr = traceFor(msg.machine, Math.max(8, msg.i?.length || 0));
      const t = msg.t;
      tr.lastT = t;
      if (Array.isArray(msg.i)) {
        ensureChannels(tr.model, msg.i.length);
        let sum = 0;
        msg.i.forEach((v, k) => { pushTrace(tr.model[k], t, v, HORIZON_S); sum += v; });
        tr.lastSum = sum;
      }
      if (Array.isArray(msg.on)) { ensureChannels(tr.on, msg.on.length); msg.on.forEach((v, k) => pushTrace(tr.on[k], t, v, HORIZON_S)); }
      if (Array.isArray(msg.do)) { ensureChannels(tr.do, msg.do.length); msg.do.forEach((v, k) => pushTrace(tr.do[k], t, v, HORIZON_S)); }
      if (Array.isArray(msg.di)) { ensureChannels(tr.di, msg.di.length); msg.di.forEach((v, k) => pushTrace(tr.di[k], t, v, HORIZON_S)); }
      if (Array.isArray(msg.mV)) { ensureChannels(tr.mV, msg.mV.length); msg.mV.forEach((v, k) => pushTrace(tr.mV[k], t, v, HORIZON_S)); }
      if (msg.vbattV != null) {
        pushTrace(tr.vbatt, t, msg.vbattV, HORIZON_S);
        const agg = batteryAgg();
        pushTrace(agg.v, t, msg.vbattV, HORIZON_S);
        let sum = 0;
        for (const k in traces) if (k !== '__battery') sum += traces[k].lastSum || 0;
        pushTrace(agg.a, t, +sum.toFixed(3), HORIZON_S);
      }
      if (msg.tempC != null) pushTrace(tr.temp, t, msg.tempC, HORIZON_S);
      bumpTick();
      break;
    }
    case 'bus':
      if (msg.frame) bus.update((list) => { const next = list.length >= 200 ? list.slice(list.length - 199) : list.slice(); next.push({ ...msg.frame, seq: ++busSeq, at: msg.t ?? null }); return next; });
      break;
    case 'renode':
      renode.update((r) => ({
        status: msg.status ?? r.status,
        vtime: msg.vtime ?? r.vtime,
        log: Array.isArray(msg.log) && msg.log.length ? [...r.log, ...msg.log].slice(-500) : r.log,
      }));
      break;
    case 'keypad':
      keypadLeds.update((m) => ({ ...m, [msg.node]: msg.leds || [] }));
      break;
    case 'toast':
      toast(msg.level || 'info', msg.text || '');
      break;
    case 'runs':
      if (Array.isArray(msg.runs)) runs.set(msg.runs);
      break;
    case 'diff':
      diff.set(msg);
      break;
    case 'engine': {
      const { type, node, ...rest } = msg;
      engineLive.update((m) => ({ ...m, [node]: rest }));
      const eng = (traces.__engine ||= {});
      const e = (eng[node] ||= { rpm: [], clt: [], oil: [], speed: [] });
      const t = get(renode).vtime;
      if (rest.rpm != null) pushTrace(e.rpm, t, rest.rpm, HORIZON_S);
      if (rest.cltC != null) pushTrace(e.clt, t, rest.cltC, HORIZON_S);
      if (rest.oilBar != null) pushTrace(e.oil, t, rest.oilBar, HORIZON_S);
      if (rest.speedKph != null) pushTrace(e.speed, t, rest.speedKph, HORIZON_S);
      break;
    }
    case 'wiper': {
      const { type, node, ...rest } = msg;
      wiperLive.update((m) => ({ ...m, [node]: rest }));
      break;
    }
    default:
      break;
  }
}
let busSeq = 0;

// ---------------------------------------------------------------------------------------------
// transport
let socket = null;
let mock = null;
let retryMs = 1000;
let outbox = [];

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

function connect() {
  if (isMock) return;
  connection.set('connecting');
  try {
    socket = new WebSocket(wsUrl());
  } catch (e) {
    connection.set('closed');
    setTimeout(connect, retryMs);
    return;
  }
  socket.onopen = () => {
    connection.set('open');
    retryMs = 1000;
    for (const m of outbox) socket.send(m);
    outbox = [];
    // If the server does not push a snapshot on connect, pull one.
    setTimeout(() => { if (!get(scene)) api('/api/snapshot').then((s) => s && handle({ type: 'snapshot', ...s })).catch(() => {}); }, 1500);
  };
  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };
  socket.onclose = () => {
    connection.set('closed');
    socket = null;
    setTimeout(connect, retryMs);
    retryMs = Math.min(10000, retryMs * 1.6);
  };
  socket.onerror = () => { try { socket?.close(); } catch {} };
}

/** Send any UI → server message (docs/interfaces.md §8). Queued while reconnecting. */
export function send(msg) {
  if (isMock) { mock?.send(msg); return; }
  const text = JSON.stringify(msg);
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(text);
  else if (outbox.length < 50) outbox.push(text);
}

/** Interactive controls: switch, rotary, keypad, fault, battery, engine, temp, renode. Immediate. */
export function action(a) {
  send({ type: 'action', action: a });
}

let sceneTimer = null;
let pendingScene = null;
/** Full scene replace, debounced 300 ms; the local store reflects it immediately. */
export function sendScene(s) {
  scene.set(s);
  pendingScene = s;
  clearTimeout(sceneTimer);
  sceneTimer = setTimeout(() => {
    send({ type: 'scene', scene: pendingScene });
    pendingScene = null;
  }, 300);
}

/** Fetch JSON from the REST surface (§8). `body` objects are serialised. In mock mode → mock routes. */
export async function api(path, opts = {}) {
  if (isMock) return mock.api(path, opts);
  const init = { method: opts.method || 'GET', headers: { Accept: 'application/json' } };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${init.method} ${path} → ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

if (typeof window !== 'undefined') {
  if (isMock) {
    import('./mock.js').then(({ createMock }) => {
      mock = createMock(handle);
      mock.start();
    });
  } else {
    connect();
  }
}
