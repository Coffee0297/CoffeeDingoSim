import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialState, step, signals, IDLE_RPM, CRANK_DIP_A } from '../lib/engine.js';
import { V, BATTERY_DEFAULTS } from '../lib/battery.js';

const run = (s, ms, inputs = {}, dt = 100) => { for (let t = 0; t < ms; t += dt) s = step(s, dt, inputs); return s; };

test('off -> ign -> crank (1 s, 150 A dip) -> run at idle', () => {
  let s = initialState();
  s = step(s, 100, { state: 'ign' });
  assert.equal(s.state, 'ign');
  s = step(s, 100, { state: 'crank' });
  assert.equal(s.state, 'crank');
  assert.equal(s.batteryDipA, CRANK_DIP_A);
  assert.equal(s.altOn, false);
  s = run(s, 900);
  assert.equal(s.state, 'run');
  assert.equal(s.batteryDipA, 0);
  assert.equal(s.altOn, true);
  s = run(s, 3000);
  assert.ok(Math.abs(s.rpm - IDLE_RPM) < 20);
  assert.ok(s.oilBar > 0.8 && s.oilBar < 1.3);
});

test('requesting run from off goes through crank', () => {
  assert.equal(step(initialState(), 10, { state: 'run' }).state, 'crank');
});

test('throttle raises RPM and oil pressure; off stops everything', () => {
  let s = run(step(initialState(), 1000, { state: 'run' }), 1000);
  s = run(s, 3000, { throttle: 50 });
  assert.ok(s.rpm > 3500 && s.rpm < 3700, `rpm ${s.rpm}`);
  assert.ok(s.oilBar > 3.5);
  s = run(s, 5000, { state: 'off' });
  assert.equal(s.state, 'off');
  assert.equal(s.rpm, 0);
  assert.equal(s.oilBar, 0);
  assert.equal(signals(s).TPS, 0);
});

test('coolant warms toward 95 C and a running fan pulls it toward 85 C', () => {
  let s = run(step(initialState(), 1000, { state: 'run' }), 1000);
  s = run(s, 1200000, {}, 1000);
  assert.ok(s.cltC > 94 && s.cltC <= 95, `clt ${s.cltC}`);
  s = run(s, 600000, { fanOn: true }, 1000);
  assert.ok(s.cltC < 89 && s.cltC > 84, `clt ${s.cltC}`);
});

test('signals expose the SimEngine.dbc names', () => {
  const s = run(step(initialState(), 1000, { state: 'run' }), 1000, { speedKph: 42.5, gear: 3, throttle: 10 });
  const sig = signals(s);
  assert.deepEqual(Object.keys(sig).sort(), ['CLT', 'Gear', 'OilP', 'RPM', 'Speed', 'TPS']);
  assert.equal(sig.Speed, 42.5);
  assert.equal(sig.Gear, 3);
  assert.equal(sig.TPS, 10);
});

test('battery: Voc - Ri*I, alternator holds altV', () => {
  assert.equal(V(12.6, 0.015, 0), 12.6);
  assert.ok(Math.abs(V(12.6, 0.015, 150) - 10.35) < 1e-9);
  assert.ok(Math.abs(V(12.6, 0.015, 50, 14.2, true) - 14.1) < 1e-9);
  assert.equal(V(12.6, 0.015, 10000), 0);
  assert.equal(V(), BATTERY_DEFAULTS.vocV);
});

test('SimEngine.dbc carries 0x200/0x201 at 100 ms with the agreed scaling', () => {
  const dbc = readFileSync(new URL('../renode/SimEngine.dbc', import.meta.url), 'utf8');
  assert.match(dbc, /^BO_ 512 \w+: 8 /m);
  assert.match(dbc, /^BO_ 513 \w+: 8 /m);
  assert.match(dbc, / SG_ RPM : 0\|16@1\+ \(0\.25,0\)/);
  assert.match(dbc, / SG_ CLT : 16\|8@1\+ \(1,-40\)/);
  assert.match(dbc, / SG_ OilP : 24\|8@1\+ \(0\.05,0\)/);
  assert.match(dbc, / SG_ TPS : 32\|8@1\+ \(0\.5,0\)/);
  assert.match(dbc, / SG_ Speed : 0\|16@1\+ \(0\.1,0\)/);
  assert.match(dbc, / SG_ Gear : 16\|8@1\+ \(1,0\)/);
  assert.match(dbc, /BA_ "GenMsgCycleTime" BO_ 512 100;/);
  assert.match(dbc, /BA_ "GenMsgCycleTime" BO_ 513 100;/);
});
