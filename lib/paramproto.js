// lib/paramproto.js — the subset of the dingo param protocol the simulator needs (docs/interfaces.md §2):
// version, single Read / Write, Burn, Sleep, and the first-boot "set base id + burn" sequence.
// Pure ESM. Verified against CoffeeDingoFW @ e680ef4+ (line numbers below refer to that tree):
//
//   core/enums.h:39-84         MsgCmd: Read 1, Write 2, ReadParamNotFound 5, BurnSettings 30, Version 31,
//                              Sleep 32, Bootloader 33, CheckCrc 34, CheckCrcRsp 35, OutputTest 48.
//   core/device_config.h:23-24 CONFIG_TX_OFFSET 0 (module → tool), CONFIG_RX_OFFSET 1 (tool → module).
//   core/param_protocol.cpp:18-27  request decode: [cmd, idxLo, idxHi, sub, v0..v3] (value LE u32).
//   core/param_protocol.cpp:29-45  reply encode: same layout, DLC 8, SID = stConfig nBaseId + 0 —
//                              read at reply time (line 35), i.e. AFTER a write has been applied.
//   core/param_protocol.cpp:121-125 requests accepted only on stConfig nBaseId + 1 and DLC 8.
//   core/param_protocol.cpp:132-143 Read → [1, idx, sub, value] or [5, idx, sub, 0] (not found).
//   core/param_protocol.cpp:145-153 Write → WriteParam(param, value) (temp = false → writes stConfig
//                              directly, param_registry.cpp:162), reply [2, idx, sub, ReadParam()];
//                              out-of-range / unknown → NO reply at all.
//   core/param_defs.h:13       base id = {0x0000, 0, UInt16, DEFAULT_BASE_ID, min 0, max 0x7FF}.
//   core/param_defs.h:14       CAN speed = {0x0000, 1, Enum, 500K(1), 0..4}.
//   core/param_defs.h:16       CAN filter enable = {0x0000, 3, Bool, default 0}.
//   comms/request_msg.cpp:29-30 request handler also filters on stConfig nBaseId + 1.
//   comms/request_msg.cpp:34-55 Sleep: [32,'Q','U','I','T', …] DLC 8 → reply SID base+0, DLC 2 (line 42),
//                              so only [32,'Q'] is on the wire.
//   comms/request_msg.cpp:59-82 Burn: [30, 1, 3, 8, …] DLC 8 → [30, 1, 3, 8, WriteConfig() ? 1 : 0, 0,0,0]
//                              on base+0, then gReinitCanRequested → DeviceThread re-runs InitCan after
//                              50 ms (core/device.cpp:104-110).
//   comms/request_msg.cpp:245-262 Version: [31, …] DLC 8 → [31, BOARD_ID, 0, 0, major, minor, buildHi, buildLo].
//   core/device.cpp:378-389    CheckRequestMsgs() then ProcessParamMsg() for every RX frame; after a Write
//                              ApplyConfig(index & 0xFF00) — for 0x0000 that only re-reads the filter flag
//                              (config_handler.cpp:110-115); hardware filters change on Burn only.

export const Cmd = Object.freeze({
  Read: 1,
  Write: 2,
  ReadParamNotFound: 5,
  ReadAll: 10,
  ReadAllRsp: 11,
  ReadAllComplete: 12,
  BurnSettings: 30,
  Version: 31,
  Sleep: 32,
  Bootloader: 33,
  CheckCrc: 34,
  CheckCrcRsp: 35,
  OutputTest: 48,
});
const CMD_NAMES = Object.fromEntries(Object.entries(Cmd).map(([k, v]) => [v, k]));

export const CONFIG_TX_OFFSET = 0; // module → tool
export const CONFIG_RX_OFFSET = 1; // tool → module
export const PARAM_BASE_ID = Object.freeze({ index: 0x0000, sub: 0 });
export const PARAM_CAN_SPEED = Object.freeze({ index: 0x0000, sub: 1 });
export const BOARD_KINDS = Object.freeze({ 0: 'pdm', 1: 'pdmmax', 2: 'canboard' });
export const DEFAULT_BASE_IDS = Object.freeze({ pdm: 0x0de, pdmmax: 0x0de, canboard: 0x640 });

