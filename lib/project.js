// lib/project.js — dingoConfig ConfigFile JSON → scene modules[] (docs/interfaces.md §3, §9). Pure ESM.
//
// Tolerant of both the original dingoConfig and the fork: keys are looked up camelCase first, then
// PascalCase, then case-insensitively; missing arrays are empty; unknown keys are ignored.
// `PdmDevices[]` with `pdmType === 1` are PDM-Max (the fork keeps them in `PdmMaxDevices[]`, also read).
// dingoConfig 0.3.0+ (upstream) saves one `Devices[]` list instead, each entry with a numeric `deviceType`
// from its device-definitions.json: 0 dingoPDM, 1 dingoPDM-Max, 2 PT-DPDM, 3 CANBoard.

export const MODULE_SPACING_X = 420;

/** Case-tolerant property lookup. */
function g(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
    const pascal = k[0].toUpperCase() + k.slice(1);
    if (obj[pascal] !== undefined) return obj[pascal];
  }
  const lower = keys.map((k) => k.toLowerCase());
  for (const [k, v] of Object.entries(obj)) if (lower.includes(k.toLowerCase())) return v;
  return undefined;
}
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(+v) ? +v : d);
const bool = (v, d = false) => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : d);
const str = (v, d) => (typeof v === 'string' && v.length ? v : d);

function mapOutput(o, i) {
  const n = num(g(o, 'number'), i + 1);
  return {
    n,
    name: str(g(o, 'name'), `output${n}`),
    enabled: bool(g(o, 'enabled')),
    currentLimit: num(g(o, 'currentLimit')),
    inrushCurrentLimit: num(g(o, 'inrushCurrentLimit')),
    inrushTime: num(g(o, 'inrushTime')),
    resetMode: num(g(o, 'resetMode')),
    resetTime: num(g(o, 'resetTime')),
    resetCountLimit: num(g(o, 'resetCountLimit')),
    pwmEnabled: bool(g(o, 'pwmEnabled')),
    fixedDutyCycle: num(g(o, 'fixedDutyCycle')),
    frequency: num(g(o, 'frequency')),
    primaryOutput: num(g(o, 'primaryOutput', 'nPrimaryOutput'), -1),
    // extras used by populate notes / precheck (not in the §3 example, harmless)
    input: num(g(o, 'input')),
    warnLimit: num(g(o, 'warnLimit')),
    openLoadLimit: num(g(o, 'openLoadLimit')),
    openLoadTime: num(g(o, 'openLoadTime')),
  };
}

function mapInput(d, i) {
  const n = num(g(d, 'number'), i + 1);
  return {
    n,
    name: str(g(d, 'name'), `digitalInput${n}`),
    enabled: bool(g(d, 'enabled')),
    mode: num(g(d, 'mode')),
    pull: num(g(d, 'pull')),
    invert: bool(g(d, 'invert')),
  };
}

function mapAnalog(a, i) {
  const n = num(g(a, 'number'), i + 1);
  const r = g(a, 'rotary') ?? {};
  let numPos = Math.max(0, Math.min(10, num(g(r, 'numPos', 'numPositions'), 0)));
  let points = arr(g(r, 'points')).slice(0, numPos).map((p) => num(p));
  // upstream dingoConfig 0.3.0 stores a uniform ladder instead: positions 0..fMaxPos centred on
  // fOffset + k·fStep (mV), no position names
  const step = num(g(r, 'fStep', 'step'), 0);
  if (!numPos && step > 0) {
    numPos = Math.max(0, Math.min(10, Math.round(num(g(r, 'fMaxPos', 'maxPos'), 0)) + 1));
    const off = num(g(r, 'fOffset', 'offset'), 0);
    points = Array.from({ length: numPos }, (_, k) => off + k * step);
  }
  const names = arr(g(r, 'positionNames'));
  const positionNames = Array.from({ length: numPos }, (_, k) => str(names[k], `P${k}`));
  const sw = g(a, 'switch') ?? {};
  return {
    n,
    name: str(g(a, 'name'), `analogInput${n}`),
    enabled: bool(g(a, 'enabled')),
    rotary: {
      enabled: bool(g(r, 'enabled')),
      numPos,
      points,
      positionNames,
      tolerance: num(g(r, 'tolerance'), 200),
      invert: bool(g(r, 'invert')),
    },
    switch: { enabled: bool(g(sw, 'enabled')), threshold: num(g(sw, 'threshold')), invert: bool(g(sw, 'invert')), mode: num(g(sw, 'mode')) },
  };
}

function mapDigitalOut(d, i) {
  const n = num(g(d, 'number'), i + 1);
  return { n, name: str(g(d, 'name'), `digitalOutput${n}`), enabled: bool(g(d, 'enabled')), input: num(g(d, 'input')) };
}

