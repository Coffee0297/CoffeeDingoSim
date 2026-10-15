<script>
  // Car tab: a top view (front at the top) with one lamp per bulb, placed from the load names
  // (car.js) and lit from each output's model current, so a faulted or PWM-dimmed bulb looks it.
  import { scene, traces, traceTick } from './ws.js';
  import { handleIndex } from './scene.js';
  import { carLamps, lampLook } from './car.js';

  const layout = $derived(carLamps($scene));
  const labelOf = $derived(new Map(($scene?.nodes || []).map((n) => [n.id, n.data?.label || n.id])));

  // node -> current / rated A of everything on its output (each load's share of the output current)
  const feed = $derived.by(() => {
    const edges = ($scene?.edges || []).filter((e) => e.from?.handle === 'supply' && e.to?.handle?.startsWith('out:'));
    const rated = new Map(($scene?.nodes || []).map((n) => [n.id, Number(n.data?.ratedA) || 0]));
    const total = new Map();
    for (const e of edges) { const k = `${e.to.node}|${e.to.handle}`; total.set(k, (total.get(k) || 0) + rated.get(e.from.node)); }
    return new Map(edges.map((e) => [e.from.node, { machine: e.to.node, n: handleIndex(e.to.handle), totalA: total.get(`${e.to.node}|${e.to.handle}`) }]));
  });

  function frac(node) {
    const f = feed.get(node);
    const ch = f && traces[f.machine]?.model?.[f.n - 1];
    const a = ch?.length ? ch[ch.length - 1][1] : 0;
    return f?.totalA > 0 ? a / f.totalA : 0;
  }

  const looks = $derived.by(() => { $traceTick; return layout.lamps.map((l) => lampLook(l, frac)); });
</script>

<div class="car">
  <svg viewBox="-12 0 224 420" role="img" aria-label="Car top view with lamps">
    <defs>
      <filter id="glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="5" /></filter>
    </defs>
    <!-- wheels -->
    {#each [[70, 112], [298, 340]] as [y0, y1]}
      <rect x="-6" y={y0} width="12" height={y1 - y0} rx="3" class="tyre" />
      <rect x="194" y={y0} width="12" height={y1 - y0} rx="3" class="tyre" />
    {/each}
    <!-- body: hood, cab, open bed -->
    <rect x="12" y="10" width="176" height="400" rx="24" class="body" />
    <path d="M30 128 L170 128 L160 158 L40 158 Z" class="glass" />
    <rect x="40" y="158" width="120" height="62" rx="6" class="roof" />
    <path d="M42 220 L158 220 L164 234 L36 234 Z" class="glass" />
    <rect x="26" y="244" width="148" height="146" rx="4" class="bed" />
    <line x1="30" y1="120" x2="170" y2="120" class="seam" />

    {#each layout.lamps as l, i (l.key)}
      {@const k = looks[i]}
      <g>
        <title>{l.filaments.map((f) => labelOf.get(f.node)).join('\n')}</title>
        {#if k.b > 0.02}<circle cx={l.x} cy={l.y} r={l.r * 2.6} fill={k.color} opacity={k.b * 0.75} filter="url(#glow)" />{/if}
        <circle cx={l.x} cy={l.y} r={l.r} fill={k.b > 0.02 ? k.color : l.lens} fill-opacity={k.b > 0.02 ? 0.35 + 0.65 * k.b : 1} class="lens" />
      </g>
    {/each}
  </svg>
  {#if layout.unplaced.length}
    <p class="muted">Not placed (no side / front / rear / function word in the name): {layout.unplaced.map((u) => u.label).join(', ')}</p>
  {/if}
  {#if !layout.lamps.length}<p class="muted">No light loads in the scene.</p>{/if}
</div>

<style>
  .car { padding: 12px; }
  svg { width: 100%; max-height: calc(100vh - 140px); display: block; }
  .body { fill: #2b2f36; stroke: #4a505a; stroke-width: 1.5; }
  .glass { fill: #1b2733; stroke: #4a505a; }
  .roof { fill: #333842; stroke: #4a505a; }
  .bed { fill: #23262c; stroke: #4a505a; }
  .seam { stroke: #4a505a; }
  .tyre { fill: #111; }
  .lens { stroke: #00000080; stroke-width: 0.8; }
  .muted { color: var(--muted); font-size: 12px; }
</style>
