<script>
  // A load: icon + name, preset, rated W / A (one derives the other at 13.8 V), the model current
  // of the output it hangs on (its share when several loads sum on one handle), fault and
  // pre-check badges. Right-click (or the Fault button) opens the fault menu in Canvas.
  import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
  import { components, scene, traces } from '../ws.js';
  import { contextMenu } from '../ui.js';
  import { componentById, NOMINAL_V, FAULT_LABEL, handleIndex, loadTitle } from '../scene.js';
  import EditableTitle from './EditableTitle.svelte';
  import { fmtA } from '../chart.js';
  import Spark from '../Spark.svelte';
  import Icon from '../Icon.svelte';
  import { instantiate, render, inrushOf } from '../../../lib/components.js';
  import { precheck as runPrecheck } from '../../../lib/precheck.js';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();

  const comp = $derived(componentById($components, data.component));
  const supply = $derived(
    ($scene?.edges || []).find((e) => e.from.node === id && e.from.handle === 'supply' && e.to.handle?.startsWith('out:')),
  );
  const machine = $derived(supply?.to.node ?? null);
  const n = $derived(supply ? handleIndex(supply.to.handle) : null);
  const outName = $derived.by(() => {
    const mod = ($scene?.modules || []).find((x) => x.id === machine);
    return mod?.outputs?.find((o) => o.n === n)?.name ?? null;
  });
  const share = $derived.by(() => {
    if (!supply) return 1;
    const peers = ($scene?.edges || [])
      .filter((e) => e.to.node === machine && e.to.handle === supply.to.handle)
      .map((e) => ($scene?.nodes || []).find((x) => x.id === e.from.node))
      .filter(Boolean);
    const total = peers.reduce((s, p) => s + (Number(p.data?.ratedA) || 0), 0);
    return total > 0 ? (Number(data.ratedA) || 0) / total : 1;
  });

  function points() {
    const ch = machine && n ? traces[machine]?.model?.[n - 1] : null;
    if (!ch) return [];
    return share === 1 ? ch : ch.map(([t, v]) => [t, v * share]);
  }

  // This load's curve, rendered in the browser with the same library the server feeds the bank with.
  const opts = (d) => ({ preset: d.preset ?? undefined, ratedW: d.ratedW, ratedA: d.ratedA, params: d.params });
  function curve(d) {
    try { return render(instantiate(d.component, opts(d)), { tableMs: 1, horizonMs: 3000 }); } catch { return null; }
  }
  const inrush = $derived.by(() => { try { return inrushOf(data.component, opts(data)); } catch { return null; } });
  const peakA = $derived.by(() => { const c = curve(data); return c ? Math.max(c.steadyA ?? 0, ...(c.table ?? [0])) : null; });

  // Pre-check of the whole output this load hangs on (every load on it, against its limits and sense range).
  const precheck = $derived.by(() => {
    if (!supply) return null;
    const mod = ($scene?.modules || []).find((x) => x.id === machine);
    const out = mod?.outputs?.find((o) => o.n === n);
    if (!out) return null;
    const loads = ($scene?.edges || [])
      .filter((e) => e.to.node === machine && e.to.handle === supply.to.handle)
      .map((e) => ($scene?.nodes || []).find((x) => x.id === e.from.node))
      .map((nd) => (nd?.id === id ? { ...nd, data } : nd))
      .filter((nd) => nd?.data?.component).map((nd) => curve(nd.data)).filter(Boolean);
    const kILIS = mod.kind === 'pdmmax' ? 35000 : n <= 2 ? 22950 : 5950;
    const r = runPrecheck(loads, out, kILIS);
    return r.find((x) => x.level === 'warn') || null;
  });

  function setInrush(key, v) {
    const x = Number(v);
    const params = { ...(data.params || {}) };
    if (v === '' || !(x >= 0)) delete params[key]; else params[key] = x;
    updateNodeData(id, { params });
  }
  const customInrush = $derived(!!inrush && data.params && (inrush.xKey in data.params || inrush.msKey in data.params));

  function setPreset(name) {
    const pr = (comp?.presets || []).find((x) => x.name === name);
    if (!pr) return;
    const ratedW = pr.W ?? +(pr.A * NOMINAL_V).toFixed(1);
    const ratedA = pr.A ?? +(pr.W / NOMINAL_V).toFixed(2);
    updateNodeData(id, { preset: name, ratedW, ratedA, guess: false });
  }
  function setW(v) {
    const w = Number(v);
    if (!(w >= 0)) return;
    updateNodeData(id, { ratedW: w, ratedA: +(w / NOMINAL_V).toFixed(2), guess: false });
  }
  function setA(v) {
    const a = Number(v);
    if (!(a >= 0)) return;
    updateNodeData(id, { ratedA: a, ratedW: +(a * NOMINAL_V).toFixed(1), guess: false });
  }
  // What this load is (its own name, else the output's), and whether it is drawing current right now.
  const isLight = $derived(/^lighting$/i.test(comp?.group ?? ''));
  const title = $derived(data.name || loadTitle(data.label, isLight) || outName || comp?.name || data.component);
  let lit = $state(false);
  $effect(() => {
    const t = setInterval(() => { lit = (points().at(-1)?.[1] ?? 0) > 0.05; }, 200);
    return () => clearInterval(t);
  });

  function openFaultMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu.set({ x: r.left, y: r.bottom + 4, nodeId: id });
  }
