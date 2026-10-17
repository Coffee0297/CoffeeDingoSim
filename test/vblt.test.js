// Virtual OpenBLT: a dingoConfig-style XCP session (connect, program, verify, reset) ends with the module on the
// ELF whose bytes were sent; an image no ELF matches leaves the module on its firmware.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVirtualBootloader, elfSegments, imageMatchesElf } from '../server/vblt.js';

/** A minimal ELF32 LE with one PT_LOAD segment at `addr`. */
function elf(addr, data) {
  const b = Buffer.alloc(52 + 32 + data.length);
  b.writeUInt32BE(0x7f454c46, 0); b[4] = 1; b[5] = 1; b[6] = 1;
  b.writeUInt16LE(2, 16); b.writeUInt16LE(40, 18); b.writeUInt32LE(52, 28); b.writeUInt16LE(52, 40); b.writeUInt16LE(32, 42); b.writeUInt16LE(1, 44);
  b.writeUInt32LE(1, 52); b.writeUInt32LE(84, 56); b.writeUInt32LE(addr, 60); b.writeUInt32LE(addr, 64); b.writeUInt32LE(data.length, 68); b.writeUInt32LE(data.length, 72);
  Buffer.from(data).copy(b, 84);
  return b;
}

test('vblt: bootloader request, XCP program + read-back, reset runs the matching ELF', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vblt-'));
  const img = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  fs.writeFileSync(path.join(dir, 'other.elf'), elf(0x08004000, [9, 9, 9]));
  fs.writeFileSync(path.join(dir, 'new.elf'), elf(0x08004000, img));
  const sent = [], log = [], calls = [];
  const v = createVirtualBootloader({
    modules: () => [{ id: 'PDM-01', kind: 'pdm', baseId: 0x680 }],
    inject: (f) => sent.push(f.data), hold: async (id, on) => calls.push(['hold', id, on]), run: async (id, e) => calls.push(['run', id, path.basename(e)]),
    elfDirs: () => [dir], log: (l) => log.push(l),
  });
  const cmd = (...d) => v.fromTool({ id: 0x680 + 12, data: d });
  assert.equal(v.fromTool({ id: 0x681, data: [33, 0, 0, 0, 0, 0, 1, 0] }), false);   // reaches the module too
  assert.deepEqual(v.held(), ['PDM-01']);
  assert.equal(cmd(0xff, 0), true);
  assert.deepEqual(sent.at(-1).slice(0, 4), [0xff, 0, 0, 8]);
  cmd(0xd2); cmd(0xf6, 0, 0, 0, 0x00, 0x40, 0x00, 0x08); cmd(0xd1, 0, 0, 0, 11, 0, 0, 0);
  cmd(0xc9, ...img.slice(0, 7)); cmd(0xd0, 4, ...img.slice(7)); cmd(0xd0, 0);
  cmd(0xf6, 0, 0, 0, 0x00, 0x40, 0x00, 0x08); cmd(0xf5, 7);
  assert.deepEqual(sent.at(-1), [0xff, 1, 2, 3, 4, 5, 6, 7]);   // read-back
  cmd(0xcf);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls.at(-1), ['run', 'PDM-01', 'new.elf']);
  assert.deepEqual(v.held(), []);
});

test('vblt: an image no ELF matches leaves the module on its firmware', () => {
  const segs = elfSegments(elf(0x08004000, [1, 2, 3]));
  assert.equal(imageMatchesElf(new Map([[0x08004000, 1], [0x08004001, 2]]), segs), true);
  assert.equal(imageMatchesElf(new Map([[0x08004000, 7]]), segs), false);
  assert.equal(imageMatchesElf(new Map(), segs), false);
});

test('vblt: a module that restarts is out of its bootloader (its config traffic reaches it again)', () => {
  const v = createVirtualBootloader({ modules: () => [{ id: 'CB-1', kind: 'canboard', baseId: 0x660 }], inject: () => {}, hold: async () => {}, run: async () => {}, elfDirs: () => [], log: () => {} });
  v.fromTool({ id: 0x661, data: [33, 0, 0, 0, 0, 0, 0, 0] });
  assert.equal(v.fromTool({ id: 0x661, data: [31, 0, 0, 0, 0, 0, 0, 0] }), true);   // swallowed while held
  v.release('CB-1');
  assert.deepEqual(v.held(), []);
  assert.equal(v.fromTool({ id: 0x661, data: [31, 0, 0, 0, 0, 0, 0, 0] }), false);
});
