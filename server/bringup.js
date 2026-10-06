// Bring-up sequencer: gets every simulated module onto its project base id with a minimal output
// config, over the real param protocol on the CAN hub (lib/paramproto.js, docs/interfaces.md §2).
//
// Why: every dingoPDM boots at the default base id 0x0DE with all outputs disabled. Five of them on
// one hub would all answer 0x0DF, so a fresh module is created OFF the hub (renode.js `isolate`),
// and this module attaches them one at a time, moves each to its project base id, writes the output
// config, burns it to the FRAM image and verifies it. A marker `nv/<module>.deploy.json` records
// what was deployed; the next start boots every module with a marker on the hub at once (the FRAM
// image already carries the project base id) and only re-deploys when the config hash changed.
//
// Inputs are deployed first (ioDeployWrites). Output params written per project-enabled output n (index 0x1000 + n - 1, CoffeeDingoFW
// core/param_defs.h OUTPUT_PARAMS):
//   sub 2 currentLimit (float A)   sub 3 inrushCurrentLimit (float A)   sub 4 inrushTime (ms)
//   sub 5 resetMode (0 None, 1 Count, 2 Endless)   sub 6 resetTime (ms)   sub 7 resetCountLimit
//   sub 17 primaryOutput (only when >= 0)   sub 18 warnLimit / sub 19 openLoadLimit (float A) and
//   sub 20 openLoadTime (only when the project sets them > 0)
//   sub 8 pwm enable + sub 12 fixed duty + sub 13 frequency (only when pwmEnabled)
//   sub 1 input (var-map index: the project's binding, or 1 = ALWAYS_TRUE with globals.forceOutputsOn)
//   sub 0 enabled = 1 — written LAST so the output switches on with its final limits.
// Disabled outputs are left at the firmware default (disabled). Nothing else is deployed (no CAN
// inputs, virtual inputs, Lua, sleep settings): outputs bound to CAN/virtual inputs stay off unless
// the scene sets globals.forceOutputsOn.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as P from '../lib/paramproto.js';

export const OUTPUT_PARAM_BASE = 0x1000;
export const VAR_ALWAYS_TRUE = 1; // core/device.cpp: pVarMap[1] = &ALWAYS_TRUE

/**
 * The param writes of the minimal output deploy for one module, in send order.
 * @param {any} module scene module (docs/interfaces.md §3) @param {{forceOutputsOn?:boolean}} [g] scene.globals
 * @returns {{n:number, index:number, sub:number, value:number, type?:'float', label:string}[]}
 */
export function outputDeployWrites(module, g = {}) {
  const out = [];
  if (module.kind === 'canboard') return out;
  for (const o of module.outputs || []) {
    if (!o.enabled) continue;
    const index = OUTPUT_PARAM_BASE + (o.n - 1);
    const w = (sub, value, label, type) => out.push({ n: o.n, index, sub, value, label, ...(type ? { type } : {}) });
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    w(2, num(o.currentLimit, 20), 'currentLimit', 'float');
    w(3, num(o.inrushCurrentLimit, 50), 'inrushCurrentLimit', 'float');
    w(4, Math.round(num(o.inrushTime, 1000)), 'inrushTime');
    w(5, Math.round(num(o.resetMode, 0)), 'resetMode');
    w(6, Math.round(num(o.resetTime, 1000)), 'resetTime');
    w(7, Math.round(num(o.resetCountLimit, 3)), 'resetCountLimit');
    if (num(o.primaryOutput, -1) >= 0) w(17, Math.round(o.primaryOutput), 'primaryOutput');
    if (num(o.warnLimit, 0) > 0) w(18, Number(o.warnLimit), 'warnLimit', 'float');
    if (num(o.openLoadLimit, 0) > 0) {
      w(19, Number(o.openLoadLimit), 'openLoadLimit', 'float');
      w(20, Math.round(num(o.openLoadTime, 1000)), 'openLoadTime');
    }
    if (o.pwmEnabled) {
      w(8, 1, 'pwmEnabled');
      w(12, Math.round(num(o.fixedDutyCycle, 100)), 'fixedDutyCycle');
      w(13, Math.round(num(o.frequency, 100)), 'frequency');
    }
    w(1, g.forceOutputsOn ? VAR_ALWAYS_TRUE : Math.round(num(o.input, 0)), g.forceOutputsOn ? 'input=AlwaysOn' : 'input');
    w(0, 1, 'enabled');
  }
  return out;
}

