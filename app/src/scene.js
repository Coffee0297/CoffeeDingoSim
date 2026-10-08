// scene.js — pure helpers shared by the canvas, the palette and the mock: scene ⇄ Svelte Flow
// conversion, the handle-compatibility rules of docs/interfaces.md §3, node defaults and a built-in
// fallback component list for when no server is attached. No DOM, no Svelte — testable in node.

export const NOMINAL_V = 13.8;

export const KIND_LABEL = { pdm: 'dingoPDM', pdmmax: 'PDM-Max', canboard: 'CANBoard' };

/** Profet saturation per output (A) — docs/interfaces.md §2. */
export function saturationA(kind, n) {
  if (kind === 'pdmmax') return 96;
  return n <= 2 ? 63 : 16.4;
}

export function handleKind(h) {
  if (!h) return null;
  const i = h.indexOf(':');
  return i < 0 ? h : h.slice(0, i);
}
export function handleIndex(h) {
  if (!h) return null;
  const i = h.indexOf(':');
  return i < 0 ? null : Number(h.slice(i + 1));
}

/**
 * Legal (source node type, source handle kind) → (target node type, target handle kind) pairs.
 * `oneSource` → the target handle accepts a single edge.
 */
export const RULES = [
  { from: ['load', 'supply'], to: ['module', 'out'] },
  { from: ['load', 'supply'], to: ['engine', 'fan'] },
  { from: ['wiper', 'supply'], to: ['module', 'out'] },
  { from: ['switch', 'contact'], to: ['module', 'di'], oneSource: true },
  { from: ['switch', 'contact'], to: ['module', 'ai'], oneSource: true },   // an analog input in switch mode
  { from: ['wiper', 'park'], to: ['module', 'di'], oneSource: true },
  { from: ['pwmsrc', 'out'], to: ['module', 'di'], oneSource: true },
  { from: ['rotary', 'wiper'], to: ['module', 'ai'], oneSource: true },
  { from: ['module', 'do'], to: ['wiper', 'run'], oneSource: true },
  { from: ['module', 'do'], to: ['wiper', 'speed'], oneSource: true },
  { from: ['engine', 'alternator'], to: ['battery', 'alt'], oneSource: true },
];

export function findModule(scene, id) {
  return scene?.modules?.find((m) => m.id === id) || null;
}
export function findNode(scene, id) {
  return scene?.nodes?.find((n) => n.id === id) || null;
}
export function nodeType(scene, id) {
  if (findModule(scene, id)) return 'module';
  return findNode(scene, id)?.type || null;
}
export function outputConfig(mod, n) {
  return mod?.outputs?.find((o) => o.n === n) || null;
}

/**
 * Two outputs of one module are a primary/follower pair when either names the other as its
 * `primaryOutput`. dingoConfig stores the primary as an output index; both 0-based and 1-based
 * are accepted so the rule survives either convention.
 */
export function isPaired(mod, a, b) {
  if (!mod || a === b) return false;
  const p = (o, other) => !!o && o.primaryOutput >= 0 && (o.primaryOutput === other - 1 || o.primaryOutput === other);
  return p(outputConfig(mod, a), b) || p(outputConfig(mod, b), a);
}

const bad = (reason) => ({ ok: false, reason });

