import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, LineSplitter } from '../lib/slcan.js';

test('encode std / ext / rtr, uppercase, no CR', () => {
  assert.equal(encode({ id: 0x681, dlc: 8, data: [31, 0, 0, 0, 0, 0, 0, 0xab] }), 't68181F000000000000AB');
  assert.equal(encode({ id: 0x18fef100, ext: true, dlc: 2, data: [1, 2] }), 'T18FEF10020102');
  assert.equal(encode({ id: 0x1ff, data: new Uint8Array([0xde, 0xad]) }), 't1FF2DEAD');
  assert.equal(encode({ id: 0x123, rtr: true, dlc: 4 }), 'r1234');
  assert.equal(encode({ id: 0x800, dlc: 0 }), 'T000008000'); // >11 bit forces ext
});

test('decode frames, lowercase, missing padding', () => {
  const f = decode('t68181f000000000000ab\r');
  assert.equal(f.id, 0x681);
  assert.equal(f.ext, false);
  assert.equal(f.dlc, 8);
  assert.deepEqual([...f.data], [31, 0, 0, 0, 0, 0, 0, 0xab]);
  const e = decode('T18FEF10020102');
  assert.equal(e.id, 0x18fef100);
  assert.equal(e.ext, true);
  const short = decode('t6828290'); // dlc 8 but only 1.5 bytes given
  assert.equal(short.dlc, 8);
  assert.deepEqual([...short.data], [0x29, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(decode('t1234').rtr, false);
  assert.equal(decode('r1234').data.length, 0);
  assert.equal(decode('tZZZ0'), null);
  assert.equal(decode('t8001'), null); // std id > 0x7FF
  assert.equal(decode(''), null);
  assert.equal(decode('?'), null);
});

test('decode commands', () => {
  for (const c of ['O', 'C', 'L', 'F', 'V', 'N', 'I']) assert.deepEqual(decode(c + '\r'), { cmd: c, arg: '' });
  assert.deepEqual(decode('S6'), { cmd: 'S', arg: '6' });
  assert.deepEqual(decode('Z1'), { cmd: 'Z', arg: '1' });
  assert.deepEqual(decode('V1013'), { cmd: 'V', arg: '1013' });
  assert.deepEqual(decode('X1,680,7FF'), { cmd: 'X', arg: '1,680,7FF' });
  assert.deepEqual(decode('\x07'), { cmd: 'error', arg: '' });
});

test('round trip', () => {
  const fr = { id: 0x6c4, ext: false, dlc: 8, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) };
  const back = decode(encode(fr));
  assert.deepEqual({ ...back, rtr: undefined }, { ...fr, rtr: undefined });
});

test('LineSplitter joins frames split across chunks', () => {
  const s = new LineSplitter();
  const bytes = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0));
  assert.deepEqual(s.push(bytes('t6818')), []);
  assert.deepEqual(s.push(bytes('1F00000000000000\rt682')), ['t68181F00000000000000']);
  assert.deepEqual(s.push('20000\r\rV1013\r'), ['t68220000', 'V1013']);
  assert.deepEqual(s.push(bytes('\x07N')), ['\x07']);
  assert.deepEqual(s.push(bytes('SIM0\n')), ['NSIM0']);
  assert.deepEqual([...s.lines('O\r')], ['O']);
});