export const DIG_INPUT_PARAM_BASE = 0x1200;
export const DIG_OUTPUT_PARAM_BASE = 0x2100; // CANBoard
export const ANALOG_INPUT_PARAM_BASE = 0x2200; // CANBoard

/**
 * Input-side writes: every project-enabled digital input (both boards, `0x1200+i`: sub 1 mode,
 * 2 invert, 4 pull, then 0 enabled — inputs are disabled by default, so a switch on DIn does nothing
 * without this), and on the CANBoard every enabled digital output (`0x2100+i`: sub 1 input, 0 enabled)
 * and analog input (`0x2200+i` sub 0 enabled; rotary/switch/scale settings are NOT deployed).
 */
export function ioDeployWrites(module) {
  const out = [];
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  for (const d of module.inputs || []) {
    if (!d.enabled) continue;
    const index = DIG_INPUT_PARAM_BASE + (d.n - 1);
    out.push({ n: d.n, index, sub: 1, value: Math.round(num(d.mode, 0)), label: `di${d.n}.mode` });
    out.push({ n: d.n, index, sub: 2, value: d.invert ? 1 : 0, label: `di${d.n}.invert` });
    out.push({ n: d.n, index, sub: 4, value: Math.round(num(d.pull, 0)), label: `di${d.n}.pull` });
    out.push({ n: d.n, index, sub: 0, value: 1, label: `di${d.n}.enabled` });
  }
  if (module.kind !== 'canboard') return out;
  for (const d of module.digitalOut || []) {
    if (!d.enabled) continue;
    const index = DIG_OUTPUT_PARAM_BASE + (d.n - 1);
    out.push({ n: d.n, index, sub: 1, value: Math.round(num(d.input, 0)), label: `do${d.n}.input` });
    out.push({ n: d.n, index, sub: 0, value: 1, label: `do${d.n}.enabled` });
  }
  for (const a of module.analogIn || []) {
    if (!a.enabled) continue;
    out.push({ n: a.n, index: ANALOG_INPUT_PARAM_BASE + (a.n - 1), sub: 0, value: 1, label: `ai${a.n}.enabled` });
  }
  return out;
}

/** Everything the minimal deploy writes, in send order (inputs first, outputs last). */
export const deployWrites = (module, g = {}) => [...ioDeployWrites(module), ...outputDeployWrites(module, g)];

/** Hash of everything the deploy writes (base id included). */
export function deployHash(module, g = {}) {
  const body = JSON.stringify({ baseId: module.baseId, writes: deployWrites(module, g).map(({ index, sub, value }) => [index, sub, value]) });
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 16);
}

export const markerPath = (nvDir, id) => path.join(nvDir, `${id}.deploy.json`);

export function readMarker(nvDir, id) {
  try { return JSON.parse(fs.readFileSync(markerPath(nvDir, id), 'utf8')); } catch { return null; }
}

/** Modules that must boot off the hub: no marker for their current base id, or no FRAM image. */
export function modulesToIsolate(modules, nvDir) {
  return modules.filter((m) => {
    const mk = readMarker(nvDir, m.id);
    return !mk || mk.baseId !== m.baseId || !fs.existsSync(path.join(nvDir, `${m.id}.bin`));
  }).map((m) => m.id);
}

/**
 * Send `data` on `txId` and resolve with the first rx frame `accept` likes (null on timeout).
 * @param {any} bus server/bus.js instance (emits 'frame', has inject())
 */
export function request(bus, txId, data, accept, timeoutMs = 500) {
  return new Promise((resolve) => {
    const onFrame = (f) => {
      if (f.dir !== 'rx' || !accept(f)) return;
      clearTimeout(t); bus.off('frame', onFrame); resolve(f);
    };
    const t = setTimeout(() => { bus.off('frame', onFrame); resolve(null); }, timeoutMs);
    bus.on('frame', onFrame);
    bus.inject({ id: txId, dlc: 8, data: Array.from(data) }, 'bringup');
  });
}

