// Turns UI actions (docs/interfaces.md §8) into bank / bus messages, renders the per-machine bank scene,
// decodes keypad LED frames, and runs the 100 ms engine / battery / CAN-generator / keypad ticks.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './state.js';
import { getComponents, getDbc, getEngine, getBattery, getSceneLib } from './compat.js';
import { SIM_ENGINE_FALLBACK_DBC } from './fallbacks.js';
import { stepWiper } from '../lib/wiper.js';

export const COLORS = ['off', 'red', 'green', 'orange', 'blue', 'violet', 'cyan', 'white'];
const BLINK_KEYS = 12; // PKP-2600SI: stacked LED layout

// ---------------------------------------------------------------- scene helpers ----------

/** Edges linking node `id` (via `handle`, optional) to a module handle starting with `prefix`. */
export function moduleLinks(scene, id, prefix, handle) {
  const mods = new Set((scene?.modules || []).map((m) => m.id));
  const out = [];
  for (const e of scene?.edges || []) {
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      if (a?.node !== id || (handle && a.handle !== handle)) continue;
      if (!mods.has(b?.node) || !String(b.handle || '').startsWith(prefix)) continue;
      out.push({ module: b.node, n: Number(String(b.handle).split(':')[1]), edge: e });
    }
  }
  return out;
}

/** Ground-switching inputs see the inverse level of the contact (pin pulled low when closed). */
export function switchPinValue(level, closed) {
  return level === 'gnd' ? (closed ? 0 : 1) : closed ? 1 : 0;
}

/**
 * PWM source → % of the period the pin is HIGH. A 12 V source drives the pin high while active; a ground
 * source (open collector, the input's pull-up) pulls it low while active. Off = the inactive level.
 */
export function pwmPinDuty(level, duty, on) {
  const d = on ? Math.max(0, Math.min(100, Number(duty) || 0)) : 0;
  return level === 'gnd' ? 100 - d : d;
}

/** Rotary position → mV with ± uniform noise. */
export function rotaryMv(data, index, rnd = Math.random) {
  const pos = data?.positions?.[index];
  if (!pos) return null;
  const noise = Number(data.noiseMv) || 0;
  return Math.max(0, Math.round(pos.mV + (rnd() * 2 - 1) * noise));
}

/** Button state frame (Blink Marine and Grayhill share the layout: bit i of byte i/8, id nodeId+0x180). */
export function keypadButtonFrame(data) {
  const bytes = new Array(8).fill(0);
  (data.pressed || []).forEach((p, i) => { if (p && i < 64) bytes[i >> 3] |= 1 << (i & 7); });
  return { id: (data.nodeId & 0x7f) + 0x180, dlc: 8, data: bytes };
}

function bitsOf(data) {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(data[i] ?? 0) << BigInt(i * 8);
  return (pos) => Number((v >> BigInt(pos)) & 1n);
}

/** Decode a Blink Marine LED frame (`+0x200` on colours / `+0x300` blink colours) → colour index per key. */
export function decodeBlinkLeds(data, keys) {
  const bit = bitsOf(data);
  const out = [];
  if (keys === BLINK_KEYS) {
    for (let i = 0; i < keys; i++) out.push(bit(i) | (bit(keys + i) << 1) | (bit(2 * keys + i) << 2));
  } else {
    const bpc = Math.ceil(keys / 8);
    for (let i = 0; i < keys; i++) {
      const p = (i >> 3) * 8 + (i & 7);
      out.push(bit(p) | (bit(bpc * 8 + p) << 1) | (bit(2 * bpc * 8 + p) << 2));
    }
  }
  return out;
}

/** Decode a Grayhill indicator frame (`+0x200`, 3 bits per button, stacked) → 3-bit value per key. */
export function decodeGrayhillLeds(data, keys) {
  const bit = bitsOf(data);
  const out = [];
  for (let i = 0; i < keys && i * 3 + 2 < 64; i++) out.push(bit(i * 3) | (bit(i * 3 + 1) << 1) | (bit(i * 3 + 2) << 2));
  return out;
}

/**
 * Build the bank `scene` message of every module (docs/interfaces.md §5): loads hung on each output.
 * @returns {Array<{machine:string, vbattV:number, noisePct:number, outputs:Record<string,{loads:any[]}>}>}
 */
