// Minimal built-in stand-ins for lib/ modules that other workstreams own (slcan, dbc, engine,
// battery, components). They are only used when the real lib module is absent or exposes an
// unexpected shape, so the server keeps working (and the tests stay deterministic). The real
// lib/ implementations are the reference; nothing here is meant to be feature-complete.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './state.js';

// ---------------------------------------------------------------- SLCAN -----------------

/** Splits a byte/string stream into `\r`-terminated SLCAN lines (also accepts `\n` and `\a`). */
export class LineSplitter {
  constructor() { this.buf = ''; }
  /** @param {Buffer|string} chunk @returns {string[]} complete lines without the terminator */
  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    const out = [];
    let i;
    while ((i = this.buf.search(/[\r\n\x07]/)) >= 0) {
      const line = this.buf.slice(0, i);
      const term = this.buf[i];
      this.buf = this.buf.slice(i + 1);
      if (line.length) out.push(line);
      else if (term === '\r' || term === '\x07') out.push(term === '\r' ? '' : '\x07'); // bare ACK / BELL
    }
    if (this.buf.length > 64) this.buf = ''; // garbage guard
    return out;
  }
}

const HEX = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');

/** `{id, ext?, dlc, data}` → `tIIILDD…` / `TIIIIIIIILDD…` (no terminator). */
export function encode(frame) {
  const data = Array.from(frame.data || []).slice(0, frame.dlc ?? (frame.data?.length ?? 0));
  const dlc = frame.dlc ?? data.length;
  const head = frame.ext ? 'T' + HEX(frame.id, 8) : 't' + HEX(frame.id, 3);
  return head + dlc.toString(16).toUpperCase() + data.map((b) => HEX(b & 0xff, 2)).join('');
}

/** SLCAN line → `{id, ext, dlc, data:Uint8Array, rtr}` or `{cmd, arg}`; null for an empty ACK. */
export function decode(line) {
  if (line === '' || line === undefined) return { cmd: 'ack' };
  if (line === '\x07') return { cmd: 'bell' };
  const c = line[0];
  if (c === 't' || c === 'T' || c === 'r' || c === 'R') {
    const ext = c === 'T' || c === 'R';
    const idLen = ext ? 8 : 3;
    const id = parseInt(line.slice(1, 1 + idLen), 16);
    const dlc = parseInt(line[1 + idLen], 16);
    if (Number.isNaN(id) || Number.isNaN(dlc)) return null;
    const hex = line.slice(2 + idLen);
    const data = new Uint8Array(dlc);
    for (let i = 0; i < dlc; i++) data[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    return { id, ext, dlc, data, rtr: c === 'r' || c === 'R' };
  }
  return { cmd: c, arg: line.slice(1) };
}

// ---------------------------------------------------------------- DBC -------------------

/** Tiny DBC parser: little-endian unsigned/signed signals only (all firmware DBCs are). */
export function parseDbc(text) {
  const messages = new Map();
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m;
    if ((m = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)/.exec(line))) {
      cur = { id: Number(m[1]), name: m[2], dlc: Number(m[3]), signals: [] };
      messages.set(cur.id, cur);
    } else if (cur && (m = /^SG_\s+(\w+)\s*(?:m\d+|M)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)/.exec(line))) {
      cur.signals.push({ name: m[1], start: Number(m[2]), len: Number(m[3]), le: m[4] === '1', signed: m[5] === '-', factor: Number(m[6]), offset: Number(m[7]) });
    } else if (line === '') cur = null;
  }
  return { messages };
}

function extractLE(data, start, len, signed) {
  let v = 0n;
  for (let i = 0; i < len; i++) {
    const bit = start + i;
    const byte = data[bit >> 3] ?? 0;
    if ((byte >> (bit & 7)) & 1) v |= 1n << BigInt(i);
  }
  if (signed && len > 0 && (v >> BigInt(len - 1)) & 1n) v -= 1n << BigInt(len);
  return Number(v);
}

/** Decode `data` with a parsed DBC message → `{name: physicalValue}`. */
export function decodeMessage(msg, data) {
  const out = {};
  for (const s of msg.signals) {
    const raw = s.le ? extractLE(data, s.start, s.len, s.signed) : 0;
    out[s.name] = raw * s.factor + s.offset;
  }
  return out;
}

/** Encode `{name: physicalValue}` into a byte array using a parsed DBC message. */
export function encodeMessage(msg, signals) {
  const data = new Uint8Array(msg.dlc || 8);
  for (const s of msg.signals) {
    if (!(s.name in signals)) continue;
    let raw = Math.round((Number(signals[s.name]) - s.offset) / s.factor);
    if (raw < 0) raw = (1 << s.len) + raw;
    for (let i = 0; i < s.len; i++) {
      if ((raw >> i) & 1) data[(s.start + i) >> 3] |= 1 << ((s.start + i) & 7);
    }
  }
  return data;
}

const DBC_FILES = { pdm: 'dingoPdm_0.5.1.dbc', pdmmax: 'dingoPdm-Max_0.5.1.dbc', canboard: 'CANBoard_0.5.1.dbc' };
const DBC_DEFAULT_BASE = { pdm: 0x0de, pdmmax: 0x0de, canboard: 0x640 };
const dbcCache = new Map();

