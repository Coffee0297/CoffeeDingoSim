// lib/dbc.js — minimal Vector DBC parser / codec for the dingoPDM, dingoPDM-Max and CANBoard DBCs
// (renode/dbc/*.dbc). Pure ESM, no Node or browser-only APIs.
//
// Supported: BO_, SG_ (Intel @1 and Motorola @0, +/- sign, factor/offset, min/max, unit), VAL_,
// CM_ (also multi-line), SIG_VALTYPE_ (1 = float32, 2 = float64). Multiplexer indicators are parsed
// and ignored.
//
// Firmware addressing (docs/interfaces.md §2): a module at base B sends config on B+0, listens on B+1 and
// sends cyclic message n on B+2+n. The DBCs are absolute for the DEFAULT base (PDM 0x0DE → Msg0 =
// 224, CANBoard 0x640 → Msg0 = 1602); `rebase()` shifts every id for a module at another base.

export const DEFAULT_BASE = Object.freeze({ pdm: 0x0de, pdmmax: 0x0de, canboard: 0x640 });
export const CYCLIC_COUNT = Object.freeze({ pdm: 28, pdmmax: 28, canboard: 10 });
export const STATE_NAMES = Object.freeze(['Off', 'On', 'Overcurrent', 'Fault', 'Warning', 'OpenLoad']);
export const DEVICE_STATES = Object.freeze(['Run', 'Sleep', 'Overtemp', 'Error']);

/**
 * @typedef {{name:string,startBit:number,length:number,littleEndian:boolean,signed:boolean,
 *   factor:number,offset:number,min:number,max:number,unit:string,values:Object<number,string>|null,
 *   valueType:'int'|'float'|'double',multiplexer:string|null,comment?:string}} DbcSignal
 * @typedef {{id:number,ext:boolean,name:string,dlc:number,sender:string,signals:DbcSignal[],comment?:string}} DbcMessage
 * @typedef {{version:string,messages:Map<number,DbcMessage>,byName:Map<string,DbcMessage>,comments:string[]}} Dbc
 */

const RE_BO = /^BO_\s+(\d+)\s+([A-Za-z_]\w*)\s*:\s*(\d+)\s*(\S*)/;
const RE_SG =
  /^SG_\s+([A-Za-z_]\w*)\s*(M|m\d+M?)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([^,\s]+)\s*,\s*([^)\s]+)\s*\)\s*\[\s*([^|\]]*)\|([^\]]*)\]\s*"([^"]*)"/;
const RE_VAL = /^VAL_\s+(\d+)\s+([A-Za-z_]\w*)\s+(.*?)\s*;\s*$/;
const RE_VAL_PAIR = /(-?\d+)\s+"([^"]*)"/g;
const RE_SIG_VALTYPE = /^SIG_VALTYPE_\s+(\d+)\s+([A-Za-z_]\w*)\s*:\s*(\d)\s*;/;
const RE_CM_SG = /^CM_\s+SG_\s+(\d+)\s+([A-Za-z_]\w*)\s+"([\s\S]*)"\s*;\s*$/;
const RE_CM_BO = /^CM_\s+BO_\s+(\d+)\s+"([\s\S]*)"\s*;\s*$/;
const RE_CM_GLOBAL = /^CM_\s+"([\s\S]*)"\s*;\s*$/;

const maskId = (raw) => (raw & 0x80000000 ? (raw & 0x1fffffff) >>> 0 : raw);

