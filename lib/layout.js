// Auto-arrange for the canvas: every module gets a "cell" — the knobs / switches that drive it on the left,
// the module in the middle, the loads it supplies on the right (sorted by output number so they line up
// with the output rows). Cells wrap into rows; battery, engine, keypads, CAN generators and anything not
// wired to a module go in a band across the top.
//
// Pure: works on Svelte Flow shaped nodes {id, type} and edges {source, target, sourceHandle, targetHandle}.
// `size(node)` returns the rendered {w, h} (Svelte Flow `measured`), falling back to rough per-type sizes.

const GAP = { col: 70, row: 18, cellX: 140, cellY: 120, band: 160 };
const FALLBACK = { module: [260, 420], load: [230, 150], switch: [180, 110], rotary: [200, 190], keypad: [260, 220],
  cangen: [240, 180], engine: [240, 230], battery: [220, 160], wiper: [240, 190] };

/** Rough size when a node has not been measured yet. */
export function fallbackSize(node) {
  const [w, h] = FALLBACK[node.type] ?? [220, 140];
  return { w, h };
}

const outNo = (h) => Number(/(\d+)$/.exec(h || '')?.[1] ?? 0);
const KIND_ORDER = { canboard: 0, pdm: 1, pdmmax: 2 };

/**
 * @param {{nodes:Array, edges:Array}} flow
 * @param {{size?:(node)=>{w:number,h:number}, perRow?:number, origin?:{x:number,y:number}}} [opts]
 * @returns {Map<string,{x:number,y:number}>} new top-left position per node id
 */
function layoutOnce({ nodes, edges }, opts) {
  const size = (n) => { const s = opts.size?.(n); return s && s.w > 0 && s.h > 0 ? s : fallbackSize(n); };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const modules = nodes.filter((n) => n.type === 'module')
    .sort((a, b) => {
      const ma = a.data?.module ?? {}, mb = b.data?.module ?? {};
      return (KIND_ORDER[ma.kind] ?? 9) - (KIND_ORDER[mb.kind] ?? 9) || (ma.baseId ?? 0) - (mb.baseId ?? 0) || a.id.localeCompare(b.id);
    });
  const isModule = (id) => byId.get(id)?.type === 'module';

  // owner module of every non-module node: loads / wipers by their supply edge, stimulus by what it drives
  const right = new Map(modules.map((m) => [m.id, []]));
  const left = new Map(modules.map((m) => [m.id, []]));
  const placed = new Set();
  for (const e of edges) {
    const src = byId.get(e.source), dst = byId.get(e.target);
    if (!src || !dst) continue;
    if (src.type !== 'module' && isModule(e.target) && (e.sourceHandle === 'supply' || /^out:/.test(e.targetHandle || ''))) {
      if (!placed.has(src.id)) { right.get(e.target).push({ node: src, key: outNo(e.targetHandle) }); placed.add(src.id); }
    }
  }
  for (const e of edges) {
    const src = byId.get(e.source);
    if (!src || placed.has(src.id) || src.type === 'module') continue;
    if (isModule(e.target) && /^(di|ai):/.test(e.targetHandle || '')) {
      left.get(e.target).push({ node: src, key: outNo(e.targetHandle) }); placed.add(src.id);
    }
  }
  for (const list of [...right.values(), ...left.values()]) list.sort((a, b) => a.key - b.key || a.node.id.localeCompare(b.node.id));

  const pos = new Map();
  const origin = opts.origin ?? { x: 0, y: 0 };

  // top band: everything not owned by a module
  const loose = nodes.filter((n) => n.type !== 'module' && !placed.has(n.id));
  let bx = origin.x, bandH = 0;
  for (const n of loose) { const s = size(n); pos.set(n.id, { x: bx, y: origin.y }); bx += s.w + GAP.col; bandH = Math.max(bandH, s.h); }
  const top = origin.y + (loose.length ? bandH + GAP.band : 0);

  const colH = (list) => list.reduce((h, it, i) => h + size(it.node).h + (i ? GAP.row : 0), 0);
  const colW = (list) => list.reduce((w, it) => Math.max(w, size(it.node).w), 0);
  // loads may wrap into several columns (column-major, so output 1.. reads down the first column)
  const loadCols = opts.loadCols ?? 1;
  const chunk = (list) => { const k = Math.max(1, Math.ceil(list.length / loadCols)); const out = []; for (let i = 0; i < list.length; i += k) out.push(list.slice(i, i + k)); return out; };
  const cells = modules.map((m) => {
    const L = left.get(m.id), Rc = chunk(right.get(m.id)), ms = size(m);
    const lw = colW(L), rws = Rc.map(colW);
    const rw = rws.reduce((a, b) => a + b, 0) + Math.max(0, rws.length - 1) * GAP.row;
    return { m, L, Rc, rws, ms, lw, w: (lw ? lw + GAP.col : 0) + ms.w + (rw ? GAP.col + rw : 0), h: Math.max(ms.h, colH(L), ...Rc.map(colH), 0) };
  });

  const perRow = opts.perRow ?? Math.max(1, Math.ceil(Math.sqrt(cells.length)));
  let y = top;
  for (let r = 0; r < cells.length; r += perRow) {
    const row = cells.slice(r, r + perRow);
    let x = origin.x;
    for (const c of row) {
      let cy = y;
      for (const it of c.L) { pos.set(it.node.id, { x: x + c.lw - size(it.node).w, y: cy }); cy += size(it.node).h + GAP.row; }
      const mx = x + (c.lw ? c.lw + GAP.col : 0);
      pos.set(c.m.id, { x: mx, y });
      let rx = mx + c.ms.w + GAP.col;
      c.Rc.forEach((col, ci) => {
        cy = y;
        for (const it of col) { pos.set(it.node.id, { x: rx, y: cy }); cy += size(it.node).h + GAP.row; }
        rx += c.rws[ci] + GAP.row;
      });
      x += c.w + GAP.cellX;
    }
    y += Math.max(...row.map((c) => c.h)) + GAP.cellY;
  }
  for (const [id, p] of pos) pos.set(id, { x: Math.round(p.x), y: Math.round(p.y) });
  return pos;
}

