import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheck, saturationA, noiseFloorA } from '../lib/precheck.js';
import { instantiate, render } from '../lib/components.js';

const load = (id, opts) => render(instantiate(id, opts));
const has = (msgs, level, re) => msgs.some((m) => m.level === level && re.test(m.text));

test('saturation per Profet from kILIS', () => {
  assert.ok(Math.abs(saturationA(22950) - 63.11) < 0.01);
  assert.ok(Math.abs(saturationA(5950) - 16.36) < 0.01);
  assert.ok(Math.abs(saturationA(35000) - 96.25) < 0.01);
  assert.equal(noiseFloorA(5950), 0.2);
});

test('2 A output, 50 A / 1000 ms inrush on outputs 3-8: limit can never trip', () => {
  const msgs = precheck([load('halogen_signal_bulb', { preset: 'W5W 5 W' })], { currentLimit: 2, inrushCurrentLimit: 50, inrushTime: 1000 }, 5950);
  assert.ok(has(msgs, 'info', /never trip/));
  assert.ok(!msgs.some((m) => m.level === 'warn'));
});

test('one 55 W low beam on a PDM out 1 (12 A, 50 A / 1000 ms) passes', () => {
  const msgs = precheck([load('halogen_headlight', { preset: 'H4 low 55 W' })], { currentLimit: 12, inrushCurrentLimit: 50, inrushTime: 1000 }, 22950);
  assert.deepEqual(msgs, []);
});

test('"Low Beam x2": two H4 filaments (~40 A) stay under the 50 A inrush limit', () => {
  const l = load('halogen_headlight', { preset: 'H4 low 55 W' });
  assert.deepEqual(precheck([l, l], { currentLimit: 12, inrushCurrentLimit: 50, inrushTime: 1000 }, 22950).filter((m) => m.level === 'warn'), []);
});

test('a harsher user inrush (10x) on two H4s saturates the sense and trips the 50 A limit', () => {
  const l = load('halogen_headlight', { preset: 'H4 low 55 W', params: { kCold: 10 } });
  const msgs = precheck([l, l], { currentLimit: 12, inrushCurrentLimit: 50, inrushTime: 1000 }, 22950);
  assert.ok(has(msgs, 'warn', /exceeds the inrush limit 50 A/), JSON.stringify(msgs));
  assert.ok(has(msgs, 'info', /reads 63\.1 A/));
});

test('peak over the inrush limit warns', () => {
  const msgs = precheck([load('halogen_headlight', { preset: 'H4 low 55 W' })], { currentLimit: 12, inrushCurrentLimit: 15, inrushTime: 1000 }, 22950);
  assert.ok(has(msgs, 'warn', /exceeds the inrush limit/));
});

test('steady over the current limit warns; still high after a short inrush window warns', () => {
  const fan = load('radiator_fan', { preset: '180 W' });
  assert.ok(has(precheck([fan], { currentLimit: 10, inrushCurrentLimit: 60, inrushTime: 1000 }, 22950), 'warn', /steady 13 A exceeds/));
  assert.ok(has(precheck([fan], { currentLimit: 15, inrushCurrentLimit: 80, inrushTime: 100 }, 22950), 'warn', /after the 100 ms inrush window/));
});

test('180 W fan on out 3-8 reads saturated', () => {
  const msgs = precheck([load('radiator_fan', { preset: '180 W' })], { currentLimit: 20, inrushCurrentLimit: 15, inrushTime: 1000 }, 5950);
  assert.ok(has(msgs, 'info', /reads 16\.4 A/));
});

test('open-load floor and noise floor', () => {
  const relay = load('relay_coil');
  assert.ok(has(precheck([relay], { currentLimit: 2, openLoadLimit: 0.5 }, 5950), 'warn', /OpenLoad/));
  assert.ok(has(precheck([relay], { currentLimit: 2 }, 5950), 'info', /noise floor/));
  assert.deepEqual(precheck([], { currentLimit: 2 }, 5950), []);
});

test('PWM on a non-PWM-able load warns', () => {
  assert.ok(has(precheck([load('hid_headlight')], { currentLimit: 10, pwmEnabled: true }, 22950), 'warn', /PWM/));
});

test('two 60 W H4 high beams (~44 A) stay under a 50 A inrush limit', () => {
  const l = load('halogen_headlight', { preset: 'H4 high 60 W' });
  assert.deepEqual(precheck([l, l], { currentLimit: 12, inrushCurrentLimit: 50, inrushTime: 1000 }, 22950).filter((m) => m.level === 'warn'), []);
});
