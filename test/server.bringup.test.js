// Bring-up sequencer (server/bringup.js) against a fake firmware on a fake bus, plus the bus id-span
// routing and the bank 'error' message fixes found in the end-to-end run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  outputDeployWrites, ioDeployWrites, deployWrites, deployHash, modulesToIsolate, configureModule, bringUp, readMarker, VAR_ALWAYS_TRUE,
} from '../server/bringup.js';
import { createBus } from '../server/bus.js';
import { startFakeBank } from './fakes/fake_bank.js';
import { until } from './fakes/fake_bridge.js';
import { createBank } from '../server/bank.js';

const pdm = (id, baseId, extra = {}) => ({
  id, kind: 'pdm', baseId,
  outputs: [
    { n: 1, enabled: true, currentLimit: 12, inrushCurrentLimit: 50, inrushTime: 1000, resetMode: 0, resetTime: 1000, resetCountLimit: 3, input: 217, primaryOutput: -1, openLoadLimit: 0 },
    { n: 2, enabled: false, currentLimit: 20 },
    { n: 3, enabled: true, currentLimit: 2.5, inrushCurrentLimit: 10, inrushTime: 500, resetMode: 1, resetTime: 2000, resetCountLimit: 5, input: 0, openLoadLimit: 0.2, openLoadTime: 800 },
  ],
  inputs: [{ n: 1, enabled: true, mode: 1, invert: true, pull: 2 }, { n: 2, enabled: false }],
  ...extra,
});
const f32 = (v) => { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v); return dv.getUint32(0); };

test('outputDeployWrites: enabled outputs only, limits first, input then enabled last, floats as IEEE bits', () => {
  const w = outputDeployWrites(pdm('PDM-01', 0x680));
  assert.ok(w.every((x) => x.n !== 2), 'disabled output untouched');
  const o1 = w.filter((x) => x.n === 1);
  assert.deepEqual(o1.map((x) => x.sub), [2, 3, 4, 5, 6, 7, 1, 0]);
  assert.equal(o1[0].index, 0x1000);
  assert.equal(o1.find((x) => x.sub === 1).value, 217, 'project input binding kept');
  assert.equal(o1[0].type, 'float');
  const o3 = w.filter((x) => x.n === 3);
  assert.equal(o3[0].index, 0x1002);
  assert.ok(o3.some((x) => x.sub === 19 && x.value === 0.2) && o3.some((x) => x.sub === 20 && x.value === 800), 'open-load floor deployed when set');
  const forced = outputDeployWrites(pdm('PDM-01', 0x680), { forceOutputsOn: true });
  assert.ok(forced.filter((x) => x.sub === 1).every((x) => x.value === VAR_ALWAYS_TRUE));
  assert.notEqual(deployHash(pdm('PDM-01', 0x680)), deployHash(pdm('PDM-01', 0x680), { forceOutputsOn: true }));
});

test('ioDeployWrites: enabled DIs (both boards), CANBoard DOs and AIs', () => {
  assert.deepEqual(ioDeployWrites(pdm('P', 0x680)).map((x) => [x.index, x.sub, x.value]), [[0x1200, 1, 1], [0x1200, 2, 1], [0x1200, 4, 2], [0x1200, 0, 1]]);
  const cb = { id: 'CB-2', kind: 'canboard', baseId: 0x670, inputs: [], digitalOut: [{ n: 1, enabled: true, input: 68 }, { n: 2, enabled: false }], analogIn: [{ n: 1, enabled: true }, { n: 2, enabled: false }] };
  assert.deepEqual(deployWrites(cb).map((x) => [x.index, x.sub, x.value]), [[0x2100, 1, 68], [0x2100, 0, 1], [0x2200, 0, 1]]);
});

