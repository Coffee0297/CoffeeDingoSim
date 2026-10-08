<script>
  // PWM source → digital input (`out` source), for an input in PWM mode. Duty = % of each period the
  // source is active: a 12 V source drives the pin high, a ground source (open collector against the
  // input's pull-up) pulls it low. Each change is a `pwm` action; the bank flips the pin at exact
  // virtual times (renode/models/ProfetLoadBank.cs ApplyPwm).
  import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
  import { action, scene } from '../ws.js';
  import { wiredInput } from '../scene.js';
  import EditableTitle from './EditableTitle.svelte';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();

  const duty = $derived(data.duty ?? 50);
  const freq = $derived(data.freq ?? 100);
  const on = $derived(data.on ?? true);
  const wired = $derived(wiredInput($scene?.edges, id));
  // the simulator takes edges into an idle CPU on its sync quantum (250 us in a scene with a PWM source,
  // globals.quantumUs to change), so each edge is good to about one quantum: +-quantum x freq of duty
  // (README sharp edge 19). Hardware is exact.
  const quantumUs = $derived(Number($scene?.globals?.quantumUs) > 0 ? Number($scene.globals.quantumUs) : 250);
  const resPct = $derived((quantumUs * freq) / 1e4);

  function set(patch) {
    updateNodeData(id, patch);
    action({ kind: 'pwm', node: id, ...patch });
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  // waveform preview: one period at the chosen duty
  const wave = $derived.by(() => {
    const x = 4 + (on ? duty : 0) * 1.52;
    return `M4 22 V6 H${x} V22 H156`;
  });
</script>

<div class="node pwmsrc" class:selected>
  <div class="node-head">
    <EditableTitle value={data.name} placeholder="PWM source" onsave={(v) => updateNodeData(id, { name: v })} />
    <span class="spacer"></span>
    <span class="state-dot" class:bool-on={on && duty > 0}></span>
  </div>
  <div class="wired faint">{wired ? `PWM → ${wired}` : 'PWM, not wired'}</div>
  <svg class="wave" viewBox="0 0 160 26" aria-hidden="true"><path d={wave} /></svg>
  <div class="node-controls nodrag">
    <label class="row"><span>Duty</span>
      <input type="range" min="0" max="100" step="1" value={duty} aria-label="Duty cycle"
        oninput={(e) => updateNodeData(id, { duty: +e.currentTarget.value })}
        onchange={(e) => set({ duty: +e.currentTarget.value })} />
      <b class="num">{duty}%</b></label>
    <label class="row"><span>Freq</span>
      <input class="input" type="number" min="1" max="10000" value={freq} aria-label="Frequency (Hz)"
        onchange={(e) => set({ freq: clamp(e.currentTarget.value, 1, 10000) })} />
      <span class="faint">Hz</span></label>
    <select class="input" value={data.level ?? '12v'} onchange={(e) => set({ level: e.currentTarget.value })} aria-label="Output type">
      <option value="12v">Drives 12 V (high side)</option><option value="gnd">Pulls to ground (open collector)</option>
    </select>
    <button class="power" class:on onclick={() => set({ on: !on })} aria-pressed={on}>{on ? 'Running' : 'Stopped'}</button>
    {#if on && resPct >= 1}<div class="warn">Simulator resolution ±{resPct >= 10 ? Math.round(resPct) : resPct.toFixed(1)} % duty at {freq} Hz ({quantumUs} µs time step); exact on hardware.</div>{/if}
  </div>
  <Handle type="source" position={Position.Right} id="out" class="handle-out" />
</div>

<style>
  .pwmsrc { width: 200px; }
  .wired { padding: 0 10px 4px; font-size: 11px; margin-top: -4px; }
  .wave { display: block; width: calc(100% - 20px); margin: 0 10px 4px; height: 26px; }
  .wave path { fill: none; stroke: var(--accent); stroke-width: 2; }
  .row { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .row > span:first-child { width: 32px; }
  .row input[type='range'] { flex: 1; min-width: 0; }
  .row input[type='number'] { width: 80px; }
  .num { width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
  .power {
    width: 100%; padding: 4px; border-radius: var(--r-m); border: 1px solid var(--line-strong);
    background: var(--raised); cursor: pointer; font: inherit;
  }
  .power.on { background: var(--st-on); border-color: var(--st-on); color: var(--accent-ink); }
  .warn { font-size: 11px; color: var(--st-warn, #c58a00); line-height: 1.3; }
</style>
