import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepWiper, isParked } from '../lib/wiper.js';

test('wiper: runs with power + RUN, fast with SPEED, nothing without power', () => {
  assert.equal(stepWiper(0, { powered: true, run: true, speed: false, dtS: 0.1 }).angleDeg.toFixed(1), (360 * 0.7 * 0.1).toFixed(1));
  assert.equal(stepWiper(0, { powered: true, run: true, speed: true, dtS: 0.1 }).angleDeg.toFixed(1), (360 * 1.2 * 0.1).toFixed(1));
  assert.equal(stepWiper(90, { powered: false, run: true, speed: false, dtS: 0.1 }).angleDeg, 90);
  assert.equal(stepWiper(90, { powered: true, run: true, speed: false, dtS: 0 }).moving, false);   // paused emulation
});

test('wiper: RUN off mid-sweep parks it, then it stays parked', () => {
  let a = 200;
  for (let i = 0; i < 50; i++) a = stepWiper(a, { powered: true, run: false, speed: false, dtS: 0.1 }).angleDeg;
  assert.equal(a, 0);
  assert.ok(isParked(a));
  assert.equal(stepWiper(a, { powered: true, run: false, speed: false, dtS: 0.1 }).moving, false);
});
