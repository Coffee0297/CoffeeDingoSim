// chart.js — pure drawing and scaling helpers for the side chart, load sparklines and
// palette thumbnails. No DOM access except the 2D context passed in, so the scaling math
// is unit-testable under `node --test` (see test/app.chart.test.js).

/** Output state → colour, shared by the canvas node dots and the chart's state band. */
export const STATE_COLORS = {
  Off: '#6b7280',
  On: '#3dd68c',
  Overcurrent: '#ff8a3d',
  Fault: '#ff4d5e',
  Warning: '#f5c342',
  OpenLoad: '#4da3ff',
};

/** Msg3 nibble → state name (docs/interfaces.md §2). */
export const STATE_NAMES = ['Off', 'On', 'Overcurrent', 'Fault', 'Warning', 'OpenLoad'];

/**
 * Pick a "nice" tick step (1, 2, 5 × 10^k) so that `range / step` is about `targetTicks`.
 * @param {number} range  positive span of the axis
 * @param {number} [targetTicks=5]
 */
export function niceStep(range, targetTicks = 5) {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const rough = range / Math.max(1, targetTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  return nice * mag;
}

/**
 * Autoscale a y-axis: always includes zero, pads the top by `padPct`, rounds the bounds out
 * to the tick step and never collapses to a zero-height range.
 * @param {number} min   data minimum
 * @param {number} max   data maximum
 * @param {{padPct?:number, ticks?:number, floorMax?:number}} [opts]
 *   floorMax — a minimum top-of-axis (e.g. 1 A) so an idle trace does not autoscale into noise
 * @returns {{min:number, max:number, step:number}}
 */
export function autoscale(min, max, opts = {}) {
  const { padPct = 0.1, ticks = 4, floorMax = 1 } = opts;
  let lo = Number.isFinite(min) ? Math.min(0, min) : 0;
  let hi = Number.isFinite(max) ? Math.max(max, floorMax) : floorMax;
  if (hi <= lo) hi = lo + floorMax;
  hi = hi + (hi - lo) * padPct;
  const step = niceStep(hi - lo, ticks);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  if (hi === lo) hi = lo + step;
  return { min: lo, max: hi, step };
}

/**
 * Linear mapping domain → range. Returns a function with an `invert` property.
 * @param {number} d0 @param {number} d1 @param {number} r0 @param {number} r1
 */
export function makeScale(d0, d1, r0, r1) {
  const span = d1 - d0 || 1;
  const k = (r1 - r0) / span;
  const f = (x) => r0 + (x - d0) * k;
  f.invert = (y) => d0 + (y - r0) / k;
  return f;
}

/**
 * Append a sample to a time-ordered ring buffer of [t, v] pairs and drop everything older
 * than `horizonS` seconds before the newest sample. Mutates and returns `buf`.
 * Out-of-order samples (t smaller than the last) reset the buffer: that is what happens on
 * a Renode reset or when virtual time restarts.
 * @param {Array<[number, number]>} buf
 * @param {number} t  seconds @param {number} v
 * @param {number} [horizonS=30]
 */
export function pushTrace(buf, t, v, horizonS = 30) {
  const last = buf.length ? buf[buf.length - 1][0] : -Infinity;
  if (t < last) buf.length = 0;
  buf.push([t, v]);
  const cutoff = t - horizonS;
  let drop = 0;
  while (drop < buf.length - 1 && buf[drop][0] < cutoff) drop++;
  if (drop) buf.splice(0, drop);
  return buf;
}

/**
 * Min/max bucket decimation so a long trace can be drawn with at most ~`maxPoints` vertices
 * without losing the spikes (inrush peaks must survive a sparkline).
 * @param {Array<[number, number]>} points time-ordered
 * @param {number} maxPoints
 * @returns {Array<[number, number]>}
 */
export function decimate(points, maxPoints) {
  if (points.length <= maxPoints || maxPoints < 4) return points;
  const buckets = Math.floor(maxPoints / 2);
  const per = points.length / buckets;
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.min(points.length, Math.floor((b + 1) * per));
    if (e <= s) continue;
    let lo = points[s], hi = points[s];
    for (let i = s + 1; i < e; i++) {
      if (points[i][1] < lo[1]) lo = points[i];
      if (points[i][1] > hi[1]) hi = points[i];
    }
    // keep chronological order inside the bucket
    if (lo === hi) out.push(lo);
    else if (lo[0] <= hi[0]) out.push(lo, hi);
    else out.push(hi, lo);
  }
  return out;
}

