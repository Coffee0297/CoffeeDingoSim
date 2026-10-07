// bank reconnect, SLCAN reassembly + telemetry decode, bridge I/X handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startFakeBank } from './fakes/fake_bank.js';
import { startFakeBridge, until } from './fakes/fake_bridge.js';
import { createBank } from '../server/bank.js';
import { createBus, applySignals } from '../server/bus.js';
import { createBridge, parseMode } from '../server/bridge.js';

test('bank: hello/trace events and reconnect with scene resend', async () => {
  const fake = await startFakeBank({ hello: [{ type: 'hello', machine: 'PDM-01', board: 'pdm', outputs: 8, inputs: 2 }] });
  const bank = createBank({ port: fake.port, minBackoffMs: 30, maxBackoffMs: 100 });
  const hellos = [], traces = [];
  bank.on('hello', (m) => hellos.push(m));
  bank.on('trace', (m) => traces.push(m));
  let connects = 0;
  bank.on('connect', () => connects++);
  bank.start();
  await until(() => bank.connected && hellos.length === 1);
  bank.sendScene({ machine: 'PDM-01', vbattV: 13.8, noisePct: 1, outputs: {} });
  await fake.waitFor((m) => m.type === 'scene' && m.machine === 'PDM-01');
  fake.send({ type: 'trace', machine: 'PDM-01', t: 1.5, i: [0, 4.1, 0, 0, 0, 0, 0, 0], on: [0, 1, 0, 0, 0, 0, 0, 0] });
  await until(() => traces.length === 1);
  assert.equal(traces[0].i[1], 4.1);

  // drop the connection: the client must come back and resend its scene
  const before = fake.received.filter((m) => m.type === 'scene').length;
  fake.dropClients();
  await until(() => connects >= 2 && bank.connected, 3000);
  await until(() => fake.received.filter((m) => m.type === 'scene').length > before);
  assert.ok(bank.gpio('PDM-01', 'DI1', true));
  const g = await fake.waitFor((m) => m.type === 'gpio');
  assert.deepEqual(g, { type: 'gpio', machine: 'PDM-01', pin: 'DI1', value: 1 });
  bank.stop();
  await fake.close();
});

test('bank: unreachable port degrades gracefully, connects once the bank appears', async () => {
  const probe = await startFakeBank();
  const port = probe.port;
  await probe.close();
  const bank = createBank({ port, minBackoffMs: 30, maxBackoffMs: 60 });
  let unreachable = 0;
  bank.on('unreachable', () => unreachable++);
  bank.start();
  await until(() => unreachable >= 2);
  assert.equal(bank.connected, false);
  assert.equal(bank.vbatt('*', 12.2), false); // not connected: no throw
  const fake = await startFakeBank({ port });
  await until(() => bank.connected, 3000);
  bank.stop();
  await fake.close();
});

test('bus: SLCAN lines reassembled across chunks and Msg1 decoded into telemetry', async () => {
  const fake = await startFakeBridge();
  const t0 = Date.now();
  const bus = await createBus({ port: fake.port, flushIntervalMs: 0, sleepAfterMs: 150, getTime: () => 12.3 + (Date.now() - t0) / 1000 }); // a running time source (asleep is virtual-time based)
  bus.setModules([{ id: 'PDM-01', kind: 'pdm', baseId: 0x680 }]);
  const lines = [], tel = [];
  bus.on('line', (l) => lines.push(l));
  bus.on('telemetry', (t) => tel.push(t));
  bus.start();
  await until(() => bus.connected);
  await fake.waitLine((l) => l === 'O'); // bus opens the channel
  // Msg1 = base+3 = 0x683: out1 4.1 A (41 = 0x0029), out2 12.0 A (120 = 0x0078)
  const line = 't68382900780000000000\r';
  fake.sendRaw(line.slice(0, 5));
  await new Promise((r) => setTimeout(r, 30));
  fake.sendRaw(line.slice(5, 13));
  await new Promise((r) => setTimeout(r, 30));
  fake.sendRaw(line.slice(13) + 't6858' + '12'); // second (Msg3) frame starts in the same chunk
  await new Promise((r) => setTimeout(r, 30));
  fake.sendRaw('00000000000000\r');
  await until(() => lines.length >= 2);
  assert.equal(lines[0], 't68382900780000000000');
  assert.equal(lines[1], 't68581200000000000000');
  await until(() => tel.some((t) => t.outputs[0].state === 'Overcurrent'));
  const last = tel.at(-1);
  assert.equal(last.module, 'PDM-01');
  assert.ok(last.t >= 12.3 && last.t < 20, "telemetry stamped with the time source");
  assert.equal(last.outputs[0].currentA, 4.1);
  assert.equal(last.outputs[1].currentA, 12);
  assert.equal(last.outputs[0].state, 'Overcurrent'); // Msg3 byte0 = 0x12: out1 = 2, out2 = 1
  assert.equal(last.outputs[1].state, 'On');
  assert.equal(last.asleep, false);
  // silence → silent (not asleep: the module may still be driving its outputs)
  await until(() => tel.at(-1).silent === true, 1000);
  assert.equal(tel.at(-1).asleep, false);
  // inject goes out as SLCAN
  bus.inject({ id: 0x681, dlc: 8, data: [31, 0, 0, 0, 0, 0, 0, 0] });
  await fake.waitLine((l) => l === 't68181F00000000000000');
  bus.stop();
  await fake.close();
});

