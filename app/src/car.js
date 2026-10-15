// car.js — the Car tab's lamps, placed from the load names alone (no extra scene data).
// Every light load node is one bulb, except a label with "x2" / "2x" and no "(1/2)" part number,
// which draws that many. Side, front/rear and function come from words in the label; filaments
// that share a bulb (H4 low + high, P21/5W tail + brake) are merged by their order on each side.
// ponytail: English keywords only; an unplaced lamp is listed under the car so a new name shows up.

const LIGHT = /headlight|signal|light_bar|beacon|strobe|bulb|dash_lights|wrong_bulb|loose_connector|corroded_contact/;

// [function, regex] — first match wins, so the order matters ("Brake + Turn" is a brake filament).
const FUNCS = [
  ['interior', /interior|dome|cabin|courtesy|dash/],
  ['third', /3rd|third|high.?mount|chmsl|cent(er|re) brake/],
  ['fog', /fog/],
  ['plate', /plate|licen[cs]e|number/],
  ['reverse', /reverse|backup|back-up/],
  ['marker', /marker/],
  ['brake', /brake|stop/],
  ['indicator', /indicator|turn|blinker|signal/],
  ['tail', /tail|rear (lamp|light)|running/],
  ['position', /position|parking|side ?light|drl|daytime/],
  ['high', /high|main beam|full beam/],
  ['low', /low|dipped|head/],
  ['aux', /beacon|strobe|light ?bar|work|spot/],
];
const REAR_BY_DEFAULT = new Set(['third', 'plate', 'reverse', 'brake', 'tail']);
// bulbs shared by several filaments: [group, filaments]
const GROUP = { low: 'head', high: 'head', tail: 'rearlamp', brake: 'rearlamp' };

// Slot of lamp 0 on the LEFT side (front at the top, viewBox 0 0 200 420); lamp i sits at x + i*dx.
// The right side mirrors x, a centre lamp spreads around x = 100.
const SLOT = {
  'front:head': [36, 24, 20], 'front:position': [30, 38, 0], 'front:indicator': [22, 30, 0], 'front:fog': [58, 12, 14],
  'front:marker': [9, 62, 0], 'front:aux': [60, 150, 14],
  'rear:rearlamp': [32, 398, 16], 'rear:indicator': [22, 388, 0], 'rear:reverse': [64, 402, 12], 'rear:plate': [88, 405, 0],
  'rear:marker': [9, 356, 0], 'rear:third': [100, 232, 10], 'rear:fog': [78, 402, 0], 'rear:position': [30, 398, 0],
  'front:interior': [100, 178, 12], 'rear:interior': [100, 178, 12],
};
export const COLOR = {
  low: '#fff1c9', high: '#eef5ff', position: '#fff6e0', fog: '#fff0a8', aux: '#ffd27a', interior: '#ffdca0',
  indicator: '#ffa21a', marker: '#ffa21a', tail: '#ff2b1c', brake: '#ff2b1c', third: '#ff2b1c',
  reverse: '#ffffff', plate: '#fff8e0',
};
const LENS = { red: '#4a1612', amber: '#4a3310', clear: '#3a3d42' };

/** Pure: what a label says about a lamp, or null for a name with no light word. */
export function classify(label) {
  const t = String(label || '').toLowerCase();
  const fn = FUNCS.find(([, re]) => re.test(t))?.[0];
  if (!fn) return null;
  const side = /\b(left|lh|l)\b|venstre/.test(t) ? 'L' : /\b(right|rh|r)\b|h(ø|o)jre/.test(t) ? 'R' : 'C';
  const zone = /\bfront\b/.test(t) ? 'front' : /\b(rear|back|trailer)\b/.test(t) || REAR_BY_DEFAULT.has(fn) ? 'rear' : 'front';
  const part = /\((\d+)\/(\d+)/.test(t);
  const m = /(\d+)\s*x\b|\bx\s*(\d+)/.exec(t);
  const count = !part && m ? Math.max(1, Math.min(8, Number(m[1] || m[2]))) : 1;
  return { fn, side, zone, count };
}

function lensOf(fn, zone) {
  if (fn === 'indicator' || (fn === 'marker' && zone === 'front')) return LENS.amber;
  if (zone === 'rear' && fn !== 'reverse' && fn !== 'plate') return LENS.red;
  return LENS.clear;
}

/**
 * Pure: the scene's lamps. Each lamp: { key, x, y, r, lens, filaments:[{node, fn, ratedW}] }.
 * `unplaced`: light loads whose label matched nothing.
 */
export function carLamps(scene) {
  const nodes = (scene?.nodes || []).filter((n) => n.type === 'load' && LIGHT.test(n.data?.component || ''));
  const lamps = new Map();
  const seen = new Map();   // side|zone|fn -> filaments of that function so far (its lamp index)
  const unplaced = [];
  for (const n of nodes) {
    const c = classify(n.data?.label);
    const group = c && (GROUP[c.fn] || c.fn);
    const slot = c && (SLOT[`${c.zone}:${group}`] || SLOT[`front:${group}`]);
    if (!slot) { unplaced.push({ node: n.id, label: n.data?.label || n.id }); continue; }
    for (let k = 0; k < c.count; k++) {
      const sk = `${c.side}|${c.zone}|${c.fn}`;
      const i = seen.get(sk) || 0;
      seen.set(sk, i + 1);
      const key = `${c.side}|${c.zone}|${group}|${i}`;
      if (!lamps.has(key)) {
        const [x0, y, dx] = slot;
        const x = c.side === 'L' ? x0 + i * dx : c.side === 'R' ? 200 - x0 - i * dx : 100 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (dx || 12);
        const r = group === 'head' ? 7 : group === 'interior' || group === 'marker' || group === 'plate' ? 3.5 : 5;
        lamps.set(key, { key, x, y, r, lens: lensOf(c.fn, c.zone), filaments: [] });
      }
      lamps.get(key).filaments.push({ node: n.id, fn: c.fn, ratedW: Number(n.data?.ratedW) || 0, color: c.fn === 'marker' && c.zone === 'rear' ? COLOR.tail : COLOR[c.fn] });
    }
  }
  return { lamps: [...lamps.values()], unplaced };
}

/**
 * Pure: brightness 0..1 and colour of a lamp from each filament's current fraction (I / rated A).
 * A filament lights in proportion to its watts against the lamp's biggest one (tail 5 W of a P21/5W is dim).
 */
export function lampLook(lamp, fracOf) {
  const maxW = Math.max(1, ...lamp.filaments.map((f) => f.ratedW));
  let best = 0, color = null;
  for (const f of lamp.filaments) {
    const b = Math.max(0, Math.min(1, fracOf(f.node))) * Math.max(0.25, f.ratedW / maxW);
    if (b > best) { best = b; color = f.color; }
  }
  return { b: best, color: color || lamp.lens };
}
