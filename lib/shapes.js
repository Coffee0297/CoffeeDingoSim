// Component shape families as pure per-unit curves (1.0 = rated steady current), plus the tiny safe
// evaluator that turns JSON defaults such as "10 + 0.6*W" into numbers. No Node or browser APIs here.

// ---------------------------------------------------------------------------------------------------
// Safe expression evaluator: numbers, + - * / ( ), identifiers W and A, functions min(a,b) / max(a,b).
// Tokenizer + recursive descent; anything outside that grammar throws. Never uses eval / new Function.
// ---------------------------------------------------------------------------------------------------

const IDENTS = new Set(['W', 'A']);
const FUNCS = new Set(['min', 'max']);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if ((c >= '0' && c <= '9') || c === '.') {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new SyntaxError(`bad number at ${i} in "${src}"`);
      tokens.push({ type: 'num', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z]+/.exec(src.slice(i));
      const word = m[0];
      if (IDENTS.has(word)) tokens.push({ type: 'ident', value: word });
      else if (FUNCS.has(word)) tokens.push({ type: 'func', value: word });
      else throw new SyntaxError(`unknown identifier "${word}" in "${src}"`);
      i += word.length;
      continue;
    }
    if ('+-*/(),'.includes(c)) { tokens.push({ type: c }); i++; continue; }
    throw new SyntaxError(`unexpected character "${c}" in "${src}"`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

/**
 * Evaluate an expression string against the rating variables.
 * @param {string|number} expr
 * @param {{W?:number, A?:number}} vars
 * @returns {number}
 */
export function evaluate(expr, vars = {}) {
  if (typeof expr === 'number') return expr;
  if (typeof expr !== 'string') throw new TypeError(`expression must be a string or number, got ${typeof expr}`);
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type) => {
    const t = next();
    if (t.type !== type) throw new SyntaxError(`expected "${type}" but found "${t.type}" in "${expr}"`);
    return t;
  };

  function parseExpr() {                         // expr := term (('+'|'-') term)*
    let v = parseTerm();
    while (peek().type === '+' || peek().type === '-') {
      const op = next().type;
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function parseTerm() {                         // term := unary (('*'|'/') unary)*
    let v = parseUnary();
    while (peek().type === '*' || peek().type === '/') {
      const op = next().type;
      const r = parseUnary();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function parseUnary() {                        // unary := ('-'|'+') unary | primary
    if (peek().type === '-') { next(); return -parseUnary(); }
    if (peek().type === '+') { next(); return parseUnary(); }
    return parsePrimary();
  }
  function parsePrimary() {                      // primary := num | W | A | func '(' expr ',' expr ')' | '(' expr ')'
    const t = next();
    if (t.type === 'num') return t.value;
    if (t.type === 'ident') {
      const v = vars[t.value];
      if (typeof v !== 'number' || Number.isNaN(v)) throw new ReferenceError(`${t.value} is not defined for "${expr}"`);
      return v;
    }
    if (t.type === 'func') {
      expect('(');
      const a = parseExpr();
      expect(',');
      const b = parseExpr();
      expect(')');
      return t.value === 'min' ? Math.min(a, b) : Math.max(a, b);
    }
    if (t.type === '(') {
      const v = parseExpr();
      expect(')');
      return v;
    }
    throw new SyntaxError(`unexpected token "${t.type}" in "${expr}"`);
  }

  const value = parseExpr();
  expect('eof');
  if (!Number.isFinite(value)) throw new RangeError(`"${expr}" did not evaluate to a finite number`);
  return value;
}

/**
 * Resolve every string-valued entry of a defaults object into a number. Non-string values pass through.
 * @param {Record<string, any>} defaults
 * @param {{W:number, A:number}} vars
 */
export function resolveParams(defaults, vars) {
  const out = {};
  for (const [k, v] of Object.entries(defaults ?? {})) out[k] = typeof v === 'string' ? evaluate(v, vars) : v;
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Shape families. Each returns the deterministic per-unit current at tMs after a cold turn-on.
// Ripple / buzz / random walk are NOT in these curves: they are reported separately by ripple() so the
// bank overlays them per docs/interfaces.md §5 ("× ripple").
// ---------------------------------------------------------------------------------------------------

export const FAMILIES = [
  'filament', 'led', 'hid', 'motor', 'actuator', 'coil', 'solenoid2', 'heater', 'ptc', 'glow',
  'electronics', 'amplifier', 'pulsed', 'strobe', 'compressor', 'resistive', 'wiper', 'table',
];

/** Families whose rotor can lock: they get a stallA and an inrush ratio kLR. */
export const MOTOR_FAMILIES = new Set(['motor', 'actuator', 'compressor', 'wiper']);

/** Families that never settle (periodic): the renderer emits whole periods and flags loop. */
export const PERIODIC_FAMILIES = new Set(['pulsed', 'strobe']);

const exp = Math.exp;

// Motor start transient: locked-rotor multiple decaying with the mechanical time constant.
const motorStart = (p, t) => 1 + ((p.kLR ?? 5) - 1) * exp(-t / (p.tauMs ?? 200));

const SHAPES = {
  // Tungsten resistance is ~1/10 cold, so a cold bulb draws kCold× and warms with tau ~ 10 ms + 0.6 ms/W.
  filament: (p, t) => 1 + ((p.kCold ?? 10) - 1) * exp(-t / (p.tauMs ?? 40)),
  // LED driver input capacitor charges in the first millisecond, then constant-power regulation.
  led: (p, t) => (t < (p.spikeMs ?? 1) ? (p.kSpike ?? 6) : 1),
  // HID ballast runs the arc at 2.5× during warm-up and settles over ~3 s (tau 1 s).
  hid: (p, t) => 1 + ((p.kWarm ?? 2.5) - 1) * exp(-t / (p.tauMs ?? 1000)),
  // DC motor: locked-rotor current kLR× decays as back-EMF builds, tau ~ 80 ms + 1.5 ms/W.
  motor: motorStart,
  // Actuator: motor start, runs, then hits its end stop and sits at locked-rotor current until switched off.
  actuator: (p, t) => (t < (p.travelMs ?? 3000) ? motorStart(p, t) : (p.kLR ?? 5)),
  // Inductor: current rises with L/R toward V/R.
  coil: (p, t) => 1 - exp(-t / (p.tauMs ?? 10)),
  // Two-winding starter solenoid: pull-in winding adds kPull× until the plunger closes, then hold only.
  solenoid2: (p, t) => (t < (p.pullMs ?? 80) ? (p.kPull ?? 4) : 1),
  // Resistive wire heats up, its resistance rises ~33 % so current falls to 0.75 with a thermal tau of minutes.
  heater: (p, t) => (p.kHot ?? 0.75) + (1 - (p.kHot ?? 0.75)) * exp(-t / (p.tauMs ?? 120000)),
  // PTC ceramic: low cold resistance (2.5×) that self-limits as it heats, ~60 s.
  ptc: (p, t) => 1 + ((p.kCold ?? 2.5) - 1) * exp(-t / (p.tauMs ?? 20000)),
  // Glow plug: metal sheath doubles its resistance as it reaches 1000 °C over ~3 s.
  glow: (p, t) => 1 + ((p.kCold ?? 2) - 1) * exp(-t / (p.tauMs ?? 3000)),
  // Electronics: bulk capacitor charge spike for 1 ms, then constant current.
  electronics: (p, t) => (t < (p.spikeMs ?? 1) ? (p.kSpike ?? 8) : 1),
  // Amplifier: same input stage; the music (0.3..1.0 random walk at 2 Hz) is modelled as ripple around 0.65.
  amplifier: (p, t) => (t < (p.spikeMs ?? 1) ? (p.kSpike ?? 8) : (p.meanPu ?? 0.65)),
  // Coils/injectors: supply current chops between dwell (1) and off (0.2 for the driver) at the firing rate.
  pulsed: (p, t) => {
    const period = 1000 / (p.rateHz ?? 27);
    return (t % period) < period * (p.dutyOn ?? 0.5) ? 1 : (p.lowPu ?? 0.2);
  },
  // Strobe: 50 ms flash every 500 ms.
  strobe: (p, t) => ((t % (p.periodMs ?? 500)) < (p.flashMs ?? 50) ? 1 : (p.offPu ?? 0)),
  // Compressor: heavy motor start (kLR 6, tau 500 ms), then current climbs 1 → 1.4 as tank pressure builds.
  compressor: (p, t) =>
    motorStart({ kLR: p.kLR ?? 6, tauMs: p.tauMs ?? 500 }, t)
    + ((p.kLoaded ?? 1.4) - 1) * (1 - exp(-t / (p.pressureTauMs ?? 20000))),
  // Pure resistance.
  resistive: () => 1,
  // Wiper: a motor; the ±35 % per-sweep load swing is ripple at the sweep rate (see ripple()).
  wiper: motorStart,
  // User table [[tMs, A], ...]: linear interpolation, hold the last value; per-unit against ratedA.
  table: (p, t) => {
    const pts = p.points ?? [];
    if (pts.length === 0) return 1;
    const rated = p.ratedA || pts[pts.length - 1][1] || 1;
    if (t <= pts[0][0]) return pts[0][1] / rated;
    for (let i = 1; i < pts.length; i++) {
      const [t0, a0] = pts[i - 1];
      const [t1, a1] = pts[i];
      if (t <= t1) return (t1 === t0 ? a1 : a0 + (a1 - a0) * (t - t0) / (t1 - t0)) / rated;
    }
    return pts[pts.length - 1][1] / rated;
  },
};

/**
 * Per-unit current of a family at tMs after a cold turn-on.
 * @param {string} family
 * @param {Record<string, number>} params  resolved numeric params (kCold, tauMs, kLR, travelMs, ...)
 * @param {number} tMs
 * @param {object} [state]  reserved for stateful families; unused by the deterministic curves
 */
export function iPu(family, params, tMs, state) { // eslint-disable-line no-unused-vars
  const f = SHAPES[family];
  if (!f) throw new Error(`unknown shape family "${family}"`);
  return f(params ?? {}, Math.max(0, tMs));
}

/** Long-run mean per-unit current a family tends to (what the bank plays after the table ends). */
export function steadyPu(family, params = {}) {
  switch (family) {
    case 'actuator': return params.kLR ?? 5;                         // parked against its end stop
    case 'heater': return params.kHot ?? 0.75;
    case 'amplifier': return params.meanPu ?? 0.65;
    case 'pulsed': {
      const d = params.dutyOn ?? 0.5;
      return d * 1 + (1 - d) * (params.lowPu ?? 0.2);
    }
    case 'strobe': return (params.flashMs ?? 50) / (params.periodMs ?? 500) * 1 + (1 - (params.flashMs ?? 50) / (params.periodMs ?? 500)) * (params.offPu ?? 0);
    case 'compressor': return params.kLoaded ?? 1.4;
    case 'table': {
      const pts = params.points ?? [];
      if (pts.length === 0) return 1;
      return pts[pts.length - 1][1] / (params.ratedA || pts[pts.length - 1][1] || 1);
    }
    default: return 1;
  }
}

/** Period in ms for the periodic families, else 0. */
export function periodMs(family, params = {}) {
  if (family === 'pulsed') return 1000 / (params.rateHz ?? 27);
  if (family === 'strobe') return params.periodMs ?? 500;
  return 0;
}

/**
 * Ripple the bank should overlay on the steady current: {hz, pct} (pct of the instantaneous value).
 * Comes from the component JSON (`ripple`), with family defaults for the ones that are physics.
 */
export function ripple(family, params = {}, jsonRipple) {
  if (jsonRipple && typeof jsonRipple.hz === 'number') return { hz: jsonRipple.hz, pct: jsonRipple.pct ?? 0 };
  switch (family) {
    case 'amplifier': return { hz: 2, pct: Math.round(((1 - (params.meanPu ?? 0.65)) / (params.meanPu ?? 0.65)) * 100) }; // 0.3..1.0 walk
    case 'wiper': return { hz: params.slowRps ?? 0.7, pct: 35 };      // load swings ±35 % per sweep
    case 'motor': return { hz: 50, pct: 5 };                           // commutator ripple
    default: return { hz: 0, pct: 0 };
  }
}

/** Default cool-down (ms off) after which a curve restarts cold, per family. */
export function defaultCoolDownMs(family) {
  switch (family) {
    case 'filament': return 1500;
    case 'led': case 'electronics': case 'amplifier': return 20;      // re-spike only after > 20 ms off
    case 'hid': return 3000;
    case 'motor': case 'actuator': case 'compressor': case 'wiper': return 2000;
    case 'coil': case 'solenoid2': return 50;
    case 'heater': case 'ptc': case 'glow': return 60000;
    default: return 0;
  }
}
