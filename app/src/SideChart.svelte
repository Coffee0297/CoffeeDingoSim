<script>
  // Chart tab: follows the canvas selection. Output / load / wiper → model current (bank trace `i`)
  // vs measured (telemetry currentA) with the Msg3 state band; battery → V and total A; engine →
  // RPM and coolant; module → board temperature and battery V.
  import { scene, modules, traces, traceTick } from './ws.js';
  import { selection } from './ui.js';
  import { toBands, fmtA } from './chart.js';
  import { handleIndex } from './scene.js';
  import Chart from './Chart.svelte';

  let paused = $state(false);
  const sel = $derived($selection);

  // Resolve a selection to the output it charts.
  const target = $derived.by(() => {
    const s = sel, sc = $scene;
    if (!s || !sc) return null;
    if (s.kind === 'output') return { machine: s.machine, n: s.n };
    if (s.kind === 'load' || s.kind === 'wiper') {
      const e = sc.edges.find((x) => x.from.node === s.id && x.from.handle === 'supply' && x.to.handle?.startsWith('out:'));
      return e ? { machine: e.to.node, n: handleIndex(e.to.handle) } : { machine: null, n: null };
    }
    return null;
  });
  const mod = $derived(target?.machine ? $scene?.modules?.find((m) => m.id === target.machine) : null);
  const outCfg = $derived(mod?.outputs?.find((o) => o.n === target?.n));
  const tel = $derived(target?.machine ? $modules[target.machine]?.outputs?.find((o) => o.n === target.n) : null);
  const selNode = $derived(sel?.id ? $scene?.nodes?.find((n) => n.id === sel.id) : null);
  const loadsHere = $derived(
    target?.machine
      ? ($scene?.edges || []).filter((e) => e.to.node === target.machine && e.to.handle === `out:${target.n}`).map((e) => e.from.node)
      : [],
  );

  const empty = { series: [], bands: [] };
  function outputData() {
    const tr = target?.machine ? traces[target.machine] : null;
    if (!tr) return empty;
    const k = target.n - 1;
    const model = tr.model[k] || [], meas = tr.meas[k] || [], st = tr.state[k] || [];
    const tEnd = Math.max(model.at(-1)?.[0] ?? 0, meas.at(-1)?.[0] ?? 0);
    return {
      series: [
        { points: model, color: '--trace-model', label: 'Model', fill: true },
        { points: meas, color: '--trace-meas', label: 'Measured', width: 1.75 },
      ],
      bands: toBands(st, tEnd),
    };
  }
  const batteryV = () => ({ series: [{ points: traces.__battery?.v || [], color: '--st-on', label: 'Battery' }] });
  const batteryA = () => ({ series: [{ points: traces.__battery?.a || [], color: '--trace-model', label: 'Total current', fill: true }] });
  const engineRpm = () => ({ series: [{ points: traces.__engine?.[sel?.id]?.rpm || [], color: '--trace-model', label: 'RPM', fill: true }] });
  const engineClt = () => ({ series: [{ points: traces.__engine?.[sel?.id]?.clt || [], color: '--st-oc', label: 'Coolant' }] });
  const moduleTemp = () => ({ series: [{ points: traces[sel?.id]?.temp || [], color: '--st-oc', label: 'Board' }] });
  const moduleV = () => ({ series: [{ points: traces[sel?.id]?.vbatt || [], color: '--st-on', label: 'Vbatt' }] });

  // keep the measured-vs-limit readout live
  const peak = $derived.by(() => {
    $traceTick;
    const tr = target?.machine ? traces[target.machine] : null;
    const pts = tr?.model?.[target.n - 1] || [];
    let p = 0;
    for (const x of pts) if (x[1] > p) p = x[1];
    return p;
  });
</script>

