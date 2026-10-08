// lib/populate.js — build the canvas (nodes, edges, notes) from imported modules (docs/interfaces.md §9).
// Pure ESM. The component library is injected so this file never imports lib/components.js:
//
//   componentsApi = {
//     matchKeyword(name) → {id, multiplier, parts:[{id, presetName?}], guess},
//     instantiate(id, {preset?, ratedA?}) → {component, preset, ratedA, ratedW, family?},
//     listComponents() → [{id, family, …}],
//   }
//
// Rules implemented:
//  1. modules come from lib/project.js (one node each; positions = layout row below);
//  2. every enabled output: parts × multiplier load instances, preset default when the part names a
//     preset, else ratedA = 0.6 × currentLimit shared across the instances; one `supply` edge each to
//     `out:<n>`; a follower output (primaryOutput >= 0, 0-based index of its primary, profet.h:21)
//     gets no loads of its own — each load of the primary gets a second edge to the follower handle;
//  3. a Rotary node per enabled analog input with rotary.enabled, edge `wiper` → `ai:<n>`;
//  4. a Switch node per enabled digital input (PDM or CANBoard), edge `contact` → `di:<n>`;
//  5. keypads from extras (BlinkMarineKeypads / GrayhillKeypads / enabled PDM keypads);
//  6. DbcDevices → cangen nodes;
//  7. a wiper motor load becomes a `wiper` node when CANBoard DOs named wiper|R_MODE|R_SPEED exist,
//     with edges `do:<n>` → `run` / `speed`;
//  8. always one battery and one engine node (engine `alternator` → battery `alt`).

import { MODULE_SPACING_X } from './project.js';

export const SIZING_FRACTION = 0.6;
export const LAYOUT = Object.freeze({
  moduleSpacingX: MODULE_SPACING_X,
  moduleY: 0,
  loadOffsetX: 220,
  loadSpacingY: 70,
  stimulusX: -320,
  stimulusSpacingY: 90,
});

// Profet sense saturation (docs/interfaces.md §2): I_sat = 3.3 · kILIS / 1200.
const KILIS = { pdm: (n) => (n <= 2 ? 22950 : 5950), pdmmax: () => 35000 };
export const kilis = (kind, n) => (KILIS[kind] ?? KILIS.pdm)(n);
export const saturationA = (kind, n) => (3.3 * kilis(kind, n)) / 1200;
const fmtA = (a) => (a >= 20 ? a.toFixed(0) : a.toFixed(1));
const list = (ns) => ns.join(', ');
const outs = (ns) => (ns.length === 1 ? `output ${ns[0]}` : `outputs ${list(ns)}`);

function isWiperComponent(id, inst, api) {
  if (/wiper/i.test(id ?? '')) return true;
  if (inst?.family === 'wiper') return true;
  try {
    return api.listComponents?.().some((c) => c.id === id && c.family === 'wiper') ?? false;
  } catch {
    return false;
  }
}

/**
 * @param {object[]} modules  from lib/project.js parseProject()
 * @param {object} componentsApi
 * @param {{extras?:object}} [opts]  extras defaults to `modules.extras`
 * @returns {{nodes:object[], edges:object[], notes:string[]}}
 */