/** Write one param on `base` and check the echo `[2, idx, sub, value]` on base+0. */
export async function writeChecked(bus, base, w, { tries = 3, timeoutMs = 500 } = {}) {
  const data = P.writeParam(w.index, w.sub, w.value, { type: w.type });
  const want = P.encodeValue(w.value, w.type);
  for (let i = 0; i < tries; i++) {
    const f = await request(bus, base + P.CONFIG_RX_OFFSET, data, (fr) => {
      if (fr.id !== base + P.CONFIG_TX_OFFSET) return false;
      const r = P.parseParamReply(Uint8Array.from(fr.data));
      return !!r && r.cmd === P.Cmd.Write && r.index === w.index && r.sub === w.sub;
    }, timeoutMs);
    if (f) {
      const r = P.parseParamReply(Uint8Array.from(f.data));
      // Int8/UInt8 params may echo only the low byte
      if (r.value === want || (r.value & 0xff) === (want & 0xff)) return r;
      throw new Error(`write 0x${w.index.toString(16)}/${w.sub} (${w.label}) = ${w.value}: module echoed ${r.value}`);
    }
  }
  throw new Error(`write 0x${w.index.toString(16)}/${w.sub} (${w.label}): no reply from base 0x${base.toString(16)}`);
}

/**
 * Poll Version on each of `bases` in turn until one answers (the module may still be booting) or
 * `totalMs` runs out. Resolves `{base, ...versionReply}` or null.
 */
export async function waitVersion(bus, bases, { totalMs = 20000, stepMs = 400 } = {}) {
  const list = [...new Set([].concat(bases))];
  const t0 = Date.now();
  while (Date.now() - t0 < totalMs) {
    for (const base of list) {
      const f = await request(bus, base + P.CONFIG_RX_OFFSET, P.versionRequest(), (fr) => fr.id === base + P.CONFIG_TX_OFFSET && fr.data[0] === P.Cmd.Version, stepMs);
      if (f) return { base, ...P.parseVersionReply(Uint8Array.from(f.data)) };
    }
  }
  return null;
}

/**
 * waitVersion with one recovery: when the module stays silent for half of `totalMs`, reset it
 * (`reset(id)`, the generated reset macro) and wait the other half. A Renode-booted CANBoard has been
 * seen to come up silent once in a while; a reset always brought it back.
 */
export async function waitBoot(bus, m, bases, { totalMs = 30000, reset = null, log = () => {} } = {}) {
  let ver = await waitVersion(bus, bases, { totalMs: reset ? totalMs / 2 : totalMs });
  if (!ver && reset) {
    log(`[bringup] ${m.id}: no Version reply after ${totalMs / 2000} s, resetting it once`);
    await reset(m.id);
    ver = await waitVersion(bus, bases, { totalMs: totalMs / 2 });
  }
  return ver;
}

async function burnChecked(bus, base) {
  for (let i = 0; i < 3; i++) {
    const f = await request(bus, base + P.CONFIG_RX_OFFSET, P.burn(), (fr) => fr.id === base + P.CONFIG_TX_OFFSET && !!P.parseBurnReply(Uint8Array.from(fr.data)), 6000);
    if (f) {
      if (!P.parseBurnReply(Uint8Array.from(f.data)).ok) throw new Error(`burn on 0x${base.toString(16)} reported failure`);
      return true;
    }
  }
  throw new Error(`burn on 0x${base.toString(16)}: no reply`);
}

/**
 * Move one module from whatever base it answers on to `m.baseId`, deploy outputs, burn, verify.
 * @returns {Promise<{from:number, version:string, writes:number}>}
 */
