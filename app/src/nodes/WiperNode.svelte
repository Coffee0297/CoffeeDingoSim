<script>
  // Wiper motor (coupled load): `supply` → a PDM output, `run` / `speed` ← CANBoard DO handles,
  // `park` → a digital input. Gauge shows the sweep angle; indicators come from the server
  // `wiper` message. Park type: standard (parks at the bottom of the sweep) or Ford depressed park (reverses
  // to a concealed position below the cowl; lib/wiper.js).
  import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
  import { wiperLive } from '../ws.js';
  import { NOMINAL_V } from '../scene.js';
  import EditableTitle from './EditableTitle.svelte';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();
  const live = $derived($wiperLive[id] || { angleDeg: 0, run: false, speed: false, park: true, powered: false, concealed: data.park === 'ford', dir: 0 });
  const ford = $derived(data.park === 'ford');
  const moving = $derived(live.powered && (live.run || !live.park));
  // Sweep 0..360° of crank maps to a 0..110° blade arc (out and back).
  const blade = $derived.by(() => {
    if (live.concealed) return -10;   // depressed park: below the cowl line
    const a = (live.angleDeg || 0) % 360;
    return (a <= 180 ? a / 180 : (360 - a) / 180) * 110;
  });
  const status = $derived(moving
    ? (live.dir < 0 ? 'PARKING ↺' : live.run ? (live.speed ? 'FAST' : 'SLOW') : 'PARKING')
    : live.powered ? (live.concealed ? 'PARKED · HIDDEN' : 'PARKED') : 'OFF');
  const tip = $derived.by(() => {
    const r = ((180 - blade) * Math.PI) / 180;
    return [60 + 46 * Math.cos(r), 58 - 46 * Math.sin(r)];
  });
</script>

<div class="node wiper" class:selected class:lit={moving}>
  <div class="node-head"><EditableTitle value={data.name || data.label} placeholder="Wiper motor" onsave={(v) => updateNodeData(id, { name: v })} /><span class="spacer"></span>
    <span class="onoff" class:on={moving}>{status}</span></div>
  <div class="kind faint">Wiper motor · {data.ratedW} W · {ford ? 'Ford concealed park' : 'standard park'}</div>
  <div class="rows">
    <div class="row"><Handle type="source" position={Position.Left} id="supply" class="handle-out" /><span class="label">Supply</span><span class="val">{(data.ratedW / NOMINAL_V).toFixed(1)} A</span></div>
    <div class="row"><Handle type="target" position={Position.Left} id="run" /><span class="state-dot" class:bool-on={live.run}></span><span class="label">Run relay</span></div>
    <div class="row"><Handle type="target" position={Position.Left} id="speed" /><span class="state-dot" class:bool-on={live.speed}></span><span class="label">Fast relay</span></div>
    <div class="row"><Handle type="source" position={Position.Left} id="park" class="handle-out" /><span class="state-dot" class:bool-on={live.park}></span><span class="label">Park switch</span><span class="val">{live.park ? (live.concealed ? 'concealed' : 'parked') : live.dir < 0 ? 'reversing' : 'sweeping'}</span></div>
  </div>
  <svg viewBox="0 0 120 70" class="gauge" aria-label="Wiper angle">
    <path d="M14 58 A46 46 0 0 1 106 58" class="arc" />
    {#if ford}<line x1="8" y1="61" x2="112" y2="61" class="cowl" />{/if}
    <line x1="60" y1="58" x2={tip[0]} y2={tip[1]} class="blade" class:moving={moving} />
    <circle cx="60" cy="58" r="3.5" class="hub" />
  </svg>
  <div class="node-controls nodrag">
    <label>Rated <input class="input num" type="number" min="1" value={data.ratedW} onchange={(e) => updateNodeData(id, { ratedW: Number(e.currentTarget.value) })} /> W</label>
    <label>Slow <input class="input num" type="number" step="0.1" value={data.slowRps} onchange={(e) => updateNodeData(id, { slowRps: Number(e.currentTarget.value) })} /></label>
    <label>Fast <input class="input num" type="number" step="0.1" value={data.fastRps} onchange={(e) => updateNodeData(id, { fastRps: Number(e.currentTarget.value) })} /> rev/s</label>
    <select class="input" value={data.park ?? 'standard'} onchange={(e) => updateNodeData(id, { park: e.currentTarget.value })} aria-label="Park type">
      <option value="standard">Standard park (bottom of the sweep)</option>
      <option value="ford">Ford concealed park (reverses below the cowl)</option>
    </select>
  </div>
</div>

<style>
  .kind { padding: 0 10px 4px; font-size: 11px; margin-top: -4px; }
  .wiper { --lit: var(--st-on); transition: box-shadow 0.15s, border-color 0.15s; }
  .wiper.lit { border-color: var(--lit); box-shadow: 0 0 0 1px var(--lit), 0 0 18px color-mix(in srgb, var(--lit) 55%, transparent); }
  .onoff { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line-strong); color: var(--muted); }
  .onoff.on { background: var(--lit); border-color: var(--lit); color: #06140c; }
  .wiper {
    width: 230px;
  }
  .rows {
    padding: 6px 0 0;
  }
  .gauge {
    display: block;
    width: 100%;
    height: 76px;
    padding: 4px 10px 0;
  }
  .cowl { stroke: var(--line-strong); stroke-width: 1.5; }
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
