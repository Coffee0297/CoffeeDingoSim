import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProject } from '../lib/project.js';
import { populate, saturationA } from '../lib/populate.js';

// Small stand-in for lib/components.js (docs/interfaces.md §4 interface): parts = one unit, multiplier repeats it.
const CATALOG = {
  halogen_headlight: { family: 'filament', presets: { 'H4 low 55 W': 55, 'H4 high 60 W': 60 } },
  halogen_signal_bulb: { family: 'filament', presets: { W5W: 5, PY21W: 21, P21W: 21 } },
  horn: { family: 'resistive', presets: {} },
  radiator_fan: { family: 'motor', presets: {} },
  hvac_blower: { family: 'motor', presets: {} },
  seat_heater: { family: 'heater', presets: {} },
  dash_display: { family: 'electronics', presets: {} },
  head_unit: { family: 'electronics', presets: {} },
  ecu: { family: 'electronics', presets: {} },
  relay_coil: { family: 'coil', presets: {} },
  wiper_motor: { family: 'wiper', presets: {} },
  washer_pump: { family: 'motor', presets: {} },
  fuel_pump: { family: 'motor', presets: {} },
  generic_resistive: { family: 'resistive', presets: {} },
};
const RULES = [
  [/low beam/i, 'halogen_headlight', 'H4 low 55 W'],
  [/high beam/i, 'halogen_headlight', 'H4 high 60 W'],
  [/indicator/i, 'halogen_signal_bulb', 'PY21W'],
  [/brake|reverse/i, 'halogen_signal_bulb', 'P21W'],
  [/position|plate|sidemarker|interior/i, 'halogen_signal_bulb', 'W5W'],
  [/horn/i, 'horn'],
  [/fan/i, 'radiator_fan'],
  [/blower/i, 'hvac_blower'],
  [/seat|heat/i, 'seat_heater'],
  [/\bpi\b|dash/i, 'dash_display'],
  [/radio/i, 'head_unit'],
  [/ecu/i, 'ecu'],
  [/relay|trigger/i, 'relay_coil'],
  [/wiper/i, 'wiper_motor'],
  [/washer/i, 'washer_pump'],
  [/fuel|pump/i, 'fuel_pump'],
];
const stub = {
  matchKeyword(name) {
    let multiplier = 1;
    let s = name.replace(/\s*(?:x|×)(\d+)\b|\b(\d+)x\s*/i, (_, a, b) => ((multiplier = Number(a ?? b)), ''));
    const lr = /\bL\+R\b/.test(s);
    s = s.replace(/\bL\+R\b/, '');
    const pieces = s.split(/\s*(?:\+|&|\band\b)\s*/i).filter(Boolean);
    const parts = [];
    let guess = false;
    for (const p of pieces) {
      const r = RULES.find(([re]) => re.test(p));
      if (!r) guess = true;
      const part = r ? { id: r[1], ...(r[2] ? { presetName: r[2] } : {}) } : { id: 'generic_resistive' };
      const n = (lr ? 2 : 1) * (/relays|triggers/i.test(p) ? 2 : 1);
      for (let i = 0; i < n; i++) parts.push({ ...part });
    }
    return { id: parts[0].id, multiplier, parts, guess };
  },
  instantiate(id, { preset, ratedA } = {}) {
    const c = CATALOG[id];
    if (!c) throw new Error(`unknown ${id}`);
    const W = preset ? c.presets[preset] : ratedA ? ratedA * 13.8 : 13.8;
    return { component: id, family: c.family, preset: preset ?? null, ratedA: +(W / 13.8).toFixed(2), ratedW: +W.toFixed(2) };
  },
  listComponents: () => Object.entries(CATALOG).map(([id, c]) => ({ id, family: c.family })),
};

const example = JSON.parse(readFileSync(new URL('../scenes/example/example-vehicle.json', import.meta.url), 'utf8'));

test('saturation figures', () => {
  assert.equal(saturationA('pdm', 1).toFixed(1), '63.1');
  assert.equal(saturationA('pdm', 5).toFixed(1), '16.4');
  assert.equal(saturationA('pdmmax', 1).toFixed(0), '96');
});