const u8 = (a) => Uint8Array.from(a, (b) => b & 0xff);

function paramFrame(cmd, index, sub, value) {
  const v = value >>> 0;
  return u8([cmd, index & 0xff, (index >> 8) & 0xff, sub, v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]);
}

/** Encode a JS number as the wire u32. `type: 'float'` → IEEE-754 bits; otherwise integer (negative → two's complement). */
export function encodeValue(value, type) {
  if (type === 'float') {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, Number(value));
    return dv.getUint32(0);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return Math.trunc(Number(value)) >>> 0;
}

/** Version request: `[31, 0×7]`, DLC 8, send on base+1. */
export const versionRequest = () => u8([Cmd.Version, 0, 0, 0, 0, 0, 0, 0]);

/** → `{boardId, kind, major, minor, build, version:'5.5.107'}` or null. */
export function parseVersionReply(data) {
  if (!data || data.length < 8 || data[0] !== Cmd.Version) return null;
  const build = (data[6] << 8) | data[7];
  return {
    boardId: data[1],
    kind: BOARD_KINDS[data[1]] ?? 'unknown',
    major: data[4],
    minor: data[5],
    build,
    version: `${data[4]}.${data[5]}.${build}`,
  };
}

/** Single write: `[2, idxLo, idxHi, sub, v0..v3]`. `opts.type = 'float'` for float params. */
export const writeParam = (index, sub, value, opts = {}) => paramFrame(Cmd.Write, index, sub, encodeValue(value, opts.type));
/** Single read: `[1, idxLo, idxHi, sub, 0,0,0,0]`. */
export const readParam = (index, sub) => paramFrame(Cmd.Read, index, sub, 0);

/** → `{cmd, cmdName, index, sub, value(u32), int32, float32, found}` or null. */
export function parseParamReply(data) {
  if (!data || data.length < 8) return null;
  const value = (data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24)) >>> 0;
  const dv = new DataView(new ArrayBuffer(4));
  dv.setUint32(0, value);
  return {
    cmd: data[0],
    cmdName: CMD_NAMES[data[0]] ?? `cmd${data[0]}`,
    index: data[1] | (data[2] << 8),
    sub: data[3],
    value,
    int32: value | 0,
    float32: dv.getFloat32(0),
    found: data[0] !== Cmd.ReadParamNotFound,
  };
}

/** Burn: `[30, 1, 3, 8, 0,0,0,0]` (the 1/3/8 signature is required, request_msg.cpp:59-63). */
export const burn = () => u8([Cmd.BurnSettings, 1, 3, 8, 0, 0, 0, 0]);

/** → `{ok:boolean}` or null when it is not a burn reply. */
export function parseBurnReply(data) {
  if (!data || data.length < 5 || data[0] !== Cmd.BurnSettings || data[1] !== 1 || data[2] !== 3 || data[3] !== 8) return null;
  return { ok: data[4] === 1 };
}

/** Sleep request: `[32,'Q','U','I','T',0,0,0]`. The ack is DLC 2 `[32,'Q']` (request_msg.cpp:42). */
export const sleep = () => u8([Cmd.Sleep, 0x51, 0x55, 0x49, 0x54, 0, 0, 0]);
export const parseSleepReply = (data) => (data && data.length >= 2 && data[0] === Cmd.Sleep && data[1] === 0x51 ? { ok: true } : null);