/**
 * Collapse a per-sample state array into contiguous bands for the strip along the bottom.
 * @param {Array<[number, string]>} states  [t, stateName]
 * @param {number} tEnd
 * @returns {Array<{t0:number, t1:number, state:string}>}
 */
export function toBands(states, tEnd) {
  const bands = [];
  for (let i = 0; i < states.length; i++) {
    const [t, s] = states[i];
    const last = bands[bands.length - 1];
    if (last && last.state === s) continue;
    if (last) last.t1 = t;
    bands.push({ t0: t, t1: tEnd, state: s });
  }
  if (bands.length) bands[bands.length - 1].t1 = tEnd;
  return bands;
}

/** Format a current reading for readouts: 0.00 A below 10 A, 0.0 A above. */
export function fmtA(a) {
  if (a == null || !Number.isFinite(a)) return '—';
  return (Math.abs(a) < 10 ? a.toFixed(2) : a.toFixed(1)) + ' A';
}

/** Format seconds of virtual time as m:ss.s */
export function fmtT(t) {
  if (t == null || !Number.isFinite(t)) return '—';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/**
 * Draw one or more time series onto a canvas 2D context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{points:Array<[number,number]>, color:string, width?:number, dash?:number[], fill?:boolean, label?:string}>} series
 * @param {object} opts
 *   width, height          CSS pixel size of the drawing area (ctx should already be DPR-scaled)
 *   tMin, tMax             time window (seconds); defaults to the data extent
 *   yMin, yMax             fixed y range; when omitted → autoscale over the visible points
 *   bands                  [{t0,t1,state}] state strip along the bottom (uses STATE_COLORS)
 *   hoverT                 time (seconds) to draw a cursor at
 *   mini                   true → sparkline mode: no axes, no grid, 2 px padding
 *   theme                  { fg, grid, muted, bg } colours
 *   unit                   y-axis unit label ("A", "V")
 * @returns {{xOf:(t:number)=>number, yOf:(v:number)=>number, tOf:(px:number)=>number, yMin:number, yMax:number, plot:{x:number,y:number,w:number,h:number}}}
 */
export function drawSeries(ctx, series, opts) {
  const {
    width, height, mini = false, bands = [], hoverT = null, unit = 'A',
    theme = { fg: '#e7e9ee', grid: 'rgba(138,147,165,0.18)', muted: '#8a93a5', bg: 'transparent' },
  } = opts;

  const pad = mini ? { l: 2, r: 2, t: 2, b: 2 } : { l: 44, r: 10, t: 10, b: bands.length ? 30 : 20 };
  const plot = { x: pad.l, y: pad.t, w: Math.max(1, width - pad.l - pad.r), h: Math.max(1, height - pad.t - pad.b) };

  // time extent
  let tMin = opts.tMin, tMax = opts.tMax;
  if (tMin == null || tMax == null) {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const p of s.points) { if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0]; }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi <= lo) hi = lo + 1;
    if (tMin == null) tMin = lo;
    if (tMax == null) tMax = hi;
  }

  // y extent
  let yMin = opts.yMin, yMax = opts.yMax;
  if (yMin == null || yMax == null) {
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const p of s.points) {
      if (p[0] < tMin || p[0] > tMax) continue;
      if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1];
    }
    const a = autoscale(lo, hi, { floorMax: opts.floorMax ?? 1 });
    if (yMin == null) yMin = a.min;
    if (yMax == null) yMax = a.max;
  }

  const xOf = makeScale(tMin, tMax, plot.x, plot.x + plot.w);
  const yOf = makeScale(yMin, yMax, plot.y + plot.h, plot.y);
  const tOf = (px) => xOf.invert(px);

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  if (theme.bg && theme.bg !== 'transparent') { ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, width, height); }

  if (!mini) {
    // grid + y labels
    const step = niceStep(yMax - yMin, 4);
    ctx.strokeStyle = theme.grid; ctx.lineWidth = 1;
    ctx.fillStyle = theme.muted; ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
      ctx.fillText(`${+v.toFixed(2)}${unit ? ' ' + unit : ''}`, plot.x - 6, y);
    }
    // x ticks every nice step
    const tStep = niceStep(tMax - tMin, 6);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const xLabelY = plot.y + plot.h + (bands.length ? 14 : 4);
    for (let t = Math.ceil(tMin / tStep) * tStep; t <= tMax + 1e-9; t += tStep) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, plot.y + plot.h); ctx.lineTo(x, plot.y + plot.h + 3); ctx.stroke();
      ctx.fillText(fmtT(t), x, xLabelY);
    }
    // state band
    if (bands.length) {
      const by = plot.y + plot.h + 2, bh = 8;
      for (const b of bands) {
        const x0 = Math.max(plot.x, xOf(b.t0)), x1 = Math.min(plot.x + plot.w, xOf(b.t1));
        if (x1 <= x0) continue;
        ctx.fillStyle = STATE_COLORS[b.state] || STATE_COLORS.Off;
        ctx.fillRect(x0, by, x1 - x0, bh);
      }
    }
  }

  // series
  ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
  for (const s of series) {
    const pts = decimate(s.points.filter((p) => p[0] >= tMin - 1 && p[0] <= tMax + 1), Math.max(16, plot.w * 2));
    if (!pts.length) continue;
    ctx.lineWidth = s.width ?? (mini ? 1.25 : 1.5);
    ctx.strokeStyle = s.color;
    ctx.setLineDash(s.dash || []);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = xOf(pts[i][0]), y = yOf(pts[i][1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (s.fill) {
      ctx.lineTo(xOf(pts[pts.length - 1][0]), yOf(yMin));
      ctx.lineTo(xOf(pts[0][0]), yOf(yMin));
      ctx.closePath();
      ctx.globalAlpha = 0.12; ctx.fillStyle = s.color; ctx.fill(); ctx.globalAlpha = 1;
    }
    ctx.setLineDash([]);
  }

  // hover cursor
  if (hoverT != null && !mini) {
    const x = Math.round(xOf(hoverT)) + 0.5;
    ctx.strokeStyle = theme.fg; ctx.globalAlpha = 0.5; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  ctx.restore();
  return { xOf, yOf, tOf, yMin, yMax, plot };
}

/**
 * Nearest sample in a time-ordered series (binary search).
 * @param {Array<[number, number]>} points @param {number} t
 */
export function sampleAt(points, t) {
  if (!points.length) return null;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1][0] - t) < Math.abs(points[lo][0] - t)) lo--;
  return points[lo];
}