/**
 * Edge rules of docs/interfaces.md §3.
 * @param {object} scene
 * @param {Array<{id:string, from:{node:string,handle:string}, to:{node:string,handle:string}}>} edges existing scene edges
 * @param {{source:string, sourceHandle:string|null, target:string, targetHandle:string|null}} c
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateConnection(scene, edges, c) {
  if (!c || !c.source || !c.target || !c.sourceHandle || !c.targetHandle) return bad('Drop the wire on a handle');
  if (c.source === c.target) return bad('A node cannot feed itself');
  const st = nodeType(scene, c.source), tt = nodeType(scene, c.target);
  const sk = handleKind(c.sourceHandle), tk = handleKind(c.targetHandle);
  if (!st || !tt) return bad('Unknown node');
  const rule = RULES.find((r) => r.from[0] === st && r.from[1] === sk && r.to[0] === tt && r.to[1] === tk);
  if (!rule) return bad(`${st} ${sk} cannot feed ${tt} ${tk}`);
  if (edges.some((e) => e.from.node === c.source && e.from.handle === c.sourceHandle && e.to.node === c.target && e.to.handle === c.targetHandle)) {
    return bad('Already connected');
  }
  if (rule.oneSource) {
    const taken = edges.find((e) => e.to.node === c.target && e.to.handle === c.targetHandle);
    if (taken) return bad(`${c.target} ${c.targetHandle} is already driven by ${taken.from.node}`);
  }
  if (sk === 'supply' && tk === 'out') {
    const existing = edges.filter((e) => e.from.node === c.source && e.from.handle === 'supply' && handleKind(e.to.handle) === 'out');
    if (existing.length >= 2) return bad('A load hangs on one output (or one paired pair)');
    if (existing.length === 1) {
      const ex = existing[0];
      const mod = findModule(scene, c.target);
      if (ex.to.node !== c.target || !isPaired(mod, handleIndex(ex.to.handle), handleIndex(c.targetHandle))) {
        return bad(`Already supplied by ${ex.to.node} ${ex.to.handle} — only its paired output can share the load`);
      }
    }
  }
  if (st === 'load' && tk === 'fan' && edges.some((e) => e.from.node === c.source && handleKind(e.to.handle) === 'fan')) {
    return bad('This load already cools the engine');
  }
  return { ok: true };
}

/** Flow-edge → scene-edge shape. */
export function edgeToScene(e) {
  return { id: e.id, from: { node: e.source, handle: e.sourceHandle }, to: { node: e.target, handle: e.targetHandle } };
}

const round = (v) => Math.round(Number(v) || 0);

/** Scene file (§3) → Svelte Flow nodes/edges. Module nodes are not deletable (they come from the project). */
export function sceneToFlow(scene) {
  const nodes = [];
  for (const m of scene?.modules || []) {
    nodes.push({ id: m.id, type: 'module', position: { x: m.pos?.x ?? 0, y: m.pos?.y ?? 0 }, data: { module: m }, deletable: false });
  }
  for (const n of scene?.nodes || []) {
    nodes.push({ id: n.id, type: n.type, position: { x: n.pos?.x ?? 0, y: n.pos?.y ?? 0 }, data: { ...(n.data || {}) } });
  }
  const edges = (scene?.edges || []).map((e) => ({
    id: e.id, source: e.from.node, sourceHandle: e.from.handle, target: e.to.node, targetHandle: e.to.handle,
  }));
  return { nodes, edges };
}

/** Svelte Flow nodes/edges → scene file, keeping everything the canvas does not own (project, firmware, globals). */
export function flowToScene(scene, nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const modules = (scene?.modules || []).map((m) => {
    const fn = byId.get(m.id);
    return fn ? { ...m, pos: { x: round(fn.position.x), y: round(fn.position.y) } } : m;
  });
  const sceneNodes = nodes
    .filter((n) => n.type !== 'module')
    .map((n) => ({ id: n.id, type: n.type, pos: { x: round(n.position.x), y: round(n.position.y) }, data: { ...(n.data || {}) } }));
  const sceneEdges = edges.map(edgeToScene);
  return { ...(scene || { version: 1, name: 'untitled' }), modules, nodes: sceneNodes, edges: sceneEdges };
}

/** Stable JSON for change detection (key order of the scene is preserved as produced). */
export function sceneJson(scene) {
  return JSON.stringify(scene);
}

