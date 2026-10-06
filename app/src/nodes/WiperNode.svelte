<script>
  // Wiper motor (coupled load): `supply` → a PDM output, `run` / `speed` ← CANBoard DO handles,
  // `park` → a digital input. Gauge shows the sweep angle; indicators come from the server
  // `wiper` message.
  import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
  import { wiperLive } from '../ws.js';
  import { NOMINAL_V } from '../scene.js';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();
  const live = $derived($wiperLive[id] || { angleDeg: 0, run: false, speed: false, park: true });
  // Sweep 0..360° of crank maps to a 0..110° blade arc (out and back).
  const blade = $derived.by(() => {
    const a = (live.angleDeg || 0) % 360;
    return (a <= 180 ? a / 180 : (360 - a) / 180) * 110;
  });
  const tip = $derived.by(() => {
    const r = ((180 - blade) * Math.PI) / 180;
    return [60 + 46 * Math.cos(r), 58 - 46 * Math.sin(r)];
  });
</script>

<div class="node wiper" class:selected>
  <div class="node-head"><span>Wiper motor</span><span class="spacer"></span><span class="num muted">{data.ratedW} W</span></div>
  <div class="rows">
    <div class="row"><Handle type="source" position={Position.Left} id="supply" class="handle-out" /><span class="label">Supply</span><span class="val">{(data.ratedW / NOMINAL_V).toFixed(1)} A</span></div>
    <div class="row"><Handle type="target" position={Position.Left} id="run" /><span class="state-dot" class:bool-on={live.run}></span><span class="label">Run relay</span></div>
    <div class="row"><Handle type="target" position={Position.Left} id="speed" /><span class="state-dot" class:bool-on={live.speed}></span><span class="label">Fast relay</span></div>
    <div class="row"><Handle type="source" position={Position.Left} id="park" class="handle-out" /><span class="state-dot" class:bool-on={live.park}></span><span class="label">Park switch</span><span class="val">{live.park ? 'parked' : 'sweeping'}</span></div>
  </div>
  <svg viewBox="0 0 120 64" class="gauge" aria-label="Wiper angle">
    <path d="M14 58 A46 46 0 0 1 106 58" class="arc" />
    <line x1="60" y1="58" x2={tip[0]} y2={tip[1]} class="blade" class:moving={live.run} />
    <circle cx="60" cy="58" r="3.5" class="hub" />
  </svg>
  <div class="node-controls nodrag">
    <label>Rated <input class="input num" type="number" min="1" value={data.ratedW} onchange={(e) => updateNodeData(id, { ratedW: Number(e.currentTarget.value) })} /> W</label>
    <label>Slow <input class="input num" type="number" step="0.1" value={data.slowRps} onchange={(e) => updateNodeData(id, { slowRps: Number(e.currentTarget.value) })} /></label>
    <label>Fast <input class="input num" type="number" step="0.1" value={data.fastRps} onchange={(e) => updateNodeData(id, { fastRps: Number(e.currentTarget.value) })} /> rev/s</label>
  </div>
</div>

<style>
  .wiper {
    width: 230px;
  }
  .rows {
    padding: 6px 0 0;
  }
  .gauge {
    display: block;
    width: 100%;
    height: 70px;
    padding: 4px 10px 0;
  }
  .arc {
    fill: none;
    stroke: var(--line-strong);
    stroke-width: 2;
    stroke-dasharray: 3 4;
  }
  .blade {
    stroke: var(--muted);
    stroke-width: 3.5;
    stroke-linecap: round;
  }
  .blade.moving {
    stroke: var(--st-on);
  }
  .hub {
    fill: var(--ink);
  }
  .node-controls .input {
    width: 48px;
  }
</style>
