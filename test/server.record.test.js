// Stimulus helpers (keypad layouts, switch levels, rotary noise) and record / replay / diff.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// state.js reads SIM_SCENES_DIR at import time: set it before importing anything from server/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
process.env.SIM_SCENES_DIR = tmp;
const { keypadButtonFrame, decodeBlinkLeds, decodeGrayhillLeds, switchPinValue, rotaryMv, moduleLinks } = await import('../server/stimulus.js');
const { createRecorder, replay, diffRuns, formatDiff, runFileName } = await import('../server/record.js');
const { SCENES_DIR } = await import('../server/state.js');

test('keypad button frame: nodeId + 0x180, bit i of byte i/8', () => {
  const f = keypadButtonFrame({ nodeId: 21, pressed: [true, false, false, true, false, false, false, false, true] });
  assert.equal(f.id, 0x195);
  assert.deepEqual(f.data, [0x09, 0x01, 0, 0, 0, 0, 0, 0]);
});

test('Blink LED decode: padded layout and the stacked 12-key layout', () => {
  // 10 keys → 2 bytes per colour: red bytes 0-1, green 2-3, blue 4-5. key 9 = blue (byte 5 bit 1)
  const d = [0x01, 0x00, 0x00, 0x00, 0x00, 0x02, 0, 0];
  const c = decodeBlinkLeds(d, 10);
  assert.equal(c[0], 1);
  assert.equal(c[9], 4);
  // 12-key stacked: red bits 0..11, green 12..23, blue 24..35 → key 0 green = bit 12 = byte1 bit4
  const s = decodeBlinkLeds([0x00, 0x10, 0, 0, 0, 0, 0, 0], 12);
  assert.equal(s[0], 2);
});

test('Grayhill LED decode: 3 bits per button, stacked', () => {
  // button 0 = 0b101, button 1 = 0b010 → bits 0..5 = 1,0,1,0,1,0 → 0x15
  const g = decodeGrayhillLeds([0x15, 0, 0, 0, 0, 0, 0, 0], 6);
  assert.deepEqual(g.slice(0, 3), [5, 2, 0]);
});

test('switch levels and rotary noise', () => {
  assert.equal(switchPinValue('12v', true), 1);
  assert.equal(switchPinValue('12v', false), 0);
  assert.equal(switchPinValue('gnd', true), 0);
  assert.equal(switchPinValue('gnd', false), 1);
  const data = { positions: [{ name: 'OFF', mV: 500 }, { name: 'Low', mV: 2500 }], noiseMv: 20 };
  assert.equal(rotaryMv(data, 1, () => 0.5), 2500);
  assert.equal(rotaryMv(data, 1, () => 1), 2520);
  assert.equal(rotaryMv(data, 5), null);
});

test('moduleLinks follows edges in either direction', () => {
  const scene = { modules: [{ id: 'PDM-01' }], edges: [{ from: { node: 'PDM-01', handle: 'di:2' }, to: { node: 'n2', handle: 'contact' } }] };
  assert.deepEqual(moduleLinks(scene, 'n2', 'di:').map((l) => [l.module, l.n]), [['PDM-01', 2]]);
});

function tel(module, state, currentA, ocCount = 0, asleep = false) {
  return { module, outputs: [{ n: 1, state, currentA, ocCount, duty: 100 }], asleep };
}

test('record → replay with RunFor steps → diff', async () => {
  assert.equal(SCENES_DIR, tmp);
  let vt = 100;
  const rec = createRecorder({ getVtime: () => vt, getSceneName: () => 'rectest' });
  rec.start();
  rec.action({ kind: 'switch', node: 'n2', state: true });
  rec.telemetry(tel('PDM-01', 'On', 4.0));
  vt = 100.3;
  rec.action({ kind: 'fault', node: 'n1', fault: { kind: 'stall' } });
  rec.telemetry(tel('PDM-01', 'Overcurrent', 20, 1));
  vt = 100.5;
  rec.telemetry(tel('PDM-01', 'Fault', 0, 1));
  const name = rec.stop();
  assert.match(name, /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.run\.json$/);
  const file = path.join(SCENES_DIR, 'rectest', 'runs', name);
  const golden = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(golden.actions.length, 2);
  assert.equal(golden.actions[1].t, 0.3);
  assert.equal(golden.durationS, 0.5);

  // replay: actions re-issued at their vtimes, Renode advanced in 0.1 s steps
  const applied = [], steps = [];
  let rvt = 0;
  const rec2 = createRecorder({ getVtime: () => rvt, getSceneName: () => 'rectest' });
  const outName = await replay(golden, {
    recorder: rec2,
    apply: (a) => { applied.push({ t: Math.round(rvt * 10) / 10, kind: a.kind }); rec2.telemetry(tel('PDM-01', a.kind === 'fault' ? 'Overcurrent' : 'On', a.kind === 'fault' ? 20 : 4.05, a.kind === 'fault' ? 1 : 0)); },
    runFor: async (s) => { steps.push(s); rvt += s; },
  }, { stepS: 0.1 });
  assert.deepEqual(applied, [{ t: 0, kind: 'switch' }, { t: 0.3, kind: 'fault' }]);
  assert.equal(steps.length, 5);
  const run = JSON.parse(fs.readFileSync(path.join(SCENES_DIR, 'rectest', 'runs', outName), 'utf8'));
  assert.equal(run.actions.length, 2);

  // the replayed run never reached Fault → state sequence differs
  const d = diffRuns(golden, run, { tolPct: 50 });
  assert.equal(d.ok, false);
  assert.ok(d.rows.some((r) => r.what === 'states' && r.module === 'PDM-01' && r.n === 1));
  assert.match(formatDiff(d), /PDM-01/);
  // identical runs diff clean
  assert.equal(diffRuns(golden, golden).ok, true);
  assert.equal(runFileName(new Date('2026-10-06T10:00:00.123Z')), '2026-10-06T10-00-00.run.json');
});

test('diff: current RMS tolerance and oc counts', () => {
  const g = { telemetry: [tel('PDM-01', 'On', 4.0), tel('PDM-01', 'On', 4.0)] };
  const r = { telemetry: [tel('PDM-01', 'On', 4.3), tel('PDM-01', 'On', 4.3)] };
  assert.equal(diffRuns(g, r, { tolPct: 10, floorA: 0 }).ok, true);
  assert.equal(diffRuns(g, r, { tolPct: 5, floorA: 0 }).ok, false);
  const r2 = { telemetry: [tel('PDM-01', 'On', 4.0, 2), tel('PDM-01', 'On', 4.0, 2)] };
  const d = diffRuns(g, r2);
  assert.equal(d.ok, false);
  assert.equal(d.rows[0].what, 'ocCount');
  const missing = diffRuns(g, { telemetry: [] });
  assert.equal(missing.rows[0].what, 'present');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));
