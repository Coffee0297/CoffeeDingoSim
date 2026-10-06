<script>
  // Runs tab: record start/stop, the runs list (GET /api/runs), replay, mark golden, diff a run
  // against the golden one; the diff result arrives as a `diff` message.
  import { runs, diff, send, api, toast, renode } from './ws.js';
  import { fmtT } from './chart.js';

  let recording = $state(false);
  let recStart = $state(0);
  let loading = $state(false);

  async function refresh() {
    loading = true;
    try {
      const r = await api('/api/runs');
      if (Array.isArray(r)) runs.set(r);
    } catch (e) {
      toast('warn', `Runs list unavailable: ${e.message}`);
    }
    loading = false;
  }
  $effect(() => { refresh(); });

  function toggleRecord() {
    recording = !recording;
    if (recording) recStart = $renode.vtime || 0;
    send({ type: 'record', cmd: recording ? 'start' : 'stop' });
    if (!recording) setTimeout(refresh, 400);
  }
  const rec = (cmd, run) => send({ type: 'record', cmd, run });
  const golden = $derived($runs.find((r) => r.golden)?.name ?? null);
  const nameOf = (r) => (typeof r === 'string' ? r : r.name);
  const pretty = (n) => n.replace(/\.run\.json$/, '').replace(/T(\d\d)-(\d\d)-(\d\d)/, ' $1:$2:$3');
</script>

<div class="runs">
  <div class="rec">
    <button class="btn" class:recording onclick={toggleRecord} aria-pressed={recording}>
      <span class="rdot"></span>{recording ? 'Stop recording' : 'Record'}
    </button>
    {#if recording}<span class="num muted">since {fmtT(recStart)}, now {fmtT($renode.vtime)}</span>{/if}
    <span class="spacer"></span>
    <button class="btn sm" onclick={refresh} disabled={loading}>Refresh</button>
  </div>
  <p class="hint">A run logs every action with virtual time plus the telemetry. Replays re-issue the actions at the same virtual times, so they are deterministic.</p>

  {#if !$runs.length}
    <p class="hint">No runs yet. Press Record, drive the vehicle, then stop.</p>
  {:else}
    <ul class="list">
      {#each $runs as r (nameOf(r))}
        {@const n = nameOf(r)}
        <li class:gold={n === golden}>
          <div class="meta">
            <span class="nm">{pretty(n)}</span>
            <span class="faint small">
              {r.durationS != null ? `${r.durationS} s` : ''}{r.actions != null ? `, ${r.actions} actions` : ''}
              {#if n === golden}<span class="badge info">Golden</span>{/if}
            </span>
          </div>
          <div class="acts">
            <button class="btn sm" onclick={() => rec('replay', n)}>Replay</button>
            <button class="btn sm" onclick={() => rec('golden', n)} disabled={n === golden}>Mark golden</button>
            <button class="btn sm" onclick={() => rec('diff', n)} disabled={!golden || n === golden} title={golden ? `Compare with ${pretty(golden)}` : 'Mark a golden run first'}>Diff</button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if $diff}
    <div class="diff">
      <div class="dhead">
        <strong>{pretty($diff.run || '')}</strong>
        <span class="muted">against {pretty($diff.golden || 'golden')}</span>
        <span class="spacer"></span>
        {#if $diff.summary}
          <span class="badge" class:fault={$diff.summary.fail > 0}>{$diff.summary.fail} differ</span>
          <span class="badge">{$diff.summary.pass} match</span>
        {/if}
        <button class="btn sm" onclick={() => diff.set(null)}>Close</button>
      </div>
      <table>
        <thead><tr><th>Module</th><th>Out</th><th>Metric</th><th>Golden</th><th>This run</th></tr></thead>
        <tbody>
          {#each $diff.rows || [] as row}
            <tr class:bad={!row.ok}>
              <td>{row.module}</td><td class="num">{row.output ?? ''}</td><td>{row.metric}</td>
              <td class="num">{row.expected}</td><td class="num">{row.actual}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .runs {
    padding: 12px;
    display: grid;
    gap: 10px;
  }
  .rec {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .spacer {
    flex: 1;
  }
  .rdot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--st-fault);
  }
  .recording {
    border-color: var(--st-fault);
  }
  .recording .rdot {
    animation: pulse 1s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  .hint {
    margin: 0;
    color: var(--muted);
    line-height: 1.5;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r-m);
  }
  .list li {
    padding: 8px 10px;
    display: grid;
    gap: 6px;
  }
  .list li + li {
    border-top: 1px solid var(--line);
  }
  .list li.gold {
    background: var(--accent-soft);
  }
  .meta {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: baseline;
  }
  .nm {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .small {
    font-size: 11px;
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .acts {
    display: flex;
    gap: 6px;
  }
  .diff {
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    overflow: hidden;
  }
  .dhead {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 8px 10px;
    background: var(--raised);
    flex-wrap: wrap;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th,
  td {
    text-align: left;
    padding: 5px 8px;
    border-top: 1px solid var(--line);
  }
  th {
    color: var(--muted);
    font-weight: 500;
  }
  td.num {
    text-align: right;
  }
  tr.bad td {
    color: var(--st-fault);
  }
  tr.bad td:first-child {
    box-shadow: inset 2px 0 0 var(--st-fault);
  }
</style>
