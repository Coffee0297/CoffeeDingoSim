// TCP client of the SlcanTcpBridge (docs/interfaces.md §6): reassembles SLCAN lines, decodes the cyclic
// frames of every scene module into `telemetry` messages (docs/interfaces.md §8), injects frames and
// re-emits the raw line stream for bridge.js. Emits: 'connect', 'disconnect', 'line' (hub → us,
// raw line without CR), 'frame' ({...frame, dir}), 'telemetry', 'cmd' (bridge replies).
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { getSlcan, getDbc } from './compat.js';

/** Object.assign that keeps getters live (copies property descriptors). */
const mixin = (target, src) => Object.defineProperties(target, Object.getOwnPropertyDescriptors(src));

const OUTPUTS = { pdm: 8, pdmmax: 4, canboard: 0 };
const STATE_NAMES = ['Off', 'On', 'Overcurrent', 'Fault', 'Warning', 'OpenLoad'];
/** Frame ids a module owns from its base: 2 config ids + its cyclic messages. */
export const idSpan = (kind) => 2 + (kind === 'canboard' ? 10 : 28);

/**
 * @param {{host?:string, port?:number, slcan?:any, dbc?:any, getTime?:()=>number,
 *          sleepAfterMs?:number, flushIntervalMs?:number, minBackoffMs?:number, maxBackoffMs?:number}} [opts]
 */
