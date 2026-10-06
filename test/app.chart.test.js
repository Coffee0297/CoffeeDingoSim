import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  niceStep, autoscale, makeScale, pushTrace, decimate, toBands, sampleAt, fmtA, fmtT, thumbnailCurve, drawSeries,
} from '../app/src/chart.js';

test('niceStep picks 1/2/5 × 10^k', () => {
  assert.equal(niceStep(10, 5), 2);
  assert.equal(niceStep(100, 5), 20);
  assert.ok(Math.abs(niceStep(1, 5) - 0.2) < 1e-12);
  assert.equal(niceStep(37, 5), 5);
  assert.ok(Math.abs(niceStep(0.9, 4) - 0.2) < 1e-12);
  assert.equal(niceStep(0, 5), 1);      // degenerate range
  assert.equal(niceStep(NaN, 5), 1);
});

test('autoscale includes zero, pads and rounds to the step', () => {
  const a = autoscale(0.8, 36.5);
  assert.equal(a.min, 0);
  assert.ok(a.max >= 36.5 * 1.1 - 1e-9, 'top padded by 10 %');
  assert.ok(Math.abs(a.max / a.step - Math.round(a.max / a.step)) < 1e-9, 'max lands on a tick');
  // idle trace does not zoom into noise
  const idle = autoscale(0, 0.02);
  assert.ok(idle.max >= 1, 'floorMax keeps a 1 A axis');
  // negative values extend the bottom
  const neg = autoscale(-3, 2);
  assert.ok(neg.min <= -3);
  // non-finite input is safe
  const nan = autoscale(Infinity, -Infinity);
  assert.equal(nan.min, 0); assert.ok(nan.max > 0);
});

test('makeScale maps linearly and inverts', () => {
  const x = makeScale(0, 30, 40, 340);
  assert.equal(x(0), 40);
  assert.equal(x(30), 340);
  assert.equal(x(15), 190);
  assert.equal(x.invert(190), 15);
  const y = makeScale(0, 10, 100, 0); // flipped (canvas y grows downwards)
  assert.equal(y(0), 100);
  assert.equal(y(10), 0);
  assert.equal(y(2.5), 75);
  const z = makeScale(5, 5, 0, 10);   // zero span must not divide by zero
  assert.ok(Number.isFinite(z(5)));
});

test('pushTrace keeps a 30 s window and resets on time going backwards', () => {
  const buf = [];
  for (let i = 0; i <= 450; i++) pushTrace(buf, i / 10, Math.sin(i / 10), 30);
  assert.ok(buf.length <= 302 && buf.length >= 299, `window kept ~300 samples at 10 Hz, got ${buf.length}`);
  assert.ok(buf[0][0] >= 15 - 1e-9, 'oldest sample inside 30 s horizon');
  assert.equal(buf[buf.length - 1][0], 45);
  pushTrace(buf, 0.5, 1, 30); // Renode reset → vtime restarts
  assert.equal(buf.length, 1);
  assert.deepEqual(buf[0], [0.5, 1]);
});

test('decimate preserves min and max of each bucket', () => {
  const pts = [];
  for (let i = 0; i < 10000; i++) pts.push([i / 1000, i === 5000 ? 40 : 1 + 0.1 * Math.sin(i)]);
  const out = decimate(pts, 200);
  assert.ok(out.length <= 200);
  assert.ok(out.some((p) => p[1] === 40), 'spike survives decimation');
  for (let i = 1; i < out.length; i++) assert.ok(out[i][0] >= out[i - 1][0], 'chronological');
  const small = pts.slice(0, 50);
  assert.equal(decimate(small, 100), small, 'short input passes through untouched');
});

test('toBands collapses runs of equal states', () => {
  const b = toBands([[0, 'Off'], [1, 'Off'], [2, 'On'], [3, 'On'], [4, 'Overcurrent'], [5, 'Fault']], 6);
  assert.deepEqual(b, [
    { t0: 0, t1: 2, state: 'Off' },
    { t0: 2, t1: 4, state: 'On' },
    { t0: 4, t1: 5, state: 'Overcurrent' },
    { t0: 5, t1: 6, state: 'Fault' },
  ]);
  assert.deepEqual(toBands([], 1), []);
});

test('sampleAt finds the nearest sample', () => {
  const pts = [[0, 0], [1, 10], [2, 20], [3, 30]];
  assert.deepEqual(sampleAt(pts, 1.4), [1, 10]);
  assert.deepEqual(sampleAt(pts, 1.6), [2, 20]);
  assert.deepEqual(sampleAt(pts, -5), [0, 0]);
  assert.deepEqual(sampleAt(pts, 99), [3, 30]);
  assert.equal(sampleAt([], 1), null);
});

test('formatters', () => {
  assert.equal(fmtA(3.987), '3.99 A');
  assert.equal(fmtA(36.4), '36.4 A');
  assert.equal(fmtA(null), '—');
  assert.equal(fmtT(0), '0:00.0');
  assert.equal(fmtT(75.25), '1:15.3');
  assert.equal(fmtT(NaN), '—');
});

test('thumbnailCurve scales with steady current and starts at the inrush', () => {
  const c = thumbnailCurve('filament', 4);
  assert.equal(c[0][0], 0);
  assert.ok(c[0][1] > 30 && c[0][1] <= 40, `filament cold peak ~10× (${c[0][1]})`);
  assert.ok(Math.abs(c[c.length - 1][1] - 4) < 0.05, 'settles to steady');
  assert.ok(thumbnailCurve('resistive', 2).every((p) => p[1] === 2));
});

test('drawSeries runs against a stub context and returns consistent scales', () => {
  // minimal CanvasRenderingContext2D stand-in so the drawing code path is exercised in node
  const calls = [];
  const ctx = new Proxy({}, {
    get: (_, k) => (typeof k === 'string' ? (...a) => { calls.push(k); return undefined; } : undefined),
    set: () => true,
  });
  const pts = [];
  for (let i = 0; i <= 300; i++) { const t = i / 10; pts.push([t, t < 1 ? 36 * Math.exp(-t / 0.05) + 4 : 4]); }
  const r = drawSeries(ctx, [{ points: pts, color: '#fff' }], {
    width: 400, height: 200, tMin: 0, tMax: 30,
    bands: [{ t0: 0, t1: 10, state: 'Off' }, { t0: 10, t1: 30, state: 'On' }],
    hoverT: 12,
  });
  assert.equal(r.yMin, 0);
  assert.ok(r.yMax >= 40, 'autoscaled above the 40 A peak');
  assert.equal(Math.round(r.xOf(0)), r.plot.x);
  assert.equal(Math.round(r.xOf(30)), r.plot.x + r.plot.w);
  assert.ok(Math.abs(r.tOf(r.xOf(12)) - 12) < 1e-9, 'tOf inverts xOf');
  assert.ok(calls.includes('stroke') && calls.includes('fillRect') && calls.includes('clip'));
  // sparkline mode: no axis text drawn
  calls.length = 0;
  const m = drawSeries(ctx, [{ points: pts, color: '#fff' }], { width: 80, height: 24, mini: true });
  assert.ok(!calls.includes('fillText'));
  assert.equal(m.plot.x, 2);
});
