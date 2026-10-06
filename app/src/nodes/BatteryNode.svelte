<script>
  // Battery: Voc / Ri / alternator set-point (immediate `battery` actions), live V under load and
  // total A from the traces. Supply to every module is implicit; `alt` takes the engine alternator.
  import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
  import { action, traces, traceTick } from '../ws.js';
  import Spark from '../Spark.svelte';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();

  const last = (a) => (a && a.length ? a[a.length - 1][1] : null);
  const live = $derived.by(() => {
    $traceTick;
    const b = traces.__battery;
    return { v: last(b?.v), a: last(b?.a) };
  });

  function set(field, raw, scale = 1) {
    const v = Number(raw) * scale;
    if (!Number.isFinite(v)) return;
    updateNodeData(id, { [field]: v });
    action({ kind: 'battery', node: id, [field]: v });
  }
</script>

<div class="node battery" class:selected>
  <Handle type="target" position={Position.Left} id="alt" />
  <div class="node-head"><span>Battery</span><span class="spacer"></span><span class="faint">feeds every module</span></div>
  <div class="big">
    <div><span class="num v">{live.v != null ? live.v.toFixed(2) : '—'}</span><span class="u">V</span></div>
    <div><span class="num a">{live.a != null ? live.a.toFixed(1) : '—'}</span><span class="u">A total</span></div>
  </div>
  <div class="spark"><Spark getPoints={() => traces.__battery?.v || []} live={true} width={206} height={26} color="--st-on" floorMax={0} /></div>
  <div class="fields nodrag">
    <label>Open-circuit <input class="input num" type="number" step="0.1" min="0" value={data.vocV} onchange={(e) => set('vocV', e.currentTarget.value)} /> V</label>
    <label>Internal R <input class="input num" type="number" step="1" min="0" value={Math.round((data.riOhm || 0) * 1000)} onchange={(e) => set('riOhm', e.currentTarget.value, 0.001)} /> mΩ</label>
    <label>Alternator <input class="input num" type="number" step="0.1" min="0" value={data.altV} onchange={(e) => set('altV', e.currentTarget.value)} /> V</label>
  </div>
</div>

<style>
  .battery {
    width: 230px;
  }
  .big {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 8px 12px 2px;
  }
  .v {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .a {
    font-size: 16px;
    font-weight: 600;
  }
  .u {
    margin-left: 3px;
    color: var(--muted);
  }
  .spark {
    padding: 2px 12px 6px;
  }
  .fields {
    display: grid;
    gap: 4px;
    padding: 2px 10px 10px;
  }
  .fields label {
    display: grid;
    grid-template-columns: 1fr 64px 26px;
    gap: 6px;
    align-items: center;
    color: var(--muted);
  }
</style>
