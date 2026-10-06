<script>
  // Renode tab: status, Start/Stop/Pause/Resume, Run-for, per-module Reset / Sleep / Wake / temp,
  // firmware per board kind (release tag, testing-latest, local build folder), bootloader, virtual
  // time, and the Renode log tail with a filter.
  import { renode, scene, sendScene, action, api } from './ws.js';
  import { fmtT } from './chart.js';

  let runSeconds = $state(60);
  let moduleId = $state('');
  let tempC = $state(85);
  let filter = $state('');
  let autoscroll = $state(true);
  let releases = $state([]);
  let releasesErr = $state('');
  let logEl;

  $effect(() => {
    api('/api/firmware/releases')
      .then((r) => (releases = Array.isArray(r) ? r : []))
      .catch((e) => (releasesErr = e.message));
  });

  const st = $derived($renode.status);
  const mods = $derived($scene?.modules || []);
  $effect(() => {
    if (!moduleId && mods.length) moduleId = mods[0].id;
  });
  const kinds = $derived([...new Set(mods.map((m) => m.kind))].length ? ['pdm', 'pdmmax', 'canboard'] : []);
  const KIND = { pdm: 'dingoPDM', pdmmax: 'PDM-Max', canboard: 'CANBoard' };
  const used = $derived(new Set(mods.map((m) => m.kind)));

  const lines = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const all = $renode.log || [];
    return q ? all.filter((l) => l.toLowerCase().includes(q)) : all;
  });
  $effect(() => {
    lines;
    if (autoscroll && logEl) queueMicrotask(() => (logEl.scrollTop = logEl.scrollHeight));
  });

  const cmd = (c, extra = {}) => action({ kind: 'renode', cmd: c, ...extra });

  function fw(kind) {
    return $scene?.firmware?.[kind] || { source: 'release', tag: releases[0]?.tag || 'testing-latest' };
  }
  const choice = (f) => (f.source === 'local' ? 'local' : f.tag === 'testing-latest' ? 'testing' : 'release');
  function setFw(kind, patch) {
    if (!$scene) return;
    const firmware = { ...($scene.firmware || {}), [kind]: { ...fw(kind), ...patch } };
    sendScene({ ...$scene, firmware });
  }
  function setChoice(kind, c) {
    if (c === 'local') setFw(kind, { source: 'local', path: fw(kind).path || '', tag: undefined });
    else if (c === 'testing') setFw(kind, { source: 'release', tag: 'testing-latest', path: undefined });
    else setFw(kind, { source: 'release', tag: releases.find((r) => r.tag !== 'testing-latest')?.tag || fw(kind).tag, path: undefined });
  }
  function setBootloader(v) {
    if (!$scene) return;
    sendScene({ ...$scene, firmware: { ...($scene.firmware || {}), bootloader: v } });
  }
  const tags = $derived(releases.filter((r) => r.tag !== 'testing-latest'));
  const STATUS_TEXT = { stopped: 'Stopped', downloading: 'Fetching firmware', starting: 'Starting', running: 'Running', paused: 'Paused', error: 'Error' };
</script>

