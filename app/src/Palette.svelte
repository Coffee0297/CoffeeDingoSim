<script>
  // Left column: scene name + Save / Load / Populate, then the component library grouped by
  // family (each with a thumbnail of its curve) and the stimulus nodes. Drag onto the canvas,
  // or press Enter / double-click to drop one in the middle of the view.
  import { scene, components, sendScene, send, api, toast, isMock } from './ws.js';
  import { addRequest } from './ui.js';
  import { BUILTIN_COMPONENTS, STIMULUS_ITEMS, groupComponents } from './scene.js';
  import { thumbnailCurve } from './chart.js';
  import Spark from './Spark.svelte';
  import Icon from './Icon.svelte';

  let filter = $state('');
  let fileInput;
  let open = $state({ Lighting: true, Stimulus: true });

  const list = $derived($components?.length ? $components : BUILTIN_COMPONENTS);
  const groups = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const items = q
      ? list.filter((c) => (c.name + ' ' + (c.keywords || []).join(' ') + ' ' + (c.presets || []).map((p) => p.name).join(' ')).toLowerCase().includes(q))
      : list;
    return groupComponents(items);
  });
  const stimulus = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return q ? STIMULUS_ITEMS.filter((s) => (s.name + ' ' + s.hint).toLowerCase().includes(q)) : STIMULUS_ITEMS;
  });

  function dragStart(e, spec) {
    e.dataTransfer.setData('application/x-cds', JSON.stringify(spec));
    e.dataTransfer.effectAllowed = 'copy';
  }
  const specOf = (c) => ({ type: 'load', component: c.id, preset: c.presets?.[0]?.name ?? null });

  export async function save() {
    const s = $scene;
    if (!s) return;
    try {
      const r = await api('/api/scene', { method: 'POST', body: s });
      toast('info', `Saved ${r?.path || s.name}`);
    } catch (err) {
      toast('error', `Save failed: ${err.message}. Is the server running?`);
    }
  }
  function rename(name) {
    if (!$scene) return;
    sendScene({ ...$scene, name: name.trim() || 'untitled' });
  }
  async function loadFile(e) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!Array.isArray(s.modules) || !Array.isArray(s.nodes) || !Array.isArray(s.edges)) throw new Error('not a scene.sim.json (modules, nodes, edges missing)');
      sendScene(s);
      toast('info', `Loaded ${s.name || f.name}`);
    } catch (err) {
      toast('error', `Load failed: ${err.message}`);
    }
    e.currentTarget.value = '';
  }
  function populate() {
    send({ type: 'populate', projectPath: $scene?.project?.path ?? '' });
  }
</script>

<aside class="palette">
  <section class="scene">
    <label class="name">
      <span class="muted">Scene</span>
      <input class="input" value={$scene?.name ?? ''} disabled={!$scene} onchange={(e) => rename(e.currentTarget.value)} aria-label="Scene name" />
    </label>
    <div class="actions">
      <button class="btn sm primary" onclick={save} disabled={!$scene} title="Save to scenes/<name>/scene.sim.json (Ctrl+S)">Save</button>
      <button class="btn sm" onclick={() => fileInput.click()}>Load…</button>
      <button class="btn sm" onclick={populate} disabled={!$scene} title="Create sized loads, knobs and switches from the project's output names">Populate from project</button>
      <input type="file" accept=".json,application/json" bind:this={fileInput} onchange={loadFile} hidden />
    </div>
    {#if $scene?.project?.path}<div class="proj faint" title={$scene.project.path}>{$scene.project.path.split(/[\\/]/).pop()}</div>{/if}
  </section>

  <input class="input search" type="search" placeholder="Find a component" bind:value={filter} aria-label="Find a component" />

  <div class="lib">
    <details open={open.Stimulus || !!filter} ontoggle={(e) => (open.Stimulus = e.currentTarget.open)}>
      <summary>Stimulus and vehicle <span class="faint">{stimulus.length}</span></summary>
      {#each stimulus as s}
        <div class="item" draggable="true" role="button" tabindex="0" title={s.hint}
          ondragstart={(e) => dragStart(e, { type: s.type })}
          ondblclick={() => addRequest.set({ type: s.type })}
          onkeydown={(e) => e.key === 'Enter' && addRequest.set({ type: s.type })}>
          <span class="ic"><Icon name={s.icon} /></span>
          <span class="txt"><span class="nm">{s.name}</span><span class="sub faint">{s.hint}</span></span>
        </div>
      {/each}
    </details>

    {#each groups as g (g.group)}
      <details open={open[g.group] || !!filter} ontoggle={(e) => (open[g.group] = e.currentTarget.open)}>
        <summary>{g.group} <span class="faint">{g.items.length}</span></summary>
        {#each g.items as c (c.id)}
          <div class="item" draggable="true" role="button" tabindex="0"
            title={`${c.name} (${c.family}). Drag onto the canvas.`}
            ondragstart={(e) => dragStart(e, specOf(c))}
            ondblclick={() => addRequest.set(specOf(c))}
            onkeydown={(e) => e.key === 'Enter' && addRequest.set(specOf(c))}>
            <span class="ic" class:fault={!!c.fault}><Icon name={c.icon} /></span>
            <span class="txt">
              <span class="nm">{c.name}</span>
              <span class="sub faint">{(c.presets || []).map((p) => p.name).slice(0, 3).join(', ')}{(c.presets || []).length > 3 ? '…' : ''}</span>
            </span>
            <Spark getPoints={() => thumbnailCurve(c.family)} width={44} height={22} color={c.fault ? '--st-fault' : '--trace-model'} />
          </div>
        {/each}
      </details>
    {/each}
    {#if !groups.length && !stimulus.length}<p class="none muted">Nothing matches “{filter}”.</p>{/if}
  </div>
  {#if isMock}<div class="mock faint">Mock mode: no server, simulated data.</div>{/if}
</aside>

<style>
  .palette {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--panel);
    border-right: 1px solid var(--line);
  }
  .scene {
    padding: 12px;
    border-bottom: 1px solid var(--line);
    display: grid;
    gap: 8px;
  }
  .name {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    align-items: center;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .proj {
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .search {
    margin: 10px 12px 6px;
  }
  .lib {
    flex: 1;
    overflow-y: auto;
    padding: 0 6px 12px;
  }
  details {
    margin-top: 4px;
  }
  summary {
    padding: 6px 6px;
    font-weight: 600;
    cursor: pointer;
    list-style-position: inside;
    border-radius: var(--r-s);
  }
  summary:hover {
    background: var(--raised);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px;
    border-radius: var(--r-m);
    cursor: grab;
  }
  .item:hover,
  .item:focus-visible {
    background: var(--raised);
    outline: none;
  }
  .item:focus-visible {
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .ic {
    display: inline-flex;
    color: var(--accent);
    flex: none;
  }
  .ic.fault {
    color: var(--st-fault);
  }
  .txt {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .nm {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .none {
    padding: 8px;
  }
  .mock {
    padding: 8px 12px;
    border-top: 1px solid var(--line);
    font-size: 11px;
  }
</style>
