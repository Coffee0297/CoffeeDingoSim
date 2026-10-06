import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Cmd,
  versionRequest,
  parseVersionReply,
  writeParam,
  readParam,
  parseParamReply,
  burn,
  parseBurnReply,
  sleep,
  parseSleepReply,
  setBaseIdSequence,
  matchesStep,
} from '../lib/paramproto.js';

test('frame builders match the firmware layouts', () => {
  assert.deepEqual([...versionRequest()], [31, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...writeParam(0x0000, 0, 0x680)], [2, 0, 0, 0, 0x80, 0x06, 0, 0]);
  assert.deepEqual([...writeParam(0x1003, 17, -1)], [2, 0x03, 0x10, 17, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual([...writeParam(0x1000, 3, 12.5, { type: 'float' })], [2, 0, 0x10, 3, 0, 0, 0x48, 0x41]);
  assert.deepEqual([...readParam(0x1201, 2)], [1, 0x01, 0x12, 2, 0, 0, 0, 0]);
  assert.deepEqual([...burn()], [30, 1, 3, 8, 0, 0, 0, 0]);
  assert.deepEqual([...sleep()], [32, 0x51, 0x55, 0x49, 0x54, 0, 0, 0]);
});

test('reply parsers', () => {
  assert.deepEqual(parseVersionReply([31, 2, 0, 0, 5, 5, 0, 107]), {
    boardId: 2,
    kind: 'canboard',
    major: 5,
    minor: 5,
    build: 107,
    version: '5.5.107',
  });
  assert.equal(parseVersionReply([2, 0, 0, 0, 0, 0, 0, 0]), null);
  const r = parseParamReply([2, 0, 0, 0, 0x80, 0x06, 0, 0]);
  assert.equal(r.cmdName, 'Write');
  assert.equal(r.value, 0x680);
  assert.equal(r.found, true);
  assert.equal(parseParamReply([5, 9, 9, 1, 0, 0, 0, 0]).found, false);
  assert.equal(parseParamReply([1, 0, 0x10, 3, 0, 0, 0x48, 0x41]).float32, 12.5);
  assert.equal(parseParamReply([1, 0, 0x10, 17, 0xff, 0xff, 0xff, 0xff]).int32, -1);
  assert.deepEqual(parseBurnReply([30, 1, 3, 8, 1, 0, 0, 0]), { ok: true });
  assert.deepEqual(parseBurnReply([30, 1, 3, 8, 0, 0, 0, 0]), { ok: false });
  assert.equal(parseBurnReply([30, 0, 0, 0, 1, 0, 0, 0]), null);
  assert.deepEqual(parseSleepReply([32, 0x51]), { ok: true });
});

test('set-base-id sequence: PDM 0x0DE → 0x680', () => {
  const steps = setBaseIdSequence(0x0de, 0x680);
  assert.deepEqual(
    steps.map((s) => s.name),
    ['version', 'write-base-id', 'burn', 'verify'],
  );
  const [ver, write, b, verify] = steps;
  assert.equal(ver.txId, 0x0df);
  assert.equal(ver.expectReplyId, 0x0de);
  assert.equal(write.txId, 0x0df); // still the old RX id
  assert.deepEqual([...write.data], [2, 0, 0, 0, 0x80, 0x06, 0, 0]);
  assert.equal(write.expectReplyId, 0x680); // reply encoded after nBaseId changed
  assert.deepEqual(write.acceptReplyIds, [0x680, 0x0de]);
  assert.equal(b.txId, 0x681);
  assert.deepEqual(b.altTxIds, [0x0df]);
  assert.equal(b.expectCmd, Cmd.BurnSettings);
  assert.equal(verify.txId, 0x681);

  // simulated firmware replies
  assert.ok(matchesStep(ver, { id: 0x0de, data: [31, 0, 0, 0, 5, 5, 0, 107] }));
  assert.ok(matchesStep(write, { id: 0x680, data: [2, 0, 0, 0, 0x80, 0x06, 0, 0] }));
  assert.ok(matchesStep(write, { id: 0x0de, data: [2, 0, 0, 0, 0x80, 0x06, 0, 0] }));
  assert.ok(!matchesStep(write, { id: 0x680, data: [2, 0, 0, 0, 0x81, 0x06, 0, 0] })); // wrong value
  assert.ok(!matchesStep(write, { id: 0x6a0, data: [2, 0, 0, 0, 0x80, 0x06, 0, 0] })); // foreign id
  assert.ok(matchesStep(b, { id: 0x680, data: [30, 1, 3, 8, 1, 0, 0, 0] }));
  assert.ok(!matchesStep(b, { id: 0x680, data: [30, 1, 3, 8, 0, 0, 0, 0] })); // burn failed
  assert.ok(matchesStep(verify, { id: 0x680, data: [1, 0, 0, 0, 0x80, 0x06, 0, 0] }));
});

test('set-base-id sequence: same base only burns; range checked', () => {
  const steps = setBaseIdSequence(0x640, 0x640);
  assert.deepEqual(
    steps.map((s) => s.name),
    ['version', 'burn', 'verify'],
  );
  assert.throws(() => setBaseIdSequence(0x0de, 0x800), RangeError);
});