export function buildBankScenes(scene, comps, vbattV = 13.8, toBankScenes = null) {
  if (toBankScenes && scene?.modules) {
    try {
      // lib/scene.js: paired/follower split + per-family render options (docs/interfaces.md §4)
      return toBankScenes({ nodes: [], edges: [], ...scene }, (d, ro, node) => comps.renderLoad(node, ro), { vbattV, familyOf: (id) => comps.familyOf?.(id) })
        .map(({ type, ...m }) => m);
    } catch (e) { console.warn(`[stimulus] toBankScenes failed (${e.message}); using built-in`); }
  }
  const res = [];
  for (const m of scene?.modules || []) {
    const outputs = {};
    for (const node of scene.nodes || []) {
      if (node.type !== 'load' && node.type !== 'wiper') continue;
      for (const l of moduleLinks(scene, node.id, 'out:', 'supply')) {
        if (l.module !== m.id) continue;
        (outputs[l.n] ||= { loads: [] }).loads.push(comps.renderLoad(node));
      }
    }
    res.push({ machine: m.id, vbattV, noisePct: scene.globals?.noisePct ?? 1, outputs });
  }
  return res;
}

// ---------------------------------------------------------------- controller -------------

/**
 * @param {{bank:any, bus:any, getScene:()=>any, getTraces:()=>Record<string,any[]>,
 *          broadcast:(m:any)=>void, onSceneMutated?:()=>void, getTelemetry?:(id:string)=>any,
 *          tickMs?:number, rnd?:()=>number}} ctx
 */
