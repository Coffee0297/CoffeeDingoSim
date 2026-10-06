import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, resolveParams, iPu, steadyPu, FAMILIES } from '../lib/shapes.js';

test('evaluator: arithmetic, precedence, W/A, min/max', () => {
  assert.equal(evaluate('10 + 0.6*W', { W: 55 }), 43);
  assert.equal(evaluate('80 + 1.5*W', { W: 120 }), 260);
  assert.equal(evaluate('(1 + 2) * 3 - 4 / 2'), 7);
  assert.equal(evaluate('-A + 2', { A: 5 }), -3);
  assert.equal(evaluate('min(W, 100) + max(1, A)', { W: 300, A: 0.5 }), 101);
  assert.equal(evaluate('1.5e2'), 150);
  assert.equal(evaluate(42), 42);
});

test('evaluator rejects anything outside the grammar', () => {
  for (const bad of ['process.exit()', 'W; 1', 'constructor', 'W**2', 'alert(1)', '1 +', '(1', 'min(1)', 'X + 1',
    '"a"', 'W[0]', '`x`', '2 2', 'Math.max(1,2)', 'this', '1 ? 2 : 3']) {
    assert.throws(() => evaluate(bad, { W: 1, A: 1 }), `should reject ${bad}`);
  }
  assert.throws(() => evaluate('W + 1', {}), /not defined/);
  assert.throws(() => evaluate('1/0'), /finite/);
  assert.throws(() => evaluate({}), TypeError);
});

test('resolveParams evaluates only strings', () => {
  assert.deepEqual(resolveParams({ kCold: 10, tauMs: '10 + 0.6*W' }, { W: 100, A: 7 }), { kCold: 10, tauMs: 70 });
});

test('every family returns finite per-unit values', () => {
  for (const f of FAMILIES) {
    for (const t of [0, 1, 10, 100, 1000, 10000]) {
      const v = iPu(f, {}, t);
      assert.ok(Number.isFinite(v) && v >= 0, `${f} @ ${t} = ${v}`);
    }
    assert.ok(Number.isFinite(steadyPu(f, {})));
  }
  assert.throws(() => iPu('nope', {}, 0));
});

test('family shapes match the documented curves', () => {
  assert.equal(iPu('filament', { kCold: 10, tauMs: 43 }, 0), 10);
  assert.ok(Math.abs(iPu('filament', { kCold: 10, tauMs: 43 }, 1000) - 1) < 1e-6);
  assert.equal(iPu('led', {}, 0), 6);
  assert.equal(iPu('led', {}, 1), 1);
  assert.equal(iPu('electronics', {}, 0), 8);
  assert.ok(iPu('coil', { tauMs: 5 }, 0) === 0 && iPu('coil', { tauMs: 5 }, 5) > 0.6 && iPu('coil', { tauMs: 5 }, 5) < 0.65);
  assert.equal(iPu('solenoid2', {}, 50), 4);
  assert.equal(iPu('solenoid2', {}, 100), 1);
  assert.equal(iPu('actuator', { kLR: 5, tauMs: 100, travelMs: 300 }, 400), 5);
  assert.ok(iPu('heater', {}, 600000) < 0.76);
  assert.equal(iPu('strobe', {}, 10), 1);
  assert.equal(iPu('strobe', {}, 100), 0);
  assert.ok(iPu('compressor', {}, 60000) > 1.3);
  assert.equal(iPu('table', { points: [[0, 10], [10, 4]], ratedA: 4 }, 5), 1.75);
  assert.equal(iPu('table', { points: [[0, 10], [10, 4]], ratedA: 4 }, 50), 1);
});
