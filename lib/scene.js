// lib/scene.js — scene model helpers (docs/interfaces.md §3, §5, §8). Pure ESM; nothing here mutates its input.
//
//   newScene(name, projectPath, modules, populated) → scene
//   validateScene(scene) → string[] (empty = valid)
//   toBankScenes(scene, renderFn, opts?) → [{type:'scene', machine, vbattV, noisePct, outputs}]
//   applyAction(scene, action) → new scene (UI actions of §8)

export const NODE_TYPES = Object.freeze(['load', 'switch', 'rotary', 'keypad', 'cangen', 'engine', 'battery', 'wiper']);
export const MODULE_KINDS = Object.freeze(['pdm', 'pdmmax', 'canboard']);
export const FAULT_KINDS = Object.freeze(['open', 'short', 'stall', 'intermittent', 'hires', 'wrongpart']);
export const ENGINE_STATES = Object.freeze(['off', 'ign', 'crank', 'run']);
const OUTPUT_COUNT = { pdm: 8, pdmmax: 4, canboard: 0 };

/** Source / target handles per node type (docs/interfaces.md §3 "Handles"). Module handles are checked separately. */
const HANDLES = {
  load: { src: ['supply'], dst: [] },
  wiper: { src: ['supply', 'park'], dst: ['run', 'speed'] },
  switch: { src: ['contact'], dst: [] },
  rotary: { src: ['wiper'], dst: [] },
  engine: { src: ['alternator'], dst: ['fan'] },
  battery: { src: [], dst: ['alt'] },
  keypad: { src: [], dst: [] },
  cangen: { src: [], dst: [] },
};
const SUPPLY_TYPES = new Set(['load', 'wiper']);

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export function newScene(name, projectPath, modules, populated = {}, opts = {}) {
  return {
    version: 1,
    name: String(name),
    project: { path: projectPath ?? null, hash: opts.hash ?? null },
    firmware: opts.firmware ?? {
      pdm: { source: 'release', tag: 'testing-latest' },
      pdmmax: { source: 'release', tag: 'testing-latest' },
      canboard: { source: 'release', tag: 'testing-latest' },
      bootloader: false,
    },
    modules: clone(modules ?? []),
    nodes: clone(populated.nodes ?? []),
    edges: clone(populated.edges ?? []),
    globals: { noisePct: 1, ...(opts.globals ?? {}) },
  };
}

function moduleHandle(m, handle) {
  // → 'src' | 'dst' | null
  const mt = /^(out|di|ai|do):(\d+)$/.exec(handle);
  if (!mt) return handle === 'vbatt' || handle === 'temp' ? 'src' : null;
  const n = Number(mt[2]);
  const has = (list) => (list ?? []).some((x) => x.n === n);
  switch (mt[1]) {
    case 'out':
      return m.kind !== 'canboard' && (has(m.outputs) || n <= OUTPUT_COUNT[m.kind]) ? 'dst' : null;
    case 'di':
      return has(m.inputs) ? 'dst' : null;
    case 'ai':
      return m.kind === 'canboard' && has(m.analogIn) ? 'dst' : null;
    case 'do':
      return m.kind === 'canboard' && has(m.digitalOut) ? 'src' : null;
  }
  return null;
}