test('example vehicle populate: loads, knobs, battery, engine', () => {
  const mods = parseProject(example);
  const { nodes, edges, notes } = populate(mods, stub);
  const byType = (t) => nodes.filter((n) => n.type === t);
  // 11 enabled outputs; two x2 headlight outputs → +2, "Rear Position + Plate" → +1 ⇒ 14 load instances
  assert.equal(byType('load').length, 14);
  assert.equal(byType('wiper').length, 0);
  assert.equal(byType('rotary').length, 2);
  assert.equal(byType('switch').length, 0); // every digital input is disabled in the example
  assert.equal(byType('battery').length, 1);
  assert.equal(byType('engine').length, 1);

  const ids = new Set(nodes.map((n) => n.id));
  assert.equal(ids.size, nodes.length);
  // load node ids the e2e golden script relies on
  for (const id of ['PDM-01.o1.1', 'PDM-01.o1.2', 'PDM-02.o1.1', 'PDM-02.o5.1']) assert.ok(ids.has(id), id);

  // both low-beam filaments on PDM-01 out 1, preset sized
  const lowBeams = edges.filter((e) => e.to.node === 'PDM-01' && e.to.handle === 'out:1').map((e) => nodes.find((n) => n.id === e.from.node));
  assert.equal(lowBeams.length, 2);
  for (const n of lowBeams) {
    assert.equal(n.data.component, 'halogen_headlight');
    assert.equal(n.data.preset, 'H4 low 55 W');
    assert.equal(n.data.ratedW, 55);
    assert.equal(n.data.fault, null);
    assert.equal(n.data.guess, false);
  }
  // "Rear Position + Plate" split into two W5W
  const pp = edges.filter((e) => e.to.node === 'PDM-02' && e.to.handle === 'out:3');
  assert.equal(pp.length, 2);
  // coolant fan: no preset → 0.6 × 8 A
  const fan = nodes.find((n) => n.data?.component === 'radiator_fan');
  assert.equal(fan.data.ratedA, 4.8);

  // every load has exactly one supply edge, to an out:<n> of its module
  for (const n of byType('load')) {
    const sup = edges.filter((e) => e.from.node === n.id && e.from.handle === 'supply');
    assert.equal(sup.length, 1, n.id);
    assert.match(sup[0].to.handle, /^out:\d$/);
  }
  // rotary ladders
  const head = nodes.find((n) => n.id === 'CB-1.ai1');
  assert.deepEqual(head.data.positions.map((p) => p.name), ['OFF', 'Park', 'Low', 'High']);
  assert.deepEqual(head.data.positions.map((p) => p.mV), [500, 1500, 2500, 3500]);
  const ind = nodes.find((n) => n.id === 'CB-1.ai2');
  assert.deepEqual(ind.data.positions.map((p) => p.name), ['OFF', 'Left', 'Right', 'Hazard']);
  assert.ok(edges.some((e) => e.from.node === 'CB-1.ai2' && e.from.handle === 'wiper' && e.to.node === 'CB-1' && e.to.handle === 'ai:2'));
  assert.ok(edges.some((e) => e.from.node === 'engine' && e.to.node === 'battery' && e.to.handle === 'alt'));

  // deterministic layout: loads right of their module, stimulus left
  assert.equal(lowBeams[0].pos.x, 220);
  assert.ok(nodes.filter((n) => ['rotary', 'battery', 'engine'].includes(n.type)).every((n) => n.pos.x < 0));
  assert.deepEqual(populate(mods, stub), { nodes, edges, notes });

  // notes
  const all = notes.join('\n');
  assert.match(all, /PDM-01: resetMode None on every enabled output \(1, 2, 3, 4, 6, 7\)/);
  assert.match(all, /PDM-01: inrush limit 50 A on outputs 3, 4, 6, 7 is above the 16\.4 A current-sense saturation \(kILIS 5950\)/);
  assert.doesNotMatch(all, /outputs 1, 2 is above/); // 50 A < 63 A on outputs 1–2
  assert.match(all, /PDM-02: outputs 1, 3, 4, 5, 6 are enabled with no input bound/);
  assert.doesNotMatch(all, /Wiper/);
  assert.doesNotMatch(all, /Guessed components/); // the stub matches every example name
});