export function populate(modules, componentsApi, opts = {}) {
  if (!Array.isArray(modules)) throw new TypeError('populate: modules must be an array');
  if (!componentsApi?.matchKeyword || !componentsApi?.instantiate) throw new TypeError('populate: componentsApi needs matchKeyword and instantiate');
  const extras = opts.extras ?? modules.extras ?? {};
  const nodes = [];
  const edges = [];
  const notes = [];
  let edgeSeq = 0;
  const edge = (fromNode, fromHandle, toNode, toHandle) =>
    edges.push({ id: `e${++edgeSeq}`, from: { node: fromNode, handle: fromHandle }, to: { node: toNode, handle: toHandle } });

  let stimY = 0;
  const stimPos = () => {
    const p = { x: LAYOUT.stimulusX, y: stimY };
    stimY += LAYOUT.stimulusSpacingY;
    return p;
  };

  // 8. battery + engine first so they sit at the top of the stimulus column
  nodes.push({ id: 'battery', type: 'battery', pos: stimPos(), data: { vocV: 12.6, riOhm: 0.015, altV: 14.2 } });
  nodes.push({ id: 'engine', type: 'engine', pos: stimPos(), data: { state: 'off', throttle: 0, speedKph: 0 } });
  edge('engine', 'alternator', 'battery', 'alt');

  const guessed = [];
  const wiperLoads = []; // {nodeId, module, n}

  modules.forEach((m, mi) => {
    const mx = m.pos?.x ?? mi * LAYOUT.moduleSpacingX;
    const my = m.pos?.y ?? LAYOUT.moduleY;
    let loadRow = 0;
    const loadsByOutput = new Map();

    // 2. outputs (primaries first, followers second)
    const outputs = (m.outputs ?? []).filter((o) => o.enabled);
    const followers = [];
    for (const o of outputs) {
      if (o.primaryOutput >= 0 && o.primaryOutput + 1 !== o.n) {
        followers.push(o);
        continue;
      }
      const match = componentsApi.matchKeyword(o.name) ?? {};
      const parts = match.parts?.length ? match.parts : [{ id: match.id ?? 'generic_resistive' }];
      const mult = Math.max(1, Math.trunc(match.multiplier ?? 1));
      const count = parts.length * mult;
      const shareA = (SIZING_FRACTION * (o.currentLimit || 0)) / count;
      if (match.guess) guessed.push(`${m.id} out ${o.n} "${o.name}"`);
      const ids = [];
      let k = 0;
      for (let r = 0; r < mult; r++) {
        for (const part of parts) {
          k++;
          const id = `${m.id}.o${o.n}.${k}`;
          const inst = part.presetName
            ? componentsApi.instantiate(part.id, { preset: part.presetName })
            : componentsApi.instantiate(part.id, { ratedA: shareA > 0 ? Number(shareA.toFixed(3)) : undefined });
          const data = {
            component: inst?.component ?? part.id,
            family: inst?.family ?? null,
            preset: part.presetName ? inst?.preset ?? part.presetName : null, // sized by ratedA otherwise
            ratedA: inst?.ratedA ?? shareA,
            ratedW: inst?.ratedW ?? null,
            fault: null,
            guess: !!match.guess,
            label: count > 1 ? `${o.name} (${k}/${count})` : o.name,
          };
          const node = { id, type: 'load', pos: { x: mx + LAYOUT.loadOffsetX, y: my + loadRow++ * LAYOUT.loadSpacingY }, data };
          if (isWiperComponent(data.component, inst, componentsApi)) wiperLoads.push({ node, module: m.id, n: o.n });
          nodes.push(node);
          edge(id, 'supply', m.id, `out:${o.n}`);
          ids.push(id);
        }
      }
      loadsByOutput.set(o.n, ids);
    }
    for (const o of followers) {
      const primaryN = o.primaryOutput + 1;
      const ids = loadsByOutput.get(primaryN);
      if (!ids?.length) {
        notes.push(`${m.id}: output ${o.n} "${o.name}" follows output ${primaryN}, which is disabled or has no load — nothing wired to it.`);
        continue;
      }
      for (const id of ids) edge(id, 'supply', m.id, `out:${o.n}`);
      notes.push(`${m.id}: output ${o.n} is paired with output ${primaryN} — its loads are wired to both handles and the current splits 50/50.`);
    }

    // 3. rotary knobs, and analog inputs used as a switch (a contact pulling the pin up)
    for (const a of m.analogIn ?? []) {
      const cfg = pinConfig(m, `ai:${a.n}`);
      if (!a.enabled || !cfg) continue;
      const id = `${m.id}.ai${a.n}`;
      nodes.push({ id, type: cfg.type, pos: stimPos(), data: { ...cfg.data, ...(cfg.type === 'rotary' ? { index: 0, noiseMv: 20 } : { state: false }) } });
      edge(id, cfg.type === 'rotary' ? 'wiper' : 'contact', m.id, `ai:${a.n}`);
    }

    // 4. switches
    for (const d of m.inputs ?? []) {
      if (!d.enabled) continue;
      const id = `${m.id}.di${d.n}`;
      const cfg = pinConfig(m, `di:${d.n}`);
      nodes.push({ id, type: cfg.type, pos: stimPos(), data: cfg.type === 'switch' ? { ...cfg.data, state: false } : cfg.data });
      edge(id, cfg.type === 'switch' ? 'contact' : 'out', m.id, `di:${d.n}`);
    }
  });

  // 7. wiper relay wiring
  const wiperDOs = [];
  for (const m of modules) {
    if (m.kind !== 'canboard') continue;
    for (const d of m.digitalOut ?? []) if (d.enabled && /wiper|R_MODE|R_SPEED/i.test(d.name)) wiperDOs.push({ module: m.id, ...d });
  }
  if (wiperLoads.length && wiperDOs.length) {
    const run = wiperDOs.find((d) => /R_MODE|\brun\b/i.test(d.name)) ?? wiperDOs[0];
    const speed = wiperDOs.find((d) => d !== run && /R_SPEED|speed|fast/i.test(d.name)) ?? wiperDOs.find((d) => d !== run);
    for (const w of wiperLoads) {
      w.node.type = 'wiper';
      Object.assign(w.node.data, { slowRps: 0.7, fastRps: 1.2 });
      edge(run.module, `do:${run.n}`, w.node.id, 'run');
      if (speed) edge(speed.module, `do:${speed.n}`, w.node.id, 'speed');
    }
    notes.push(
      `Wiper: ${wiperLoads.map((w) => `${w.module} out ${w.n}`).join(', ')} wired as a wiper motor, run ← ${run.module} DO${run.n} "${run.name}"` +
        (speed ? `, speed ← ${speed.module} DO${speed.n} "${speed.name}"` : '') +
        '; park switch left unwired (no park input in the project).',
    );
  } else if (wiperLoads.length) {
    notes.push(`Wiper motor on ${wiperLoads.map((w) => `${w.module} out ${w.n}`).join(', ')} has no CANBoard wiper relay outputs — kept as a plain load.`);
  }

  // 5. keypads
  const keypads = [
    ...(extras.blinkMarineKeypads ?? []).map((k) => ({ model: 'blink', k })),
    ...(extras.grayhillKeypads ?? []).map((k) => ({ model: 'grayhill', k })),
    ...(extras.pdmKeypads ?? []).map((k) => ({ model: Number(k.model ?? 0) >= 10 ? 'grayhill' : 'blink', k })),
  ];
  keypads.forEach(({ model, k }, i) => {
    const keys = Number(k.numButtons ?? k.keys ?? (Array.isArray(k.buttons) ? k.buttons.length : 8)) || 8;
    nodes.push({
      id: `keypad${i + 1}`,
      type: 'keypad',
      pos: stimPos(),
      data: { model, keys, nodeId: Number(k.nodeId ?? k.id ?? 0), pressed: Array(keys).fill(false), leds: [], name: k.name ?? `Keypad ${i + 1}` },
    });
  });

  // 6. DBC devices → CAN generators
  (extras.dbcDevices ?? []).forEach((d, i) => {
    nodes.push({ id: `cangen${i + 1}`, type: 'cangen', pos: stimPos(), data: { name: d.name ?? `DBC ${i + 1}`, dbc: d.dbcPath ?? d.path ?? d.file ?? null, frames: [] } });
  });

  // ---- notes (config observations) ----
  for (const m of modules) {
    if (m.kind === 'canboard') continue;
    const en = (m.outputs ?? []).filter((o) => o.enabled);
    if (!en.length) continue;
    const noReset = en.filter((o) => o.resetMode === 0).map((o) => o.n);
    if (noReset.length)
      notes.push(
        `${m.id}: resetMode None on ${noReset.length === en.length ? 'every enabled output' : 'outputs'} (${list(noReset)}) — the first overcurrent latches Fault until power cycle.`,
      );
    const sat = new Map();
    for (const o of en) {
      const s = saturationA(m.kind, o.n);
      if (o.inrushCurrentLimit > s) {
        const key = `${o.inrushCurrentLimit}|${fmtA(s)}`;
        if (!sat.has(key)) sat.set(key, { lim: o.inrushCurrentLimit, s, k: kilis(m.kind, o.n), ns: [] });
        sat.get(key).ns.push(o.n);
      }
    }
    for (const { lim, s, k, ns } of sat.values())
      notes.push(
        `${m.id}: inrush limit ${lim} A on ${outs(ns)} is above the ${fmtA(s)} A current-sense saturation (kILIS ${k}) — the inrush limit can never trip there; the steady limit takes over after inrushTime.`,
      );
    const unbound = en.filter((o) => !o.input).map((o) => o.n);
    if (unbound.length)
      notes.push(
        `${m.id}: ${outs(unbound)} ${unbound.length === 1 ? 'is' : 'are'} enabled with no input bound (input 0 = always off)` + (m.hasLua ? ' — presumably driven by the Lua script.' : ' — they will never turn on.'),
      );
  }
  if (guessed.length) notes.push(`Guessed components (Generic resistive, orange badge): ${guessed.join('; ')}.`);
  return { nodes, edges, notes };
}

