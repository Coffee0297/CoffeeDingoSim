<script>
  // Layout: top bar, palette (left), canvas (centre), side panel with Chart / Renode / Runs / Bus
  // tabs (right), toasts. Keyboard: Delete removes the selection (Svelte Flow), Ctrl+S saves.
  import { SvelteFlowProvider } from '@xyflow/svelte';
  import { connection, renode, toasts, dismissToast, isMock } from './ws.js';
  import { sideTab, theme, toggleTheme } from './ui.js';
  import { fmtT } from './chart.js';
  import Palette from './Palette.svelte';
  import Canvas from './Canvas.svelte';
  import SideChart from './SideChart.svelte';
  import RenodePanel from './RenodePanel.svelte';
  import RunsPanel from './RunsPanel.svelte';
  import BusLog from './BusLog.svelte';

  let palette;
  const TABS = [
    { id: 'chart', label: 'Chart' },
    { id: 'renode', label: 'Renode' },
    { id: 'runs', label: 'Runs' },
    { id: 'bus', label: 'Bus' },
  ];
  const CONN = { open: 'Server connected', connecting: 'Connecting to server', closed: 'Server offline, retrying', mock: 'Mock data' };

  function onkeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      palette?.save();
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="app">
  <header class="top">
    <div class="brand">
      <span class="mark" aria-hidden="true"></span>
      <span class="title">CoffeeDingoSim</span>
    </div>
    <span class="pill conn" data-c={$connection}><span class="dot"></span>{CONN[$connection]}</span>
    <span class="spacer"></span>
    <span class="run" data-s={$renode.status}>
      <span class="state-dot" data-state={$renode.status === 'running' ? 'On' : $renode.status === 'error' ? 'Fault' : $renode.status === 'paused' ? 'Warning' : 'Off'}></span>
      Renode {$renode.status}
      <b class="num">{fmtT($renode.vtime)}</b>
    </span>
    <button class="btn sm" onclick={toggleTheme} title="Switch between dark and light">{$theme === 'dark' ? 'Light theme' : 'Dark theme'}</button>
  </header>

  <SvelteFlowProvider>
    <div class="main">
      <div class="left"><Palette bind:this={palette} /></div>
      <main class="centre"><Canvas /></main>
      <aside class="right">
        <div class="tabs" role="tablist">
          {#each TABS as t}
            <button role="tab" aria-selected={$sideTab === t.id} class:active={$sideTab === t.id} onclick={() => sideTab.set(t.id)}>{t.label}</button>
          {/each}
        </div>
        <div class="panel" role="tabpanel">
          {#if $sideTab === 'chart'}<SideChart />
          {:else if $sideTab === 'renode'}<RenodePanel />
          {:else if $sideTab === 'runs'}<RunsPanel />
          {:else}<BusLog />{/if}
        </div>
      </aside>
    </div>
  </SvelteFlowProvider>

  <div class="toasts" aria-live="polite">
    {#each $toasts as t (t.id)}
      <div class="toast" data-level={t.level}>
        <span>{t.text}</span>
        <button onclick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
      </div>
    {/each}
  </div>
</div>

<style>
  .app {
    display: grid;
    grid-template-rows: var(--topbar-h) 1fr;
    height: 100%;
  }
  .top {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .mark {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    background: conic-gradient(var(--st-on) 0 25%, var(--st-oc) 0 50%, var(--st-ol) 0 75%, var(--accent) 0);
  }
  .title {
    font-weight: 700;
    font-size: 14px;
    letter-spacing: -0.005em;
  }
  .conn[data-c='open'] .dot,
  .conn[data-c='mock'] .dot {
    background: var(--st-on);
  }
  .conn[data-c='mock'] .dot {
    background: var(--st-ol);
  }
  .conn[data-c='closed'] .dot {
    background: var(--st-fault);
  }
  .spacer {
    flex: 1;
  }
  .run {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
  }
  .run b {
    color: var(--ink);
    min-width: 52px;
  }
  .main {
    display: grid;
    grid-template-columns: var(--palette-w) 1fr var(--side-w);
    min-height: 0;
  }
  .left,
  .centre,
  .right {
    min-height: 0;
    min-width: 0;
  }
  .centre {
    position: relative;
  }
  .right {
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border-left: 1px solid var(--line);
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 0 8px;
    border-bottom: 1px solid var(--line);
  }
  .tabs button {
    padding: 10px 12px 9px;
    border: none;
    background: none;
    color: var(--muted);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tabs button:hover {
    color: var(--ink);
  }
  .tabs button.active {
    color: var(--ink);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .panel {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .toasts {
    position: fixed;
    right: calc(var(--side-w) + 16px);
    bottom: 16px;
    display: grid;
    gap: 8px;
    z-index: 50;
    max-width: 380px;
  }
  .toast {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 9px 12px;
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-left: 3px solid var(--st-ol);
    border-radius: var(--r-m);
    box-shadow: var(--shadow);
  }
  .toast[data-level='warn'] {
    border-left-color: var(--st-warn);
  }
  .toast[data-level='error'] {
    border-left-color: var(--st-fault);
  }
  .toast span {
    flex: 1;
  }
  .toast button {
    border: none;
    background: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 15px;
    line-height: 1;
  }
  @media (max-width: 1100px) {
    .main {
      grid-template-columns: 220px 1fr 340px;
    }
    .toasts {
      right: 356px;
    }
  }
  @media (max-width: 820px) {
    .main {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr 50vh;
    }
    .left {
      display: none;
    }
    .toasts {
      right: 16px;
    }
  }
</style>