<div class="side-chart">
  <div class="bar">
    <div class="what">
      {#if !sel}
        <span class="muted">Nothing selected</span>
      {:else if target}
        <strong>{target.machine ? `${target.machine} out ${target.n}` : sel.id}</strong>
        {#if outCfg}<span class="muted">{outCfg.name}</span>{/if}
      {:else}
        <strong>{sel.id}</strong><span class="muted">{selNode?.type ?? sel.kind}</span>
      {/if}
    </div>
    <button class="btn sm" class:on={paused} onclick={() => (paused = !paused)} aria-pressed={paused}>{paused ? 'Resume' : 'Pause'}</button>
  </div>

  {#if !sel}
    <p class="hint">Click a load, an output row on a module, the battery or the engine to chart it. The window shows the last 30 s of virtual time.</p>
  {:else if target && !target.machine}
    <p class="hint">{sel.id} is not wired. Drag from its left handle onto a module output to see its current.</p>
  {:else if target}
    {#key `${target.machine}:${target.n}`}
      <Chart getData={outputData} unit="A" height={220} {paused} />
    {/key}
    <dl class="facts">
      <div><dt>State</dt><dd><span class="state-dot" data-state={tel?.state ?? 'Off'}></span> {tel?.state ?? '—'}</dd></div>
      <div><dt>Measured</dt><dd class="num">{tel ? fmtA(tel.currentA) : '—'}</dd></div>
      <div><dt>Model peak (30 s)</dt><dd class="num">{fmtA(peak)}</dd></div>
      <div><dt>OC count</dt><dd class="num">{tel?.ocCount ?? '—'}</dd></div>
      {#if outCfg}
        <div><dt>Current limit</dt><dd class="num">{outCfg.currentLimit} A</dd></div>
        <div><dt>Inrush limit</dt><dd class="num">{outCfg.inrushCurrentLimit} A for {outCfg.inrushTime} ms</dd></div>
        <div><dt>Reset mode</dt><dd>{outCfg.resetMode === 0 ? 'None (latches Fault)' : outCfg.resetMode}</dd></div>
        <div><dt>Loads</dt><dd>{loadsHere.join(', ') || 'none'}</dd></div>
      {/if}
    </dl>
    {#if selNode?.data?.precheck}
      <p class="pre">{typeof selNode.data.precheck === 'string' ? selNode.data.precheck : selNode.data.precheck.map((p) => p.text).join(' ')}</p>
    {/if}
  {:else if sel.kind === 'battery'}
    <Chart getData={batteryV} unit="V" height={150} floorMax={14} {paused} />
    <Chart getData={batteryA} unit="A" height={150} {paused} />
  {:else if sel.kind === 'engine'}
    {#key sel.id}
      <Chart getData={engineRpm} unit="rpm" digits={0} height={150} floorMax={1000} {paused} />
      <Chart getData={engineClt} unit="°C" digits={1} height={150} floorMax={100} {paused} />
    {/key}
  {:else if sel.kind === 'module'}
    {#key sel.id}
      <Chart getData={moduleTemp} unit="°C" digits={1} height={150} floorMax={40} {paused} />
      <Chart getData={moduleV} unit="V" height={150} floorMax={14} {paused} />
    {/key}
    <p class="hint">Click an output row on {sel.id} to chart that output.</p>
  {:else}
    <p class="hint">{selNode?.type ?? 'This node'} has no time series. Select a load, an output, the battery or the engine.</p>
  {/if}
</div>

<style>
  .side-chart {
    padding: 12px;
    display: grid;
    gap: 10px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .what {
    flex: 1;
    display: flex;
    gap: 8px;
    align-items: baseline;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .hint {
    color: var(--muted);
    margin: 0;
    line-height: 1.5;
  }
  .facts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 16px;
    margin: 0;
  }
  .facts div {
    display: grid;
    gap: 1px;
  }
  dt {
    color: var(--muted);
    font-size: 11px;
  }
  dd {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .pre {
    margin: 0;
    padding: 8px 10px;
    border-left: 2px solid var(--st-warn);
    background: var(--raised);
    border-radius: 0 var(--r-s) var(--r-s) 0;
    color: var(--muted);
  }
</style>