export function loadFirmwareDbc(kind) {
  if (dbcCache.has(kind)) return dbcCache.get(kind);
  const file = path.join(ROOT, 'renode', 'dbc', DBC_FILES[kind] || DBC_FILES.pdm);
  const db = fs.existsSync(file) ? parseDbc(fs.readFileSync(file, 'utf8')) : { messages: new Map() };
  dbcCache.set(kind, db);
  return db;
}

/**
 * Telemetry decoder for one board kind: `(frame, baseId) → {msgIndex, name, signals} | null`.
 * `msgIndex = frame.id - (baseId + 2)`; the DBC is written for the default base of that kind.
 */
export function moduleTelemetryDecoder(kind) {
  const db = loadFirmwareDbc(kind);
  const defBase = DBC_DEFAULT_BASE[kind] ?? 0x0de;
  return (frame, baseId) => {
    const msgIndex = frame.id - (baseId + 2);
    if (msgIndex < 0 || msgIndex > 40) return null;
    const msg = db.messages.get(defBase + 2 + msgIndex);
    if (!msg) return null;
    return { msgIndex, name: msg.name, signals: decodeMessage(msg, frame.data) };
  };
}

// ---------------------------------------------------------------- engine ----------------

/** Built-in SimEngine frame layout used only when renode/SimEngine.dbc is absent. */
export const SIM_ENGINE_FALLBACK_DBC = `BO_ 512 SimEngine1: 8 Vector__XXX
 SG_ RPM : 0|16@1+ (1,0) [0|8000] "rpm" Vector__XXX
 SG_ CLT : 16|8@1+ (1,-40) [-40|215] "degC" Vector__XXX
 SG_ OilP : 24|8@1+ (0.1,0) [0|25] "bar" Vector__XXX
 SG_ TPS : 32|8@1+ (1,0) [0|100] "%" Vector__XXX
 SG_ Speed : 40|8@1+ (1,0) [0|255] "kph" Vector__XXX
 SG_ Gear : 48|8@1+ (1,0) [0|15] "" Vector__XXX
 SG_ State : 56|8@1+ (1,0) [0|3] "" Vector__XXX
`;

/** Minimal engine model — `step(dtMs)` returns the current signal set. */
export function createEngine(data = {}) {
  const st = { state: data.state || 'off', throttle: data.throttle || 0, speedKph: data.speedKph || 0, rpm: 0, cltC: 20, oilBar: 0, gear: 0, crankMs: 0, fanOn: false };
  return {
    get: () => ({ ...st }),
    set(patch) {
      if (patch.state && patch.state !== st.state) {
        st.state = patch.state;
        if (patch.state === 'crank') st.crankMs = 0;
      }
      if (patch.throttle !== undefined) st.throttle = patch.throttle;
      if (patch.speedKph !== undefined) st.speedKph = patch.speedKph;
      if (patch.gear !== undefined) st.gear = patch.gear;
      if (patch.fanOn !== undefined) st.fanOn = patch.fanOn;
    },
    step(dtMs) {
      const dt = dtMs / 1000;
      if (st.state === 'crank') {
        st.crankMs += dtMs;
        st.rpm = 250;
        if (st.crankMs >= 1000) st.state = 'run';
      } else if (st.state === 'run') {
        const target = 800 + st.throttle * 60;
        st.rpm += (target - st.rpm) * Math.min(1, dt * 3);
        const cltTarget = st.fanOn ? 85 : 95;
        st.cltC += (cltTarget - st.cltC) * Math.min(1, dt / 30);
      } else {
        st.rpm = 0;
        st.cltC += (20 - st.cltC) * Math.min(1, dt / 120);
      }
      st.oilBar = st.rpm > 0 ? Math.min(6, 0.5 + st.rpm / 1500) : 0;
      return { RPM: Math.round(st.rpm), CLT: Math.round(st.cltC), OilP: st.oilBar, TPS: st.throttle, Speed: st.speedKph, Gear: st.gear, State: ['off', 'ign', 'crank', 'run'].indexOf(st.state) };
    },
  };
}

// ---------------------------------------------------------------- battery ---------------

/** `V = Voc − Ri·ΣI`; alternator holds `altV` when the engine runs; crank adds a 150 A pulse. */
export function batteryVoltage({ vocV = 12.6, riOhm = 0.015, altV = 14.2 } = {}, totalA = 0, { engineState = 'off' } = {}) {
  if (engineState === 'run') return Math.max(9, altV - 0.003 * totalA);
  const crankA = engineState === 'crank' ? 150 : 0;
  return Math.max(6, vocV - riOhm * (totalA + crankA));
}

// ---------------------------------------------------------------- components ------------

/** Fallback bank load object: a flat resistive load sized from `ratedA`/`ratedW` at 13.8 V. */
export function renderLoad(node) {
  const d = node.data || {};
  const ratedA = d.ratedA ?? (d.ratedW ? d.ratedW / 13.8 : 1);
  return { id: node.id, ratedA, vExp: 1, tableMs: 1, table: [], steadyA: ratedA, ripple: { hz: 0, pct: 0 }, coolDownMs: 1000, stallA: ratedA * 4, shortA: 999, pwm: { onPhaseExp: 0 }, fault: d.fault ?? null };
}
