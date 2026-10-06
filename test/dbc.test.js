import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseDbc, decode, encode, rebase, moduleTelemetryDecoder } from '../lib/dbc.js';

const read = (f) => readFileSync(new URL(`../renode/dbc/${f}`, import.meta.url), 'utf8');
const PDM = read('dingoPdm_0.5.1.dbc');
const MAX = read('dingoPdm-Max_0.5.1.dbc');
const CB = read('CANBoard_0.5.1.dbc');

test('parses the three firmware DBCs', () => {
  const pdm = parseDbc(PDM);
  assert.equal(pdm.version, '0.5.1');
  assert.equal(pdm.messages.size, 28);
  assert.equal(pdm.messages.get(224).name, 'dingoPdmMsg0');
  assert.equal(pdm.messages.get(227).signals.find((s) => s.name === 'OutputState_1').values[2], 'Overcurrent');
  assert.equal(pdm.messages.get(251).signals[0].valueType, 'float');
  assert.equal(parseDbc(MAX).messages.size, 27); // Max has no Msg2
  const cb = parseDbc(CB);
  assert.equal(cb.messages.size, 10);
  assert.equal(cb.messages.get(1602).signals.length, 4);
});

test('PDM Msg1 [0x29,0,…] → output 1 = 4.1 A (rebased to 0x680)', () => {
  const dbc = rebase(parseDbc(PDM), 0x0de, 0x680);
  const r = decode(dbc, 0x683, [0x29, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(r.name, 'dingoPdmMsg1');
  assert.equal(r.signals.OutputCurrent_1, 4.1);
  assert.equal(r.signals.OutputCurrent_4, 0);
  assert.equal(decode(dbc, 225, [0x29]), null); // old id gone after rebase
});

test('PDM Msg3 state nibbles and labels', () => {
  const dbc = parseDbc(PDM);
  // out1 On, out2 Overcurrent, out3 Fault, out4 Warning, out5 OpenLoad, out6 Off …
  const r = decode(dbc, 227, [0x21, 0x43, 0x05, 0, 0x01, 0, 0b0101, 0x80]);
  assert.equal(r.labels.OutputState_1, 'On');
  assert.equal(r.labels.OutputState_2, 'Overcurrent');
  assert.equal(r.labels.OutputState_3, 'Fault');
  assert.equal(r.labels.OutputState_4, 'Warning');
  assert.equal(r.labels.OutputState_5, 'OpenLoad');
  assert.equal(r.labels.OutputState_6, 'Off');
  assert.equal(r.signals.WiperSlowSpeed, 1);
  assert.equal(r.signals.Flasher_1, 1);
  assert.equal(r.signals.Flasher_3, 1);
  assert.equal(r.signals.Timer_8, 1);
});

test('CANBoard analog frame (Msg0) in volts', () => {
  const dbc = parseDbc(CB);
  const r = decode(dbc, 1602, [0xf4, 0x01, 0xdc, 0x05, 0, 0, 0x94, 0x11]); // 500, 1500, 0, 4500 mV
  assert.equal(r.signals.ADCVolt_1, 0.5);
  assert.equal(r.signals.ADCVolt_2, 1.5);
  assert.equal(r.signals.ADCVolt_4, 4.5);
});

test('encode round-trips, signed float signals too', () => {
  const dbc = parseDbc(PDM);
  const f = encode(dbc, 'dingoPdmMsg0', { BatteryVoltage: 13.8, BoardTemperature: 31.2, DeviceState: 1, DigitalInput_2: 1 });
  assert.equal(f.id, 224);
  assert.equal(f.dlc, 8);
  const r = decode(dbc, 224, f.data);
  assert.equal(r.signals.BatteryVoltage, 13.8);
  assert.equal(r.signals.BoardTemperature, 31.2);
  assert.equal(r.labels.DeviceState, 'Sleep');
  assert.equal(r.signals.DigitalInput_2, 1);
  const t = encode(dbc, 'dingoPdmMsg27', { Table_1: -2.5, Table_2: 1e3 });
  const rt = decode(dbc, 251, t.data);
  assert.equal(rt.signals.Table_1, -2.5);
  assert.equal(rt.signals.Table_2, 1000);
});

test('Motorola, signed, extended ids, multi-line comments', () => {
  const text = [
    'BO_ 2147484160 Ext: 8 X', // 0x80000200 → ext id 0x200
    ' SG_ Big : 7|16@0+ (1,0) [0|65535] "" X',
    ' SG_ Neg : 23|12@0- (0.5,-1) [0|0] "" X',
    ' SG_ Mux M : 63|1@1+ (1,0) [0|1] "" X',
    'CM_ SG_ 2147484160 Big "spans',
    'two lines";',
    'CM_ BO_ 2147484160 "msg comment";',
  ].join('\n');
  const dbc = parseDbc(text);
  const m = dbc.messages.get(0x200);
  assert.equal(m.ext, true);
  assert.equal(m.comment, 'msg comment');
  assert.equal(m.signals[0].comment, 'spans\ntwo lines');
  const r = decode(dbc, 0x200, [0x12, 0x34, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.equal(r.signals.Big, 0x1234); // big-endian
  assert.equal(r.signals.Neg, -2 * 0.5 - 1); // raw 0xFFE (12 bit) = -2
  const e = encode(dbc, 'Ext', { Big: 0x1234, Neg: -2 });
  assert.deepEqual([...e.data.slice(0, 4)], [0x12, 0x34, 0xff, 0xe0]);
});

test('moduleTelemetryDecoder: PDM partials at base 0x680', () => {
  const dec = moduleTelemetryDecoder('pdm', 0x680);
  assert.equal(dec({ id: 0x680, data: [31, 0, 0, 0, 0, 0, 0, 0] }), null); // config TX, not cyclic
  const m1 = dec({ id: 0x683, data: [0x29, 0, 0, 0, 0, 0, 0, 0] });
  assert.equal(m1.msgIndex, 1);
  assert.deepEqual(m1.outputs[0], { n: 1, currentA: 4.1 });
  assert.equal(m1.telemetry.outputs.length, 4);
  const m2 = dec({ id: 0x684, data: [0, 0, 0x0a, 0, 0, 0, 0, 0] });
  assert.deepEqual(m2.outputs[1], { n: 6, currentA: 1 });
  const m3 = dec({ id: 0x685, data: [0x21, 0x05, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(m3.outputs.slice(0, 3), [
    { n: 1, state: 'On' },
    { n: 2, state: 'Overcurrent' },
    { n: 3, state: 'OpenLoad' },
  ]);
  const m4 = dec({ id: 0x686, data: [3, 0, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(m4.outputs[0], { n: 1, ocCount: 3 });
  const m0 = dec({ id: 0x682, data: [0x02, 0x01, 0, 0, 0x88, 0x00, 0x38, 0x01] });
  assert.deepEqual(m0.inputs, [false, true]);
  assert.equal(m0.asleep, true);
  assert.equal(m0.vbattV, 13.6);
  assert.equal(m0.tempC, 31.2);
  const m23 = dec({ id: 0x680 + 2 + 23, data: [50, 100, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(m23.outputs.slice(0, 2), [{ n: 1, duty: 50 }, { n: 2, duty: 100 }]);
});

test('moduleTelemetryDecoder: CANBoard positions / analog / DO', () => {
  const dec = moduleTelemetryDecoder('canboard', 0x670);
  const m2 = dec({ id: 0x674, data: [0x32, 0x00, 0, 0, 0x01, 0, 0x03, 7] });
  assert.deepEqual(m2.positions, [2, 3, 0, 0, 0]);
  assert.equal(m2.inputs[0], true);
  assert.deepEqual(m2.digitalOut, [true, true, false, false]);
  assert.equal(m2.heartbeat, 7);
  const m0 = dec({ id: 0x672, data: [0xdc, 0x05, 0, 0, 0, 0, 0, 0] });
  assert.deepEqual(m0.analogMv[0], { n: 1, mV: 1500 });
});

test('built-in telemetry subset decodes like the full DBC files', () => {
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push(Array.from({ length: 8 }, (_, k) => (i * 37 + k * 91) & 0xff));
  for (const [kind, text, base] of [
    ['pdm', PDM, 0x6a0],
    ['pdmmax', MAX, 0x6c0],
    ['canboard', CB, 0x660],
  ]) {
    const a = moduleTelemetryDecoder(kind, base);
    const b = moduleTelemetryDecoder(kind, base, text);
    for (let msg = 0; msg < (kind === 'canboard' ? 10 : 28); msg++) {
      for (const data of frames.slice(0, 5)) {
        const ra = a({ id: base + 2 + msg, data });
        const rb = b({ id: base + 2 + msg, data });
        if (!ra) continue; // message not in the subset
        assert.deepEqual(ra.telemetry, rb.telemetry, `${kind} msg ${msg}`);
      }
    }
  }
});