export function validateScene(scene) {
  const errors = [];
  if (!scene || typeof scene !== 'object') return ['scene is not an object'];
  if (scene.version !== 1) errors.push(`version must be 1 (got ${scene.version})`);
  if (typeof scene.name !== 'string' || !scene.name) errors.push('name missing');
  if (!Array.isArray(scene.modules)) errors.push('modules must be an array');
  if (!Array.isArray(scene.nodes)) errors.push('nodes must be an array');
  if (!Array.isArray(scene.edges)) errors.push('edges must be an array');
  if (errors.length) return errors;

  const modules = new Map();
  const bases = new Map();
  for (const m of scene.modules) {
    if (!m?.id) {
      errors.push('module without id');
      continue;
    }
    if (modules.has(m.id)) errors.push(`duplicate module id ${m.id}`);
    modules.set(m.id, m);
    if (!MODULE_KINDS.includes(m.kind)) errors.push(`module ${m.id}: unknown kind ${m.kind}`);
    if (!Number.isInteger(m.baseId) || m.baseId < 0 || m.baseId > 0x7fe) errors.push(`module ${m.id}: baseId out of range`);
    else {
      // config + cyclic ids: base .. base+2+count-1
      const span = m.kind === 'canboard' ? 12 : 30;
      for (const [other, ob] of bases)
        if (m.baseId < ob.base + ob.span && ob.base < m.baseId + span) errors.push(`module ${m.id}: CAN id range overlaps ${other}`);
      bases.set(m.id, { base: m.baseId, span });
    }
  }
  const nodes = new Map();
  for (const n of scene.nodes) {
    if (!n?.id) {
      errors.push('node without id');
      continue;
    }
    if (nodes.has(n.id) || modules.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    nodes.set(n.id, n);
    if (!NODE_TYPES.includes(n.type)) errors.push(`node ${n.id}: unknown type ${n.type}`);
    if (n.data?.fault != null && !FAULT_KINDS.includes(n.data.fault.kind)) errors.push(`node ${n.id}: unknown fault ${n.data.fault.kind}`);
    if (n.type === 'rotary' && !(n.data?.positions?.length > 0)) errors.push(`rotary ${n.id}: no positions`);
  }

  const supplyEdges = new Map();
  const edgeIds = new Set();
  for (const e of scene.edges) {
    const tag = `edge ${e?.id ?? '?'}`;
    if (!e?.id) errors.push('edge without id');
    else if (edgeIds.has(e.id)) errors.push(`duplicate edge id ${e.id}`);
    edgeIds.add(e?.id);
    const ends = [
      [e?.from, 'src'],
      [e?.to, 'dst'],
    ];
    let ok = true;
    for (const [end, dir] of ends) {
      if (!end?.node || !end?.handle) {
        errors.push(`${tag}: incomplete endpoint`);
        ok = false;
        continue;
      }
      const m = modules.get(end.node);
      const n = nodes.get(end.node);
      if (!m && !n) {
        errors.push(`${tag}: unknown node ${end.node}`);
        ok = false;
        continue;
      }
      const kind = m ? moduleHandle(m, end.handle) : HANDLES[n.type]?.src.includes(end.handle) ? 'src' : HANDLES[n.type]?.dst.includes(end.handle) ? 'dst' : null;
      if (kind !== dir) {
        errors.push(`${tag}: ${end.node} has no ${dir === 'src' ? 'source' : 'target'} handle "${end.handle}"`);
        ok = false;
      }
    }
    if (ok && e.from.handle === 'supply' && SUPPLY_TYPES.has(nodes.get(e.from.node)?.type)) {
      if (!/^out:/.test(e.to.handle)) errors.push(`${tag}: supply must go to an out:<n> handle`);
      if (!supplyEdges.has(e.from.node)) supplyEdges.set(e.from.node, []);
      supplyEdges.get(e.from.node).push(e.to);
    }
  }
  for (const [id, n] of nodes) {
    if (!SUPPLY_TYPES.has(n.type)) continue;
    const targets = supplyEdges.get(id) ?? [];
    if (targets.length === 0) continue; // an unwired palette load is allowed (it is simply not simulated)
    if (targets.length === 1) continue;
    // several supply edges are only legal across one paired group of one module
    const mod = new Set(targets.map((t) => t.node));
    const groups = new Set(targets.map((t) => pairKey(modules.get(t.node), Number(t.handle.slice(4)))));
    if (mod.size !== 1 || groups.size !== 1 || !isPaired(modules.get(targets[0].node), Number(targets[0].handle.slice(4))))
      errors.push(`load ${id}: more than one supply edge outside a paired output group`);
  }
  return errors;
}

// ---- paired outputs ---------------------------------------------------------------------------
// primaryOutput is the 0-based index of the primary (profet.h:21), -1 = unpaired.
function primaryOf(m, n) {
  const o = (m?.outputs ?? []).find((x) => x.n === n);
  return o && o.primaryOutput >= 0 && o.primaryOutput + 1 !== n ? o.primaryOutput + 1 : n;
}
const pairKey = (m, n) => primaryOf(m, n);
function groupMembers(m, n) {
  const p = primaryOf(m, n);
  const members = [p, ...(m?.outputs ?? []).filter((o) => o.n !== p && o.primaryOutput + 1 === p && o.primaryOutput >= 0).map((o) => o.n)];
  return [...new Set(members)].sort((a, b) => a - b);
}
const isPaired = (m, n) => groupMembers(m, n).length > 1;

/** docs/interfaces.md §4: slow families get a coarse long table. */
export const SLOW_FAMILIES = Object.freeze(['heater', 'ptc', 'glow', 'compressor', 'hid']);
export const renderOptions = (family) =>
  SLOW_FAMILIES.includes(family) ? { tableMs: 100, horizonMs: 600000 } : { tableMs: 1, horizonMs: 10000 };

function scaleLoad(load, f) {
  if (f === 1) return load;
  const s = (v) => (typeof v === 'number' ? v * f : v);
  return {
    ...load,
    ratedA: s(load.ratedA),
    steadyA: s(load.steadyA),
    stallA: s(load.stallA),
    shortA: s(load.shortA),
    table: Array.isArray(load.table) ? load.table.map((x) => x * f) : load.table,
    split: f,
  };
}

/**
 * One docs/interfaces.md §5 "scene" message per module. `renderFn(loadNodeData, renderOpts, node)` → bank load
 * object (e.g. `(d, o) => render(instantiate(d.component, d), o)`); `renderOpts` = `renderOptions(family)`
 * (docs/interfaces.md §4; family from `data.family` or `opts.familyOf(componentId)`). Extra load fields
 * (loopMs, settled, pwm, …) pass through untouched. Loads come from `supply` edges. In a paired
 * group (primary + followers) every load attached to any member is fed to every member at 1/members
 * of its current, which is how the hardware shares a paralleled load.
 */
export function toBankScenes(scene, renderFn, opts = {}) {
  if (typeof renderFn !== 'function') throw new TypeError('toBankScenes: renderFn required');
  const nodes = new Map(scene.nodes.map((n) => [n.id, n]));
  const vbattV = opts.vbattV ?? 13.8;
  const noisePct = scene.globals?.noisePct ?? 1;
  const rendered = new Map();
  const render = (node) => {
    if (!rendered.has(node.id)) {
      const d = node.data ?? {};
      const family = d.family ?? opts.familyOf?.(d.component) ?? null;
      const r = renderFn(d, renderOptions(family), node) ?? {};
      rendered.set(node.id, { ...r, id: node.id, fault: node.data?.fault ?? null });
    }
    return rendered.get(node.id);
  };

  return scene.modules.map((m) => {
    const attached = new Map(); // output n → Set(loadId)
    for (const e of scene.edges) {
      if (e.to?.node !== m.id || !/^out:\d+$/.test(e.to.handle) || e.from?.handle !== 'supply') continue;
      const node = nodes.get(e.from.node);
      if (!node || !SUPPLY_TYPES.has(node.type)) continue;
      const n = Number(e.to.handle.slice(4));
      if (!attached.has(n)) attached.set(n, new Set());
      attached.get(n).add(node.id);
    }
    const outputs = {};
    const done = new Set();
    for (const n of [...attached.keys()].sort((a, b) => a - b)) {
      const members = groupMembers(m, n);
      const key = members.join(',');
      if (done.has(key)) continue;
      done.add(key);
      const ids = new Set();
      for (const k of members) for (const id of attached.get(k) ?? []) ids.add(id);
      const f = 1 / members.length;
      for (const k of members) {
        outputs[String(k)] = { loads: [...ids].map((id) => scaleLoad(render(nodes.get(id)), f)) };
      }
    }
    return { type: 'scene', machine: m.id, vbattV, noisePct, outputs };
  });
}

// ---- UI actions (docs/interfaces.md §8) ------------------------------------------------------------------

function withNode(scene, id, fn) {
  const i = scene.nodes.findIndex((n) => n.id === id);
  if (i < 0) throw new RangeError(`no node ${id}`);
  const node = scene.nodes[i];
  const data = fn({ ...(node.data ?? {}) }, node);
  const nodesOut = scene.nodes.slice();
  nodesOut[i] = { ...node, data };
  return { ...scene, nodes: nodesOut };
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function applyAction(scene, action) {
  if (!action?.kind) throw new TypeError('action.kind required');
  switch (action.kind) {
    case 'switch':
      return withNode(scene, action.node, (d) => ({ ...d, state: !!action.state }));
    case 'rotary':
      return withNode(scene, action.node, (d) => {
        const max = Math.max(0, (d.positions?.length ?? 1) - 1);
        return { ...d, index: Math.max(0, Math.min(max, Math.trunc(num(action.index, 0)))) };
      });
    case 'keypad':
      return withNode(scene, action.node, (d) => {
        const keys = d.keys ?? d.pressed?.length ?? 0;
        const pressed = Array.from({ length: keys }, (_, k) => !!d.pressed?.[k]);
        if (Number.isInteger(action.key) && action.key >= 0 && action.key < keys) pressed[action.key] = !!action.pressed;
        return { ...d, pressed };
      });
    case 'fault':
      return withNode(scene, action.node, (d) => {
        const f = action.fault;
        if (f == null || f.kind === 'clear') return { ...d, fault: null };
        if (!FAULT_KINDS.includes(f.kind)) throw new RangeError(`unknown fault ${f.kind}`);
        return { ...d, fault: { kind: f.kind, atMs: num(f.atMs, 0) } };
      });
    case 'battery':
      return withNode(scene, action.node, (d) => ({
        ...d,
        vocV: num(action.vocV, d.vocV),
        riOhm: num(action.riOhm, d.riOhm),
        altV: num(action.altV, d.altV),
      }));
    case 'engine':
      return withNode(scene, action.node, (d) => {
        if (action.state !== undefined && !ENGINE_STATES.includes(action.state)) throw new RangeError(`unknown engine state ${action.state}`);
        return {
          ...d,
          state: action.state ?? d.state,
          throttle: Math.max(0, Math.min(100, num(action.throttle, d.throttle ?? 0))),
          speedKph: Math.max(0, num(action.speedKph, d.speedKph ?? 0)),
        };
      });
    case 'temp': {
      const i = scene.modules.findIndex((m) => m.id === action.module);
      if (i < 0) throw new RangeError(`no module ${action.module}`);
      const modules = scene.modules.slice();
      modules[i] = { ...modules[i], tempC: num(action.c, modules[i].tempC) };
      return { ...scene, modules };
    }
    case 'renode':
      return scene; // Renode control does not change the scene
    default:
      throw new RangeError(`unknown action kind ${action.kind}`);
  }
}
