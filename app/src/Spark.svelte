<script>
  // Sparkline: the side chart's drawing code in miniature (chart.js drawSeries, mini mode).
  // `getPoints()` is called on every redraw; with `live` it redraws on every trace tick.
  import { drawSeries } from './chart.js';
  import { traceTick } from './ws.js';

  let { getPoints, color = '--trace-model', width = 120, height = 28, live = false, windowS = null, floorMax = 0.1 } = $props();
  let canvas;

  function resolve(c) {
    if (!c.startsWith('--')) return c;
    return getComputedStyle(document.documentElement).getPropertyValue(c).trim() || '#999';
  }

  function draw() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pts = getPoints() || [];
    let tMin, tMax;
    if (windowS && pts.length) {
      tMax = pts[pts.length - 1][0];
      tMin = tMax - windowS;
    }
    drawSeries(ctx, [{ points: pts, color: resolve(color), fill: true }], { width, height, mini: true, tMin, tMax, floorMax });
  }

  $effect(() => {
    if (live) $traceTick;
    getPoints;
    width; height; color;
    draw();
  });
</script>

<canvas bind:this={canvas} style:width="{width}px" style:height="{height}px" aria-hidden="true"></canvas>

<style>
  canvas {
    display: block;
  }
</style>
