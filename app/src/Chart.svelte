<script>
  // One time chart: a 30 s window of one or more series, autoscaled, with an optional state band,
  // a hover readout and pause. `getData()` → { series:[{points,color,label,dash?,fill?}], bands:[] }
  // is called on every redraw; the ring buffers it returns are mutated in place by ws.js, so the
  // redraw is driven by `traceTick`.
  import { drawSeries, sampleAt, fmtT, STATE_COLORS } from './chart.js';
  import { traceTick, HORIZON_S } from './ws.js';
  import { theme } from './ui.js';

  let { getData, unit = 'A', height = 190, paused = false, floorMax = 1, digits = 2, title = '' } = $props();

  let canvas;
  let width = $state(320);
  let hoverX = $state(null);
  let readout = $state({ t: null, rows: [] });
  let frozen = null;
  let scales = null;

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const resolve = (c) => (c && c.startsWith('--') ? css(c) : c);

  function data() {
    if (paused) {
      if (!frozen) {
        const d = getData();
        frozen = { series: d.series.map((s) => ({ ...s, points: s.points.slice() })), bands: (d.bands || []).slice() };
      }
      return frozen;
    }
    frozen = null;
    return getData();
  }

  function draw() {
    if (!canvas || width < 10) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const d = data();
    let tEnd = 0;
    for (const s of d.series) if (s.points.length) tEnd = Math.max(tEnd, s.points[s.points.length - 1][0]);
    const tMax = Math.max(HORIZON_S, tEnd);
    const tMin = tMax - HORIZON_S;
    const series = d.series.map((s) => ({ ...s, color: resolve(s.color) }));
    const hoverT = hoverX != null && scales ? scales.tOf(hoverX) : null;
    scales = drawSeries(ctx, series, {
      width, height, tMin, tMax, bands: d.bands || [], hoverT, unit, floorMax,
      theme: { fg: css('--ink'), grid: css('--grid'), muted: css('--muted'), bg: 'transparent' },
    });
    if (hoverT != null) {
      readout = {
        t: hoverT,
        rows: series.map((s) => {
          const p = sampleAt(s.points, hoverT);
          return { label: s.label, color: s.color, value: p && Math.abs(p[0] - hoverT) < 1 ? p[1] : null };
        }),
        state: (d.bands || []).find((b) => hoverT >= b.t0 && hoverT < b.t1)?.state ?? null,
      };
    } else {
      readout = {
        t: null,
        rows: series.map((s) => ({ label: s.label, color: s.color, value: s.points.length ? s.points[s.points.length - 1][1] : null })),
        state: (d.bands || []).at(-1)?.state ?? null,
      };
    }
  }

  $effect(() => {
    $traceTick; $theme; width; height; hoverX; paused; getData;
    draw();
  });

  function onmove(e) {
    const r = canvas.getBoundingClientRect();
    hoverX = e.clientX - r.left;
  }
  const fmt = (v) => (v == null ? '—' : typeof v === 'number' ? `${v.toFixed(digits)} ${unit}` : String(v));
</script>

<div class="chart" bind:clientWidth={width}>
  <div class="legend">
    {#if title}<span class="title">{title}</span>{/if}
    {#each readout.rows as r}
      <span class="item"><i style:background={r.color}></i>{r.label} <b class="num">{fmt(r.value)}</b></span>
    {/each}
    {#if readout.state}
      <span class="item"><i class="sq" style:background={STATE_COLORS[readout.state]}></i>{readout.state}</span>
    {/if}
    <span class="t num muted">{readout.t != null ? 't ' + fmtT(readout.t) : ''}</span>
  </div>
  <canvas
    bind:this={canvas}
    style:height="{height}px"
    onpointermove={onmove}
    onpointerleave={() => (hoverX = null)}
    aria-label={title || 'time chart'}
  ></canvas>
</div>

<style>
  .chart {
    width: 100%;
  }
  canvas {
    display: block;
    width: 100%;
    cursor: crosshair;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    align-items: center;
    padding: 0 2px 6px;
    font-size: 12px;
    color: var(--muted);
    min-height: 22px;
  }
  .title {
    color: var(--ink);
    font-weight: 600;
  }
  .item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .item b {
    color: var(--ink);
    font-weight: 600;
  }
  .item i {
    width: 12px;
    height: 2px;
    border-radius: 1px;
  }
  .item i.sq {
    width: 9px;
    height: 9px;
    border-radius: 2px;
  }
  .t {
    margin-left: auto;
  }
</style>
