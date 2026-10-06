// Loads the shared lib/ modules (owned by other workstreams) and adapts them to the small
// internal API the server uses. If a lib module is missing or exposes an unexpected shape,
// the built-in fallbacks take over and the fact is logged once. Never writes into lib/.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './state.js';
import * as fb from './fallbacks.js';

const cache = new Map();
const warned = new Set();

function warnOnce(key, text) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[compat] ${text}`);
}

/** Dynamic import of `lib/<name>.js`; null when absent or failing to load. */
export async function loadLib(name) {
  if (cache.has(name)) return cache.get(name);
  const file = path.join(ROOT, 'lib', `${name}.js`);
  let mod = null;
  if (fs.existsSync(file)) {
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (e) {
      warnOnce(`load:${name}`, `lib/${name}.js failed to load (${e.message}); using fallback`);
    }
  } else warnOnce(`missing:${name}`, `lib/${name}.js not present; using fallback`);
  cache.set(name, mod);
  return mod;
}

/** Tests inject doubles here; `null` resets to the real lib. */
export function injectLib(name, mod) {
  if (mod === null) cache.delete(name);
  else cache.set(name, mod);
}

/** `{ splitter(), encode(frame) → line (no CR), decode(line) }` */
export async function getSlcan(override) {
  const lib = override ?? (await loadLib('slcan'));
  const encodeRaw = lib?.encode ?? fb.encode;
  const decodeRaw = lib?.decode ?? fb.decode;
  const Splitter = lib?.LineSplitter ?? fb.LineSplitter;
  return {
    splitter() {
      const s = new Splitter();
      if (typeof s.push === 'function') {
        return {
          push(chunk) {
            const r = s.push(chunk);
            return Array.isArray(r) ? r.map(stripCr) : [];
          },
        };
      }
      // event-style splitter: collect synchronously emitted lines
      const pending = [];
      const feed = s.feed?.bind(s) || s.write?.bind(s);
      s.on?.('line', (l) => pending.push(stripCr(l)));
      return { push(chunk) { feed?.(chunk); return pending.splice(0); } };
    },
    encode(frame) { return stripCr(encodeRaw(frame)); },
    decode(line) {
      try { return decodeRaw(line); } catch { return null; }
    },
  };
}
const stripCr = (l) => (typeof l === 'string' ? l.replace(/[\r\n]+$/, '') : l);

/**
 * `{ telemetryDecoder(kind) → (frame, baseId) → {msgIndex, signals}|null, parseDbc, encodeMessage }`
 * The lib decoder may return `{signals}`, a flat signal map, or a telemetry partial; all are accepted.
 */
export async function getDbc(override) {
  const lib = override ?? (await loadLib('dbc'));
  return {
    telemetryDecoder(kind, baseId) {
      const mk = lib?.moduleTelemetryDecoder;
      if (typeof mk !== 'function') return fb.moduleTelemetryDecoder(kind);
      let dec;
      try { dec = mk(kind, baseId); } catch { dec = null; }
      const fn = typeof dec === 'function' ? dec : typeof dec?.decode === 'function' ? dec.decode.bind(dec) : null;
      if (!fn) {
        warnOnce('dbc:shape', 'lib/dbc.js moduleTelemetryDecoder returned an unexpected shape; using fallback decoder');
        return fb.moduleTelemetryDecoder(kind);
      }
      return (frame, base) => {
        let r;
        try { r = fn(frame, base); } catch { return null; }
        if (!r) return null;
        if (r.signals) return { msgIndex: r.msgIndex ?? frame.id - (base + 2), name: r.name, signals: r.signals, telemetry: r.telemetry ?? r.partial };
        if (r.outputs || r.inputs || r.positions) return { msgIndex: frame.id - (base + 2), signals: {}, telemetry: r };
        return { msgIndex: frame.id - (base + 2), signals: r };
      };
    },
    parseDbc: lib?.parseDbc ?? lib?.parse ?? fb.parseDbc,
    /** `(db, messageNameOrId, signals) → Uint8Array|null` */
    encodeMessage(db, msgRef, signals) {
      for (const name of ['encodeMessage', 'encodeFrame', 'encode']) {
        if (typeof lib?.[name] === 'function') {
          try {
            const r = lib[name](db, msgRef, signals);
            if (r?.data) return r.data;
            if (r instanceof Uint8Array || Array.isArray(r)) return Uint8Array.from(r);
          } catch { /* fall through */ }
        }
      }
      const msg = findMessage(db, msgRef);
      return msg ? fb.encodeMessage(msg, signals) : null;
    },
    findMessage,
  };
}

function findMessage(db, ref) {
  const msgs = db?.messages instanceof Map ? [...db.messages.values()] : Array.isArray(db?.messages) ? db.messages : Object.values(db?.messages || {});
  return msgs.find((m) => m.name === ref || m.id === ref || m.id === Number(ref)) || null;
}

/** Engine model: `{ get(), set(patch), step(dtMs) → signals }` */
export async function getEngine(override) {
  const lib = override ?? (await loadLib('engine'));
  // lib/engine.js is functional: initialState(), step(state, dtMs, inputs), signals(state)
  if (typeof lib?.step === 'function' && typeof lib?.initialState === 'function') {
    return (data = {}) => {
      let st = lib.initialState({ throttle: data.throttle ?? 0, speedKph: data.speedKph ?? 0 });
      let inputs = { state: data.state };
      return {
        get: () => ({ ...st }),
        set(patch) { inputs = { ...inputs, ...patch }; },
        step(dtMs) {
          st = lib.step(st, dtMs, inputs);
          delete inputs.state; // a state request is consumed by one step (crank → run handled by the model)
          return lib.signals ? lib.signals(st) : st;
        },
      };
    };
  }
  const mk = lib?.createEngine ?? (lib?.Engine ? (d) => new lib.Engine(d) : null);
  if (!mk) return fb.createEngine;
  return (data) => {
    const e = mk(data);
    if (typeof e?.step === 'function' && typeof e?.set === 'function') return e;
    warnOnce('engine:shape', 'lib/engine.js engine lacks step()/set(); using fallback engine');
    return fb.createEngine(data);
  };
}

/** `(batteryData, totalA, {engineState}) → V` */
export async function getBattery(override) {
  const lib = override ?? (await loadLib('battery'));
  if (typeof lib?.V === 'function') {
    // lib/battery.js: V(voc, riOhm, totalA, altV, altOn); the caller adds the crank pulse
    return (d = {}, totalA = 0, { engineState = 'off' } = {}) =>
      lib.V(d.vocV, d.riOhm, totalA + (engineState === 'crank' ? lib.CRANK_A ?? 150 : 0), d.altV, engineState === 'run');
  }
  const fn = lib?.batteryVoltage ?? lib?.voltage;
  return typeof fn === 'function' ? fn : fb.batteryVoltage;
}

/** `{ listComponents(), renderLoad(node) → bank load object }` */
export async function getComponents(override) {
  const lib = override ?? (await loadLib('components'));
  return {
    listComponents() {
      try { return lib?.listComponents?.() ?? []; } catch { return []; }
    },
    lib,
    familyOf(id) { try { return lib?.getComponent?.(id)?.family ?? null; } catch { return null; } },
    renderLoad(node, renderOpts = {}) {
      const d = node.data || {};
      if (lib?.instantiate && lib?.render && d.component) {
        try {
          const inst = lib.instantiate(d.component, { preset: d.preset, ratedW: d.ratedW, ratedA: d.ratedA, params: d.params });
          const load = lib.render(inst, renderOpts);
          return { id: node.id, ...load, fault: d.fault ?? null };
        } catch (e) {
          warnOnce(`comp:${d.component}`, `components.render failed for ${d.component}: ${e.message}`);
        }
      }
      return fb.renderLoad(node);
    },
    matchKeyword: lib?.matchKeyword,
  };
}

/** lib/scene.js toBankScenes or null */
export async function getSceneLib() {
  const lib = await loadLib('scene');
  return { toBankScenes: typeof lib?.toBankScenes === 'function' ? lib.toBankScenes : null };
}

/** `{ importProject(json) → modules[] | null, populate(modules, components) → {nodes,edges,notes} | null }` */
export async function getProjectLibs() {
  const project = await loadLib('project');
  const populate = await loadLib('populate');
  const importFn = project?.importProject ?? project?.modulesFromProject ?? project?.parseProject ?? project?.fromConfigFile ?? null;
  return { importProject: importFn, populate: populate?.populate ?? null };
}