/** Parse DBC text. Message ids with bit 31 set are extended (29-bit) frames. */
export function parseDbc(text) {
  if (typeof text !== 'string') throw new TypeError('parseDbc: text must be a string');
  /** @type {Dbc} */
  const dbc = { version: '', messages: new Map(), byName: new Map(), comments: [] };
  let cur = null;
  let pendingCm = null;
  const sigOf = (id, name) => dbc.messages.get(maskId(Number(id)))?.signals.find((s) => s.name === name);

  const applyComment = (stmt) => {
    let m;
    if ((m = RE_CM_SG.exec(stmt))) {
      const s = sigOf(m[1], m[2]);
      if (s) s.comment = m[3];
    } else if ((m = RE_CM_BO.exec(stmt))) {
      const msg = dbc.messages.get(maskId(Number(m[1])));
      if (msg) msg.comment = m[2];
    } else if ((m = RE_CM_GLOBAL.exec(stmt))) dbc.comments.push(m[1]);
  };

  for (const raw of text.split(/\r?\n/)) {
    if (pendingCm !== null) {
      pendingCm += '\n' + raw;
      if (/";\s*$/.test(raw)) {
        applyComment(pendingCm.trim());
        pendingCm = null;
      }
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    let m;
    if (line.startsWith('SG_ ')) {
      if (cur && (m = RE_SG.exec(line))) {
        cur.signals.push({
          name: m[1],
          multiplexer: m[2] || null,
          startBit: Number(m[3]),
          length: Number(m[4]),
          littleEndian: m[5] === '1',
          signed: m[6] === '-',
          factor: Number(m[7]),
          offset: Number(m[8]),
          min: m[9].trim() === '' ? 0 : Number(m[9]),
          max: m[10].trim() === '' ? 0 : Number(m[10]),
          unit: m[11],
          values: null,
          valueType: 'int',
        });
      }
      continue;
    }
    cur = null;
    if (line.startsWith('BO_ ') && (m = RE_BO.exec(line))) {
      const rawId = Number(m[1]);
      cur = { id: maskId(rawId), ext: rawId > 0x7fffffff, name: m[2], dlc: Number(m[3]), sender: m[4], signals: [] };
      dbc.messages.set(cur.id, cur);
      dbc.byName.set(cur.name, cur);
    } else if (line.startsWith('VERSION') && (m = /^VERSION\s+"([^"]*)"/.exec(line))) {
      dbc.version = m[1];
    } else if (line.startsWith('VAL_ ') && (m = RE_VAL.exec(line))) {
      const s = sigOf(m[1], m[2]);
      if (s) {
        s.values = {};
        for (const p of m[3].matchAll(RE_VAL_PAIR)) s.values[Number(p[1])] = p[2];
      }
    } else if (line.startsWith('SIG_VALTYPE_ ') && (m = RE_SIG_VALTYPE.exec(line))) {
      const s = sigOf(m[1], m[2]);
      if (s) s.valueType = m[3] === '1' ? 'float' : m[3] === '2' ? 'double' : 'int';
    } else if (line.startsWith('CM_ ')) {
      if (/";\s*$/.test(line)) applyComment(line);
      else pendingCm = line;
    }
  }
  return dbc;
}

// Bit walk, MSB first, shared by decode and encode.
//   Intel   (@1): value bit k is at message bit startBit+k.
//   Motorola(@0): startBit is the MSB (byte*8 + bitInByte); next bit is bitInByte-1, wrapping to
//                 bit 7 of the following byte.
function* bitPositions(sig) {
  if (sig.littleEndian) {
    for (let k = sig.length - 1; k >= 0; k--) yield sig.startBit + k;
  } else {
    let byte = sig.startBit >> 3;
    let bit = sig.startBit & 7;
    for (let k = 0; k < sig.length; k++) {
      yield byte * 8 + bit;
      if (--bit < 0) {
        bit = 7;
        byte++;
      }
    }
  }
}

function extractRaw(data, sig) {
  let raw = 0n;
  for (const pos of bitPositions(sig)) {
    const byte = pos >> 3;
    raw = (raw << 1n) | BigInt(byte < data.length ? (data[byte] >> (pos & 7)) & 1 : 0);
  }
  return raw;
}

function insertRaw(data, sig, raw) {
  let k = sig.length - 1;
  for (const pos of bitPositions(sig)) {
    const byte = pos >> 3;
    if (byte < data.length) {
      const mask = 1 << (pos & 7);
      data[byte] = (raw >> BigInt(k)) & 1n ? data[byte] | mask : data[byte] & ~mask & 0xff;
    }
    k--;
  }
}

const scratch = new DataView(new ArrayBuffer(8));

function rawToPhysical(raw, sig) {
  if (sig.valueType === 'float' && sig.length === 32) {
    scratch.setUint32(0, Number(raw));
    return scratch.getFloat32(0);
  }
  if (sig.valueType === 'double' && sig.length === 64) {
    scratch.setBigUint64(0, raw);
    return scratch.getFloat64(0);
  }
  const n = Number(sig.signed ? BigInt.asIntN(sig.length, raw) : raw);
  if (sig.factor === 1 && sig.offset === 0) return n;
  return Number((n * sig.factor + sig.offset).toPrecision(12)); // 41 * 0.1 → 4.1, not 4.1000000000000005
}

function physicalToRaw(value, sig) {
  if (sig.valueType === 'float' && sig.length === 32) {
    scratch.setFloat32(0, Number(value));
    return BigInt(scratch.getUint32(0));
  }
  if (sig.valueType === 'double' && sig.length === 64) {
    scratch.setFloat64(0, Number(value));
    return scratch.getBigUint64(0);
  }
  return BigInt.asUintN(sig.length, BigInt(Math.round((Number(value) - sig.offset) / sig.factor)));
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data && typeof data.length === 'number') return Uint8Array.from(data, (b) => b & 0xff);
  throw new TypeError('data must be a Uint8Array or an array of bytes');
}