/**
 * Ordered steps to move a freshly booted module from `oldBase` to `newBase` and persist it.
 *
 * Why the reply ids look the way they do (firmware facts above):
 *  - Write of 0x0000/0 changes stConfig.nBaseId BEFORE the reply is encoded, so the Write echo already
 *    comes from newBase+0, and from then on the module only accepts requests on newBase+1.
 *  - Therefore Burn is sent to newBase+1 and answered on newBase+0.
 *  - Hardware CAN filters are only rebuilt on Burn. A fresh module has filtering disabled (param
 *    0x0000/3 default 0) so newBase+1 gets through; if filters were enabled the Burn would have to be
 *    retried — each step lists `acceptReplyIds` and `altTxIds` so a driver can accept the old id too
 *    and retry on the other id before giving up. Both are harmless: an id the module does not own is
 *    ignored by it.
 *
 * Step: `{name, txId, data, expectReplyId, acceptReplyIds, expectCmd, timeoutMs, altTxIds, check(data)}`.
 * `check(data)` returns true when the reply is the one this step waits for (cmd + payload verified).
 */
export function setBaseIdSequence(oldBase, newBase, opts = {}) {
  for (const b of [oldBase, newBase]) {
    if (!Number.isInteger(b) || b < 0 || b > 0x7fe) throw new RangeError(`base id out of range: ${b}`);
  }
  const timeoutMs = opts.timeoutMs ?? 500;
  const steps = [
    {
      name: 'version',
      txId: oldBase + CONFIG_RX_OFFSET,
      data: versionRequest(),
      expectReplyId: oldBase + CONFIG_TX_OFFSET,
      acceptReplyIds: [oldBase + CONFIG_TX_OFFSET],
      expectCmd: Cmd.Version,
      timeoutMs,
      altTxIds: [],
      check: (d) => parseVersionReply(d) !== null,
    },
  ];
  if (oldBase !== newBase) {
    steps.push({
      name: 'write-base-id',
      txId: oldBase + CONFIG_RX_OFFSET,
      data: writeParam(PARAM_BASE_ID.index, PARAM_BASE_ID.sub, newBase),
      expectReplyId: newBase + CONFIG_TX_OFFSET,
      acceptReplyIds: [newBase + CONFIG_TX_OFFSET, oldBase + CONFIG_TX_OFFSET],
      expectCmd: Cmd.Write,
      timeoutMs,
      altTxIds: [],
      check: (d) => {
        const r = parseParamReply(d);
        return !!r && r.cmd === Cmd.Write && r.index === 0 && r.sub === 0 && r.value === newBase;
      },
    });
  }
  steps.push({
    name: 'burn',
    txId: newBase + CONFIG_RX_OFFSET,
    data: burn(),
    expectReplyId: newBase + CONFIG_TX_OFFSET,
    acceptReplyIds: oldBase === newBase ? [newBase] : [newBase + CONFIG_TX_OFFSET, oldBase + CONFIG_TX_OFFSET],
    expectCmd: Cmd.BurnSettings,
    timeoutMs: opts.burnTimeoutMs ?? 2000, // flash page erase on the CANBoard
    altTxIds: oldBase === newBase ? [] : [oldBase + CONFIG_RX_OFFSET],
    check: (d) => parseBurnReply(d)?.ok === true,
  });
  steps.push({
    name: 'verify',
    txId: newBase + CONFIG_RX_OFFSET,
    data: readParam(PARAM_BASE_ID.index, PARAM_BASE_ID.sub),
    expectReplyId: newBase + CONFIG_TX_OFFSET,
    acceptReplyIds: [newBase + CONFIG_TX_OFFSET],
    expectCmd: Cmd.Read,
    timeoutMs,
    altTxIds: [],
    delayMs: 100, // InitCan restarts ~50 ms after the burn reply (device.cpp:107)
    check: (d) => {
      const r = parseParamReply(d);
      return !!r && r.cmd === Cmd.Read && r.value === newBase;
    },
  });
  return steps;
}

/** Does `frame` ({id, data}) answer `step`? */
export function matchesStep(step, frame) {
  if (!frame || !step.acceptReplyIds.includes(frame.id)) return false;
  const d = frame.data;
  return !!d && d[0] === step.expectCmd && step.check(d);
}
