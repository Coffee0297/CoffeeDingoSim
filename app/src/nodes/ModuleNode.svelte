<script>
  // PDM / PDM-Max / CANBoard. Rows are the module's terminal strip: one target handle per output
  // (`out:<n>`, right edge, live state dot + measured A), digital inputs `di:<n>` and CANBoard
  // analog inputs `ai:<n>` on the left, CANBoard digital outputs `do:<n>` as sources on the right,
  // plus `vbatt` and `temp` sources. Clicking an output row charts it (Canvas reads data-out).
  import { Handle, Position } from '@xyflow/svelte';
  import { modules, traces, traceTick } from '../ws.js';
  import { selection } from '../ui.js';
  import { KIND_LABEL } from '../scene.js';
  import { fmtA } from '../chart.js';

  let { id, data, selected } = $props();

  const m = $derived(data.module);
  const tel = $derived($modules[id]);
  const isCb = $derived(m.kind === 'canboard');
  const outState = (n) => tel?.outputs?.find((o) => o.n === n);
  const last = (arr) => (arr && arr.length ? arr[arr.length - 1][1] : null);
  const live = $derived.by(() => {
    $traceTick;
    const tr = traces[id];
    return {
      mV: tr?.mV?.map(last) ?? [],
      do: tr?.do?.map(last) ?? [],
      vbatt: last(tr?.vbatt) ?? tel?.vbattV ?? null,
      temp: last(tr?.temp) ?? tel?.tempC ?? null,
    };
  });
  const isActive = (n) => $selection?.kind === 'output' && $selection.machine === id && $selection.n === n;
  const hex = (v) => '0x' + Number(v || 0).toString(16).toUpperCase().padStart(3, '0');
</script>

<div class="node module" class:selected class:asleep={tel?.asleep} data-kind={m.kind}>
  <div class="node-head">
    <span class="kind">{KIND_LABEL[m.kind] || m.kind}</span>
    <span class="name">{m.id}</span>
    <span class="spacer"></span>
    {#if tel?.asleep}<span class="badge info">Asleep</span>{/if}
    <span class="base num">{hex(m.baseId)}</span>
  </div>

  <div class="node-body">
    {#if !isCb}
      <div class="node-section">Outputs</div>
      {#each m.outputs || [] as o (o.n)}
        {@const st = outState(o.n)}
        <div class="row clickable out" class:dim={!o.enabled} class:active={isActive(o.n)} data-out={o.n}
          title={o.enabled ? `limit ${o.currentLimit} A, inrush ${o.inrushCurrentLimit} A / ${o.inrushTime} ms` : 'disabled in the project'}>
          <span class="state-dot" data-state={st?.state ?? 'Off'}></span>
          <span class="label">{o.name} <span class="n">({o.n})</span></span>
          {#if o.pwmEnabled && st}<span class="val duty">{st.duty ?? 0}%</span>{/if}
          <span class="val">{st ? fmtA(st.currentA) : '—'}</span>
          <Handle type="target" position={Position.Right} id={`out:${o.n}`} />
        </div>
      {/each}
    {/if}

    {#if isCb && (m.analogIn || []).length}
      <div class="node-section">Analog inputs</div>
      {#each m.analogIn as a (a.n)}
        <div class="row" class:dim={!a.enabled}>
          <Handle type="target" position={Position.Left} id={`ai:${a.n}`} />
          <span class="label">{a.name} <span class="n">(AI{a.n})</span></span>
          <span class="pos">{tel?.positions?.[a.n - 1] ?? ''}</span>
          <span class="val">{live.mV[a.n - 1] != null ? Math.round(live.mV[a.n - 1]) + ' mV' : '—'}</span>
        </div>
      {/each}
    {/if}

    {#if (m.inputs || []).length}
      <div class="node-section">Digital inputs</div>
      {#each m.inputs as i (i.n)}
        <div class="row" class:dim={!i.enabled}>
          <Handle type="target" position={Position.Left} id={`di:${i.n}`} />
          <span class="state-dot" class:bool-on={tel?.inputs?.[i.n - 1]}></span>
          <span class="label">{i.name} <span class="n">(DI{i.n})</span></span>
        </div>
      {/each}
    {/if}

    {#if isCb && (m.digitalOut || []).length}
      <div class="node-section">Digital outputs</div>
      {#each m.digitalOut as d (d.n)}
        <div class="row" class:dim={!d.enabled}>
          <span class="state-dot" class:bool-on={live.do[d.n - 1] === 1}></span>
          <span class="label">{d.name} <span class="n">(DO{d.n})</span></span>
          <Handle type="source" position={Position.Right} id={`do:${d.n}`} class="handle-out" />
        </div>
      {/each}
    {/if}

    <div class="node-section">Board</div>
    <div class="row">
      <span class="label">Battery</span>
      <span class="val">{live.vbatt != null ? live.vbatt.toFixed(2) + ' V' : '—'}</span>
      <Handle type="source" position={Position.Right} id="vbatt" class="handle-out" />
    </div>
    <div class="row">
      <span class="label">Board temperature</span>
      <span class="val" class:hot={live.temp > 80}>{live.temp != null ? live.temp.toFixed(1) + ' °C' : '—'}</span>
      <Handle type="source" position={Position.Right} id="temp" class="handle-out" />
    </div>
  </div>
</div>

<style>
  .module {
    width: 290px;
    border-color: var(--line-strong);
  }
  .module.asleep {
    opacity: 0.65;
  }
  .node-head {
    background: var(--raised);
    border-radius: var(--r-l) var(--r-l) 0 0;
  }
  .kind {
    color: var(--muted);
    font-weight: 500;
  }
  .name {
    font-size: 14px;
    letter-spacing: 0.01em;
  }
  .base {
    color: var(--faint);
    font-weight: 500;
  }
  .out .val {
    color: var(--ink);
  }
  .duty {
    min-width: 34px;
  }
  .pos {
    color: var(--accent);
    font-weight: 600;
  }
  .hot {
    color: var(--st-oc);
  }
</style>
