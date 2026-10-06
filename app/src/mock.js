// mock.js — a server stand-in for `?mock=1`. Builds a small example vehicle scene (PDM-01,
// PDM-02, CB-1 and a handful of loads) and fakes the bank + firmware well enough that every
// panel has something to show: inrush curves when an output turns on, Msg3-style states
// (Overcurrent → Fault with reset mode None, OpenLoad on a burnt bulb), rotary ladders, keypad
// LEDs, a battery that sags, an engine that cranks, Renode status/log and a runs list.
// It speaks exactly the docs/interfaces.md §8 messages (plus the extensions listed in ws.js).

import { STATE_NAMES } from './chart.js';
import { BUILTIN_COMPONENTS, handleKind, handleIndex, keywordComponent, loadFromComponent, nextId, saturationA, NOMINAL_V } from './scene.js';

const out = (n, name, currentLimit, enabled = true, extra = {}) => ({
  n, name, enabled, currentLimit, inrushCurrentLimit: 50, inrushTime: 1000, resetMode: 0, resetTime: 1000,
  resetCountLimit: 3, pwmEnabled: false, fixedDutyCycle: 100, frequency: 100, primaryOutput: -1, ...extra,
});
const di = (n, name, enabled = false) => ({ n, name, enabled, mode: 0, pull: 0, invert: false });

