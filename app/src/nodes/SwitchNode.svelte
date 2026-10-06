<script>
  // Switch → digital input (`contact` source). toggle: click flips; momentary: held while pressed;
  // 3pos: state 0 | 1 | 2 (0 = centre/open). Every change is an immediate `switch` action.
  import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
  import { action } from '../ws.js';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();

  function set(state) {
    updateNodeData(id, { state });
    action({ kind: 'switch', node: id, state });
  }
  function setKind(kind) {
    updateNodeData(id, { kind, state: kind === '3pos' ? 0 : false });
    action({ kind: 'switch', node: id, state: kind === '3pos' ? 0 : false });
  }
  const on = $derived(data.kind === '3pos' ? data.state !== 0 : !!data.state);
</script>

<div class="node switch" class:selected>
  <div class="node-head">
    <span>Switch</span><span class="spacer"></span>
    <span class="state-dot" class:bool-on={on}></span>
  </div>
  <div class="node-controls nodrag">
    <select class="input" value={data.kind} onchange={(e) => setKind(e.currentTarget.value)} aria-label="Switch type">
      <option value="toggle">Toggle</option><option value="momentary">Momentary</option><option value="3pos">3-position</option>
    </select>
    <select class="input" value={data.level} onchange={(e) => updateNodeData(id, { level: e.currentTarget.value })} aria-label="Switching level">
      <option value="12v">Switches 12 V</option><option value="gnd">Switches ground</option>
    </select>
  </div>
  <div class="control nodrag">
    {#if data.kind === 'toggle'}
      <button class="lever" class:on={data.state} onclick={() => set(!data.state)} aria-pressed={!!data.state}>
        <span class="knob"></span><span class="txt">{data.state ? 'On' : 'Off'}</span>
      </button>
    {:else if data.kind === 'momentary'}
      <button class="push" class:on={data.state}
        onpointerdown={() => set(true)} onpointerup={() => data.state && set(false)} onpointerleave={() => data.state && set(false)}
        onkeydown={(e) => (e.key === ' ' || e.key === 'Enter') && !data.state && set(true)}
        onkeyup={(e) => (e.key === ' ' || e.key === 'Enter') && set(false)}>
        {data.state ? 'Held' : 'Hold to press'}
      </button>
    {:else}
      <div class="three" role="radiogroup" aria-label="Position">
        {#each ['A', 'Off', 'B'] as label, i}
          {@const v = i === 0 ? 1 : i === 1 ? 0 : 2}
          <button class:on={data.state === v} role="radio" aria-checked={data.state === v} onclick={() => set(v)}>{label}</button>
        {/each}
      </div>
    {/if}
  </div>
  <Handle type="source" position={Position.Right} id="contact" class="handle-out" />
</div>

<style>
  .switch {
    width: 190px;
  }
  .control {
    padding: 4px 10px 10px;
  }
  .lever {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 4px;
    border-radius: 999px;
    border: 1px solid var(--line-strong);
    background: var(--sunken);
    cursor: pointer;
  }
  .lever .knob {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--faint);
    transition: transform 0.12s ease, background 0.12s;
  }
  .lever.on .knob {
    background: var(--st-on);
    transform: translateX(118px);
  }
  .lever .txt {
    font-weight: 600;
  }
  .lever.on .txt {
    order: -1;
    margin-left: 8px;
  }
  .lever.on .knob {
    transform: none;
    margin-left: auto;
  }
  .push {
    width: 100%;
    padding: 8px;
    border-radius: var(--r-m);
    border: 1px solid var(--line-strong);
    background: var(--raised);
    cursor: pointer;
    font-weight: 600;
    user-select: none;
  }
  .push.on {
    background: var(--st-on);
    color: #08140d;
    border-color: var(--st-on);
  }
  .three {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-m);
    overflow: hidden;
  }
  .three button {
    padding: 6px 0;
    border: none;
    background: var(--sunken);
    cursor: pointer;
  }
  .three button + button {
    border-left: 1px solid var(--line-strong);
  }
  .three button.on {
    background: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
  }
</style>