/**
 * Pick the cells-per-row and load-column count whose bounding box best matches the viewport shape
 * (`opts.aspect` = width / height, default 16:9), so the fitted canvas stays readable.
 * @param {{nodes:Array, edges:Array}} flow
 * @param {{size?:(node)=>{w:number,h:number}, aspect?:number, perRow?:number, loadCols?:number, origin?:{x:number,y:number}}} [opts]
 * @returns {Map<string,{x:number,y:number}>} new top-left position per node id
 */
export function arrange(flow, opts = {}) {
  const size = (n) => { const s = opts.size?.(n); return s && s.w > 0 && s.h > 0 ? s : fallbackSize(n); };
  const nMod = flow.nodes.filter((n) => n.type === 'module').length || 1;
  const aspect = opts.aspect ?? 16 / 9;
  let best = null;
  for (let perRow = 1; perRow <= nMod; perRow++) {
    if (opts.perRow && perRow !== opts.perRow) continue;
    for (let loadCols = 1; loadCols <= 3; loadCols++) {
      if (opts.loadCols && loadCols !== opts.loadCols) continue;
      const pos = layoutOnce(flow, { ...opts, perRow, loadCols });
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of flow.nodes) { const p = pos.get(n.id); if (!p) continue; const s = size(n); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + s.w); y1 = Math.max(y1, p.y + s.h); }
      const w = x1 - x0, h = y1 - y0;
      // the zoom that fits the box into a viewport of this aspect: bigger is more readable
      const zoom = Math.min(aspect / w, 1 / h);
      if (!best || zoom > best.zoom * 1.0001) best = { zoom, pos };
    }
  }
  return best.pos;
}
