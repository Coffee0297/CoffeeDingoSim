// Virtual OpenBLT: firmware updates over CAN in the Sim.
//
// Renode reloads each module's ELF on every reset and its flash does not survive one, so the real bootloader
// cannot run here. Instead the Sim plays the bootloader at the protocol level, exactly as dingoConfig talks to it:
//   1. the tool sends Bootloader (cmd 33, byte 6 = 1) to a module's base+1: the module is held (as if it sat in
//      OpenBLT) and the Sim answers XCP on base+12 -> base+13 for it;
//   2. CONNECT, GET_STATUS, PROGRAM_START, SET_MTA, PROGRAM_CLEAR, PROGRAM / PROGRAM_MAX, UPLOAD (read-back),
//      PROGRAM_RESET, DISCONNECT, into a sparse image;
//   3. on PROGRAM_RESET the image runs: the ELF whose loadable bytes are that image (the build folder, release
//      files next to it) becomes the module's firmware, kept in the scene so a later start runs it too.
// The tool's frames to a held module stay off the hub; its XCP replies are injected like any Sim frame.
import fs from 'node:fs';
import path from 'node:path';

const XCP = { CONNECT: 0xff, DISCONNECT: 0xfe, GET_STATUS: 0xfd, SET_MTA: 0xf6, UPLOAD: 0xf5,
  PROGRAM_START: 0xd2, PROGRAM_CLEAR: 0xd1, PROGRAM: 0xd0, PROGRAM_RESET: 0xcf, PROGRAM_MAX: 0xc9 };
const ERR_CMD_UNKNOWN = 0x20;

/** Loadable segments of an ELF32 file: [{ addr, data }] (physical addresses, file bytes only). */
export function elfSegments(buf) {
  if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 1) return [];   // ELF32 only
  const le = buf[5] === 1, u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)), u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const phoff = u32(28), phentsize = u16(42), phnum = u16(44), out = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (u32(p) !== 1 || !u32(p + 16)) continue;   // PT_LOAD with file bytes
    out.push({ addr: u32(p + 12), data: buf.subarray(u32(p + 4), u32(p + 4) + u32(p + 16)) });
  }
  return out;
}

/** True when every programmed byte of `image` (Map addr -> byte) equals the ELF's bytes at that address. */
export function imageMatchesElf(image, segs) {
  if (!image.size) return false;
  for (const [a, v] of image) {
    const s = segs.find((x) => a >= x.addr && a < x.addr + x.data.length);
    if (!s || s.data[a - s.addr] !== v) return false;
  }
  return true;
}

/**
 * @param {{ modules: () => any[], inject: (f:{id:number,dlc:number,data:number[]}) => void,
 *   hold: (module:string, on:boolean) => Promise<void>, run: (module:string, elf:string) => Promise<void>,
 *   elfDirs: () => string[], log: (s:string) => void }} o
 */
export function createVirtualBootloader(o) {
  const held = new Map();   // module id -> session { mod, image: Map, mta, connected }

  const reply = (s, bytes) => o.inject({ id: s.mod.baseId + 13, dlc: bytes.length, data: bytes });
  const ok = (s, ...rest) => reply(s, [0xff, ...rest]);

  function findElf(image) {
    for (const dir of o.elfDirs()) {
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => /\.elf$/i.test(n)); } catch { continue; }
      for (const n of names) {
        const p = path.join(dir, n);
        try { if (imageMatchesElf(image, elfSegments(fs.readFileSync(p)))) return p; } catch { /* not an ELF */ }
      }
    }
    return null;
  }

  async function finish(id, s) {
    held.delete(id);
    const elf = findElf(s.image);
    if (elf) { o.log(`[vblt] ${id}: programmed ${s.image.size} bytes, runs ${path.basename(elf)}`); await o.run(id, elf); }
    else { o.log(`[vblt] ${id}: programmed ${s.image.size} bytes, but no ELF in the firmware folders matches the image: it keeps its firmware`); await o.hold(id, false); }
  }

  function xcp(s, d) {
    const u32 = (i) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;   // Intel (byte order bit 0 = 0)
    switch (d[0]) {
      case XCP.CONNECT: s.connected = true; return ok(s, 0x00, 0x00, 8, 8, 0, 1, 1);   // resources, comm mode (Intel), MAX_CTO 8, MAX_DTO 8, versions
      case XCP.GET_STATUS: return ok(s, 0, 0, 0, 0, 0);
      case XCP.PROGRAM_START: return ok(s, 0, 0, 8, 0, 0, 0);   // MAX_CTO_PGM 8
      case XCP.SET_MTA: s.mta = u32(4); return ok(s);
      case XCP.PROGRAM_CLEAR: { const n = u32(4); for (let a = s.mta; a < s.mta + n; a++) s.image.delete(a); return ok(s); }   // erased = unprogrammed
      case XCP.PROGRAM_MAX: for (let i = 1; i < 8; i++) s.image.set(s.mta++, d[i]); return ok(s);
      case XCP.PROGRAM: { const n = d[1]; for (let i = 0; i < n; i++) s.image.set(s.mta++, d[2 + i]); return ok(s); }   // n = 0: end of programming
      case XCP.UPLOAD: { const n = Math.min(d[1], 7), out = []; for (let i = 0; i < n; i++) out.push(s.image.get(s.mta++) ?? 0xff); return ok(s, ...out); }
      case XCP.DISCONNECT: s.connected = false; return ok(s);
      case XCP.PROGRAM_RESET: ok(s); return 'reset';
      default: return reply(s, [0xfe, ERR_CMD_UNKNOWN]);
    }
  }

  return {
    held: () => [...held.keys()],
    /** The module restarted (reset, or the emulation restarted): it runs its app again, so it is out of the bootloader. */
    release(id) { if (id == null) held.clear(); else held.delete(id); },
    /**
     * A frame from the tool (dingoConfig). Returns true when the Sim handled it and it must not reach the hub.
     * @param {{id:number,data:number[]}} f
     */
    fromTool(f) {
      const mods = o.modules();
      // Bootloader request with the CAN-update entry: the module goes into its (virtual) bootloader
      const m = mods.find((x) => f.id === x.baseId + 1);
      if (m && f.data[0] === 33 && (f.data[6] === 1 || m.kind === 'canboard') && !held.has(m.id)) {   // a CANBoard's only bootloader is the CAN one
        held.set(m.id, { mod: m, image: new Map(), mta: 0, connected: false });
        o.log(`[vblt] ${m.id}: bootloader request, held in the (virtual) bootloader`);
        setTimeout(() => o.hold(m.id, true).catch((e) => o.log(`[vblt] hold ${m.id}: ${e.message}`)), 150);   // let it answer first, like the real app
        return false;
      }
      for (const [id, s] of held) {
        if (f.id === s.mod.baseId + 12) {
          if (xcp(s, f.data) === 'reset') finish(id, s).catch((e) => o.log(`[vblt] ${id}: ${e.message}`));
          return true;
        }
        if (f.id === s.mod.baseId + 1) return true;   // config traffic to a module in its bootloader: nobody answers
      }
      return false;
    },
  };
}