test('wiper relay wiring, L+R and composite splits, no-preset sizing', () => {
  const o = (n, name, currentLimit) => ({ n, name, enabled: true, currentLimit, inrushCurrentLimit: 50, primaryOutput: -1, resetMode: 1, input: 5 });
  const mods = [
    { id: 'P', kind: 'pdm', baseId: 0x680, pos: { x: 0, y: 0 }, analogIn: [], digitalOut: [], inputs: [],
      outputs: [o(1, 'HVAC Blower', 12), o(2, 'Seat Heating L+R', 12), o(3, 'Wiper Motor', 8), o(4, 'Dash Display + Radio', 5), o(5, 'ECU + O2 Relay Triggers', 10)] },
    { id: 'C', kind: 'canboard', baseId: 0x660, pos: { x: 420, y: 0 }, outputs: [], inputs: [],
      analogIn: [{ n: 4, name: 'Gear', enabled: true, rotary: { enabled: true, numPos: 3, points: [500, 1500, 2500], positionNames: ['P', 'R', 'D'], tolerance: 200 } }],
      digitalOut: [{ n: 1, name: 'Wiper RUN (R_MODE)', enabled: true }, { n: 2, name: 'Wiper SPEED (R_SPEED)', enabled: true }] },
  ];
  const { nodes, edges, notes } = populate(mods, stub);
  const byType = (t) => nodes.filter((n) => n.type === t);
  // blower 1, seat L+R 2, wiper 1, "Dash Display + Radio" 2, "ECU + O2 Relay Triggers" 3
  assert.equal(byType('load').length + byType('wiper').length, 9);
  // HVAC blower: no preset → 0.6 × 12 A
  assert.equal(nodes.find((n) => n.data?.component === 'hvac_blower').data.ratedA, 7.2);
  // seat heating L+R → two heaters sharing 0.6 × 12
  const seats = nodes.filter((n) => n.data?.component === 'seat_heater');
  assert.equal(seats.length, 2);
  assert.equal(seats[0].data.ratedA, 3.6);
  // wiper relays C DO1 → run, DO2 → speed
  assert.equal(byType('wiper').length, 1);
  const w = byType('wiper')[0];
  assert.ok(edges.some((e) => e.from.node === 'C' && e.from.handle === 'do:1' && e.to.node === w.id && e.to.handle === 'run'));
  assert.ok(edges.some((e) => e.from.node === 'C' && e.from.handle === 'do:2' && e.to.node === w.id && e.to.handle === 'speed'));
  assert.ok(edges.some((e) => e.from.node === 'C.ai4' && e.from.handle === 'wiper' && e.to.node === 'C' && e.to.handle === 'ai:4'));
  assert.match(notes.join('\n'), /Wiper: P out 3 wired as a wiper motor/);
});

test('guesses, 63 A note, switches, followers, keypads', () => {
  const mods = [
    {
      id: 'P',
      kind: 'pdm',
      baseId: 0x0de,
      pos: { x: 0, y: 0 },
      outputs: [
        { n: 1, name: 'Mystery Box', enabled: true, currentLimit: 10, inrushCurrentLimit: 80, primaryOutput: -1, resetMode: 1, input: 5 },
        { n: 2, name: 'Mystery Box b', enabled: true, currentLimit: 10, inrushCurrentLimit: 10, primaryOutput: 0, resetMode: 1, input: 5 },
      ],
      inputs: [
        { n: 1, name: 'Ign', enabled: true, mode: 0, pull: 2 },
        { n: 2, name: 'Btn', enabled: true, mode: 1, pull: 1 },
      ],
      analogIn: [],
      digitalOut: [],
    },
  ];
  mods.extras = { blinkMarineKeypads: [{ nodeId: 21, numButtons: 8 }] };
  const { nodes, edges, notes } = populate(mods, stub);
  const loads = nodes.filter((n) => n.type === 'load');
  assert.equal(loads.length, 1);
  assert.equal(loads[0].data.guess, true);
  assert.equal(loads[0].data.ratedA, 6);
  const sup = edges.filter((e) => e.from.node === loads[0].id).map((e) => e.to.handle);
  assert.deepEqual(sup, ['out:1', 'out:2']); // follower gets the primary's load
  const sw = nodes.filter((n) => n.type === 'switch');
  assert.deepEqual(sw.map((s) => [s.data.kind, s.data.level]), [['toggle', '12v'], ['momentary', 'gnd']]);
  assert.ok(edges.some((e) => e.from.node === 'P.di2' && e.to.handle === 'di:2'));
  const kp = nodes.find((n) => n.type === 'keypad');
  assert.equal(kp.data.nodeId, 21);
  assert.equal(kp.data.pressed.length, 8);
  const all = notes.join('\n');
  assert.match(all, /inrush limit 80 A on output 1 is above the 63 A current-sense saturation \(kILIS 22950\)/);
  assert.match(all, /Guessed components.*Mystery Box/);
  assert.match(all, /output 2 is paired with output 1/);
  assert.doesNotMatch(all, /resetMode None/);
});