/** Fake dingo firmware on a fake hub: base-id write takes effect at once, burn only on the NEW base+1. */
function fakeFirmware(bus, { base = 0x0de, boardId = 0, silent = false } = {}) {
  const fw = { base, params: new Map(), burns: [], writes: [], silent };
  bus.on('inject', (f) => {
    if (fw.silent || f.id !== fw.base + 1) return;
    const d = f.data;
    const idx = d[1] | (d[2] << 8), sub = d[3], val = (d[4] | (d[5] << 8) | (d[6] << 16) | (d[7] << 24)) >>> 0;
    const reply = (data) => setImmediate(() => bus.emit('frame', { id: fw.base, dlc: 8, data, dir: 'rx' }));
    if (d[0] === 31) reply([31, boardId, 0, 0, 5, 5, 0, 107]);
    else if (d[0] === 2) {
      fw.writes.push([idx, sub, val]);
      if (idx === 0 && sub === 0) fw.base = val; else fw.params.set(`${idx}/${sub}`, val);
      reply([2, idx & 0xff, idx >> 8, sub, ...[0, 8, 16, 24].map((s) => (val >>> s) & 0xff)]);
    } else if (d[0] === 30 && d[1] === 1 && d[2] === 3 && d[3] === 8) { fw.burns.push(f.id); reply([30, 1, 3, 8, 1, 0, 0, 0]); }
    else if (d[0] === 1) { const v = idx === 0 && sub === 0 ? fw.base : fw.params.get(`${idx}/${sub}`) ?? 0; reply([1, idx & 0xff, idx >> 8, sub, v & 0xff, (v >> 8) & 0xff, 0, 0]); }
  });
  return fw;
}
function fakeBus() {
  const bus = new EventEmitter();
  bus.inject = (f) => { bus.emit('frame', { ...f, dir: 'tx' }); bus.emit('inject', f); return true; };
  return bus;
}

test('configureModule: moves 0x0DE -> project base, writes on the new base, burns on NEW base+1, verifies', async () => {
  const bus = fakeBus();
  const fw = fakeFirmware(bus);
  const m = pdm('PDM-01', 0x680);
  const log = [];
  const r = await configureModule(bus, m, { forceOutputsOn: true }, { defaultBase: 0x0de, log: (l) => log.push(l), bootMs: 2000 });
  assert.equal(r.from, 0x0de);
  assert.equal(fw.base, 0x680);
  assert.deepEqual(fw.writes[0], [0, 0, 0x680], 'base id first');
  assert.deepEqual(fw.burns, [0x681], 'burn sent to the new base + 1');
  assert.equal(fw.params.get('4096/2'), f32(12), 'out1 current limit as float bits');
  assert.equal(fw.params.get('4096/1'), 1, 'out1 input forced to Always On');
  assert.equal(fw.params.get('4096/0'), 1, 'out1 enabled');
  assert.ok(!fw.params.has('4097/0'), 'disabled out2 untouched');
  assert.equal(r.writes, deployWrites(m, { forceOutputsOn: true }).length);
  assert.ok(log.some((l) => /base id 0xde -> 0x680/.test(l)));
});

test('configureModule: a module already on its project base (FRAM image) is not moved', async () => {
  const bus = fakeBus();
  const fw = fakeFirmware(bus, { base: 0x680 });
  const r = await configureModule(bus, pdm('PDM-01', 0x680), {}, { defaultBase: 0x0de, bootMs: 3000 });
  assert.equal(r.from, 0x680);
  assert.ok(!fw.writes.some(([i, s]) => i === 0 && s === 0));
});