export async function configureModule(bus, m, g, { defaultBase, log = () => {}, bootMs = 30000, reset = null } = {}) {
  const ver = await waitBoot(bus, m, [defaultBase, m.baseId], { totalMs: bootMs, reset, log });
  if (!ver) throw new Error(`${m.id}: no Version reply on 0x${defaultBase.toString(16)} or 0x${m.baseId.toString(16)}`);
  const from = ver.base;
  log(`[bringup] ${m.id}: firmware ${ver.version} (${ver.kind}) answering on 0x${from.toString(16)}`);
  if (from !== m.baseId) {
    const w = { index: P.PARAM_BASE_ID.index, sub: P.PARAM_BASE_ID.sub, value: m.baseId, label: 'baseId' };
    // the echo already comes from the new base (paramproto.js setBaseIdSequence notes)
    const f = await request(bus, from + P.CONFIG_RX_OFFSET, P.writeParam(w.index, w.sub, w.value), (fr) => {
      const r = P.parseParamReply(Uint8Array.from(fr.data));
      return (fr.id === m.baseId || fr.id === from) && !!r && r.cmd === P.Cmd.Write && r.index === 0 && r.sub === 0;
    }, 1000);
    if (!f) throw new Error(`${m.id}: base id write got no reply`);
    log(`[bringup] ${m.id}: base id 0x${from.toString(16)} -> 0x${m.baseId.toString(16)}`);
  }
  const writes = deployWrites(m, g);
  for (const w of writes) await writeChecked(bus, m.baseId, w);
  await burnChecked(bus, m.baseId);
  await new Promise((r) => setTimeout(r, 150)); // InitCan re-runs ~50 ms after the burn reply
  const v = await request(bus, m.baseId + P.CONFIG_RX_OFFSET, P.readParam(0, 0), (fr) => fr.id === m.baseId && fr.data[0] === P.Cmd.Read, 1000);
  const r = v && P.parseParamReply(Uint8Array.from(v.data));
  if (!r || r.value !== m.baseId) throw new Error(`${m.id}: verify read of the base id failed`);
  log(`[bringup] ${m.id}: ${writes.length} params written, burned, base id verified 0x${m.baseId.toString(16)}`);
  return { from, version: ver.version, writes: writes.length };
}

/**
 * Run the bring-up for a started emulation.
 * @param {{bus:any, renode:any, scene:any, simulated:string[], isolated:string[], nvDir:string,
 *          log?:(l:string)=>void, bootMs?:number, reset?:(id:string)=>Promise<void>}} ctx
 * @returns {Promise<{module:string, action:'configured'|'redeployed'|'ok', from?:number, version?:string}[]>}
 */
export async function bringUp(ctx) {
  const { bus, renode, scene, nvDir } = ctx;
  const log = ctx.log || (() => {});
  const g = scene.globals || {};
  const mods = (scene.modules || []).filter((m) => ctx.simulated.includes(m.id));
  const isolated = new Set(ctx.isolated || []);
  const report = [];
  const mark = (m, extra) => fs.writeFileSync(markerPath(nvDir, m.id), JSON.stringify({ baseId: m.baseId, hash: deployHash(m, g), at: new Date().toISOString(), forceOutputsOn: !!g.forceOutputsOn, ...extra }, null, 2));

  // modules already on their project base id: check they answer, re-deploy if the config changed
  for (const m of mods.filter((x) => !isolated.has(x.id))) {
    const ver = await waitBoot(bus, m, m.baseId, { totalMs: ctx.bootMs ?? 30000, reset: ctx.reset, log });
    if (!ver) throw new Error(`${m.id}: no Version reply on its project base id 0x${m.baseId.toString(16)}`);
    if (readMarker(nvDir, m.id)?.hash === deployHash(m, g)) {
      log(`[bringup] ${m.id}: up on 0x${m.baseId.toString(16)}, firmware ${ver.version}, config unchanged`);
      report.push({ module: m.id, action: 'ok', version: ver.version });
      continue;
    }
    const r = await configureModule(bus, m, g, { defaultBase: m.baseId, log, reset: ctx.reset });
    mark(m, { version: r.version });
    report.push({ module: m.id, action: 'redeployed', ...r });
  }
  // fresh modules: attach to the hub one at a time, each still on the default base id
  for (const m of mods.filter((x) => isolated.has(x.id))) {
    const defaultBase = P.DEFAULT_BASE_IDS[m.kind] ?? 0x0de;
    log(`[bringup] ${m.id}: first start (no ${m.id}.deploy.json), attaching it alone to the hub`);
    await renode.connectCan(m.id);
    log(`[bringup] ${m.id}: on the hub, waiting for Version on 0x${defaultBase.toString(16)} / 0x${m.baseId.toString(16)}`);
    const r = await configureModule(bus, m, g, { defaultBase, log, bootMs: ctx.bootMs, reset: ctx.reset });
    mark(m, { version: r.version });
    report.push({ module: m.id, action: 'configured', ...r });
  }
  return report;
}
