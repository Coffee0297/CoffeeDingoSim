import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProject, parseProjectFull } from '../lib/project.js';

const example = JSON.parse(readFileSync(new URL('../scenes/example/example-vehicle.json', import.meta.url), 'utf8'));

test('example vehicle: 2 PDMs + 1 CANBoard with project base ids', () => {
  const mods = parseProject(example);
  assert.deepEqual(
    mods.map((m) => [m.id, m.kind, m.baseId]),
    [
      ['PDM-01', 'pdm', 0x680],
      ['PDM-02', 'pdm', 0x6a0],
      ['CB-1', 'canboard', 0x660],
    ],
  );
  assert.deepEqual(
    mods.map((m) => m.pos.x),
    [0, 420, 840],
  );
  assert.deepEqual(mods.extras.dbcDevices, []);
  assert.equal(JSON.stringify(mods).includes('extras'), false); // extras not serialised into the scene
});

test('example vehicle: PDM output fields', () => {
  const pdm1 = parseProject(example).find((m) => m.id === 'PDM-01');
  assert.equal(pdm1.outputs.length, 8);
  assert.equal(pdm1.inputs.length, 2);
  assert.equal(pdm1.hasLua, false);
  const o1 = pdm1.outputs[0];
  assert.deepEqual(
    { ...o1 },
    {
      n: 1,
      name: 'Low Beam x2',
      enabled: true,
      currentLimit: 12,
      inrushCurrentLimit: 50,
      inrushTime: 1000,
      resetMode: 0,
      resetTime: 1000,
      resetCountLimit: 3,
      pwmEnabled: false,
      fixedDutyCycle: 100,
      frequency: 100,
      primaryOutput: -1,
      input: 0,
      warnLimit: 0,
      openLoadLimit: 0,
      openLoadTime: 1000,
    },
  );
  assert.deepEqual(pdm1.outputs.filter((o) => o.enabled).map((o) => o.n), [1, 2, 3, 4, 6, 7]);
  assert.equal(pdm1.outputs[7].enabled, false);
  const pdm2 = parseProject(example).find((m) => m.id === 'PDM-02');
  assert.deepEqual(pdm2.outputs.filter((o) => o.enabled).map((o) => [o.n, o.name]), [
    [1, 'Fuel Pump'], [3, 'Rear Position + Plate'], [4, 'Rear Indicator'], [5, 'Brake Light'], [6, 'Reverse Light'],
  ]);
});

test('example vehicle: CANBoard rotaries and digital outputs', () => {
  const mods = parseProject(example);
  const cb1 = mods.find((m) => m.id === 'CB-1');
  const rot = cb1.analogIn.filter((a) => a.enabled && a.rotary.enabled);
  assert.deepEqual(
    rot.map((a) => [a.n, a.name, a.rotary.numPos]),
    [
      [1, 'Headlights', 4],
      [2, 'Indicators', 4],
    ],
  );
  assert.deepEqual(rot[0].rotary.points, [500, 1500, 2500, 3500]);
  assert.deepEqual(rot[0].rotary.positionNames, ['OFF', 'Park', 'Low', 'High']);
  assert.deepEqual(rot[1].rotary.points, [500, 1800, 3200, 4500]);
  assert.deepEqual(rot[1].rotary.positionNames, ['OFF', 'Left', 'Right', 'Hazard']);
  assert.equal(rot[0].rotary.tolerance, 200);
  assert.equal(cb1.analogIn.length, 5);
  assert.equal(cb1.inputs.length, 8);
  assert.deepEqual(cb1.digitalOut.filter((d) => d.enabled), []);
  assert.equal(cb1.digitalOut.length, 4);
  assert.equal(cb1.outputs.length, 0);
});

test('tolerant of PascalCase, missing keys, PDM-Max, string input, duplicate names', () => {
  const cfg = {
    PdmDevices: [
      { Name: 'A', BaseId: 0x500, PdmType: 1, Outputs: [{ Number: 1, Name: 'Pump', Enabled: true, CurrentLimit: 30 }] },
      { Name: 'A', BaseId: 0x520 },
    ],
    CanBoardDevices: [{ BaseId: 0x640 }],
    GrayhillKeypads: [{ nodeId: 0x15 }],
  };
  const { modules, extras } = parseProjectFull(JSON.stringify(cfg));
  assert.deepEqual(
    modules.map((m) => [m.id, m.kind, m.baseId]),
    [
      ['A', 'pdm', 0x520],
      ['A-2', 'pdmmax', 0x500],
      ['CB-1', 'canboard', 0x640],
    ],
  );
  const max = modules[1];
  assert.equal(max.outputs[0].primaryOutput, -1);
  assert.equal(max.outputs[0].currentLimit, 30);
  assert.equal(max.outputs[0].resetMode, 0);
  assert.equal(extras.grayhillKeypads.length, 1);
  assert.deepEqual(parseProject({}), []);
});

test('upstream dingoConfig 0.3.0 save format: one Devices[] list typed by deviceType', async () => {
  const { parseProjectFull } = await import('../lib/project.js');
  const dev = (deviceType, name, baseId, extra = {}) => ({ type: null, deviceType, name, baseId, outputs: [], digitalIn: [], analogIn: [], digitalOut: [], ...extra });
  const out = { enabled: true, name: 'output1', number: 1, currentLimit: 12, inrushCurrentLimit: 50, inrushTime: 1000, resetMode: 0, input: 1 };
  const { modules, extras } = parseProjectFull({
    Devices: [dev(0, 'PDM-A', 1664, { outputs: [out] }), dev(1, 'MAX-A', 1700), dev(3, 'CB-A', 1632), dev(2, 'PT-A', 1800)],
    DbcDevices: [{ name: 'ECU' }], BlinkMarineKeypads: [], GrayhillKeypads: [],
  });
  assert.deepEqual(modules.map((m) => [m.id, m.kind, m.baseId]), [['PDM-A', 'pdm', 1664], ['MAX-A', 'pdmmax', 1700], ['CB-A', 'canboard', 1632]]);
  assert.equal(modules[0].outputs[0].currentLimit, 12);
  assert.equal(extras.dbcDevices.length, 1);
  assert.deepEqual(extras.skipped.map((s) => s.name), ['PT-A']);
});