export async function createStimulus(ctx) {
  const comps = await getComponents();
  const dbc = await getDbc();
  const mkEngine = await getEngine();
  const batteryV = await getBattery();
  const { toBankScenes } = await getSceneLib();
  const tickMs = ctx.tickMs ?? 100;
  const rnd = ctx.rnd || Math.random;
  const engines = new Map();
  const genClock = new Map();
  const dbcCache = new Map();
  const ledState = new Map();
  let timer = null;
  let lastV = 12.6;
  let lastTotalA = 0;
  const wipers = new Map();   // node id → { angleDeg, t, sent }

  const scene = () => ctx.getScene() || { modules: [], nodes: [], edges: [] };
  const node = (id) => scene().nodes?.find((n) => n.id === id);
  const mutated = () => ctx.onSceneMutated?.();

  function loadDbc(rel) {
    if (dbcCache.has(rel)) return dbcCache.get(rel);
    const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (!text && /SimEngine\.dbc$/.test(rel)) text = SIM_ENGINE_FALLBACK_DBC;
    let db = null;
    try { db = text ? dbc.parseDbc(text) : null; } catch { db = null; }
    dbcCache.set(rel, db);
    return db;
  }
  const messagesOf = (db) => (db?.messages instanceof Map ? [...db.messages.values()] : Array.isArray(db?.messages) ? db.messages : Object.values(db?.messages || {}));

  function engineFor(n) {
    let e = engines.get(n.id);
    if (!e) { e = mkEngine(n.data || {}); engines.set(n.id, e); }
    return e;
  }
  const engineState = () => {
    const n = scene().nodes?.find((x) => x.type === 'engine');
    return n ? (engines.get(n.id)?.get?.().state ?? n.data?.state ?? 'off') : 'off';
  };

  /** Send every module's bank scene (on scene change and on bank connect). */
  function pushBankScenes() {
    for (const msg of buildBankScenes(scene(), comps, lastV, toBankScenes)) ctx.bank.sendScene(msg);
  }

  /** Re-assert all stimulus levels (after a bank reconnect / Renode restart). */
  function pushLevels() {
    for (const n of scene().nodes || []) {
      if (n.type === 'switch') apply({ kind: 'switch', node: n.id, state: !!n.data?.state }, { silent: true });
      if (n.type === 'rotary') apply({ kind: 'rotary', node: n.id, index: n.data?.index ?? 0 }, { silent: true });
      if (n.type === 'pwmsrc') apply({ kind: 'pwm', node: n.id }, { silent: true });
    }
  }

  /**
   * Apply one action. Returns `{ok, sent:[...], error?}`; never throws for unknown nodes.
   * @param {any} a action @param {{silent?:boolean}} [o]
   */
  function apply(a, o = {}) {
    const sent = [];
    const n = a.node ? node(a.node) : null;
    if (a.node && !n && a.kind !== 'temp') return { ok: false, error: `unknown node ${a.node}` };
    switch (a.kind) {
      case 'switch': {
        n.data = { ...n.data, state: !!a.state };
        for (const l of moduleLinks(scene(), n.id, 'di:')) {
          const value = switchPinValue(n.data.level || '12v', !!a.state);
          ctx.bank.gpio(l.module, `DI${l.n}`, value);
          sent.push({ gpio: l.module, pin: `DI${l.n}`, value });
        }
        // a switch on an analog input pulls it to the supply (5 V sensor rail) or leaves it at 0 V
        for (const l of moduleLinks(scene(), n.id, 'ai:')) {
          const mV = a.state ? 5000 : 0;
          ctx.bank.adc(l.module, l.n, mV);
          sent.push({ adc: l.module, ch: l.n, mV });
        }
        break;
      }
      case 'pwm': {
        const d = { duty: 50, freq: 100, on: true, level: '12v', ...n.data };
        for (const k of ['duty', 'freq', 'on', 'level']) if (a[k] !== undefined) d[k] = a[k];
        d.duty = Math.max(0, Math.min(100, Number(d.duty) || 0));
        d.freq = Math.max(0, Math.min(10000, Number(d.freq) || 0));
        n.data = d;
        for (const l of moduleLinks(scene(), n.id, 'di:')) {
          const pin = `DI${l.n}`, duty = pwmPinDuty(d.level, d.duty, d.on);
          ctx.bank.pwm(l.module, pin, duty, d.freq);
          sent.push({ pwm: l.module, pin, duty, freq: d.freq });
        }
        break;
      }
      case 'rotary': {
        n.data = { ...n.data, index: a.index };
        const mV = rotaryMv(n.data, a.index, rnd);
        if (mV === null) return { ok: false, error: `rotary ${n.id} has no position ${a.index}` };
        for (const l of moduleLinks(scene(), n.id, 'ai:')) { ctx.bank.adc(l.module, l.n, mV); sent.push({ adc: l.module, ch: l.n, mV }); }
        break;
      }
      case 'keypad': {
        const keys = n.data?.keys || 8;
        const pressed = Array.from({ length: keys }, (_, i) => !!n.data?.pressed?.[i]);
        if (a.key >= 0 && a.key < keys) pressed[a.key] = !!a.pressed;
        n.data = { ...n.data, pressed };
        const f = keypadButtonFrame(n.data);
        ctx.bus.inject(f, 'keypad');
        sent.push({ frame: f });
        break;
      }
      case 'fault': {
        n.data = { ...n.data, fault: a.fault ?? null };
        for (const l of moduleLinks(scene(), n.id, 'out:', 'supply')) {
          ctx.bank.fault(l.module, l.n, n.id, a.fault?.kind ?? 'clear', a.fault?.atMs ?? 0);
          sent.push({ fault: l.module, out: l.n, kind: a.fault?.kind ?? 'clear' });
        }
        break;
      }
      case 'battery': {
        const { kind, node: _n, ...rest } = a;
        n.data = { ...n.data, ...rest };
        break; // the 100 ms battery tick broadcasts the new voltage
      }
      case 'engine': {
        const { kind, node: _n, ...rest } = a;
        n.data = { ...n.data, ...rest };
        engineFor(n).set(rest);
        break;
      }
      case 'temp': {
        ctx.bank.temp(a.module, Number(a.c));
        sent.push({ temp: a.module, c: Number(a.c) });
        break;
      }
      default:
        return { ok: false, error: `unknown action kind ${a.kind}` };
    }
    if (!o.silent && a.kind !== 'temp') mutated();
    return { ok: true, sent };
  }

  /** Inspect a hub frame for keypad LED commands; broadcasts `keypad` messages. */
  function onFrame(frame) {
    for (const n of scene().nodes || []) {
      if (n.type !== 'keypad') continue;
      const d = n.data || {};
      const rel = frame.id - (d.nodeId & 0x7f);
      const keys = d.keys || 8;
      let st = ledState.get(n.id);
      if (!st) { st = { on: [], blink: [] }; ledState.set(n.id, st); }
      if (d.model === 'grayhill') {
        if (rel !== 0x200) continue;
        st.on = decodeGrayhillLeds(frame.data, keys);
      } else {
        if (rel === 0x200) st.on = decodeBlinkLeds(frame.data, keys);
        else if (rel === 0x300) st.blink = decodeBlinkLeds(frame.data, keys);
        else continue;
      }
      const leds = Array.from({ length: keys }, (_, k) => {
        const on = st.on[k] ?? 0, bl = st.blink[k] ?? 0;
        return { key: k, color: COLORS[on] ?? 'off', blink: bl !== 0, blinkColor: bl ? COLORS[bl] : null, bits: on };
      });
      const sig = JSON.stringify(leds);
      if (sig !== st.sig) {
        st.sig = sig;
        ctx.broadcast({ type: 'keypad', node: n.id, leds });
      }
    }
  }

  function totalCurrent() {
    let sum = 0;
    for (const ring of Object.values(ctx.getTraces() || {})) {
      const last = ring[ring.length - 1];
      if (last?.i) sum += last.i.reduce((a, b) => a + (Number(b) || 0), 0);
    }
    return sum;
  }

  /** One 100 ms tick: engine frames, CAN generators, keypad heartbeat, battery voltage. */
  function tick() {
    const sc = scene();
    for (const n of sc.nodes || []) {
      if (n.type === 'engine') {
        const e = engineFor(n);
        // a linked fan load that is On pulls the coolant down
        const fan = (sc.edges || []).find((x) => x.to?.node === n.id && x.to?.handle === 'fan');
        if (fan) {
          const sup = moduleLinks(sc, fan.from.node, 'out:', 'supply')[0];
          const tel = sup && ctx.getTelemetry?.(sup.module);
          e.set({ fanOn: tel?.outputs?.[sup.n - 1]?.state === 'On' });
        }
        const sig = e.step(tickMs);
        const db = loadDbc(n.data?.dbc || 'renode/SimEngine.dbc');
        for (const msg of messagesOf(db)) {
          const data = dbc.encodeMessage(db, msg.name, sig);
          if (data) ctx.bus.inject({ id: msg.id, dlc: data.length, data: Array.from(data) }, 'engine');
        }
      } else if (n.type === 'cangen') {
        const db = n.data?.dbc ? loadDbc(n.data.dbc) : null;
        (n.data?.frames || []).forEach((f, i) => {
          const key = `${n.id}:${i}`;
          const acc = (genClock.get(key) || 0) + tickMs;
          if (acc < (f.cycleMs || 100)) { genClock.set(key, acc); return; }
          genClock.set(key, 0);
          let data = f.data;
          if (!data && db) { const enc = dbc.encodeMessage(db, f.id, f.signals || {}); data = enc && Array.from(enc); }
          if (data) ctx.bus.inject({ id: f.id, ext: f.id > 0x7ff, dlc: data.length, data }, 'cangen');
        });
      } else if (n.type === 'wiper') {
        stepWiperNode(sc, n);
      } else if (n.type === 'keypad' && (n.data?.pressed || []).some(Boolean)) {
        ctx.bus.inject(keypadButtonFrame(n.data), 'keypad'); // keep held buttons alive past the firmware timeout
      }
    }
    const bat = sc.nodes?.find((x) => x.type === 'battery');
    if (bat) {
      lastTotalA = totalCurrent();
      let v;
      try { v = batteryV(bat.data || {}, lastTotalA, { engineState: engineState() }); } catch { v = bat.data?.vocV ?? 12.6; }
      if (typeof v === 'object') v = v?.v ?? v?.vbattV;
      if (Number.isFinite(v)) {
        const changed = Math.abs(v - lastV) > 0.005;
        lastV = v;
        ctx.bank.vbatt('*', v);
        if (changed) ctx.broadcast({ type: 'battery', node: bat.id, v: Math.round(v * 100) / 100, totalA: Math.round(lastTotalA * 10) / 10 });
      }
    }
  }

  // Wiper mechanics: power from its PDM output, RUN / SPEED from the CANBoard relay outputs wired to it,
  // in vehicle time (the supplying module's telemetry clock, so a paused emulation stops the blade).
  function stepWiperNode(sc, n) {
    const sup = moduleLinks(sc, n.id, 'out:', 'supply')[0];
    const tel = sup && ctx.getTelemetry?.(sup.module);
    const relay = (handle) => {
      const e = (sc.edges || []).find((x) => x.to?.node === n.id && x.to?.handle === handle && /^do:/.test(x.from?.handle || ''));
      const k = e ? Number(e.from.handle.split(':')[1]) : 0;
      return !!(k && ctx.getTelemetry?.(e.from.node)?.digitalOut?.[k - 1]);
    };
    const st = wipers.get(n.id) || { angleDeg: 0, t: tel?.t ?? 0, sent: '' };
    const t = tel?.t ?? st.t;
    const powered = ['On', 'Warning'].includes(tel?.outputs?.[sup.n - 1]?.state);
    const run = relay('run'), speed = relay('speed');
    const r = stepWiper(st.angleDeg, { powered, run, speed, dtS: Math.max(0, Math.min(1, t - st.t)), slowRps: n.data?.slowRps, fastRps: n.data?.fastRps });
    st.angleDeg = r.angleDeg; st.t = t;
    wipers.set(n.id, st);
    // the park switch, when wired to a digital input, closes to ground in the park window
    for (const l of moduleLinks(sc, n.id, 'di:', 'park')) ctx.bank.gpio(l.module, `DI${l.n}`, switchPinValue('gnd', r.park));
    const msg = { type: 'wiper', node: n.id, angleDeg: Math.round(r.angleDeg), run, speed, park: r.park, powered };
    const key = JSON.stringify(msg);
    if (key !== st.sent) { st.sent = key; ctx.broadcast(msg); }
  }

  return {
    apply, onFrame, tick, pushBankScenes, pushLevels,
    start() { if (!timer) { timer = setInterval(tick, tickMs); timer.unref?.(); } },
    stop() { clearInterval(timer); timer = null; },
    get battery() { return { v: lastV, totalA: lastTotalA }; },
    resetEngines() { engines.clear(); },
  };
}
