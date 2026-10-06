// lib/slcan.js — SLCAN (Lawicel) text codec for the bridge link (docs/interfaces.md §6). Pure ESM.
//
//   encode({id, ext, dlc, data}) → 'tIIILDD…' (std) / 'TIIIIIIIILDD…' (ext), uppercase hex, no '\r'.
//   decode(line) → {id, ext, rtr, dlc, data:Uint8Array} for t/T/r/R frames, {cmd, arg} for the
//   O C S L F Z V N I X commands (and their replies), or null for empty / unparseable lines.
//   LineSplitter: feed byte chunks (Uint8Array / Buffer / string), get complete lines back; '\r' ends
//   a line ('\n' tolerated), '\a' (BEL, error reply) is reported as the line '\a'.

const HEX = '0123456789ABCDEF';
const hex = (v, w) => {
  let s = '';
  for (let i = w - 1; i >= 0; i--) s += HEX[(v >>> (i * 4)) & 0xf];
  return s;
};

/** @param {{id:number, ext?:boolean, rtr?:boolean, dlc?:number, data?:ArrayLike<number>}} frame */
export function encode(frame) {
  const ext = !!frame.ext || frame.id > 0x7ff;
  const data = frame.data ?? [];
  const dlc = Math.max(0, Math.min(8, frame.dlc ?? data.length));
  const head = frame.rtr ? (ext ? 'R' : 'r') : ext ? 'T' : 't';
  let s = head + hex(frame.id >>> 0, ext ? 8 : 3) + HEX[dlc];
  if (!frame.rtr) for (let i = 0; i < dlc; i++) s += hex((data[i] ?? 0) & 0xff, 2);
  return s;
}

const COMMANDS = new Set(['O', 'C', 'S', 'L', 'F', 'Z', 'V', 'v', 'N', 'I', 'X', 's', 'M', 'm', 'Q', 'U']);

/** Decode one line (with or without the trailing '\r'). */
export function decode(line) {
  if (typeof line !== 'string') return null;
  const l = line.replace(/[\r\n]+$/, '').trim();
  if (!l) return null;
  if (l === '\x07') return { cmd: 'error', arg: '' };
  const c = l[0];
  if (c === 't' || c === 'T' || c === 'r' || c === 'R') {
    const ext = c === 'T' || c === 'R';
    const rtr = c === 'r' || c === 'R';
    const idLen = ext ? 8 : 3;
    const idHex = l.slice(1, 1 + idLen);
    if (idHex.length < idLen || !/^[0-9a-fA-F]+$/.test(idHex)) return null;
    const id = parseInt(idHex, 16);
    if (!ext && id > 0x7ff) return null;
    const dlcCh = l[1 + idLen];
    if (dlcCh === undefined || !/[0-8]/.test(dlcCh)) return null;
    const dlc = Number(dlcCh);
    const data = new Uint8Array(rtr ? 0 : dlc);
    if (!rtr) {
      // tolerate missing padding: absent / odd trailing nibbles read as 0
      const body = l.slice(2 + idLen).replace(/[^0-9a-fA-F]/g, '');
      for (let i = 0; i < dlc; i++) {
        const pair = body.slice(i * 2, i * 2 + 2);
        data[i] = pair ? parseInt(pair.padEnd(2, '0'), 16) : 0;
      }
    }
    return { id, ext, rtr, dlc, data };
  }
  if (COMMANDS.has(c)) return { cmd: c, arg: l.slice(1) };
  return null;
}

/** Splits a byte stream into '\r'-terminated lines. `push(chunk) → string[]` (lines without '\r'). */
export class LineSplitter {
  constructor() {
    this.buf = '';
  }
  push(chunk) {
    if (chunk == null) return [];
    if (typeof chunk === 'string') this.buf += chunk;
    else {
      const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      this.buf += s;
    }
    const out = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const ch = this.buf[i];
      if (ch === '\r' || ch === '\n') {
        if (i > start) out.push(this.buf.slice(start, i));
        start = i + 1;
      } else if (ch === '\x07') {
        if (i > start) out.push(this.buf.slice(start, i));
        out.push('\x07');
        start = i + 1;
      }
    }
    this.buf = this.buf.slice(start);
    if (this.buf.length > 4096) this.buf = this.buf.slice(-64); // garbage guard
    return out;
  }
  /** Iterator form: `for (const line of splitter.lines(chunk))`. */
  *lines(chunk) {
    yield* this.push(chunk);
  }
  reset() {
    this.buf = '';
  }
}