/**
 * Decode one frame → `{id, name, signals:{name:value}, labels:{name:VAL_text}}`, or null when the id is
 * not in the DBC.
 */
export function decode(dbc, id, data) {
  const msg = dbc.messages.get(id);
  if (!msg) return null;
  const bytes = toBytes(data);
  const signals = {};
  const labels = {};
  for (const sig of msg.signals) {
    const v = rawToPhysical(extractRaw(bytes, sig), sig);
    signals[sig.name] = v;
    if (sig.values && sig.values[v] !== undefined) labels[sig.name] = sig.values[v];
  }
  return { id, name: msg.name, signals, labels };
}

/** Encode `{signal: physical}` for message `name` (or numeric id) → `{id, ext, dlc, data}`. Missing signals = 0. */
export function encode(dbc, name, signals = {}) {
  const msg = typeof name === 'number' ? dbc.messages.get(name) : dbc.byName.get(name);
  if (!msg) throw new RangeError(`encode: unknown message ${String(name)}`);
  const data = new Uint8Array(msg.dlc);
  for (const sig of msg.signals) {
    const v = signals[sig.name];
    if (v !== undefined && v !== null) insertRaw(data, sig, physicalToRaw(v, sig));
  }
  return { id: msg.id, ext: msg.ext, dlc: msg.dlc, data };
}