/**
 * A synthetic rendered curve for palette thumbnails when the server has not supplied one:
 * a per-family inrush shape so every thumbnail shows a believable curve.
 * @param {string} family
 * @param {number} [steadyA=1]
 * @returns {Array<[number, number]>}
 */
export function thumbnailCurve(family, steadyA = 1) {
  const pts = [];
  const n = 120, horizon = 3; // seconds
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * horizon;
    let pu = 1;
    switch (family) {
      case 'filament': pu = 1 + 9 * Math.exp(-t / 0.045); break;
      case 'led': case 'electronics': pu = t < 0.03 ? 6 : 1; break;
      case 'hid': pu = 1 + 1.5 * Math.max(0, 1 - t / 3); break;
      case 'motor': case 'compressor': pu = 1 + 4 * Math.exp(-t / 0.2) + 0.08 * Math.sin(t * 60); break;
      case 'actuator': pu = t < 0.2 ? 1 + 4 * Math.exp(-t / 0.08) : t > 2 ? 5 : 1; break;
      case 'coil': pu = 1 - Math.exp(-t / 0.015); break;
      case 'solenoid2': pu = t < 0.08 ? 4 : 1; break;
      case 'heater': pu = 1 - 0.1 * (t / 3); break;
      case 'ptc': pu = 1 + 1.5 * Math.exp(-t / 1); break;
      case 'glow': pu = 1 + Math.exp(-t / 1); break;
      case 'pulsed': pu = Math.sin(t * 40) > 0 ? 1 : 0.2; break;
      case 'strobe': pu = (t % 0.5) < 0.05 ? 1 : 0; break;
      case 'amplifier': pu = 0.5 + 0.4 * Math.sin(t * 4) * Math.sin(t * 9); break;
      case 'wiper': pu = 1 + 0.35 * Math.sin(t * 6) + 3 * Math.exp(-t / 0.2); break;
      default: pu = 1;
    }
    pts.push([t, pu * steadyA]);
  }
  return pts;
}
