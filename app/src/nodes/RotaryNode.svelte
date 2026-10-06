<script>
  // Rotary knob → CANBoard analog input (`wiper` source). Positions and mV come from the project's
  // ladder; picking one sends an immediate `rotary` action.
  import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
  import { action } from '../ws.js';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();

  const positions = $derived(data.positions || []);
  const idx = $derived(Math.min(Math.max(0, data.index || 0), Math.max(0, positions.length - 1)));
  const SWEEP = 270;
  const angleOf = (i) => (positions.length <= 1 ? 0 : -SWEEP / 2 + (SWEEP * i) / (positions.length - 1));

  function pick(i) {
    if (i < 0 || i >= positions.length) return;
    updateNodeData(id, { index: i });
    action({ kind: 'rotary', node: id, index: i });
  }
  function onwheel(e) {
    e.preventDefault();
    pick(idx + (e.deltaY > 0 ? 1 : -1));
  }
  const pt = (deg, r) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [50 + r * Math.cos(a), 50 + r * Math.sin(a)];
  };
</script>

<div class="node rotary" class:selected>
  <div class="node-head"><span>Rotary knob</span><span class="spacer"></span><span class="pos">{positions[idx]?.name ?? '—'}</span></div>
  <div class="body nodrag nowheel">
    <svg viewBox="0 0 100 100" class="dial" {onwheel} role="slider" tabindex="0" aria-valuemin="0" aria-valuemax={positions.length - 1}
      aria-valuenow={idx} aria-valuetext={positions[idx]?.name}
      onkeydown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowUp') pick(idx + 1); if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') pick(idx - 1); }}>
      {#each positions as p, i}
        {@const [x1, y1] = pt(angleOf(i), 40)}
        {@const [x2, y2] = pt(angleOf(i), 46)}
        <line {x1} {y1} {x2} {y2} class="tick" class:on={i === idx} />
      {/each}
      <circle cx="50" cy="50" r="30" class="cap" />
      {#if positions.length}
        {@const [px, py] = pt(angleOf(idx), 24)}
        <line x1="50" y1="50" x2={px} y2={py} class="pointer" />
      {/if}
    </svg>
    <ol class="names">
      {#each positions as p, i}
        <li><button class:on={i === idx} onclick={() => pick(i)}><span>{p.name}</span><span class="num faint">{p.mV} mV</span></button></li>
      {/each}
    </ol>
  </div>
  <Handle type="source" position={Position.Right} id="wiper" class="handle-out" />
</div>

<style>
  .rotary {
    width: 250px;
  }
  .pos {
    color: var(--accent);
  }
  .body {
    display: flex;
    gap: 8px;
    padding: 8px 10px 10px;
    align-items: center;
  }
  .dial {
    width: 92px;
    height: 92px;
    flex: none;
    cursor: ns-resize;
  }
  .dial:focus-visible {
    outline: 2px solid var(--accent);
    border-radius: 50%;
  }
  .tick {
    stroke: var(--line-strong);
    stroke-width: 3;
    stroke-linecap: round;
  }
  .tick.on {
    stroke: var(--accent);
  }
  .cap {
    fill: var(--raised);
    stroke: var(--line-strong);
    stroke-width: 1.5;
  }
  .pointer {
    stroke: var(--ink);
    stroke-width: 4;
    stroke-linecap: round;
    transition: all 0.15s ease;
  }
  .names {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1;
    min-width: 0;
  }
  .names button {
    display: flex;
    justify-content: space-between;
    width: 100%;
    padding: 1px 6px;
    border: none;
    border-radius: var(--r-s);
    background: none;
    cursor: pointer;
    text-align: left;
  }
  .names button.on {
    background: var(--accent-soft);
    font-weight: 600;
  }
  .names button:hover {
    background: var(--raised);
  }
</style>