export function buildScene() {
  return {
    version: 1,
    name: 'example-mock',
    project: { path: 'scenes/example/example-vehicle.json', hash: 'mock' },
    firmware: {
      pdm: { source: 'release', tag: 'v5.5.107' },
      pdmmax: { source: 'release', tag: 'testing-latest' },
      canboard: { source: 'local', path: '../CoffeeDingoFW/build' },
      bootloader: false,
    },
    modules: [
      {
        id: 'PDM-01', kind: 'pdm', baseId: 1664, pos: { x: 420, y: 40 },
        outputs: [
          out(1, 'Low Beam x2', 12), out(2, 'High Beam x2', 12), out(3, 'Front Position', 2),
          out(4, 'Left Indicator', 5), out(5, 'Side Marker', 2), out(6, 'Horn', 8),
          out(7, 'Coolant Fan', 8), out(8, 'Spare', 20, false),
        ],
        inputs: [di(1, 'Low beam switch', true), di(2, 'Horn button', true)],
        analogIn: [], digitalOut: [],
      },
      {
        id: 'PDM-02', kind: 'pdm', baseId: 1696, pos: { x: 420, y: 520 },
        outputs: [
          out(1, 'Fuel Pump', 12), out(2, 'Wiper Motor', 8), out(3, 'Rear Position + Plate', 3),
          out(4, 'Right Indicator', 5), out(5, 'Brake Light', 5), out(6, 'Reverse Light', 3),
          out(7, 'Rear Marker', 2), out(8, 'Spare', 20, false),
        ],
        inputs: [di(1, 'digitalInput1'), di(2, 'digitalInput2')],
        analogIn: [], digitalOut: [],
      },
      {
        id: 'CB-1', kind: 'canboard', baseId: 1632, pos: { x: 420, y: 1020 },
        outputs: [],
        inputs: [di(1, 'Wiper park', true), di(2, 'digitalInput2'), di(3, 'digitalInput3'), di(4, 'digitalInput4'),
          di(5, 'digitalInput5'), di(6, 'digitalInput6'), di(7, 'digitalInput7'), di(8, 'digitalInput8')],
        analogIn: [
          { n: 1, name: 'Headlights', enabled: true, rotary: { numPos: 4, points: [500, 1500, 2500, 3500], positionNames: ['OFF', 'Park', 'Low', 'High'], tolerance: 200 } },
          { n: 2, name: 'Wiper', enabled: true, rotary: { numPos: 4, points: [500, 1800, 3200, 4500], positionNames: ['OFF', 'INT', 'Low', 'High'], tolerance: 200 } },
          { n: 3, name: 'Indicators', enabled: true, rotary: { numPos: 4, points: [500, 1800, 3200, 4500], positionNames: ['OFF', 'Left', 'Right', 'Hazard'], tolerance: 200 } },
          { n: 4, name: 'Gear', enabled: true, rotary: { numPos: 6, points: [500, 1300, 2100, 2900, 3700, 4500], positionNames: ['P', 'R', 'N', 'D', '2', '1'], tolerance: 200 } },
          { n: 5, name: 'analogInput5', enabled: false, rotary: null },
        ],
        digitalOut: [
          { n: 1, name: 'Wiper RUN (R_MODE)', enabled: true }, { n: 2, name: 'Wiper SPEED (R_SPEED)', enabled: true },
          { n: 3, name: 'digitalOutput3', enabled: false }, { n: 4, name: 'digitalOutput4', enabled: false },
        ],
      },
    ],
    nodes: [
      { id: 'n1', type: 'load', pos: { x: 760, y: 40 }, data: { component: 'halogen_headlight', preset: 'H4 low 55 W', ratedA: 3.99, ratedW: 55, fault: null, guess: false } },
      { id: 'n2', type: 'load', pos: { x: 1000, y: 40 }, data: { component: 'halogen_headlight', preset: 'H4 low 55 W', ratedA: 3.99, ratedW: 55, fault: null, guess: false } },
      { id: 'n3', type: 'load', pos: { x: 760, y: 280 }, data: { component: 'halogen_signal_bulb', preset: 'PY21W 21 W', ratedA: 1.52, ratedW: 21, fault: null, guess: false,
        precheck: 'inrush limit 50 A is above the 16.4 A sense saturation of out 4 — only the 5 A steady limit can trip' } },
      { id: 'n4', type: 'load', pos: { x: 1000, y: 280 }, data: { component: 'horn', preset: '40 W', ratedA: 2.9, ratedW: 40, fault: null, guess: false } },
      { id: 'n5', type: 'load', pos: { x: 760, y: 520 }, data: { component: 'radiator_fan', preset: '120 W', ratedA: 8.7, ratedW: 120, fault: null, guess: false,
        precheck: 'steady 8.7 A exceeds the 8 A limit — expect Overcurrent after 1 s, then Fault (reset mode None)' } },
      { id: 'n6', type: 'load', pos: { x: 1000, y: 520 }, data: { component: 'fuel_pump', preset: '340 lph 110 W', ratedA: 7.97, ratedW: 110, fault: null, guess: false } },
      { id: 'n7', type: 'load', pos: { x: 760, y: 760 }, data: { component: 'halogen_signal_bulb', preset: 'W5W 5 W', ratedA: 0.36, ratedW: 5, fault: null, guess: false } },
      { id: 'n8', type: 'load', pos: { x: 1000, y: 760 }, data: { component: 'halogen_signal_bulb', preset: 'Licence 5 W', ratedA: 0.36, ratedW: 5, fault: { kind: 'open', atMs: 0 }, guess: false } },
      { id: 'n9', type: 'load', pos: { x: 760, y: 1000 }, data: { component: 'generic_resistive', preset: '1 A', ratedA: 1.5, ratedW: 20.7, fault: null, guess: true } },
      { id: 'n10', type: 'switch', pos: { x: 120, y: 60 }, data: { kind: 'toggle', level: '12v', state: false } },
      { id: 'n11', type: 'switch', pos: { x: 120, y: 200 }, data: { kind: 'momentary', level: '12v', state: false } },
      { id: 'n12', type: 'rotary', pos: { x: 100, y: 1020 }, data: { positions: [{ name: 'OFF', mV: 500 }, { name: 'Park', mV: 1500 }, { name: 'Low', mV: 2500 }, { name: 'High', mV: 3500 }], index: 0, noiseMv: 20 } },
      { id: 'n13', type: 'rotary', pos: { x: 100, y: 1220 }, data: { positions: [{ name: 'OFF', mV: 500 }, { name: 'Left', mV: 1800 }, { name: 'Right', mV: 3200 }, { name: 'Hazard', mV: 4500 }], index: 0, noiseMv: 20 } },
      { id: 'n14', type: 'keypad', pos: { x: 100, y: 560 }, data: { model: 'blink', keys: 8, nodeId: 21, pressed: Array(8).fill(false), leds: [] } },
      { id: 'n15', type: 'engine', pos: { x: 1260, y: 420 }, data: { state: 'off', throttle: 0, speedKph: 0 } },
      { id: 'n16', type: 'battery', pos: { x: 1260, y: 40 }, data: { vocV: 12.6, riOhm: 0.015, altV: 14.2 } },
      { id: 'n17', type: 'wiper', pos: { x: 1260, y: 760 }, data: { ratedW: 60, slowRps: 0.7, fastRps: 1.2 } },
    ],
    edges: [
      { id: 'e1', from: { node: 'n1', handle: 'supply' }, to: { node: 'PDM-01', handle: 'out:1' } },
      { id: 'e2', from: { node: 'n2', handle: 'supply' }, to: { node: 'PDM-01', handle: 'out:1' } },
      { id: 'e3', from: { node: 'n3', handle: 'supply' }, to: { node: 'PDM-01', handle: 'out:4' } },
      { id: 'e4', from: { node: 'n4', handle: 'supply' }, to: { node: 'PDM-01', handle: 'out:6' } },
      { id: 'e5', from: { node: 'n5', handle: 'supply' }, to: { node: 'PDM-01', handle: 'out:7' } },
      { id: 'e6', from: { node: 'n5', handle: 'supply' }, to: { node: 'n15', handle: 'fan' } },
      { id: 'e7', from: { node: 'n6', handle: 'supply' }, to: { node: 'PDM-02', handle: 'out:1' } },
      { id: 'e8', from: { node: 'n7', handle: 'supply' }, to: { node: 'PDM-02', handle: 'out:3' } },
      { id: 'e9', from: { node: 'n8', handle: 'supply' }, to: { node: 'PDM-02', handle: 'out:3' } },
      { id: 'e10', from: { node: 'n9', handle: 'supply' }, to: { node: 'PDM-02', handle: 'out:6' } },
      { id: 'e11', from: { node: 'n10', handle: 'contact' }, to: { node: 'PDM-01', handle: 'di:1' } },
      { id: 'e12', from: { node: 'n11', handle: 'contact' }, to: { node: 'PDM-01', handle: 'di:2' } },
      { id: 'e13', from: { node: 'n12', handle: 'wiper' }, to: { node: 'CB-1', handle: 'ai:1' } },
      { id: 'e14', from: { node: 'n13', handle: 'wiper' }, to: { node: 'CB-1', handle: 'ai:3' } },
      { id: 'e15', from: { node: 'n15', handle: 'alternator' }, to: { node: 'n16', handle: 'alt' } },
      { id: 'e16', from: { node: 'n17', handle: 'supply' }, to: { node: 'PDM-02', handle: 'out:2' } },
      { id: 'e17', from: { node: 'CB-1', handle: 'do:1' }, to: { node: 'n17', handle: 'run' } },
      { id: 'e18', from: { node: 'CB-1', handle: 'do:2' }, to: { node: 'n17', handle: 'speed' } },
      { id: 'e19', from: { node: 'n17', handle: 'park' }, to: { node: 'CB-1', handle: 'di:1' } },
    ],
    globals: { noisePct: 1 },
  };
}

