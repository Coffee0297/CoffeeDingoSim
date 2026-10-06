// Component library (docs/interfaces.md §4): palette listing, instantiation from presets / ratings, rendering to the
// bank load object (docs/interfaces.md §5) and output-name → component matching. Pure ESM, no Node APIs.

import lighting from './components/lighting.json' with { type: 'json' };
import motors from './components/motors.json' with { type: 'json' };
import coils from './components/coils.json' with { type: 'json' };
import heaters from './components/heaters.json' with { type: 'json' };
import electronics from './components/electronics.json' with { type: 'json' };
import faults from './components/faults.json' with { type: 'json' };
import other from './components/other.json' with { type: 'json' };
import {
  iPu, steadyPu, periodMs, ripple, resolveParams, defaultCoolDownMs, MOTOR_FAMILIES, PERIODIC_FAMILIES,
} from './shapes.js';

export const NOMINAL_V = 13.8;
export const SHORT_A = 999;
export const FALLBACK_ID = 'generic_resistive';

const ALL = [...lighting, ...motors, ...coils, ...heaters, ...electronics, ...faults, ...other];
const BY_ID = new Map(ALL.map((c) => [c.id, c]));

// Which params are "the inrush" of each family: a multiple of the rated current and how long it lasts.
// These are the two knobs a load node exposes; everything else stays at the component's defaults.
export const INRUSH_KEYS = {
  filament: ['kCold', 'tauMs'], ptc: ['kCold', 'tauMs'], glow: ['kCold', 'tauMs'], hid: ['kWarm', 'tauMs'],
  motor: ['kLR', 'tauMs'], actuator: ['kLR', 'tauMs'], compressor: ['kLR', 'tauMs'], wiper: ['kLR', 'tauMs'],
  led: ['kSpike', 'spikeMs'], electronics: ['kSpike', 'spikeMs'], amplifier: ['kSpike', 'spikeMs'],
  solenoid2: ['kPull', 'pullMs'],
};

/** @returns {{id:string, group:string, name:string, family:string, presets:object[], icon:string, inrush:string[]|null}[]} */
export function listComponents() {
  return ALL.map(({ id, group, name, family, presets, icon }) => ({ id, group, name, family, presets, icon, inrush: INRUSH_KEYS[family] ?? null }));
}

/**
 * The inrush knobs of a load at its rating: {xKey, msKey, x, ms} with the component defaults (`x`, `ms`) and the
 * effective values after the node's own overrides (`effX`, `effMs`). null for families without an inrush.
 */
export function inrushOf(id, opts = {}) {
  const keys = INRUSH_KEYS[getComponent(id).family];
  if (!keys) return null;
  const base = instantiate(id, { ...opts, params: undefined });
  const eff = instantiate(id, opts);
  return { xKey: keys[0], msKey: keys[1], x: base.params[keys[0]], ms: base.params[keys[1]], effX: eff.params[keys[0]], effMs: eff.params[keys[1]] };
}