export async function createBus(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port || 7777;
  const slcan = await getSlcan(opts.slcan);
  const dbc = await getDbc(opts.dbc);
  const getTime = opts.getTime || (() => 0);
  const sleepAfterMs = opts.sleepAfterMs ?? 2000;
  const flushIntervalMs = opts.flushIntervalMs ?? 100;
  const minBackoff = opts.minBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 5000;

  const em = new EventEmitter();
  let sock = null;
  let splitter = slcan.splitter();
  let backoff = minBackoff;
  let timer = null;
  let stopped = true;
  let connected = false;
  let frames = 0;

  /** @type {Map<number, {module:any, decode:Function, tel:any, dirty:boolean, sleepTimer:any, flushTimer:any}>} baseId → entry */
  const byBase = new Map();
  const byModule = new Map();

  function freshTelemetry(module) {
    const n = OUTPUTS[module.kind] ?? 8;
    return {
      module: module.id, t: 0,
      outputs: Array.from({ length: n }, (_, i) => ({ n: i + 1, state: 'Off', currentA: 0, duty: 0, ocCount: 0 })),
      inputs: [], positions: [], digitalOut: [], mV: [], asleep: false, silent: false, vbattV: null, tempC: null, extra: {},
    };
  }

  /** Set the modules to decode (from the scene). Keeps telemetry of modules that stay. */
  function setModules(modules = []) {
    const keep = new Set();
    for (const m of modules) {
      if (!m?.id || typeof m.baseId !== 'number') continue;
      keep.add(m.id);
      let e = byModule.get(m.id);
      if (!e || e.module.baseId !== m.baseId || e.module.kind !== m.kind) {
        if (e) { byBase.delete(e.module.baseId); clearTimeout(e.sleepTimer); clearTimeout(e.flushTimer); }
        e = { module: m, decode: dbc.telemetryDecoder(m.kind, m.baseId), tel: freshTelemetry(m), dirty: false, sleepTimer: null, flushTimer: null };
        byModule.set(m.id, e);
      }
      e.module = m;
      byBase.set(m.baseId, e);
    }
    for (const [id, e] of byModule) {
      if (!keep.has(id)) { byBase.delete(e.module.baseId); byModule.delete(id); clearTimeout(e.sleepTimer); clearTimeout(e.flushTimer); }
    }
  }

  function flush(e) {
    e.flushTimer = null;
    if (!e.dirty) return;
    e.dirty = false;
    e.tel.t = getTime();
    em.emit('telemetry', { ...e.tel, outputs: e.tel.outputs.map((o) => ({ ...o })) });
  }
  function markDirty(e) {
    e.dirty = true;
    if (flushIntervalMs <= 0) return flush(e);
    if (!e.flushTimer) e.flushTimer = setTimeout(() => flush(e), flushIntervalMs);
  }
  /**
   * "silent" = no frame from the module for sleepAfterMs of VIRTUAL time when the time source runs
   * (not "asleep": only the firmware says that, DeviceState = Sleep / the bank's deep-sleep event; a
   * module that stopped talking may still be driving its outputs)
   * (getTime() > 0): Renode runs slower than real time, and a paused / RunFor-stepped emulation has
   * host-time gaps that are not silences. Without a time source it falls back to host time.
   */
  function armSleep(e) {
    clearTimeout(e.sleepTimer);
    if (sleepAfterMs <= 0) return;
    e.lastVt = getTime();
    const check = () => {
      const vt = getTime();
      if (vt > 0 && (vt - e.lastVt) * 1000 < sleepAfterMs) {
        e.sleepTimer = setTimeout(check, Math.max(100, sleepAfterMs - (vt - e.lastVt) * 1000));
        e.sleepTimer.unref?.();
        return;
      }
      if (!e.tel.silent) { e.tel.silent = true; markDirty(e); }
    };
    e.sleepTimer = setTimeout(check, sleepAfterMs);
    e.sleepTimer.unref?.();
  }

  /**
   * Route a decoded frame to its module: ids in [base, base + 2 + cyclic messages) (PDM 28, CANBoard
   * 10, docs/interfaces.md §2). Project base ids are often 0x20 apart, so a wider window would steal the next
   * module's frames.
   */
  function handleFrame(frame) {
    if (frame.ext) return null;
    for (const [base, e] of byBase) {
      if (frame.id < base || frame.id >= base + idSpan(e.module.kind)) continue;
      if (e.tel.asleep || e.tel.silent) { e.tel.asleep = false; e.tel.silent = false; e.tel.silentWhy = undefined; e.dirty = true; }
      armSleep(e);
      if (frame.id < base + 2) { markDirty(e); return e.module; } // config traffic: alive, nothing to decode
      const r = e.decode(frame, base);
      if (r) {
        if (r.signals) applySignals(e.tel, e.module.kind, r.msgIndex, r.signals);
        if (r.telemetry) mergeTelemetry(e.tel, r.telemetry);
        markDirty(e);
      }
      return e.module;
    }
    return null;
  }

  function onLine(line) {
    em.emit('line', line);
    const d = slcan.decode(line);
    if (!d) return;
    if (d.cmd !== undefined) { em.emit('cmd', d, line); return; }
    frames++;
    const module = handleFrame(d);
    em.emit('frame', { id: d.id, ext: !!d.ext, dlc: d.dlc, data: Array.from(d.data), dir: 'rx', module: module?.id ?? null });
  }

  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; connect(); }, backoff);
    backoff = Math.min(maxBackoff, backoff * 2);
  }
  function connect() {
    if (stopped || sock) return;
    const s = net.createConnection({ host, port });
    sock = s;
    s.setNoDelay(true);
    s.on('connect', () => {
      connected = true; backoff = minBackoff; splitter = slcan.splitter();
      em.emit('connect');
      s.write('O\r');
    });
    s.on('data', (d) => { for (const l of splitter.push(d)) onLine(l); });
    const drop = (err) => {
      if (sock !== s) return;
      sock = null;
      const was = connected; connected = false;
      if (was) em.emit('disconnect', err?.message);
      schedule();
    };
    s.on('error', drop);
    s.on('close', () => drop());
  }

  function writeLine(line) {
    if (!sock || !connected) return false;
    try { sock.write(line.replace(/[\r\n]+$/, '') + '\r'); return true; } catch { return false; }
  }

  return mixin(em, {
    get connected() { return connected; },
    get frames() { return frames; },
    port,
    setModules,
    start() { stopped = false; if (!sock) connect(); return this; },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      for (const e of byModule.values()) { clearTimeout(e.sleepTimer); clearTimeout(e.flushTimer); }
      if (sock) { try { sock.destroy(); } catch { /* ignore */ } sock = null; }
      connected = false;
    },
    /** Inject a frame `{id, ext?, dlc?, data}` onto the hub (keypad, cangen, engine, dingoConfig). */
    inject(frame, source = 'sim') {
      const line = slcan.encode(frame);
      const ok = writeLine(line);
      em.emit('frame', { id: frame.id, ext: !!frame.ext, dlc: frame.dlc ?? frame.data.length, data: Array.from(frame.data), dir: 'tx', source });
      return ok;
    },
    /** Forward a raw SLCAN line from dingoConfig to the hub (bridge.js). */
    writeLine,
    /** Feed a raw hub line (tests, or a non-TCP transport). */
    feedLine: onLine,
    /** Feed raw bytes as if they came from the hub socket (tests). */
    feedChunk(chunk) { for (const l of splitter.push(chunk)) onLine(l); },
    telemetryOf(moduleId) { return byModule.get(moduleId)?.tel ?? null; },
    modules: () => [...byModule.values()].map((e) => e.module),
  });
}