/** New Dbc with every message id shifted by (toBase − fromBase). The input is not modified. */
export function rebase(dbc, fromBase, toBase) {
  const delta = toBase - fromBase;
  const out = { ...dbc, messages: new Map(), byName: new Map() };
  for (const msg of dbc.messages.values()) {
    const copy = { ...msg, id: msg.id + delta };
    out.messages.set(copy.id, copy);
    out.byName.set(copy.name, copy);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Module telemetry (docs/interfaces.md §8 "telemetry").

/**
 * Returns `frame → partial telemetry | null`. The partial holds only what that frame carries
 * (`outputs:[{n,currentA}]` from Msg1/2, `outputs:[{n,state}]` from Msg3, `ocCount` from Msg4, `duty`
 * from Msg23, `inputs`/`vbattV`/`tempC`/`asleep` from Msg0; CANBoard `analogMv`, `positions`,
 * `inputs`, `digitalOut`). The server merges partials. Each partial also carries `msgIndex`, `name`,
 * the raw `signals` map and `telemetry` (the partial without those three) for server/compat.js.
 *
 * @param {'pdm'|'pdmmax'|'canboard'} kind
 * @param {number} baseId
 * @param {Dbc|string} [dbcSource] a full DBC for the DEFAULT base; default = built-in subset below.
 */
export function moduleTelemetryDecoder(kind, baseId, dbcSource) {
  if (!(kind in DEFAULT_BASE)) throw new RangeError(`unknown module kind ${kind}`);
  const src = dbcSource ?? builtinDbcText(kind);
  const dbc = rebase(typeof src === 'string' ? parseDbc(src) : src, DEFAULT_BASE[kind], baseId);
  const first = baseId + 2;
  const count = CYCLIC_COUNT[kind];
  const map = kind === 'canboard' ? canboardTelemetry : pdmTelemetry;
  return function decodeTelemetry(frame) {
    const id = frame?.id;
    if (frame?.ext || typeof id !== 'number' || id < first || id >= first + count) return null;
    const d = decode(dbc, id, frame.data ?? []);
    if (!d) return null;
    const t = map(id - first, d.signals, d.labels);
    return { ...t, msgIndex: id - first, name: d.name, signals: d.signals, telemetry: t };
  };
}

function numbered(signals, prefix) {
  const re = new RegExp(`^${prefix}_(\\d+)$`);
  const out = [];
  for (const [k, v] of Object.entries(signals)) {
    const m = re.exec(k);
    if (m) out.push([Number(m[1]), v]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
const bools = (s, p) => numbered(s, p).map(([, v]) => v !== 0);
const perOutput = (s, p, field) => numbered(s, p).map(([n, v]) => ({ n, [field]: v }));

function pdmTelemetry(msg, s, labels) {
  switch (msg) {
    case 0:
      return {
        inputs: bools(s, 'DigitalInput'),
        vbattV: s.BatteryVoltage,
        tempC: s.BoardTemperature,
        totalA: s.TotalCurrent,
        deviceState: labels.DeviceState ?? DEVICE_STATES[s.DeviceState] ?? String(s.DeviceState),
        asleep: s.DeviceState === 1,
      };
    case 1:
    case 2:
      return { outputs: perOutput(s, 'OutputCurrent', 'currentA') };
    case 3:
      return {
        outputs: numbered(s, 'OutputState').map(([n, v]) => ({
          n,
          state: labels[`OutputState_${n}`] ?? STATE_NAMES[v] ?? String(v),
        })),
        wiper: {
          state: labels.WiperState ?? s.WiperState,
          speed: labels.WiperSpeed ?? s.WiperSpeed,
          slow: s.WiperSlowSpeed === 1,
          fast: s.WiperFastSpeed === 1,
        },
        flashers: bools(s, 'Flasher'),
        timers: bools(s, 'Timer'),
      };
    case 4:
      return { outputs: perOutput(s, 'OutputResetCount', 'ocCount') };
    case 23:
      return { outputs: perOutput(s, 'OutputDC', 'duty') };
    default:
      return {};
  }
}

function canboardTelemetry(msg, s) {
  switch (msg) {
    case 0:
      return { analogMv: numbered(s, 'ADCVolt').map(([n, v]) => ({ n, mV: Math.round(v * 1000) })) };
    case 1:
      return { analogMv: [{ n: 5, mV: Math.round(s.ADCVolt5 * 1000) }], tempC: s.BoardTemp };
    case 2:
      return {
        positions: numbered(s, 'RotarySwitch').map(([, v]) => v),
        inputs: bools(s, 'DigitalInput'),
        digitalOut: bools(s, 'DigitalOutput'),
        analogSwitch: bools(s, 'AnalogSwitch'),
        flashers: bools(s, 'Flash'),
        timers: bools(s, 'Timer'),
        heartbeat: s.Heartbeat,
      };
    case 9:
      return { doDuty: numbered(s, 'DigitalOutputDC').map(([, v]) => v) };
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------------------------
// Built-in telemetry subset, generated to match renode/dbc/*.dbc (test/dbc.test.js decodes the same
// frames through both and compares). lib/ cannot read files, so the default decoder carries this.

function builtinDbcText(kind) {
  const L = [];
  const sg = (name, start, len, factor = 1, unit = '', sign = '+') =>
    L.push(` SG_ ${name} : ${start}|${len}@1${sign} (${factor},0) [0|0] "${unit}" Vector__XXX`);
  const bo = (id, name) => L.push('', `BO_ ${id} ${name}: 8 Vector__XXX`);
  const stateVals = ' 0 "Off" 1 "On" 2 "Overcurrent" 3 "Fault" 4 "Warning" 5 "OpenLoad" ;';
  if (kind === 'canboard') {
    bo(1602, 'CANBoardMsg0');
    for (let n = 1; n <= 4; n++) sg(`ADCVolt_${n}`, (n - 1) * 16, 16, 0.001);
    bo(1603, 'CANBoardMsg1');
    sg('BoardTemp', 48, 16);
    sg('ADCVolt5', 0, 16, 0.001);
    bo(1604, 'CANBoardMsg2');
    sg('Heartbeat', 56, 8);
    for (let n = 1; n <= 4; n++) sg(`DigitalOutput_${n}`, 47 + n, 1);
    for (let n = 1; n <= 5; n++) sg(`AnalogSwitch_${n}`, 39 + n, 1);
    for (let n = 1; n <= 8; n++) sg(`DigitalInput_${n}`, 31 + n, 1);
    for (let n = 1; n <= 4; n++) sg(`Timer_${n}`, 27 + n, 1);
    for (let n = 1; n <= 4; n++) sg(`Flash_${n}`, 23 + n, 1);
    for (let n = 1; n <= 5; n++) sg(`RotarySwitch_${n}`, (n - 1) * 4, 4);
    bo(1611, 'CANBoardMsg9');
    for (let n = 1; n <= 4; n++) sg(`DigitalOutputDC_${n}`, (n - 1) * 8, 8, 1, '%');
    return L.join('\n');
  }
  const outs = kind === 'pdmmax' ? 4 : 8;
  const p = kind === 'pdmmax' ? 'dingoPdmMax' : 'dingoPdm';
  bo(224, `${p}Msg0`);
  sg('BoardTemperature', 48, 16, 0.1, 'degC');
  sg('BatteryVoltage', 32, 16, 0.1, 'V');
  sg('TotalCurrent', 16, 16, 0.1, 'A');
  sg('PDMType', 12, 4);
  sg('DeviceState', 8, 4);
  sg('DigitalInput_2', 1, 1);
  sg('DigitalInput_1', 0, 1);
  bo(225, `${p}Msg1`);
  for (let n = 1; n <= 4; n++) sg(`OutputCurrent_${n}`, (n - 1) * 16, 16, 0.1, 'A');
  if (outs === 8) {
    bo(226, `${p}Msg2`);
    for (let n = 5; n <= 8; n++) sg(`OutputCurrent_${n}`, (n - 5) * 16, 16, 0.1, 'A');
  }
  bo(227, `${p}Msg3`);
  for (let n = 1; n <= 8; n++) sg(`Timer_${n}`, 55 + n, 1);
  for (let n = 1; n <= 4; n++) sg(`Flasher_${n}`, 47 + n, 1);
  sg('WiperState', 44, 4);
  sg('WiperSpeed', 40, 4);
  sg('WiperFastSpeed', 33, 1);
  sg('WiperSlowSpeed', 32, 1);
  for (let n = 1; n <= outs; n++) sg(`OutputState_${n}`, (n - 1) * 4, 4);
  bo(228, `${p}Msg4`);
  for (let n = 1; n <= outs; n++) sg(`OutputResetCount_${n}`, (n - 1) * 8, 8);
  bo(247, `${p}Msg23`);
  for (let n = 1; n <= 8; n++) sg(`OutputDC_${n}`, (n - 1) * 8, 8, 1, '%');
  L.push('');
  L.push('VAL_ 224 PDMType 0 "dingoPDM" 1 "dingoPDM-Max" ;');
  L.push('VAL_ 224 DeviceState 0 "Run" 1 "Sleep" 2 "Overtemp" 3 "Error" ;');
  L.push(
    'VAL_ 227 WiperState 0 "Park" 1 "Parking" 2 "Slow" 3 "Fast" 4 "Intermit Pause" 5 "Intermit On" 6 "Wash" 7 "Swipe" ;',
  );
  L.push(
    'VAL_ 227 WiperSpeed 0 "Park" 1 "Slow" 2 "Fast" 3 "Intermit Speed 1" 4 "Intermit Speed 2" 5 "Intermit Speed 3" 6 "Intermit Speed 4" 7 "Intermit Speed 5" 8 "Intermit Speed 6" ;',
  );
  for (let n = 1; n <= outs; n++) L.push(`VAL_ 227 OutputState_${n}${stateVals}`);
  return L.join('\n');
}
