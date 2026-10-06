<script>
  // Fault overlay menu for a load (or wiper): open / short / stall / intermittent / high resistance /
  // wrong part, now or at t ms after turn-on; clear. Updates the node data and sends a `fault` action.
  import { useSvelteFlow } from '@xyflow/svelte';
  import { contextMenu } from './ui.js';
  import { action } from './ws.js';
  import { FAULT_KINDS, FAULT_LABEL } from './scene.js';

  const { updateNodeData, getNode } = useSvelteFlow();
  let when = $state('now');
  let atMs = $state(500);
  let menu = $state();

  const m = $derived($contextMenu);
  const current = $derived(m ? getNode(m.nodeId)?.data?.fault : null);

  function apply(kind) {
    const fault = kind ? { kind, atMs: when === 'at' ? Math.max(0, Number(atMs) || 0) : 0 } : null;
    updateNodeData(m.nodeId, { fault });
    action({ kind: 'fault', node: m.nodeId, fault });
    contextMenu.set(null);
  }
  function onkey(e) {
    if (e.key === 'Escape') contextMenu.set(null);
  }
  $effect(() => {
    if (m && menu) menu.querySelector('button')?.focus();
  });
</script>

<svelte:window onkeydown={onkey} />

{#if m}
  <div class="scrim" onpointerdown={() => contextMenu.set(null)} role="presentation"></div>
  <div class="menu" bind:this={menu} style:left="{Math.min(m.x, window.innerWidth - 240)}px" style:top="{Math.min(m.y, window.innerHeight - 330)}px" role="menu">
    <div class="head">Break {m.nodeId}</div>
    <div class="when">
      <label><input type="radio" bind:group={when} value="now" /> Now</label>
      <label><input type="radio" bind:group={when} value="at" /> At <input class="input num" type="number" min="0" step="50" bind:value={atMs} onfocus={() => (when = 'at')} /> ms after turn-on</label>
    </div>
    {#each FAULT_KINDS as k}
      <button role="menuitem" class:cur={current?.kind === k} onclick={() => apply(k)}>{FAULT_LABEL[k]}</button>
    {/each}
    <hr />
    <button role="menuitem" onclick={() => apply(null)} disabled={!current}>Clear fault</button>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
  }
  .menu {
    position: fixed;
    z-index: 41;
    width: 230px;
    padding: 6px;
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-l);
    box-shadow: var(--shadow);
  }
  .head {
    padding: 4px 8px 6px;
    font-weight: 600;
  }
  .when {
    display: grid;
    gap: 4px;
    padding: 2px 8px 8px;
    color: var(--muted);
    font-size: 12px;
  }
  .when label {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .when .input {
    width: 60px;
    padding: 2px 5px;
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 8px;
    border: none;
    border-radius: var(--r-s);
    background: none;
    cursor: pointer;
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--raised);
    outline: none;
  }
  button.cur {
    color: var(--st-fault);
    font-weight: 600;
  }
  button:disabled {
    color: var(--faint);
    cursor: default;
  }
  hr {
    border: none;
    border-top: 1px solid var(--line);
    margin: 4px 0;
  }
</style>