function common(dev, kind, fallbackName) {
  const lua = g(dev, 'lua');
  return {
    id: str(g(dev, 'name'), fallbackName),
    kind,
    baseId: num(g(dev, 'baseId'), kind === 'canboard' ? 0x640 : 0x0de),
    pos: { x: 0, y: 0 },
    outputs: [],
    inputs: [],
    analogIn: [],
    digitalOut: [],
    hasLua: typeof lua === 'string' ? lua.trim().length > 0 : !!(lua && (lua.enabled || lua.script)),
  };
}

/**
 * Full import: `{modules, extras}`. `extras` keeps DbcDevices / BlinkMarineKeypads / GrayhillKeypads
 * verbatim (plus per-PDM keypads under `pdmKeypads`).
 */
export function parseProjectFull(json) {
  const cfg = typeof json === 'string' ? JSON.parse(json) : json ?? {};
  const pdms = [];
  const maxes = [];
  const cbs = [];
  const pdmKeypads = [];

  arr(g(cfg, 'pdmDevices')).forEach((d, i) => {
    const kind = num(g(d, 'pdmType')) === 1 ? 'pdmmax' : 'pdm';
    const m = common(d, kind, `PDM-${String(i + 1).padStart(2, '0')}`);
    m.outputs = arr(g(d, 'outputs')).map(mapOutput);
    m.inputs = arr(g(d, 'inputs')).map(mapInput);
    (kind === 'pdmmax' ? maxes : pdms).push(m);
    for (const k of arr(g(d, 'keypads'))) if (bool(g(k, 'enabled'))) pdmKeypads.push({ module: m.id, ...k });
  });
  arr(g(cfg, 'pdmMaxDevices')).forEach((d, i) => {
    const m = common(d, 'pdmmax', `PDMMAX-${String(i + 1).padStart(2, '0')}`);
    m.outputs = arr(g(d, 'outputs')).map(mapOutput);
    m.inputs = arr(g(d, 'inputs')).map(mapInput);
    maxes.push(m);
  });
  const addCanboard = (d, i) => {
    const m = common(d, 'canboard', `CB-${i + 1}`);
    m.inputs = arr(g(d, 'digitalIn', 'digitalInputs')).map(mapInput);
    m.analogIn = arr(g(d, 'analogIn', 'analogInputs')).map(mapAnalog);
    m.digitalOut = arr(g(d, 'digitalOut', 'digitalOutputs')).map(mapDigitalOut);
    cbs.push(m);
  };
  arr(g(cfg, 'canboardDevices', 'canBoardDevices')).forEach(addCanboard);

  // upstream 0.3.0+: one Devices[] list, typed by deviceType
  const skipped = [];
  arr(g(cfg, 'devices')).forEach((d, i) => {
    const type = num(g(d, 'deviceType'), -1);
    if (type === 0 || type === 1) {
      const kind = type === 1 ? 'pdmmax' : 'pdm';
      const m = common(d, kind, `${kind === 'pdm' ? 'PDM' : 'PDMMAX'}-${String(i + 1).padStart(2, '0')}`);
      m.outputs = arr(g(d, 'outputs')).map(mapOutput);
      m.inputs = arr(g(d, 'inputs', 'digitalIn', 'digitalInputs')).map(mapInput);
      (kind === 'pdmmax' ? maxes : pdms).push(m);
      for (const k of arr(g(d, 'keypads'))) if (bool(g(k, 'enabled'))) pdmKeypads.push({ module: m.id, ...k });
    } else if (type === 3) addCanboard(d, cbs.length);
    else skipped.push({ name: str(g(d, 'name'), `device ${i + 1}`), deviceType: type, reason: type === 2 ? 'PT-DPDM has no firmware in this simulator' : `unknown deviceType ${type}` });
  });

  const byBase = (a, b) => a.baseId - b.baseId || a.id.localeCompare(b.id);
  const modules = [...pdms.sort(byBase), ...maxes.sort(byBase), ...cbs.sort(byBase)];
  // unique ids (machine names) — a duplicated project name gets a suffix
  const seen = new Map();
  for (const m of modules) {
    const c = seen.get(m.id) ?? 0;
    seen.set(m.id, c + 1);
    if (c) m.id = `${m.id}-${c + 1}`;
  }
  modules.forEach((m, i) => (m.pos = { x: i * MODULE_SPACING_X, y: 0 }));

  const extras = {
    dbcDevices: arr(g(cfg, 'dbcDevices')),
    blinkMarineKeypads: arr(g(cfg, 'blinkMarineKeypads')),
    grayhillKeypads: arr(g(cfg, 'grayhillKeypads')),
    pdmKeypads,
    skipped,
  };
  return { modules, extras };
}

/** `modules[]` (docs/interfaces.md §3); the array also carries a non-serialised `extras` property. */
export function parseProject(json) {
  const { modules, extras } = parseProjectFull(json);
  Object.defineProperty(modules, 'extras', { value: extras, enumerable: false });
  return modules;
}

export { parseProject as importProject };