test('bus: works with a hand-written decoder stub (lib/dbc.js stand-in)', async () => {
  const stub = {
    moduleTelemetryDecoder: (kind, base) => (frame) =>
      frame.id === base + 3 ? { msgIndex: 1, signals: { OutputCurrent_1: (frame.data[0] | (frame.data[1] << 8)) / 10 } } : null,
  };
  const bus = await createBus({ dbc: stub, flushIntervalMs: 0, sleepAfterMs: 0 });
  bus.setModules([{ id: 'PDM-02', kind: 'pdm', baseId: 0x6a0 }]);
  const tel = [];
  bus.on('telemetry', (t) => tel.push(t));
  bus.feedChunk('t6A3' + '8' + '3200000000000000\r');
  assert.equal(tel.length, 1);
  assert.equal(tel[0].outputs[0].currentA, 5);
  assert.equal(tel[0].module, 'PDM-02');
});

test('bus: applySignals maps canboard signals', () => {
  const tel = { outputs: [], inputs: [], positions: [], digitalOut: [], mV: [], extra: {} };
  applySignals(tel, 'canboard', 2, { RotarySwitch_1: 2, DigitalInput_1: 1, DigitalOutput_2: 1 });
  applySignals(tel, 'canboard', 0, { ADCVolt_1: 1.5 });
  assert.deepEqual(tel.positions, [2]);
  assert.equal(tel.inputs[0], true);
  assert.equal(tel.digitalOut[1], true);
  assert.equal(tel.mV[0], 1500);
});

function client(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host: '127.0.0.1' }, () => resolve(s));
    s.data = '';
    s.on('data', (d) => { s.data += d.toString('latin1'); });
  });
}

test('bridge: tcp mode answers I and honours X, forwards frames to the hub', async () => {
  const toHub = [];
  const bridge = createBridge({ mode: 'tcp:0', getBaseId: () => 0x680, toHub: (l) => toHub.push(l) });
  await bridge.start();
  const c = await client(bridge.port);
  await until(() => bridge.describe().clients === 1);
  c.write('I\r');
  await until(() => c.data.includes('I680\r'));
  c.write('V\rN\rO\r');
  await until(() => c.data.includes('V1013\r') && c.data.includes('NSIM0\r'));
  c.data = '';

  bridge.fromHub('t6838' + '2900000000000000');
  bridge.fromHub('t6848' + '0000000000000000');
  await until(() => c.data.split('\r').filter(Boolean).length === 2);
  c.data = '';

  c.write('X683\r');
  await until(() => bridge.filterId === 0x683);
  bridge.fromHub('t6848' + '0000000000000000');
  bridge.fromHub('t6838' + '2A00000000000000');
  await until(() => c.data.length > 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.data, 't68382A00000000000000\r');

  c.write('X\r');
  await until(() => bridge.filterId === -1);

  c.data = '';
  c.write('t6818' + '1F00000000000000\r');
  await until(() => toHub.length === 1);
  assert.equal(toHub[0], 't68181F00000000000000');
  assert.ok(!toHub.some((l) => l[0] === 'I' || l[0] === 'X'), 'I/X never reach the hub');
  c.destroy();
  await bridge.stop();
});

test('bridge: mode parsing', () => {
  assert.deepEqual(parseMode('serial:COM6'), { kind: 'serial', path: 'COM6' });
  assert.deepEqual(parseMode('tcp:7778'), { kind: 'tcp', port: 7778 });
  assert.deepEqual(parseMode('tcp'), { kind: 'tcp', port: 7778 });
  assert.deepEqual(parseMode('none'), { kind: 'none' });
  assert.deepEqual(parseMode(undefined), { kind: 'none' });
});