const FAMILY = Object.fromEntries(BUILTIN_COMPONENTS.map((c) => [c.id, c.family]));

/** Per-unit shape i_pu(t) of a component family (t seconds since turn-on). */
function shape(family, t, W = 55) {
  switch (family) {
    case 'filament': { const tau = (10 + 0.6 * W) / 1000; return 1 + 9 * Math.exp(-t / tau); }
    case 'led': case 'electronics': return t < 0.002 ? 6 : 1;
    case 'hid': return 1 + 1.5 * Math.max(0, 1 - t / 3);
    case 'motor': case 'wiper': { const tau = (80 + 1.5 * W) / 1000; return 1 + 4 * Math.exp(-t / tau) + 0.05 * Math.sin(t * 80); }
    case 'compressor': return 1 + 5 * Math.exp(-t / 0.5) + 0.4 * Math.min(1, t / 60);
    case 'actuator': return t < 3 ? 1 + 4 * Math.exp(-t / 0.1) : 5;
    case 'coil': return 1 - Math.exp(-t / 0.015);
    case 'solenoid2': return t < 0.08 ? 4 : 1;
    case 'heater': return 1 - 0.25 * Math.min(1, t / 120);
    case 'ptc': return 1 + 1.5 * Math.exp(-t / 20);
    case 'glow': return 1 + Math.exp(-t / 3);
    case 'pulsed': return Math.sin(t * 2 * Math.PI * 30) > 0 ? 1 : 0.2;
    case 'strobe': return (t % 0.5) < 0.05 ? 1 : 0;
    case 'amplifier': return 0.6 + 0.4 * Math.sin(t * 2) * Math.sin(t * 7);
    default: return 1;
  }
}

const clone = (o) => JSON.parse(JSON.stringify(o));

