// CAN generator DBCs: an uploaded file is stored in the scene and listed with its signal ranges; a frame the
// Sim injects reaches the dingoConfig bridge too (the hub does not echo it to its sender).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeBridge, until } from './fakes/fake_bridge.js';

const DBC = `VERSION ""
BO_ 1522 CANTCU_3: 8 Vector__XXX
 SG_ TCU_Gear : 16|8@1- (1,0) [-3|8] "GearNumber" Vector__XXX
`;

test('dbc upload: saved in the scene, messages listed with ranges, a non-DBC refused', async () => {
  process.env.SIM_SCENES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'simdbc-'));
  const { saveDbc, readDbc } = await import('../server/dbcfiles.js');
  const r = saveDbc('../evil/CANTCU.dbc', DBC);
  assert.match(r.path, /dbc\/CANTCU\.dbc$/);
  assert.deepEqual(r.messages[0].signals[0], { name: 'TCU_Gear', min: -3, max: 8, factor: 1, unit: 'GearNumber', values: null });
  assert.equal(readDbc(path.join(process.env.SIM_SCENES_DIR, 'default', 'dbc', 'CANTCU.dbc')).messages[0].id, 1522);
  assert.throws(() => saveDbc('x.dbc', 'hello'), /No messages/);
});

test('bus: an injected frame is handed to the bridge as a line', async () => {
  const { createBus } = await import('../server/bus.js');
  const fake = await startFakeBridge();
  const bus = await createBus({ port: fake.port, flushIntervalMs: 0, sleepAfterMs: 0 });
  const lines = [];
  bus.on('line', (l) => lines.push(l));
  bus.start();
  await until(() => bus.connected);
  bus.inject({ id: 0x5f2, dlc: 8, data: [0, 0, 0xff, 0, 0, 0, 0, 0] }, 'cangen');
  await until(() => lines.length > 0);
  assert.equal(lines[0], 't5F280000FF0000000000');
  bus.stop();
  await fake.close?.();
});

test('project import: an ECU from the project gets a DBC rebuilt from its signals', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'simproj-'));
  process.env.SIM_SCENES_DIR = dir;
  const proj = JSON.parse(fs.readFileSync(new URL('./fixtures/upstream-0.3.0.json', import.meta.url), 'utf8'));
  proj.DbcDevices = [{ name: 'CANTCU', dbcSignal: [{ name: 'TCU_Gear', id: 1522, extended: false, message: 'CANTCU_3', startBit: 16, length: 8, byteOrder: 0, isSigned: true, factor: 1, offset: 0, unit: '', min: -3, max: 8 }] }];
  const file = path.join(dir, 'proj.json');
  fs.writeFileSync(file, JSON.stringify(proj));
  const { importProject } = await import('../server/project.js');
  const { scene } = await importProject(file, { name: 'p' });
  const gen = scene.nodes.find((n) => n.type === 'cangen');
  assert.match(gen.data.dbc, /CANTCU\.dbc$/);
  const { parseDbc, encode } = await import('../lib/dbc.js');
  const { ROOT } = await import('../server/state.js');
  const db = parseDbc(fs.readFileSync(path.resolve(ROOT, gen.data.dbc), 'utf8'));
  assert.deepEqual(Array.from(encode(db, 1522, { TCU_Gear: -1 }).data), [0, 0, 0xff, 0, 0, 0, 0, 0]);
});

test('bus: a module that says goodbye is asleep, not silent (no CPU diagnosis while it resets out of STOP)', async () => {
  const { createBus } = await import('../server/bus.js');
  const bus = await createBus({ flushIntervalMs: 0, sleepAfterMs: 0 });
  bus.setModules([{ id: 'CB-1', kind: 'canboard', baseId: 0x660 }]);
  bus.feedLine('t66088000000000000000');   // ordinary config reply
  assert.equal(bus.telemetryOf('CB-1').asleep, false);
  bus.feedLine('t6608205A5A5A02000000');   // goodbye: [Sleep, 'Z', 'Z', 'Z', why]
  assert.equal(bus.telemetryOf('CB-1').asleep, true);
  bus.feedLine('t6628FB01F501F101E401');   // talking again: awake
  assert.equal(bus.telemetryOf('CB-1').asleep, false);
});
