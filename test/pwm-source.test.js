import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pwmPinDuty } from '../server/stimulus.js';
import { pinConfig } from '../lib/populate.js';
import { applyAction, validateScene } from '../lib/scene.js';

test('pwm source: pin-high duty for a 12 V and an open-collector source', () => {
  assert.equal(pwmPinDuty('12v', 30, true), 30);
  assert.equal(pwmPinDuty('gnd', 30, true), 70);    // active = pulled low
  assert.equal(pwmPinDuty('12v', 30, false), 0);    // stopped: inactive level
  assert.equal(pwmPinDuty('gnd', 30, false), 100);  // stopped open collector: the pull-up holds it high
  assert.equal(pwmPinDuty('12v', 140, true), 100);
});

test('pwm source: a DI in PWM mode populates as a PWM source at its frequency', () => {
  const m = { inputs: [{ n: 1, name: 'Fan duty', enabled: true, mode: 0, pull: 1, pwm: true, pwmFreq: 250 },
                       { n: 2, name: 'Horn', enabled: true, mode: 1, pull: 0 }] };
  assert.deepEqual(pinConfig(m, 'di:1'), { type: 'pwmsrc', data: { name: 'Fan duty', level: 'gnd', duty: 50, freq: 250, on: true } });
  assert.equal(pinConfig({ inputs: [{ ...m.inputs[0], pwmFreq: 0 }] }, 'di:1').data.freq, 100);   // auto-detect
  assert.equal(pinConfig(m, 'di:2').type, 'switch');
});

test('pwm source: action clamps duty/freq and the node type is valid', () => {
  const scene = { modules: [], nodes: [{ id: 'p1', type: 'pwmsrc', data: { duty: 50, freq: 100, on: true } }], edges: [] };
  const s2 = applyAction(scene, { kind: 'pwm', node: 'p1', duty: 120, freq: -5, on: false });
  assert.deepEqual(s2.nodes[0].data, { duty: 100, freq: 0, on: false });
  assert.deepEqual(validateScene({ version: 1, name: 't', ...s2 }), []);
});