test('bringUp: isolated modules one at a time, markers, then ok / redeploy on the next start', async () => {
  const nvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bringup-'));
  const scene = { globals: { forceOutputsOn: true }, modules: [pdm('PDM-01', 0x680), pdm('PDM-02', 0x6a0)] };
  assert.deepEqual(modulesToIsolate(scene.modules, nvDir), ['PDM-01', 'PDM-02']);
  const bus = fakeBus();
  // both modules boot at 0x0DE; only the one attached to the hub answers
  const fws = { 'PDM-01': fakeFirmware(bus, { silent: true }), 'PDM-02': fakeFirmware(bus, { silent: true }) };
  const attached = [];
  const renode = { async connectCan(id) { attached.push(id); for (const [k, f] of Object.entries(fws)) f.silent = !attached.includes(k) ; } };
  const r1 = await bringUp({ bus, renode, scene, simulated: ['PDM-01', 'PDM-02'], isolated: ['PDM-01', 'PDM-02'], nvDir, bootMs: 2000 });
  assert.deepEqual(r1.map((x) => [x.module, x.action]), [['PDM-01', 'configured'], ['PDM-02', 'configured']]);
  assert.deepEqual(attached, ['PDM-01', 'PDM-02']);
  assert.equal(fws['PDM-01'].base, 0x680);
  assert.equal(fws['PDM-02'].base, 0x6a0);
  assert.equal(readMarker(nvDir, 'PDM-02').baseId, 0x6a0);
  for (const id of ['PDM-01', 'PDM-02']) fs.writeFileSync(path.join(nvDir, `${id}.bin`), '');
  assert.deepEqual(modulesToIsolate(scene.modules, nvDir), []);
  // second start: both on the hub, PDM-02's config changed
  scene.modules[1].outputs[0].currentLimit = 15;
  const r2 = await bringUp({ bus, renode, scene, simulated: ['PDM-01', 'PDM-02'], isolated: [], nvDir, bootMs: 2000 });
  assert.deepEqual(r2.map((x) => [x.module, x.action]), [['PDM-01', 'ok'], ['PDM-02', 'redeployed']]);
  assert.equal(fws['PDM-02'].params.get('4096/2'), f32(15));
  fs.rmSync(nvDir, { recursive: true, force: true });
});

test('bringUp: a silent module is reset once, then configured', async () => {
  const nvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bringup-'));
  const bus = fakeBus();
  const fw = fakeFirmware(bus, { base: 0x680, silent: true });
  const resets = [];
  const report = await bringUp({ bus, renode: {}, scene: { modules: [pdm('PDM-01', 0x680)] }, simulated: ['PDM-01'], isolated: [], nvDir, bootMs: 1600,
    reset: async (id) => { resets.push(id); fw.silent = false; } });
  assert.deepEqual(resets, ['PDM-01']);
  assert.equal(report[0].action, 'redeployed');
  fs.rmSync(nvDir, { recursive: true, force: true });
});

test('bus: frames route by base + 2 + message count (bases 0x20 apart do not steal frames)', async () => {
  const bus = await createBus({ port: 1, flushIntervalMs: 0, sleepAfterMs: 0 });
  bus.setModules([{ id: 'PDM-01', kind: 'pdm', baseId: 0x680 }, { id: 'PDM-02', kind: 'pdm', baseId: 0x6a0 }, { id: 'CB-1', kind: 'canboard', baseId: 0x660 }]);
  const seen = [];
  bus.on('frame', (f) => seen.push([f.id, f.module]));
  for (const id of [0x683, 0x6a3, 0x69d, 0x662, 0x66c]) bus.feedLine(`t${id.toString(16).toUpperCase()}80000000000000000`);
  assert.deepEqual(seen, [[0x683, 'PDM-01'], [0x6a3, 'PDM-02'], [0x69d, 'PDM-01'], [0x662, 'CB-1'], [0x66c, null]]);
});

test("bank: a {type:'error'} reply is a 'bankError' event, not a thrown EventEmitter error", async () => {
  const fake = await startFakeBank();
  const bank = createBank({ port: fake.port, minBackoffMs: 30 });
  const errs = [];
  bank.on('bankError', (m) => errs.push(m.msg));
  bank.start();
  await until(() => bank.connected);
  fake.send({ type: 'error', msg: "no machine 'CB-1'" });
  await until(() => errs.length === 1);
  assert.equal(errs[0], "no machine 'CB-1'");
  bank.stop();
  await fake.close();
});

test('bus: silence is judged in virtual time (a paused emulation is not a silent module)', async () => {
  let vt = 5;
  const bus = await createBus({ port: 1, flushIntervalMs: 0, sleepAfterMs: 100, getTime: () => vt });
  bus.setModules([{ id: 'PDM-01', kind: 'pdm', baseId: 0x680 }]);
  const tel = [];
  bus.on('telemetry', (t) => tel.push(t));
  bus.feedLine('t68280000000000000000');
  await new Promise((r) => setTimeout(r, 400));          // host time passes, virtual time does not
  assert.equal(tel.at(-1).silent, false);
  vt = 5.5;                                               // 500 ms of virtual silence
  await until(() => tel.at(-1).silent === true, 2000);
  assert.equal(tel.at(-1).asleep, false);                 // silent is not asleep: only the firmware says that
  bus.stop();
});
