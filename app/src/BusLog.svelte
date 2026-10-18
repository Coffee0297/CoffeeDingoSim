<script>
  // Bus tab: the last 200 frames the server forwards (`bus` messages, at most 20 a second: a sample of the bus, the
  // frames left out are counted and shown as a "skipped" row), each with the vehicle time and the module it belongs to
  // by base ID (config TX/RX or cyclic message n). Newest first by default; Oldest first reads like a trace.
  import { bus, scene } from './ws.js';

  let paused = $state(false);
  let filter = $state('');
  let oldestFirst = $state(false);
  let frozen = $state([]);

  const frames = $derived(paused ? frozen : $bus);
  function togglePause() {
    if (!paused) frozen = $bus.slice();
    paused = !paused;
  }

  function owner(id) {
    for (const m of $scene?.modules || []) {
      const d = id - m.baseId;
      const msgs = m.kind === 'canboard' ? 10 : 28;
      if (d === 0) return `${m.id} config TX`;
      if (d === 1) return `${m.id} config RX`;
      if (d >= 2 && d < 2 + msgs) return `${m.id} Msg${d - 2}`;
    }
    return '';
  }
  const hex = (v, w = 3) => Number(v).toString(16).toUpperCase().padStart(w, '0');
  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const list = (q ? frames.filter((f) => (hex(f.id) + ' ' + owner(f.id)).toLowerCase().includes(q)) : frames).slice();
    return oldestFirst ? list : list.reverse();
  });
</script>

<div class="buslog">
  <div class="bar">
    <input class="input" type="search" placeholder="Filter by ID or module" bind:value={filter} aria-label="Filter frames" />
    <button class="btn sm" class:on={oldestFirst} onclick={() => (oldestFirst = !oldestFirst)} aria-pressed={oldestFirst}>Oldest first</button>
    <button class="btn sm" class:on={paused} onclick={togglePause} aria-pressed={paused}>{paused ? 'Resume' : 'Pause'}</button>
    <button class="btn sm" onclick={() => bus.set([])}>Clear</button>
  </div>
  <div class="scroll">
    <table>
      <thead><tr><th>Time</th><th>Dir</th><th>ID</th><th>Source</th><th>DLC</th><th>Data</th></tr></thead>
      <tbody>
        {#each shown as f (f.seq)}
          {#if f.skipped && oldestFirst && !filter}<tr class="gap"><td colspan="6">… {f.skipped} frame{f.skipped === 1 ? '' : 's'} not shown …</td></tr>{/if}
          <tr>
            <td class="mono t">{f.at == null ? '' : f.at.toFixed(1) + ' s'}</td>
            <td class="dir" data-d={f.dir}>{f.dir === 'tx' ? 'TX' : 'RX'}</td>
            <td class="mono">{hex(f.id, f.id > 0x7ff ? 8 : 3)}</td>
            <td class="src">{owner(f.id)}</td>
            <td class="mono">{f.dlc}</td>
            <td class="mono data">{(f.data || []).map((b) => hex(b, 2)).join(' ')}</td>
          </tr>
          {#if f.skipped && !oldestFirst && !filter}<tr class="gap"><td colspan="6">… {f.skipped} frame{f.skipped === 1 ? '' : 's'} not shown …</td></tr>{/if}
        {/each}
      </tbody>
    </table>
    {#if !shown.length}<p class="hint">{filter ? 'No frames match.' : 'No frames yet. Frames appear while Renode is running.'}</p>{/if}
  </div>
  <div class="foot faint">{frames.length} of 200 frames kept, {oldestFirst ? 'oldest' : 'newest'} at the top. A sample: at most 20 frames a second reach this list. Every frame with its time: record it in dingoConfig (Live › Logs › Record).</div>
</div>

<style>
  .buslog {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .bar {
    display: flex;
    gap: 6px;
    padding: 12px;
  }
  .bar .input {
    flex: 1;
  }
  .scroll {
    flex: 1;
    overflow: auto;
    min-height: 0;
    padding: 0 12px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    position: sticky;
    top: 0;
    background: var(--panel);
    color: var(--muted);
    font-weight: 500;
    text-align: left;
    padding: 4px 6px;
  }
  td {
    padding: 2px 6px;
    border-top: 1px solid var(--line);
    white-space: nowrap;
  }
  .mono {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .data {
    color: var(--muted);
  }
  .src {
    color: var(--muted);
  }
  .t {
    color: var(--muted);
  }
  .gap td {
    color: var(--muted);
    font-style: italic;
    text-align: center;
  }
  .dir[data-d='tx'] {
    color: var(--accent);
  }
  .hint {
    color: var(--muted);
  }
  .foot {
    padding: 6px 12px;
    border-top: 1px solid var(--line);
    font-size: 11px;
  }
</style>
