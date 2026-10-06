<script>
  // CAN generator: one slider per DBC signal of each frame. Values are scene data (the server
  // broadcasts the frames at their cycle times), so edits go through the debounced scene update.
  import { useSvelteFlow } from '@xyflow/svelte';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();

  const RANGES = { RPM: 8000, TPS: 100, CLT: 130, OilP: 10, Speed: 250, Gear: 6 };
  const maxOf = (name, v) => RANGES[name] ?? Math.max(255, Math.ceil(Math.abs(v) * 2));
  const hex = (v) => '0x' + Number(v).toString(16).toUpperCase();

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
  <div class="node-head"><span>CAN generator</span><span class="spacer"></span><span class="faint">{(data.dbc || '').split('/').pop()}</span></div>
  {#each data.frames || [] as f, fi}
    <div class="frame">
      <div class="fhead">
        <span class="num">{hex(f.id)}</span>
        <label class="nodrag muted">every <input class="input num" type="number" min="1" value={f.cycleMs} onchange={(e) => setCycle(fi, e.currentTarget.value)} /> ms</label>
      </div>
      {#each Object.entries(f.signals || {}) as [name, v]}
        <div class="sig nodrag">
          <span class="sname">{name}</span>
          <input type="range" min="0" max={maxOf(name, v)} step="1" value={v} oninput={(e) => setSignal(fi, name, e.currentTarget.value)} aria-label={name} />
          <span class="num val">{v}</span>
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .cangen {
    width: 250px;
  }
  .frame {
    padding: 6px 10px 8px;
  }
  .frame + .frame {
    border-top: 1px solid var(--line);
  }
  .fhead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: 4px;
    font-weight: 600;
  }
  .fhead .input {
    width: 56px;
  }
  .sig {
    display: grid;
    grid-template-columns: 52px 1fr 44px;
    gap: 6px;
    align-items: center;
  }
  .sname {
    color: var(--muted);
  }
  .val {
    text-align: right;
  }
</style>
