import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listComponents, instantiate, render, matchKeyword, getComponent } from '../lib/components.js';

test('listComponents covers the palette groups with presets', () => {
  const list = listComponents();
  const groups = new Set(list.map((c) => c.group));
  for (const g of ['Lighting', 'Motors', 'Coils', 'Heaters', 'Electronics', 'Faults', 'Other']) assert.ok(groups.has(g), g);
  assert.ok(list.length >= 45);
  const ids = new Set();
  for (const c of list) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`); ids.add(c.id);
    assert.ok(c.presets.length > 0, `${c.id} has presets`);
    assert.ok(getComponent(c.id).source, `${c.id} has a source note`);
    for (const p of c.presets) render(instantiate(c.id, { preset: p.name }));    // every preset renders
  }
});

test('instantiate: ratedA = W / 13.8, ratedA override, unknown preset throws', () => {
  const h = instantiate('halogen_headlight', { preset: 'H4 low 55 W' });
  assert.equal(h.ratedA, 3.99);
  assert.equal(h.params.tauMs, 18.75);   // 5 + 0.25·W
  assert.equal(instantiate('radiator_fan', { ratedA: 10 }).ratedW, 138);
  assert.throws(() => instantiate('halogen_headlight', { preset: 'nope' }));
  assert.throws(() => instantiate('nope'));
});

test('render: 55 W halogen peaks 5x (~20 A), ~19 ms decay, then 4 A, compact table', () => {
  const r = render(instantiate('halogen_headlight', { preset: 'H4 low 55 W' }));
  assert.ok(r.table[0] > 19.5 && r.table[0] < 20.5, `peak ${r.table[0]}`);
  assert.ok(r.table[19] > 9 && r.table[19] < 11, `at 19 ms ${r.table[19]}`);
  assert.ok(Math.abs(r.steadyA - 3.99) < 0.01);
  assert.ok(r.table.length < 400, `table length ${r.table.length}`);
  assert.equal(r.shortA, 999);
  assert.equal(r.stallA, 0);
  assert.equal(r.fault, null);
  assert.equal(r.vExp, 0.55);
  assert.equal(r.coolDownMs, 1500);
  assert.deepEqual(r.pwm, { onPhaseExp: 0.45 });
  for (const k of ['id', 'ratedA', 'vExp', 'tableMs', 'table', 'steadyA', 'ripple', 'coolDownMs', 'stallA', 'shortA', 'pwm', 'fault']) assert.ok(k in r, k);
});

test('render: 120 W fan peaks 4x decaying over ~170 ms, stallA = kLR * steady', () => {
  const r = render(instantiate('radiator_fan', { preset: '120 W' }));
  const rated = 120 / 13.8;
  assert.ok(Math.abs(r.table[0] / rated - 4) < 0.01);
  assert.ok(r.table[170] / rated < 2.3 && r.table[170] / rated > 1.8);
  assert.ok(Math.abs(r.stallA - 4 * rated) < 0.01);
  assert.ok(r.ripple.hz > 0);
});

test('render: blocked pump has stallA and the stall fault preset', () => {
  const inst = instantiate('blocked_pump');
  assert.deepEqual(inst.fault, { kind: 'stall', atMs: 0 });
  const r = render(inst);
  assert.ok(Math.abs(r.stallA - 4 * 60 / 13.8) < 0.01);
});

test('render: LED spike 1 ms, coil rises exponentially, periodic strobe loops', () => {
  const led = render(instantiate('led_light_bar', { preset: '72 W' }));
  assert.equal(led.table.length, 2);
  assert.ok(Math.abs(led.table[0] / led.table[1] - 3) < 0.05);
  const coil = render(instantiate('solenoid_valve', { preset: '20 W' }), { tableMs: 1 });
  assert.equal(coil.table[0], 0);
  for (let k = 1; k < coil.table.length; k++) assert.ok(coil.table[k] >= coil.table[k - 1]);
  assert.ok(coil.table[15] / coil.steadyA > 0.6 && coil.table[15] / coil.steadyA < 0.66);
  const strobe = render(instantiate('led_strobe'));
  assert.equal(strobe.loopMs, 500);
  assert.equal(strobe.table.length, 500);
});

test('render: slow curves stop at the horizon without a step', () => {
  const r = render(instantiate('seat_heater'), { tableMs: 100, horizonMs: 600000 });
  assert.ok(r.steadyA < 0.76 * 50 / 13.8);
  const short = render(instantiate('seat_heater'), { tableMs: 10, horizonMs: 1000 });
  assert.equal(short.settled, false);
  assert.equal(short.steadyA, short.table.at(-1));
});

// Typical vehicle output names (multipliers, composites, L+R, plural relays) and the components they must map to.
const OUTPUT_NAMES = [
  ['Low Beam x2', 2, ['halogen_headlight:H4 low 55 W']],
  ['High Beam x2', 2, ['halogen_headlight:H4 high 60 W']],
  ['Front Position', 1, ['halogen_signal_bulb:W5W 5 W']],
  ['Front Indicator', 1, ['halogen_signal_bulb:PY21W 21 W']],
  ['Front Sidemarker', 1, ['halogen_signal_bulb:W5W 5 W']],
  ['Horn', 1, ['horn:40 W']],
  ['Coolant Fan', 1, ['radiator_fan']],
  ['Fuel Pump', 1, ['fuel_pump:255 lph 60 W']],
  ['Rear Position + Plate', 1, ['halogen_signal_bulb:W5W 5 W', 'halogen_signal_bulb:licence 5 W']],
  ['Rear Indicator', 1, ['halogen_signal_bulb:PY21W 21 W']],
  ['Brake Light', 1, ['halogen_signal_bulb:P21W 21 W']],
  ['Reverse Light', 1, ['halogen_signal_bulb:P21W 21 W']],
  ['HVAC Blower', 1, ['hvac_blower']],
  ['Seat Heating L+R', 1, ['seat_heater:50 W', 'seat_heater:50 W']],
  ['Interior Lighting', 1, ['halogen_signal_bulb:C5W 5 W']],
  ['Dash Display + Radio', 1, ['dash_display', 'head_unit:radio 30 W']],
  ['Wiper Motor', 1, ['wiper_motor']],
  ['Washer Pump', 1, ['washer_pump']],
  ['ECU + O2 Relay Triggers', 1, ['ecu:20 W', 'relay_coil', 'relay_coil']],
];

test('matchKeyword maps typical vehicle output names', () => {
  for (const [name, mult, parts] of OUTPUT_NAMES) {
    const m = matchKeyword(name);
    const got = m.parts.map((p) => p.id + (p.presetName ? ':' + p.presetName : ''));
    assert.deepEqual(got, parts, name);
    assert.equal(m.multiplier, mult, name);
    assert.equal(m.id, m.parts[0].id);
    assert.equal(m.guess, false, name);
    for (const p of m.parts) if (p.presetName) instantiate(p.id, { preset: p.presetName });   // presets exist
  }
});

test('matchKeyword: multiplier spellings, composites, case, LED, fallback', () => {
  assert.equal(matchKeyword('Low Beam ×2').multiplier, 2);
  assert.equal(matchKeyword('2x Fog').multiplier, 2);
  assert.equal(matchKeyword('FOG X3').multiplier, 3);
  assert.equal(matchKeyword('Tail & Plate').parts.length, 2);
  assert.deepEqual(matchKeyword('Horn and Fan').parts.map((p) => p.id), ['horn', 'radiator_fan']);
  assert.equal(matchKeyword('LED Light Bar').id, 'led_light_bar');
  assert.equal(matchKeyword('LED Tail').id, 'led_signal_lamp');
  assert.equal(matchKeyword('Radio').id, 'head_unit');                    // "rad" must not grab radio
  assert.equal(matchKeyword('Left Indicator').id, 'halogen_signal_bulb'); // "left" is not "led"
  const g = matchKeyword('Spare - Trailer/Tow');
  assert.deepEqual(g, { id: 'generic_resistive', multiplier: 1, parts: [{ id: 'generic_resistive' }], guess: true });
  assert.equal(matchKeyword('').guess, true);
});

test('per-load inrush overrides: params replace the defaults, inrushOf reports both', async () => {
  const { inrushOf } = await import('../lib/components.js');
  const o = { preset: 'H4 low 55 W' };
  const r = render(instantiate('halogen_headlight', { ...o, params: { kCold: 4, tauMs: 10 } }));
  assert.ok(Math.abs(r.table[0] - 4 * 3.99) < 0.1);
  const i = inrushOf('halogen_headlight', { ...o, params: { kCold: 4 } });
  assert.deepEqual([i.xKey, i.msKey, i.x, i.effX], ['kCold', 'tauMs', 5, 4]);
  // junk and unknown keys are ignored
  assert.equal(instantiate('halogen_headlight', { ...o, params: { kCold: -3, bogus: 9 } }).params.kCold, 5);
  assert.equal(inrushOf('generic_resistive'), null);
});
