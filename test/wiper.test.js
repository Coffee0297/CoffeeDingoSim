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

test('wiper (Ford concealed park): RUN off reverses it to the concealed park, the switch closes only there', () => {
  const o = { powered: true, run: false, speed: false, dtS: 0.1, park: 'ford' };
  let r = { angleDeg: 200, concealed: false };
  r = stepWiper(r.angleDeg, { ...o, concealed: r.concealed });
  assert.equal(r.dir, -1);                          // runs backwards
  assert.ok(r.angleDeg < 200 && !r.park);
  for (let i = 0; i < 50 && !r.concealed; i++) r = stepWiper(r.angleDeg, { ...o, concealed: r.concealed });
  assert.deepEqual([r.angleDeg, r.concealed, r.park], [0, true, true]);
  r = stepWiper(r.angleDeg, { ...o, concealed: r.concealed });
  assert.equal(r.moving, false);                    // stays concealed
  // 10 deg past park when switched off: back the short way, not a whole turn
  r = stepWiper(10, { ...o, concealed: false });
  assert.deepEqual([r.angleDeg, r.concealed], [0, true]);
});

test('wiper (Ford concealed park): RUN on leaves the concealed park forward; no power, no motion', () => {
  const r = stepWiper(0, { powered: true, run: true, speed: true, dtS: 0.1, park: 'ford', concealed: true });
  assert.deepEqual([r.dir, r.concealed, r.park], [1, false, false]);
  assert.equal(r.angleDeg.toFixed(1), (360 * 1.2 * 0.1).toFixed(1));
  const s = stepWiper(120, { powered: false, run: false, speed: false, dtS: 0.1, park: 'ford', concealed: false });
  assert.deepEqual([s.angleDeg, s.moving], [120, false]);
});