export function nextId(prefix, items) {
  let max = 0;
  for (const it of items || []) {
    const m = /^([a-z]+)(\d+)$/.exec(it.id || '');
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}${max + 1}`;
}

/** Default `data` for a freshly dropped node of each type (shapes of docs/interfaces.md §3). */
export function nodeDefaults(type) {
  switch (type) {
    case 'switch': return { kind: 'toggle', level: '12v', state: false };
    case 'rotary': return {
      positions: [{ name: 'OFF', mV: 500 }, { name: '1', mV: 1800 }, { name: '2', mV: 3200 }, { name: '3', mV: 4500 }],
      index: 0, noiseMv: 20,
    };
    case 'keypad': return { model: 'blink', keys: 8, nodeId: 21, pressed: Array(8).fill(false), leds: [] };
    case 'cangen': return { dbc: 'renode/SimEngine.dbc', frames: [{ id: 512, cycleMs: 100, signals: { RPM: 850 } }] };
    case 'engine': return { state: 'off', throttle: 0, speedKph: 0 };
    case 'battery': return { vocV: 12.6, riOhm: 0.015, altV: 14.2 };
    case 'wiper': return { ratedW: 60, slowRps: 0.7, fastRps: 1.2 };
    case 'pwmsrc': return { level: '12v', duty: 50, freq: 100, on: true };
    case 'load': return { component: 'generic_resistive', preset: null, ratedA: 1, ratedW: 13.8, fault: null, guess: false };
    default: return {};
  }
}

/** Load node data from a palette component (+ optional preset name). */
export function loadFromComponent(comp, presetName) {
  const preset = (comp.presets || []).find((p) => p.name === presetName) || (comp.presets || [])[0] || null;
  let ratedW = preset?.W ?? null, ratedA = preset?.A ?? null;
  if (ratedW == null && ratedA != null) ratedW = +(ratedA * NOMINAL_V).toFixed(1);
  if (ratedA == null && ratedW != null) ratedA = +(ratedW / NOMINAL_V).toFixed(2);
  if (ratedW == null) { ratedW = 13.8; ratedA = 1; }
  return {
    component: comp.id,
    preset: preset?.name ?? null,
    ratedA, ratedW,
    fault: comp.fault ? { kind: comp.fault, atMs: 0 } : null,
    guess: false,
  };
}

export const FAULT_KINDS = ['open', 'short', 'stall', 'intermittent', 'hires', 'wrongpart'];
export const FAULT_LABEL = {
  open: 'Open circuit', short: 'Short circuit', stall: 'Stalled', intermittent: 'Intermittent',
  hires: 'High resistance', wrongpart: 'Wrong part',
};

export const STIMULUS_ITEMS = [
  { type: 'switch', name: 'Switch', hint: 'toggle, momentary or 3-position → digital input', icon: 'switch' },
  { type: 'rotary', name: 'Rotary knob', hint: 'ladder positions → CANBoard analog input', icon: 'knob' },
  { type: 'keypad', name: 'Keypad', hint: 'Blink Marine / Grayhill on the bus', icon: 'keypad' },
  { type: 'cangen', name: 'CAN generator', hint: 'signals from a DBC or raw frames', icon: 'can' },
  { type: 'engine', name: 'Engine', hint: 'off / ign / crank / run, RPM, coolant', icon: 'engine' },
  { type: 'battery', name: 'Battery', hint: 'Voc, Ri, alternator — feeds every module', icon: 'battery' },
  { type: 'wiper', name: 'Wiper motor', hint: 'coupled load with run / speed / park', icon: 'wiper' },
  { type: 'pwmsrc', name: 'PWM source', hint: 'duty % + frequency → digital input (PWM mode)', icon: 'pwm' },
];

/**
 * Minimal built-in palette for mock mode / an empty snapshot. Shape = `listComponents()` of
 * docs/interfaces.md §4 plus an optional `fault` for the pre-broken items.
 */
export const BUILTIN_COMPONENTS = [
  { id: 'halogen_headlight', group: 'Lighting', name: 'Halogen headlight', family: 'filament', icon: 'bulb',
    presets: [{ name: 'H4 low 55 W', W: 55 }, { name: 'H4 high 60 W', W: 60 }, { name: 'H7 55 W', W: 55 }, { name: '100 W aux spot', W: 100 }] },
  { id: 'halogen_signal_bulb', group: 'Lighting', name: 'Halogen signal bulb', family: 'filament', icon: 'bulb',
    presets: [{ name: 'P21W 21 W', W: 21 }, { name: 'PY21W 21 W', W: 21 }, { name: 'W5W 5 W', W: 5 }, { name: 'R5W 5 W', W: 5 }, { name: 'Licence 5 W', W: 5 }] },
  { id: 'led_bar', group: 'Lighting', name: 'LED pod / light bar', family: 'led', icon: 'led',
    presets: [{ name: '20 W', W: 20 }, { name: '40 W', W: 40 }, { name: '72 W', W: 72 }, { name: '126 W', W: 126 }] },
  { id: 'led_signal', group: 'Lighting', name: 'LED signal lamp', family: 'led', icon: 'led',
    presets: [{ name: 'Tail 2 W', W: 2 }, { name: 'Indicator 3 W', W: 3 }, { name: 'Interior 1.5 W', W: 1.5 }] },
  { id: 'hid_headlight', group: 'Lighting', name: 'HID headlight', family: 'hid', icon: 'bulb', presets: [{ name: '35 W', W: 35 }] },
  { id: 'dash_lights', group: 'Lighting', name: 'Dash & gauge lights', family: 'filament', icon: 'bulb', presets: [{ name: '10 W', W: 10 }] },
  { id: 'radiator_fan', group: 'Motors', name: 'Radiator fan', family: 'motor', icon: 'fan',
    presets: [{ name: '80 W', W: 80 }, { name: '120 W', W: 120 }, { name: '180 W', W: 180 }] },
  { id: 'hvac_blower', group: 'Motors', name: 'HVAC blower', family: 'motor', icon: 'fan', presets: [{ name: '150 W', W: 150 }, { name: '250 W', W: 250 }] },
  { id: 'fuel_pump', group: 'Motors', name: 'Fuel pump', family: 'motor', icon: 'pump',
    presets: [{ name: '255 lph 60 W', W: 60 }, { name: '340 lph 110 W', W: 110 }, { name: '450 lph 160 W', W: 160 }, { name: 'Lift pump 40 W', W: 40 }] },
  { id: 'washer_pump', group: 'Motors', name: 'Washer pump', family: 'motor', icon: 'pump', presets: [{ name: '30 W', W: 30 }] },
  { id: 'wiper_motor', group: 'Motors', name: 'Wiper motor', family: 'wiper', icon: 'wiper', presets: [{ name: '60 W', W: 60 }, { name: '90 W', W: 90 }] },
  { id: 'window_actuator', group: 'Motors', name: 'Window / seat actuator', family: 'actuator', icon: 'motor', presets: [{ name: '60 W', W: 60 }, { name: '90 W', W: 90 }] },
  { id: 'door_lock', group: 'Motors', name: 'Door lock actuator', family: 'actuator', icon: 'motor', presets: [{ name: '40 W', W: 40 }] },
  { id: 'air_compressor', group: 'Motors', name: 'Air compressor', family: 'compressor', icon: 'motor', presets: [{ name: '150 W', W: 150 }, { name: '300 W', W: 300 }] },
  { id: 'relay_coil', group: 'Coils', name: 'Relay coil', family: 'coil', icon: 'coil', presets: [{ name: '1.5 W', W: 1.5 }] },
  { id: 'solenoid_valve', group: 'Coils', name: 'Solenoid valve', family: 'coil', icon: 'coil', presets: [{ name: '10 W', W: 10 }, { name: '20 W', W: 20 }] },
  { id: 'ac_clutch', group: 'Coils', name: 'A/C compressor clutch', family: 'coil', icon: 'coil', presets: [{ name: '45 W', W: 45 }] },
  { id: 'starter_solenoid', group: 'Coils', name: 'Starter solenoid', family: 'solenoid2', icon: 'coil', presets: [{ name: 'Pull 35 A / hold 8 A', A: 8 }] },
  { id: 'horn', group: 'Coils', name: 'Horn', family: 'resistive', icon: 'horn', presets: [{ name: '40 W', W: 40 }, { name: '2 × 40 W', W: 80 }] },
  { id: 'seat_heater', group: 'Heaters', name: 'Seat heater', family: 'heater', icon: 'heater', presets: [{ name: '50 W', W: 50 }, { name: '90 W', W: 90 }] },
  { id: 'rear_defrost', group: 'Heaters', name: 'Rear-window defrost', family: 'heater', icon: 'heater', presets: [{ name: '150 W', W: 150 }, { name: '250 W', W: 250 }] },
  { id: 'ptc_heater', group: 'Heaters', name: 'PTC cabin heater', family: 'ptc', icon: 'heater', presets: [{ name: '300 W', W: 300 }, { name: '600 W', W: 600 }] },
  { id: 'glow_plugs', group: 'Heaters', name: 'Glow plugs', family: 'glow', icon: 'heater', presets: [{ name: '100 W per plug', W: 100 }, { name: '4 × 100 W', W: 400 }] },
  { id: 'ecu', group: 'Electronics', name: 'ECU / PCM', family: 'electronics', icon: 'chip', presets: [{ name: '20 W', W: 20 }, { name: '40 W', W: 40 }] },
  { id: 'dash_pi', group: 'Electronics', name: 'Dash / Raspberry Pi display', family: 'electronics', icon: 'chip', presets: [{ name: '15 W', W: 15 }] },
  { id: 'head_unit', group: 'Electronics', name: 'Head unit / radio', family: 'electronics', icon: 'chip', presets: [{ name: '30 W', W: 30 }, { name: 'GPS 10 W', W: 10 }, { name: 'Camera 5 W', W: 5 }] },
  { id: 'amplifier', group: 'Electronics', name: 'Amplifier', family: 'amplifier', icon: 'chip', presets: [{ name: '300 W', W: 300 }, { name: '600 W', W: 600 }] },
  { id: 'usb_charger', group: 'Electronics', name: 'USB charger / phone', family: 'electronics', icon: 'chip', presets: [{ name: '15 W', W: 15 }, { name: '30 W', W: 30 }] },
  { id: 'ignition_supply', group: 'Electronics', name: 'Ignition coils / injectors', family: 'pulsed', icon: 'bolt', presets: [{ name: '60 W', W: 60 }, { name: '120 W', W: 120 }] },
  { id: 'burnt_bulb', group: 'Faults', name: 'Burnt bulb', family: 'filament', icon: 'bulb', fault: 'open', presets: [{ name: 'H4 55 W, open', W: 55 }] },
  { id: 'blocked_pump', group: 'Faults', name: 'Blocked pump', family: 'motor', icon: 'pump', fault: 'stall', presets: [{ name: 'Fuel pump 110 W, stalled', W: 110 }] },
  { id: 'short_circuit', group: 'Faults', name: 'Short circuit', family: 'resistive', icon: 'bolt', fault: 'short', presets: [{ name: 'Dead short', A: 999 }] },
  { id: 'broken_wire', group: 'Faults', name: 'Broken wire', family: 'resistive', icon: 'bolt', fault: 'open', presets: [{ name: 'Open feed', W: 21 }] },
  { id: 'loose_connector', group: 'Faults', name: 'Loose connector', family: 'filament', icon: 'bolt', fault: 'intermittent', presets: [{ name: 'P21W, intermittent', W: 21 }] },
  { id: 'wrong_bulb', group: 'Faults', name: 'Wrong bulb (×2)', family: 'filament', icon: 'bulb', fault: 'wrongpart', presets: [{ name: 'H4 fitted as 100 W', W: 55 }] },
  { id: 'generic_resistive', group: 'Other', name: 'Generic resistive', family: 'resistive', icon: 'generic', presets: [{ name: '1 A', A: 1 }, { name: '5 A', A: 5 }, { name: '10 A', A: 10 }] },
  { id: 'custom_curve', group: 'Other', name: 'Custom curve (CSV)', family: 'table', icon: 'generic', presets: [{ name: 'table', A: 1 }] },
];

/** Group components for the palette: [{group, items}] in first-seen order. */
export function groupComponents(list) {
  const groups = [];
  const map = new Map();
  for (const c of list) {
    let g = map.get(c.group || 'Other');
    if (!g) { g = { group: c.group || 'Other', items: [] }; map.set(g.group, g); groups.push(g); }
    g.items.push(c);
  }
  return groups;
}

/** Output-name keyword → component id (subset, used by the mock's populate). */
export function keywordComponent(outputName) {
  const n = (outputName || '').toLowerCase();
  const t = (re, id, preset) => (re.test(n) ? { id, preset } : null);
  return (
    t(/fuel|pump/, 'fuel_pump', '340 lph 110 W') ||
    t(/washer/, 'washer_pump') ||
    t(/fan|rad|coolant/, 'radiator_fan', '120 W') ||
    t(/blower|hvac/, 'hvac_blower', '150 W') ||
    t(/led|bar/, 'led_bar', '40 W') ||
    t(/low beam|high beam|head|spot|fog|driving|aux/, 'halogen_headlight', 'H4 low 55 W') ||
    t(/position|park|tail|plate|licen|marker|sidemarker|interior|dome/, 'halogen_signal_bulb', 'W5W 5 W') ||
    t(/brake|stop|reverse/, 'halogen_signal_bulb', 'P21W 21 W') ||
    t(/indicator|turn|blink|hazard/, 'halogen_signal_bulb', 'PY21W 21 W') ||
    t(/horn/, 'horn', '40 W') ||
    t(/wiper/, 'wiper_motor', '60 W') ||
    t(/heat|seat|defrost|demist|mirror/, 'seat_heater', '50 W') ||
    t(/ecu|pcm|ems|efi|pi|dash|gauge|radio|stereo|gps|cam|usb/, 'ecu', '20 W') ||
    t(/amp/, 'amplifier', '300 W') ||
    t(/ign|coil|inj/, 'ignition_supply', '60 W') ||
    t(/starter|sol/, 'starter_solenoid') ||
    t(/relay|trigger/, 'relay_coil') ||
    t(/lock|window|actuator|locker/, 'window_actuator', '60 W') ||
    t(/compressor|air/, 'air_compressor', '150 W') ||
    t(/glow/, 'glow_plugs') ||
    null
  );
}

export function componentById(list, id) {
  return (list || []).find((c) => c.id === id) || BUILTIN_COMPONENTS.find((c) => c.id === id) || null;
}

/**
 * Card name of a load from its populate label: `Right Low Beam x2 (1/2)` → `Right Low Beam · bulb 1 of 2`
 * (one of several loads on an output), otherwise the label as is.
 */
export function loadTitle(label, isLight = false) {
  if (!label) return '';
  const m = /^(.*?)(?:\s+x\d+)?\s*\((\d+)\/(\d+)\)$/.exec(String(label));
  return m ? `${m[1]} · ${isLight ? 'bulb' : 'part'} ${m[2]} of ${m[3]}` : String(label);
}

/** What a stimulus node is wired to: `CB-1 DI2`, `CB-1 AI1`, or null. */
export function wiredInput(edges, nodeId) {
  const e = (edges || []).find((x) => x.from?.node === nodeId && /^(di|ai):/.test(x.to?.handle || ''));
  if (!e) return null;
  const [kind, n] = e.to.handle.split(':');
  return `${e.to.node} ${kind.toUpperCase()}${n}`;
}