function fmtTime(d = new Date()) {
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/**
 * @param {(msg: object) => void} emit  delivers a server→UI message to the store
 */
export function createMock(emit) {
  let scene = buildScene();
  const renode = { status: 'stopped', vtime: 0 };
  let runs = [
    { name: '2026-10-05T18-20-11.run.json', startedAt: '2026-10-05T18:20:11Z', durationS: 124.5, actions: 37, golden: true },
    { name: '2026-10-06T08-02-40.run.json', startedAt: '2026-10-06T08:02:40Z', durationS: 61.2, actions: 12, golden: false },
  ];
  const releases = [
    { tag: 'v5.5.107', assets: [{ name: 'dingopdm_v7_FW_v5.5.107.elf', url: '#' }, { name: 'canboard_v2_FW_v5.5.107.elf', url: '#' }] },
    { tag: 'v5.5.106', assets: [{ name: 'dingopdm_v7_FW_v5.5.106.elf', url: '#' }] },
    { tag: 'v5.5.100', assets: [] },
    { tag: 'testing-latest', assets: [{ name: 'dingopdm_v7_FW_testing.elf', url: '#' }] },
  ];
  let recording = null;
  let t = 0, tick = 0, speed = 1, runUntil = null, timer = null;
  const live = {
    outputs: {},      // `${machine}:${n}` → { onSince, state, oc, tripAt }
    loads: {},        // loadId → { onSince, offSince }
    pressed: {},      // keypadNodeId → Set(keys)
    leds: {},         // keypadNodeId → [{key,color,blink}]
    temps: {},        // machine → °C
    asleep: {},       // machine → bool
    engine: { rpm: 0, cltC: 20, oilBar: 0, crankUntil: null, fanOn: false },
    wiper: { angleDeg: 0, park: true },
    battV: 12.6, sumA: 0,
  };

  const log = (line) => emit({ type: 'renode', log: [`${fmtTime()} ${line}`] });
  const toast = (level, text) => emit({ type: 'toast', level, text });
  const status = (s) => { renode.status = s; emit({ type: 'renode', status: s, vtime: t }); };

  // ---- scene queries -------------------------------------------------------------------------
  const nodeById = (id) => scene.nodes.find((n) => n.id === id);
  const modById = (id) => scene.modules.find((m) => m.id === id);
  const edgesTo = (node, handle) => scene.edges.filter((e) => e.to.node === node && (!handle || e.to.handle === handle));
  const edgesFrom = (node, handle) => scene.edges.filter((e) => e.from.node === node && (!handle || e.from.handle === handle));
  const loadsOn = (machine, n) => edgesTo(machine, `out:${n}`).map((e) => nodeById(e.from.node)).filter(Boolean);
  const rotaryIndex = (aiName) => {
    for (const m of scene.modules) for (const ai of m.analogIn || []) {
      if (ai.name !== aiName) continue;
      const e = edgesTo(m.id, `ai:${ai.n}`)[0];
      const r = e && nodeById(e.from.node);
      if (r) return r.data.index ?? 0;
    }
    return 0;
  };
  const rotaryName = (m, ai) => {
    const e = edgesTo(m.id, `ai:${ai.n}`)[0];
    const r = e && nodeById(e.from.node);
    if (!r) return '—';
    return r.data.positions?.[r.data.index]?.name ?? '—';
  };
  const rotaryMv = (m, ai) => {
    const e = edgesTo(m.id, `ai:${ai.n}`)[0];
    const r = e && nodeById(e.from.node);
    if (!r) return 0;
    return (r.data.positions?.[r.data.index]?.mV ?? 0) + (Math.random() - 0.5) * (r.data.noiseMv || 0);
  };
  const diState = (m, n) => {
    const e = edgesTo(m.id, `di:${n}`)[0];
    if (!e) return false;
    if (e.from.handle === 'park') return live.wiper.park;
    const s = nodeById(e.from.node);
    return !!(s && s.data.state);
  };
  const anyPressed = (kind) => scene.nodes.some((n) => n.type === 'switch' && n.data.kind === kind && n.data.state);
  const keyHeld = (k) => Object.values(live.pressed).some((set) => set.has(k));
  const engineNode = () => scene.nodes.find((n) => n.type === 'engine');
  const batteryNode = () => scene.nodes.find((n) => n.type === 'battery');
  const engineState = () => engineNode()?.data.state || 'off';

  /** Does the (mock) firmware want this output on? DI n → out n, plus simple rules by output name. */
  function outputWanted(m, o) {
    if (!o.enabled) return false;
    if (diState(m, o.n)) return true;
    const name = o.name.toLowerCase();
    const hl = rotaryIndex('Headlights'), ind = rotaryIndex('Indicators'), wp = rotaryIndex('Wiper'), gear = rotaryIndex('Gear');
    const es = engineState();
    const left = /left/.test(name), right = /right/.test(name);
    const flash = Math.floor(t * 1.5) % 2 === 0;
    if (/low beam/.test(name)) return hl >= 2;
    if (/high beam/.test(name)) return hl === 3;
    if (/indicator|turn/.test(name)) return (ind === 3 || (ind === 1 && left) || (ind === 2 && right)) && flash;
    if (/position|plate|sidemarker|marker|tail|licen|dash/.test(name)) return hl >= 1;
    if (/horn/.test(name)) return anyPressed('momentary');
    if (/fuel/.test(name)) return es !== 'off';
    if (/fan|coolant/.test(name)) return live.engine.fanOn;
    if (/wiper/.test(name)) return wp >= 2 || (wp === 1 && Math.floor(t / 4) % 2 === 0) || !live.wiper.park;
    if (/washer/.test(name)) return keyHeld(1);
    if (/brake|stop/.test(name)) return keyHeld(0);
    if (/reverse/.test(name)) return gear === 1;
    if (/blower|hvac/.test(name)) return keyHeld(2);
    if (/seat|heat/.test(name)) return keyHeld(3);
    if (/interior|dome/.test(name)) return keyHeld(4);
    if (/ecu|pi|radio|dash/.test(name)) return es !== 'off';
    return false;
  }

  function loadCurrent(load, dt) {
    const d = load.data;
    const A = d.ratedA || (d.ratedW || 0) / NOMINAL_V;
    const fam = load.type === 'wiper' ? 'wiper' : FAMILY[d.component] || 'resistive';
    let i = shape(fam, dt, d.ratedW || A * NOMINAL_V) * A;
    const f = d.fault;
    if (f && f.kind && (f.atMs || 0) / 1000 <= dt) {
      switch (f.kind) {
        case 'open': i = 0; break;
        case 'short': i = 999; break;
        case 'stall': i = 5 * A; break;
        case 'intermittent': if (Math.sin(dt * 9) * Math.sin(dt * 2.3) > 0.55) i = 0; break;
        case 'hires': i *= 0.6; break;
        case 'wrongpart': i *= 2; break;
      }
    }
    return i;
  }

  function stepOutputs(dt) {
    let sumA = 0;
    for (const m of scene.modules) {
      if (m.kind === 'canboard' || live.asleep[m.id]) continue;
      for (const o of m.outputs) {
        const key = `${m.id}:${o.n}`;
        const st = (live.outputs[key] ||= { onSince: null, state: 'Off', oc: 0, tripAt: null, i: 0 });
        const want = outputWanted(m, o);
        if (st.state === 'Fault') { // latched until the request drops (reset mode None)
          if (!want) { st.state = 'Off'; st.onSince = null; }
          st.i = 0; continue;
        }
        if (want && st.onSince == null) st.onSince = t;
        if (!want) { st.onSince = null; st.state = 'Off'; st.i = 0; st.tripAt = null; continue; }
        const tOn = t - st.onSince;
        const loads = loadsOn(m.id, o.n);
        let i = 0;
        for (const l of loads) {
          const ls = (live.loads[l.id] ||= { onSince: null });
          if (ls.onSince == null) ls.onSince = t; // restarts cold with the output (cool-down ignored in the mock)
          i += loadCurrent(l, t - ls.onSince);
        }
        for (const l of scene.nodes) if (l.type === 'load' && !loads.includes(l) && live.loads[l.id] && !edgesFrom(l.id, 'supply').some((e) => live.outputs[`${e.to.node}:${handleIndex(e.to.handle)}`]?.onSince != null)) live.loads[l.id].onSince = null;
        i *= Math.pow(live.battV / NOMINAL_V, 0.55);
        i *= 1 + (Math.random() - 0.5) * 0.02;
        const sat = saturationA(m.kind, o.n);
        i = Math.min(Math.max(0, i), sat);
        if (st.state === 'Overcurrent') {
          if (t - st.tripAt >= (o.resetTime || 1000) / 1000) { st.state = 'Fault'; st.i = 0; continue; }
          st.i = 0; continue; // output is off while tripped
        }
        const inInrush = tOn < (o.inrushTime || 0) / 1000;
        const limit = inInrush ? Math.max(o.inrushCurrentLimit || 0, o.currentLimit) : o.currentLimit;
        if (i > limit && tOn > 0.05) { st.state = 'Overcurrent'; st.tripAt = t; st.oc++; st.i = 0; continue; }
        st.state = loads.length && i < 0.1 && tOn > 0.3 ? 'OpenLoad' : 'On';
        st.i = i;
        sumA += i;
      }
    }
    live.sumA = sumA;
  }

  function stepEngine(dt) {
    const e = engineNode();
    const b = batteryNode()?.data || { vocV: 12.6, riOhm: 0.015, altV: 14.2 };
    const en = live.engine;
    const state = e?.data.state || 'off';
    if (state === 'crank' && en.crankUntil == null) en.crankUntil = t + 1;
    if (state === 'crank' && t >= en.crankUntil) { e.data.state = 'run'; en.crankUntil = null; emit({ type: 'scene', scene: clone(scene) }); }
    if (state !== 'crank') en.crankUntil = null;
    const thr = e?.data.throttle || 0;
    en.rpm = state === 'run' ? 800 + thr * 55 : state === 'crank' ? 250 : 0;
    const fanLoadOn = scene.edges.some((ed) => ed.to.handle === 'fan' && edgesFrom(ed.from.node, 'supply').some((s) => live.outputs[`${s.to.node}:${handleIndex(s.to.handle)}`]?.state === 'On'));
    const target = state === 'run' ? (fanLoadOn ? 85 : 95) : 20;
    en.cltC += (target - en.cltC) * Math.min(1, dt * (state === 'run' ? 0.05 : 0.01));
    en.fanOn = state === 'run' && (en.fanOn ? en.cltC > 88 : en.cltC > 92);
    en.oilBar = state === 'run' ? 1 + en.rpm / 1500 : 0;
    const crankA = state === 'crank' ? 150 : 0;
    const voc = state === 'run' ? b.altV : b.vocV;
    const ri = state === 'run' ? 0.004 : b.riOhm;
    live.battV = +(voc - ri * (live.sumA + crankA)).toFixed(2);
    if (e) emit({ type: 'engine', node: e.id, rpm: Math.round(en.rpm), cltC: +en.cltC.toFixed(1), oilBar: +en.oilBar.toFixed(2), speedKph: e.data.speedKph || 0, gear: rotaryName(modById('CB-1') || {}, { n: 4 }) });
  }

  function stepWiper(dt) {
    const w = scene.nodes.find((n) => n.type === 'wiper');
    if (!w) return;
    const supply = edgesFrom(w.id, 'supply')[0];
    const on = supply && live.outputs[`${supply.to.node}:${handleIndex(supply.to.handle)}`]?.state === 'On';
    const wp = rotaryIndex('Wiper');
    const run = on, fast = wp >= 3;
    const rps = fast ? w.data.fastRps || 1.2 : w.data.slowRps || 0.7;
    if (run) live.wiper.angleDeg = (live.wiper.angleDeg + rps * 360 * dt) % 360;
    live.wiper.park = live.wiper.angleDeg < 10 || live.wiper.angleDeg > 350;
    emit({ type: 'wiper', node: w.id, angleDeg: +live.wiper.angleDeg.toFixed(1), run: !!run, speed: fast, park: live.wiper.park });
  }

  function emitTraces() {
    for (const m of scene.modules) {
      if (live.asleep[m.id]) continue;
      const tempC = +((live.temps[m.id] ?? 28) + Math.sin(t / 7) * 0.3).toFixed(1);
      if (m.kind === 'canboard') {
        emit({
          type: 'trace', machine: m.id, t: +t.toFixed(2),
          do: (m.digitalOut || []).map((d) => (d.enabled && /run|mode/i.test(d.name) ? (rotaryIndex('Wiper') >= 1 || !live.wiper.park ? 1 : 0) : d.enabled && /speed/i.test(d.name) ? (rotaryIndex('Wiper') >= 3 ? 1 : 0) : 0)),
          di: (m.inputs || []).map((i) => (diState(m, i.n) ? 1 : 0)),
          mV: (m.analogIn || []).map((ai) => Math.round(rotaryMv(m, ai))),
          vbattV: live.battV, tempC,
        });
      } else {
        emit({
          type: 'trace', machine: m.id, t: +t.toFixed(2),
          i: m.outputs.map((o) => +(live.outputs[`${m.id}:${o.n}`]?.i || 0).toFixed(3)),
          on: m.outputs.map((o) => (live.outputs[`${m.id}:${o.n}`]?.state === 'On' ? 1 : 0)),
          duty: m.outputs.map((o) => (live.outputs[`${m.id}:${o.n}`]?.state === 'On' ? 100 : 0)),
          vbattV: live.battV, tempC,
        });
      }
    }
  }

  function emitTelemetry() {
    for (const m of scene.modules) {
      const tempC = +((live.temps[m.id] ?? 28) + Math.sin(t / 7) * 0.3).toFixed(1);
      if (live.asleep[m.id]) {
        emit({ type: 'telemetry', module: m.id, t: +t.toFixed(2), outputs: [], inputs: [], positions: [], asleep: true, vbattV: live.battV, tempC });
        continue;
      }
      emit({
        type: 'telemetry', module: m.id, t: +t.toFixed(2),
        outputs: m.outputs.map((o) => {
          const st = live.outputs[`${m.id}:${o.n}`] || { state: 'Off', i: 0, oc: 0 };
          return { n: o.n, state: st.state, currentA: Math.round(st.i * 10) / 10, duty: st.state === 'On' ? 100 : 0, ocCount: st.oc };
        }),
        inputs: (m.inputs || []).map((i) => diState(m, i.n)),
        positions: (m.analogIn || []).map((ai) => (ai.enabled ? rotaryName(m, ai) : null)),
        asleep: false, vbattV: live.battV, tempC,
      });
    }
  }

  function emitBus() {
    const m = scene.modules[tick % scene.modules.length];
    if (live.asleep[m.id]) return;
    const k = tick % (m.kind === 'canboard' ? 10 : 28);
    const data = Array.from({ length: 8 }, (_, i) => (i === 0 ? k : Math.floor(Math.random() * 256)));
    emit({ type: 'bus', frame: { id: m.baseId + 2 + k, dlc: 8, data, dir: 'rx' } });
  }

  function step() {
    tick++;
    if (renode.status === 'running') {
      const dt = 0.1 * speed;
      t += dt;
      stepOutputs(dt);
      stepEngine(dt);
      stepWiper(dt);
      emitTraces();
      if (tick % 5 === 0) emitTelemetry();
      if (tick % 2 === 0) emitBus();
      if (tick % 20 === 0) emit({ type: 'renode', vtime: +t.toFixed(1) });
      if (runUntil != null && t >= runUntil) { runUntil = null; speed = 1; status('paused'); log(`[INFO] Emulation paused at ${t.toFixed(3)} s (RunFor done)`); }
    } else if (tick % 10 === 0 && renode.status === 'paused') {
      emitTelemetry();
    }
  }

  function resetLive() {
    live.outputs = {}; live.loads = {}; live.engine = { rpm: 0, cltC: 20, oilBar: 0, crankUntil: null, fanOn: false };
    live.wiper = { angleDeg: 0, park: true }; live.sumA = 0; live.battV = batteryNode()?.data.vocV ?? 12.6;
  }

  // ---- UI → server -----------------------------------------------------------------------------
  function handleAction(a) {
    if (recording) recording.actions++;
    const n = a.node ? nodeById(a.node) : null;
    switch (a.kind) {
      case 'switch': if (n) n.data.state = a.state; break;
      case 'rotary': if (n) n.data.index = a.index; break;
      case 'keypad': {
        if (!n) break;
        const set = (live.pressed[n.id] ||= new Set());
        if (a.pressed) {
          set.add(a.key);
          const leds = (live.leds[n.id] ||= []);
          const cur = leds.find((l) => l.key === a.key);
          const next = { off: 'green', green: 'red', red: 'blue', blue: 'off' }[cur?.color || 'off'];
          const rest = leds.filter((l) => l.key !== a.key);
          live.leds[n.id] = next === 'off' ? rest : [...rest, { key: a.key, color: next, blink: next === 'red' }];
          emit({ type: 'keypad', node: n.id, leds: live.leds[n.id] });
        } else set.delete(a.key);
        if (n.data.pressed) n.data.pressed[a.key] = !!a.pressed;
        break;
      }
      case 'fault': if (n) { n.data.fault = a.fault; toast('info', a.fault ? `${n.id}: ${a.fault.kind} fault armed` : `${n.id}: fault cleared`); } break;
      case 'battery': if (n) Object.assign(n.data, { vocV: a.vocV ?? n.data.vocV, riOhm: a.riOhm ?? n.data.riOhm, altV: a.altV ?? n.data.altV }); break;
      case 'engine': if (n) { if (a.state) n.data.state = a.state; if (a.throttle != null) n.data.throttle = a.throttle; if (a.speedKph != null) n.data.speedKph = a.speedKph; } break;
      case 'temp': live.temps[a.module] = a.c; log(`[INFO] ${a.module}: tempSensor.SetTemperature ${a.c}`); break;
      case 'renode': handleRenode(a); break;
      default: toast('warn', `Mock ignores action ${a.kind}`);
    }
  }

  function handleRenode(a) {
    switch (a.cmd) {
      case 'start':
        if (renode.status === 'running') break;
        status('downloading'); log('[INFO] firmware: v5.5.107 already in cache/firmware/v5.5.107');
        setTimeout(() => { status('starting'); log('[INFO] Renode, version 1.15.3 (mock)'); for (const m of scene.modules) log(`[INFO] ${m.id}: machine created from ${m.kind === 'canboard' ? 'canboard_v2.repl' : 'dingopdm_v7.repl'}`); }, 300);
        setTimeout(() => { resetLive(); t = 0; status('running'); log('[INFO] Emulation started'); for (const m of scene.modules) log(`[INFO] ${m.id}: Version reply 5.5.107 (board ${m.kind === 'canboard' ? 2 : 0})`); }, 900);
        break;
      case 'stop': status('stopped'); runUntil = null; speed = 1; t = 0; resetLive(); log('[INFO] Emulation stopped, machines cleared'); break;
      case 'pause': if (renode.status === 'running') { status('paused'); log('[INFO] Emulation paused'); } break;
      case 'resume': if (renode.status === 'paused') { status('running'); log('[INFO] Emulation resumed'); } break;
      case 'runfor': { const s = Math.max(0.1, Number(a.seconds) || 10); runUntil = t + s; speed = 10; status('running'); log(`[INFO] emulation RunFor "0:0:${s}"`); break; }
      case 'reset': { for (const k of Object.keys(live.outputs)) if (k.startsWith(a.module + ':')) delete live.outputs[k]; log(`[INFO] mach set "${a.module}"; machine Reset`); toast('info', `${a.module} reset`); break; }
      case 'sleep': live.asleep[a.module] = true; log(`[INFO] ${a.module}: EnterStopMode()`); emit({ type: 'telemetry', module: a.module, t, outputs: [], inputs: [], positions: [], asleep: true, vbattV: live.battV, tempC: 28 }); break;
      case 'wake': live.asleep[a.module] = false; log(`[INFO] ${a.module}: wake pulse on PB8 → NVIC_SystemReset()`); break;
      default: toast('warn', `Unknown renode cmd ${a.cmd}`);
    }
  }

  function handleRecord(msg) {
    switch (msg.cmd) {
      case 'start': recording = { startedAt: new Date().toISOString(), t0: t, actions: 0 }; toast('info', 'Recording started'); break;
      case 'stop': {
        if (!recording) break;
        const name = recording.startedAt.replace(/[:.]/g, '-').replace(/-\d{3}Z$/, '') + '.run.json';
        runs = [{ name, startedAt: recording.startedAt, durationS: +(t - recording.t0).toFixed(1), actions: recording.actions, golden: false }, ...runs];
        recording = null; emit({ type: 'runs', runs }); toast('info', `Saved ${name}`); break;
      }
      case 'replay': toast('info', `Replaying ${msg.run} at virtual time`); log(`[INFO] replay ${msg.run}: ${runs.find((r) => r.name === msg.run)?.actions ?? 0} actions`); if (renode.status !== 'running') handleRenode({ cmd: 'start' }); break;
      case 'golden': runs = runs.map((r) => ({ ...r, golden: r.name === msg.run })); emit({ type: 'runs', runs }); toast('info', `${msg.run} is the golden run`); break;
      case 'diff': {
        const golden = runs.find((r) => r.golden)?.name || null;
        emit({
          type: 'diff', run: msg.run, golden,
          summary: { pass: 5, fail: 2 },
          rows: [
            { module: 'PDM-01', output: 1, metric: 'peak A', expected: 72.1, actual: 71.4, ok: true },
            { module: 'PDM-01', output: 1, metric: 'steady A', expected: 7.98, actual: 8.02, ok: true },
            { module: 'PDM-01', output: 4, metric: 'state sequence', expected: 'Off,On,Off,On', actual: 'Off,On,Off,On', ok: true },
            { module: 'PDM-01', output: 7, metric: 'OC count', expected: 1, actual: 0, ok: false },
            { module: 'PDM-01', output: 7, metric: 'final state', expected: 'Fault', actual: 'On', ok: false },
            { module: 'PDM-02', output: 1, metric: 'steady A', expected: 7.97, actual: 7.9, ok: true },
            { module: 'PDM-02', output: 3, metric: 'final state', expected: 'OpenLoad', actual: 'OpenLoad', ok: true },
          ],
        });
        break;
      }
    }
  }

  function handlePopulate() {
    let added = 0;
    const notes = [];
    for (const m of scene.modules) {
      for (const o of m.outputs) {
        if (!o.enabled || loadsOn(m.id, o.n).length) continue;
        const match = keywordComponent(o.name);
        const comp = BUILTIN_COMPONENTS.find((c) => c.id === (match?.id || 'generic_resistive'));
        const data = loadFromComponent(comp, match?.preset);
        if (!match) { data.guess = true; data.ratedA = +(o.currentLimit * 0.6).toFixed(2); data.ratedW = +(data.ratedA * NOMINAL_V).toFixed(1); }
        const id = nextId('n', scene.nodes);
        scene.nodes.push({ id, type: 'load', pos: { x: m.pos.x + 340, y: m.pos.y + (o.n - 1) * 110 }, data });
        scene.edges.push({ id: nextId('e', scene.edges), from: { node: id, handle: 'supply' }, to: { node: m.id, handle: `out:${o.n}` } });
        added++;
      }
      if (m.kind !== 'canboard' && m.outputs.every((o) => o.resetMode === 0)) notes.push(`${m.id}: reset mode None on every output — first overcurrent latches Fault`);
    }
    emit({ type: 'scene', scene: clone(scene) });
    toast('info', `Populate: ${added} load${added === 1 ? '' : 's'} added. ${notes[0] || ''}`);
  }

  // ---- public surface ------------------------------------------------------------------------
  return {
    snapshot() {
      return { type: 'snapshot', scene: clone(scene), renode: { status: renode.status, vtime: t, log: [] }, modules: {}, components: BUILTIN_COMPONENTS, runs };
    },
    start() {
      if (timer) return;
      timer = setInterval(step, 100);
      setTimeout(() => { emit(this.snapshot()); log('[INFO] mock server attached (?mock=1) — no Renode, no firmware, no bus'); toast('info', 'Mock mode: the UI is driven by a built-in fake. Press Start in the Renode tab.'); }, 0);
    },
    stop() { clearInterval(timer); timer = null; },
    send(msg) {
      switch (msg.type) {
        case 'scene': scene = clone(msg.scene); break;
        case 'action': handleAction(msg.action); break;
        case 'populate': handlePopulate(); break;
        case 'record': handleRecord(msg); break;
        default: toast('warn', `Mock ignores ${msg.type}`);
      }
    },
    async api(path, opts = {}) {
      const p = path.split('?')[0];
      if (p === '/api/runs') return runs;
      if (p === '/api/firmware/releases') return releases;
      if (p === '/api/components') return BUILTIN_COMPONENTS;
      if (p === '/api/snapshot') return this.snapshot();
      if (p === '/api/scene' && opts.method === 'POST') { scene = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body; return { ok: true, path: `scenes/${scene.name}/scene.sim.json` }; }
      if (p.startsWith('/api/run/')) return { name: decodeURIComponent(p.slice(9)), actions: [], telemetry: [] };
      if (p === '/api/project') return { modules: scene.modules };
      throw new Error(`mock: no route ${path}`);
    },
  };
}

export { STATE_NAMES };
