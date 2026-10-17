<script>
  // CAN generator: frames from a DBC, one slider per signal (its own range from the DBC). Values are scene data
  // (the server broadcasts the frames at their cycle times), so edits go through the debounced scene update.
  // Load DBC… uploads a file into the scene folder (POST /api/dbc); its messages are offered as frames to send.
  import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();

  const RANGES = { RPM: 8000, TPS: 100, CLT: 130, OilP: 10, Speed: 250, Gear: 6 };
  const hex = (v) => '0x' + Number(v).toString(16).toUpperCase();
  let messages = $state([]), err = $state(''), q = $state(''), busy = $state(false), fileEl;

  // the DBC the node points at: its messages (for the picker and the slider ranges)
  $effect(() => {
    const p = data.dbc;
    if (!p) { messages = []; return; }
    fetch('/api/dbc?path=' + encodeURIComponent(p)).then((r) => r.json()).then((j) => { messages = j.messages ?? []; err = j.error ?? ''; }).catch((e) => (err = e.message));
  });
  const msgOf = (fid) => messages.find((m) => m.id === fid);
  const sigOf = (fid, name) => msgOf(fid)?.signals.find((s) => s.name === name);
  function range(fid, name, v) {
    const s = sigOf(fid, name);
    if (s && s.max > s.min) return { min: s.min, max: s.max, step: s.factor || 1 };
    return { min: 0, max: RANGES[name] ?? Math.max(255, Math.ceil(Math.abs(v) * 2)), step: 1 };
  }
  const label = (fid, name, v) => sigOf(fid, name)?.values?.[v] ?? '';

  async function upload(e) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    busy = true; err = '';
    try {
      const r = await fetch('/api/dbc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, text: await f.text() }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `upload failed (${r.status})`);
      messages = j.messages;
      updateNodeData(id, { dbc: j.path, frames: (data.frames || []).filter((fr) => j.messages.some((m) => m.id === fr.id)) });
    } catch (x) { err = x.message; } finally { busy = false; }
  }
  const hits = $derived(q.trim() ? messages.filter((m) => `${m.name} ${hex(m.id)} ${m.signals.map((s) => s.name).join(' ')}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 40) : [])
  function addFrame(m) {
    if ((data.frames || []).some((f) => f.id === m.id)) return;
    const signals = Object.fromEntries(m.signals.map((s) => [s.name, Math.min(Math.max(0, s.min), s.max > s.min ? s.max : 0)]));
    updateNodeData(id, { frames: [...(data.frames || []), { id: m.id, cycleMs: 100, signals }] });
    q = '';
  }
  const removeFrame = (fi) => updateNodeData(id, { frames: (data.frames || []).filter((_, i) => i !== fi) });
  function setSignal(fi, name, value) {
    const frames = (data.frames || []).map((f, i) => (i === fi ? { ...f, signals: { ...f.signals, [name]: Number(value) } } : f));
    updateNodeData(id, { frames });
  }
  function setCycle(fi, value) {
    const frames = (data.frames || []).map((f, i) => (i === fi ? { ...f, cycleMs: Number(value) } : f));
    updateNodeData(id, { frames });
  }
</script>

<div class="node cangen" class:selected>
  <Handle type="source" position={Position.Left} id="supply" class="handle-out" title="Power (optional): wire it to a module output and it sends only while that output is on" />
  <div class="node-head"><span>{data.name || 'CAN generator'}</span><span class="spacer"></span><span class="faint" title={data.dbc || ''}>{(data.dbc || 'no DBC').split('/').pop()}</span></div>
  <div class="load nodrag">
    <button class="btn sm" disabled={busy} onclick={() => fileEl.click()}>{busy ? 'Loading…' : data.dbc ? 'Load another DBC…' : 'Load DBC…'}</button>
    <input bind:this={fileEl} type="file" accept=".dbc" hidden onchange={upload} />
    {#if messages.length}<span class="faint">{messages.length} frames</span>{/if}
  </div>
  {#if err}<div class="err">{err}</div>{/if}
  {#if messages.length}
    <div class="pick nodrag">
      <input class="input" type="search" placeholder="Add a frame: search name, id or signal" bind:value={q} />
      {#each hits as m (m.id)}
        <button class="hit" onclick={() => addFrame(m)}><span class="num">{hex(m.id)}</span> {m.name} <span class="faint">· {m.signals.length} signals</span></button>
      {/each}
    </div>
  {/if}
  {#each data.frames || [] as f, fi (f.id)}
    <div class="frame">
      <div class="fhead">
        <span><span class="num">{hex(f.id)}</span> <span class="faint">{msgOf(f.id)?.name ?? ''}</span></span>
        <span class="nodrag muted">every <input class="input num" type="number" min="1" value={f.cycleMs} onchange={(e) => setCycle(fi, e.currentTarget.value)} /> ms
          <button class="x" title="Stop sending this frame" aria-label="Remove frame" onclick={() => removeFrame(fi)}>✕</button></span>
      </div>
      {#each Object.entries(f.signals || {}) as [name, v] (name)}
        {@const r = range(f.id, name, v)}
        <div class="sig nodrag">
          <span class="sname" title={name}>{name}</span>
          <input type="range" min={r.min} max={r.max} step={r.step} value={v} oninput={(e) => setSignal(fi, name, e.currentTarget.value)} aria-label={name} />
          <span class="num val" title={sigOf(f.id, name)?.unit ?? ''}>{v}{label(f.id, name, v) ? ' ' + label(f.id, name, v) : ''}</span>
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .cangen {
    width: 290px;
  }
  .load {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
  }
  .err {
    padding: 0 10px 6px;
    color: var(--st-fault, #ff4d5e);
  }
  .pick {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 10px 6px;
    max-height: 220px;
    overflow: auto;
  }
  .pick .input {
    width: 100%;
    margin-bottom: 4px;
  }
  .hit {
    text-align: left;
    padding: 3px 6px;
    border-radius: var(--r-s);
    border: 1px solid transparent;
    background: var(--sunken);
    cursor: pointer;
  }
  .hit:hover {
    border-color: var(--line-strong);
  }
  .frame {
    padding: 6px 10px 8px;
  }
  .frame + .frame,
  .pick + .frame,
  .load + .frame {
    border-top: 1px solid var(--line);
  }
  .fhead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    padding-bottom: 4px;
    font-weight: 600;
  }
  .fhead .input {
    width: 56px;
  }
  .x {
    border: 0;
    background: transparent;
    cursor: pointer;
    color: var(--muted);
  }
  .sig {
    display: grid;
    grid-template-columns: 88px 1fr 56px;
    gap: 6px;
    align-items: center;
  }
  .sname {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .val {
    text-align: right;
  }
</style>