/** Full JSON entry for an id (throws on unknown ids). */
export function getComponent(id) {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown component "${id}"`);
  return c;
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

// Per-pulse PWM behaviour per family; the bank applies i · (1/duty)^onPhaseExp.
function pwmFor(c, params) {
  const fam = c.family;
  const byFamily = { filament: 0.45, heater: 0.1, ptc: 0.1, glow: 0.1, coil: -1 }[fam] ?? 0;
  const pwm = { onPhaseExp: byFamily, ...(c.pwm ?? {}) };
  if (fam === 'hid') pwm.pwmable = false;
  // Motors: on-phase ≈ steady·(1 + (kLR−1)(1−duty)); carried as model + kLR for the bank.
  if (MOTOR_FAMILIES.has(fam)) Object.assign(pwm, { model: 'motor', kLR: params.kLR ?? 5 });
  return pwm;
}

/**
 * @param {string} id
 * @param {{preset?:string, ratedW?:number, ratedA?:number, params?:Record<string,number>, nominalV?:number}} [opts]
 *   `params` overrides resolved component params (e.g. {kCold: 5, tauMs: 15}) — the canvas inrush knobs.
 * @returns {{component:string, family:string, preset:string|null, ratedA:number, ratedW:number, nominalV:number,
 *           params:Record<string, any>, pwm:object, ripple:{hz:number,pct:number}, fault:object|null}}
 */
export function instantiate(id, { preset, ratedW, ratedA, params: overrides, nominalV = NOMINAL_V } = {}) {
  const c = getComponent(id);
  let p = c.presets[0];
  if (preset != null) {
    p = c.presets.find((x) => x.name === preset);
    if (!p) throw new Error(`component "${id}" has no preset "${preset}"`);
  }
  let W;
  if (ratedW > 0) W = ratedW;
  else if (ratedA > 0) W = ratedA * nominalV;
  else if (p?.W > 0) W = p.W;
  else if (p?.A > 0) W = p.A * nominalV;
  else W = nominalV;                                      // 1 A when nothing is known
  const A = W / nominalV;
  const params = resolveParams({ ...c.defaults, ...(p?.params ?? {}) }, { W, A });
  // per-load overrides from the canvas (node data.params): only known numeric params, never below 0
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (k in params && Number.isFinite(Number(v)) && Number(v) >= 0) params[k] = Number(v);
  }
  if (c.family === 'table') params.ratedA = A;
  return {
    component: c.id, family: c.family, preset: p?.name ?? null,
    ratedA: round(A, 2), ratedW: round(W, 2), nominalV, params,
    pwm: pwmFor(c, params), ripple: ripple(c.family, params, c.ripple), fault: c.fault ?? null,
  };
}

/**
 * Render an instance into the bank load object of docs/interfaces.md §5 (`id` is filled by the caller).
 * The table holds A at k·tableMs from a cold turn-on and stops once the curve is within 0.5 % of steady
 * (checked again at 1.5·t so a curve crossing steady on its way elsewhere does not stop early) or at horizonMs.
 * A curve not settled by horizonMs keeps its last table value as steadyA (no step at the table end), with
 * `settled: false`. Periodic families (pulsed, strobe) render exactly one period and carry `loopMs`.
 * @param {ReturnType<typeof instantiate>} instance
 * @param {{tableMs?:number, horizonMs?:number}} [opts]
 */
export function render(instance, { tableMs = 1, horizonMs = 10000 } = {}) {
  const { family, params } = instance;
  const nominalV = instance.nominalV ?? NOMINAL_V;
  const A = instance.ratedW > 0 ? instance.ratedW / nominalV : instance.ratedA;   // unrounded rated amps
  const steadyFull = A * steadyPu(family, params);
  const at = (t) => A * iPu(family, params, t);
  const table = [];
  let steadyA = steadyFull;
  let settled = true;
  let loopMs;

  if (PERIODIC_FAMILIES.has(family)) {
    loopMs = periodMs(family, params);
    const n = Math.max(1, Math.ceil(loopMs / tableMs));
    for (let k = 0; k < n; k++) table.push(round(at(k * tableMs), 3));
  } else {
    const tol = 0.005 * Math.max(Math.abs(steadyFull), 1e-9);
    const maxK = Math.floor(horizonMs / tableMs);
    for (let k = 0; k <= maxK; k++) {
      const t = k * tableMs;
      const i = at(t);
      table.push(round(i, 3));
      if (k > 0 && Math.abs(i - steadyFull) <= tol && Math.abs(at(t * 1.5) - steadyFull) <= tol) break;
      if (k === maxK) { settled = false; steadyA = i; }
    }
  }

  const load = {
    id: null,
    ratedA: instance.ratedA,
    vExp: params.vExp ?? 1,
    tableMs,
    table,
    steadyA: round(steadyA, 3),
    ripple: instance.ripple ?? { hz: 0, pct: 0 },
    coolDownMs: params.coolDownMs ?? defaultCoolDownMs(family),
    stallA: MOTOR_FAMILIES.has(family) ? round((params.kLR ?? 5) * A, 3) : 0,   // locked rotor
    shortA: SHORT_A,
    pwm: instance.pwm ?? { onPhaseExp: 0 },
    fault: null,
  };
  if (!settled) load.settled = false;
  if (loopMs) load.loopMs = loopMs;
  return load;
}

// ---------------------------------------------------------------------------------------------------
// Output name → component(s)
// ---------------------------------------------------------------------------------------------------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Keywords match at a word start; short ones (≤ 3 chars: pi, amp, ecu, fan…) must be whole words, longer ones
// may be prefixes ("licen" → licence/license, "trigger" → triggers, "heat" → heating).
const kwRe = (kw) => new RegExp(`(?<![a-z0-9])${esc(kw)}${kw.length <= 3 ? '(?![a-z0-9])' : ''}`);

const KEYWORDS = [];
for (const c of ALL) {
  for (const kw of c.keywords ?? []) KEYWORDS.push({ kw, re: kwRe(kw), id: c.id, presetName: c.keywordPresets?.[kw] });
}
const LED_RE = /(?<![a-z0-9])led(?![a-z0-9])/;

function matchPart(text) {
  let best = null;
  for (const k of KEYWORDS) {
    if (k.kw === 'led') continue;                         // "led" only selects the LED variant (below)
    if (k.re.test(text) && (!best || k.kw.length > best.kw.length)) best = k;
  }
  const isLed = LED_RE.test(text);
  if (!best && isLed) return { id: 'led_light_bar', kw: 'led' };
  if (!best) return null;
  const c = BY_ID.get(best.id);
  if (isLed && c.ledVariant) {
    const led = BY_ID.get(c.ledVariant);
    return { id: led.id, kw: best.kw, presetName: led.keywordPresets?.[`led ${best.kw}`] ?? led.keywordPresets?.[best.kw] };
  }
  return { id: best.id, kw: best.kw, presetName: best.presetName };
}

const MULT_RE = /(?<![a-z0-9])x\s*(\d+)(?![a-z0-9])|×\s*(\d+)(?![a-z0-9])|(?<![a-z0-9])(\d+)\s*[x×](?![a-z0-9])/;
const LR_RE = /(?<![a-z0-9])(?:l\s*[+&/]\s*r|lh\s*[+&/]\s*rh|left\s*(?:\+|&|and)\s*right)(?![a-z0-9])/;
const SPLIT_RE = /\s*(?:\+|&|(?<![a-z0-9])and(?![a-z0-9]))\s*/;
const PLURAL_RELAY_RE = /(?<![a-z0-9])(?:relays|triggers)(?![a-z0-9])/;

/**
 * Parse an output name. `parts` lists one entry per physical part of ONE unit (composites and
 * `L+R` expand here, a plural "relays/triggers" counts two coils); `multiplier` (x2, ×2, 2x) repeats the
 * whole unit, so the number of load instances is parts.length × multiplier. `id` = first part.
 * `guess` is true when any part fell back to Generic resistive.
 * @param {string} outputName
 * @returns {{id:string, multiplier:number, parts:{id:string, presetName?:string}[], guess:boolean}}
 */
export function matchKeyword(outputName) {
  let s = String(outputName ?? '').toLowerCase().trim();
  let multiplier = 1;
  const m = MULT_RE.exec(s);
  if (m) {
    multiplier = Math.max(1, Number(m[1] ?? m[2] ?? m[3]));
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim();
  }
  let sides = 1;
  if (LR_RE.test(s)) { sides = 2; s = s.replace(LR_RE, ' ').trim(); }

  const parts = [];
  let guess = false;
  for (const text of s.split(SPLIT_RE).filter(Boolean)) {
    const hit = matchPart(text);
    const part = hit ? { id: hit.id } : { id: FALLBACK_ID };
    if (hit?.presetName) part.presetName = hit.presetName;
    if (!hit) guess = true;
    const n = (hit?.id === 'relay_coil' && PLURAL_RELAY_RE.test(text) ? 2 : 1) * sides;
    for (let i = 0; i < n; i++) parts.push({ ...part });
  }
  if (parts.length === 0) { parts.push({ id: FALLBACK_ID }); guess = true; }
  return { id: parts[0].id, multiplier, parts, guess };
}