/**
 * What a card wired to a module pin takes over from the project: its name and how it behaves.
 * Used by populate and by the canvas when a card is wired by hand (both config formats map to the
 * same module shape in lib/project.js). Returns `{type, data}` or null when the pin has nothing to offer.
 *   di:n  → switch: name, toggle/momentary (firmware InputMode: Momentary 0 = follows the contact = a
 *           toggle switch; Latching 1 = the firmware latches a press = a push button), level (InputPull
 *           Up 1 = the switch grounds the pin)
 *   ai:n  → rotary: name, positions with their mV, tolerance; or, with the analog switch enabled, a
 *           switch (12 V level, toggle/momentary from its mode)
 *   out:n → load: label = the output name
 */
export function pinConfig(module, handle) {
  const [kind, nStr] = String(handle || '').split(':');
  const n = Number(nStr);
  if (kind === 'di') {
    const d = (module?.inputs ?? []).find((x) => x.n === n);
    if (!d) return null;
    const level = d.pull === 1 ? 'gnd' : '12v';
    // a PWM input gets a PWM source at its configured frequency (auto-detect: 100 Hz)
    if (d.pwm) return { type: 'pwmsrc', data: { name: d.name, level, duty: 50, freq: d.pwmFreq || 100, on: true } };
    return { type: 'switch', data: { name: d.name, kind: d.mode === 1 ? 'momentary' : 'toggle', level } };
  }
  if (kind === 'ai') {
    const a = (module?.analogIn ?? []).find((x) => x.n === n);
    if (!a) return null;
    if (a.rotary?.enabled && a.rotary.numPos) {
      const positions = a.rotary.points.map((mV, k) => ({ name: a.rotary.positionNames?.[k] ?? `P${k}`, mV }));
      return { type: 'rotary', data: { name: a.name, positions, tolerance: a.rotary.tolerance } };
    }
    if (a.switch?.enabled) return { type: 'switch', data: { name: a.name, kind: a.switch.mode === 1 ? 'momentary' : 'toggle', level: '12v' } };
    return null;
  }
  if (kind === 'out') {
    const o = (module?.outputs ?? []).find((x) => x.n === n);
    return o ? { type: 'load', data: { label: o.name } } : null;
  }
  return null;
}