<div class="renode">
  <div class="status">
    <span class="pill" data-s={st}><span class="dot"></span>{STATUS_TEXT[st] || st}</span>
    <span class="vt"><span class="muted">Virtual time</span> <b class="num">{fmtT($renode.vtime)}</b></span>
  </div>

  <div class="group">
    <div class="btns">
      <button class="btn primary" onclick={() => cmd('start')} disabled={st === 'running' || st === 'starting' || st === 'downloading'}>Start</button>
      <button class="btn" onclick={() => cmd('pause')} disabled={st !== 'running'}>Pause</button>
      <button class="btn" onclick={() => cmd('resume')} disabled={st !== 'paused'}>Resume</button>
      <button class="btn danger" onclick={() => cmd('stop')} disabled={st === 'stopped'}>Stop</button>
    </div>
    <div class="line">
      <label>Run for <input class="input num" type="number" min="0.1" step="1" bind:value={runSeconds} /> s of vehicle time</label>
      <button class="btn sm" onclick={() => cmd('runfor', { seconds: Number(runSeconds) })} disabled={st === 'stopped' || st === 'error'}>Run</button>
    </div>
  </div>

  <div class="group">
    <h3>Module</h3>
    <div class="line">
      <select class="input" bind:value={moduleId} aria-label="Module">
        {#each mods as m}<option value={m.id}>{m.id}</option>{/each}
      </select>
      <button class="btn sm" onclick={() => cmd('reset', { module: moduleId })} disabled={!moduleId}>Reset</button>
      <button class="btn sm" onclick={() => cmd('sleep', { module: moduleId })} disabled={!moduleId}>Sleep</button>
      <button class="btn sm" onclick={() => cmd('wake', { module: moduleId })} disabled={!moduleId}>Wake</button>
    </div>
    <div class="line">
      <label>Board temperature <input class="input num" type="number" step="1" bind:value={tempC} /> °C</label>
      <button class="btn sm" onclick={() => action({ kind: 'temp', module: moduleId, c: Number(tempC) })} disabled={!moduleId}>Set</button>
    </div>
  </div>

  <div class="group">
    <h3>Firmware</h3>
    {#each kinds as k}
      {@const f = fw(k)}
      <div class="fw" class:unused={!used.has(k)}>
        <span class="k">{KIND[k]}</span>
        <select class="input" value={choice(f)} onchange={(e) => setChoice(k, e.currentTarget.value)} aria-label="{KIND[k]} firmware source">
          <option value="release">Release</option><option value="testing">testing-latest</option><option value="local">Local build</option>
        </select>
        {#if choice(f) === 'release'}
          <select class="input" value={f.tag} onchange={(e) => setFw(k, { tag: e.currentTarget.value })} aria-label="{KIND[k]} release tag">
            {#if !tags.some((r) => r.tag === f.tag)}<option value={f.tag}>{f.tag}</option>{/if}
            {#each tags as r}<option value={r.tag}>{r.tag}</option>{/each}
          </select>
        {:else if choice(f) === 'local'}
          <input class="input path" placeholder="C:/…/CoffeeDingoFW/build" value={f.path || ''} onchange={(e) => setFw(k, { path: e.currentTarget.value })} aria-label="{KIND[k]} local build folder" />
        {:else}
          <span class="faint">newest testing build</span>
        {/if}
      </div>
    {/each}
    {#if releasesErr}<p class="faint small">Release list unavailable ({releasesErr}).</p>{/if}
    <label class="check"><input type="checkbox" checked={!!$scene?.firmware?.bootloader} onchange={(e) => setBootloader(e.currentTarget.checked)} disabled={!$scene} /> Load the OpenBLT bootloader in sector 0</label>
    <p class="faint small">Firmware changes apply on the next Start.</p>
  </div>

  <div class="group log-group">
    <div class="line">
      <h3>Log</h3>
      <input class="input filter" type="search" placeholder="Filter" bind:value={filter} aria-label="Filter log" />
      <label class="check"><input type="checkbox" bind:checked={autoscroll} /> Follow</label>
    </div>
    <pre class="log" bind:this={logEl}>{#each lines as l}<span class:err={/error|exception|fault/i.test(l)} class:warn={/warn/i.test(l)}>{l}
</span>{/each}{#if !lines.length}<span class="faint">{filter ? 'No lines match.' : 'Renode output appears here after Start.'}</span>{/if}</pre>
  </div>
</div>

<style>
  .renode {
    display: flex;
    flex-direction: column;
    gap: 2px;
    height: 100%;
    min-height: 0;
  }
  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px;
  }
  .pill[data-s='running'] .dot {
    background: var(--st-on);
  }
  .pill[data-s='paused'] .dot {
    background: var(--st-warn);
  }
  .pill[data-s='starting'] .dot,
  .pill[data-s='downloading'] .dot {
    background: var(--st-ol);
  }
  .pill[data-s='error'] .dot {
    background: var(--st-fault);
  }
  .vt b {
    font-size: 15px;
  }
  .group {
    padding: 8px 12px 12px;
    border-top: 1px solid var(--line);
    display: grid;
    gap: 8px;
  }
  h3 {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
  }
  .btns {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .line {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }
  .line label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--muted);
  }
  .fw {
    display: grid;
    grid-template-columns: 74px 120px 1fr;
    gap: 6px;
    align-items: center;
  }
  .fw.unused {
    opacity: 0.55;
  }
  .fw .k {
    font-weight: 600;
  }
  .path {
    width: 100%;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .small {
    margin: 0;
    font-size: 11px;
  }
  .log-group {
    flex: 1;
    min-height: 180px;
    grid-template-rows: auto 1fr;
  }
  .filter {
    flex: 1;
    min-width: 80px;
  }
  .log {
    margin: 0;
    padding: 8px;
    background: var(--sunken);
    border: 1px solid var(--line);
    border-radius: var(--r-m);
    font-family: var(--mono);
    font-size: 11.5px;
    line-height: 1.45;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    min-height: 0;
  }
  .log .err {
    color: var(--st-fault);
  }
  .log .warn {
    color: var(--st-warn);
  }
</style>