// ---------------------------------------------------------------- signal → telemetry -----

/** Map DBC signal names (firmware DBCs) onto the telemetry object. Works for pdm/pdmmax/canboard. */
export function applySignals(tel, kind, msgIndex, signals) {
  for (const [name, v] of Object.entries(signals)) {
    let m;
    if ((m = /^OutputCurrent_(\d+)$/.exec(name))) out(tel, +m[1]).currentA = round1(v);
    else if ((m = /^OutputState_(\d+)$/.exec(name))) out(tel, +m[1]).state = STATE_NAMES[v] ?? String(v);
    else if ((m = /^OutputResetCount_(\d+)$/.exec(name))) out(tel, +m[1]).ocCount = v;
    else if ((m = /^OutputDC_(\d+)$/.exec(name))) out(tel, +m[1]).duty = v;
    else if ((m = /^DigitalInput_(\d+)$/.exec(name))) tel.inputs[+m[1] - 1] = !!v;
    else if ((m = /^DigitalOutput_(\d+)$/.exec(name))) tel.digitalOut[+m[1] - 1] = !!v;
    else if ((m = /^DigitalOutputDC_(\d+)$/.exec(name))) (tel.extra.doDuty ||= [])[+m[1] - 1] = v;
    else if ((m = /^RotarySwitch_(\d+)$/.exec(name))) tel.positions[+m[1] - 1] = v;
    else if ((m = /^ADCVolt_?(\d+)$/.exec(name))) tel.mV[+m[1] - 1] = Math.round(v * 1000);
    else if (name === 'BatteryVoltage') tel.vbattV = round1(v);
    else if (name === 'BoardTemperature' || name === 'BoardTemp') tel.tempC = round1(v);
    else if (name === 'DeviceState') { tel.extra.deviceState = v; if (v === 1) tel.asleep = true; }
    else if (name === 'TotalCurrent') tel.extra.totalA = round1(v);
    else tel.extra[name] = v;
  }
  return tel;
}

function mergeTelemetry(tel, partial) {
  for (const [k, v] of Object.entries(partial)) {
    if (v === undefined || k === 'module' || k === 't' || k === 'msgIndex' || k === 'name' || k === 'signals' || k === 'telemetry') continue;
    if (k === 'outputs' && Array.isArray(v)) {
      for (const o of v) if (o?.n) Object.assign(out(tel, o.n), o);
    } else tel[k] = v;
  }
}

function out(tel, n) {
  while (tel.outputs.length < n) tel.outputs.push({ n: tel.outputs.length + 1, state: 'Off', currentA: 0, duty: 0, ocCount: 0 });
  return tel.outputs[n - 1];
}
const round1 = (v) => Math.round(v * 10) / 10;