</script>

<div class="node load" class:selected class:faulted={!!data.fault} class:lit class:light={isLight}>
  <Handle type="source" position={Position.Left} id="supply" class="handle-out" />
  <div class="node-head">
    <span class="icon"><Icon name={comp?.icon || 'generic'} /></span>
    <EditableTitle value={title} onsave={(v) => updateNodeData(id, { name: v })} />
    <span class="spacer"></span>
    {#if data.guess}<span class="badge guess" title="No keyword matched the output name; sized at 60 % of the current limit">Guess</span>{/if}
    <span class="onoff" class:on={lit}>{lit ? 'ON' : 'OFF'}</span>
  </div>
  <div class="kind faint">{comp?.name || data.component}</div>
  <div class="node-controls nodrag">
    <select class="input preset" value={data.preset ?? ''} onchange={(e) => setPreset(e.currentTarget.value)} aria-label="Preset">
      {#if !data.preset}<option value="">Custom</option>{/if}
      {#each comp?.presets || [] as p}<option value={p.name}>{p.name}</option>{/each}
    </select>
  </div>
  <div class="node-controls nodrag">
    <label>W <input class="input num" type="number" min="0" step="0.5" value={data.ratedW} onchange={(e) => setW(e.currentTarget.value)} /></label>
    <label>A <input class="input num" type="number" min="0" step="0.05" value={data.ratedA} onchange={(e) => setA(e.currentTarget.value)} /></label>
  </div>
  {#if inrush}
    <div class="node-controls nodrag inrush" title="Inrush: a multiple of the rated current at turn-on, decaying over the given time. Defaults come from the component.">
      <label>Inrush ×<input class="input num" type="number" min="1" step="0.5" value={+inrush.effX.toFixed(2)} onchange={(e) => setInrush(inrush.xKey, e.currentTarget.value)} /></label>
      <label>ms<input class="input num" type="number" min="0" step="1" value={+inrush.effMs.toFixed(0)} onchange={(e) => setInrush(inrush.msKey, e.currentTarget.value)} /></label>
      {#if customInrush}<button class="link" onclick={() => updateNodeData(id, { params: {} })} title={`Back to the default: ${+inrush.x.toFixed(2)}× for ${+inrush.ms.toFixed(0)} ms`}>reset</button>{/if}
    </div>
    {#if peakA != null}<div class="peak faint">peak ≈ {fmtA(peakA)}</div>{/if}
  {/if}
  <div class="spark">
    <Spark getPoints={points} live={true} width={196} height={30} windowS={10} />
    <div class="spark-meta">
      <span class="muted">{supply ? `${machine} out ${n}` : 'Not wired'}{share < 1 ? `, ${Math.round(share * 100)} % share` : ''}</span>
      <span class="num">{supply ? fmtA(points().at(-1)?.[1] ?? 0) : ''}</span>
    </div>
  </div>
  <div class="badges nodrag">
    {#if data.fault}
      <button class="badge fault" onclick={openFaultMenu} title="Change or clear the fault">
        {FAULT_LABEL[data.fault.kind] || data.fault.kind}{data.fault.atMs ? ` at ${data.fault.atMs} ms` : ''}
      </button>
    {:else}
      <button class="badge" onclick={openFaultMenu} title="Break this load">Fault…</button>
    {/if}
    {#if precheck}
      <span class="badge {precheck.level === 'warn' ? 'warn' : 'info'}" title={precheck.text}>Pre-check</span>
    {/if}
  </div>
  {#if precheck}<div class="precheck" class:warn={precheck.level === 'warn'}>{precheck.text}</div>{/if}
</div>

<style>
  .inrush label { gap: 3px; }
  .link { background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0 2px; font-size: 11px; }
  .peak { font-size: 11px; padding: 0 10px; }
  .load {
    width: 220px;
  }
  .load.faulted {
    border-color: color-mix(in srgb, var(--st-fault) 55%, var(--line));
  }
  .icon {
    display: inline-flex;
    color: var(--accent);
  }
  .preset {
    width: 100%;
  }
  .spark {
    padding: 2px 10px 4px;
  }
  .spark-meta {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    padding-top: 2px;
  }
  .badges {
    display: flex;
    gap: 6px;
    padding: 2px 10px 8px;
  }
  .badges button {
    cursor: pointer;
  }
  .precheck {
    padding: 0 10px 8px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.35;
  }
  .precheck.warn {
    color: color-mix(in srgb, var(--st-warn) 80%, var(--ink));
  }
  .kind { padding: 0 10px 4px; font-size: 11px; margin-top: -4px; }
  /* drawing current: lights glow amber, everything else green; the icon lights up too */
  .load { --lit: var(--st-on); transition: box-shadow 0.15s, border-color 0.15s; }
  .load.light { --lit: #ffb627; }
  .load.lit { border-color: var(--lit); box-shadow: 0 0 0 1px var(--lit), 0 0 18px color-mix(in srgb, var(--lit) 55%, transparent); }
  .load.lit .icon { color: var(--lit); filter: drop-shadow(0 0 4px var(--lit)); }
  .onoff { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 999px;
    border: 1px solid var(--line-strong); color: var(--muted); }
  .onoff.on { background: var(--lit); border-color: var(--lit); color: #1a1200; }
</style>
