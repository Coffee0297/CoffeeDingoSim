<script>
  // Engine: state buttons, throttle and road speed, live readouts (server `engine` message).
  // `alternator` source → battery `alt`; `fan` target takes a second edge from a fan load.
  import { Handle, Position, useSvelteFlow } from '@xyflow/svelte';
  import { action, engineLive } from '../ws.js';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();
  const live = $derived($engineLive[id] || {});
  const STATES = [
    { v: 'off', label: 'Off' }, { v: 'ign', label: 'Ignition' }, { v: 'crank', label: 'Crank' }, { v: 'run', label: 'Run' },
  ];

  function setState(state) {
    updateNodeData(id, { state });
    action({ kind: 'engine', node: id, state, throttle: data.throttle });
  }
  function setThrottle(v) {
    const throttle = Number(v);
    updateNodeData(id, { throttle });
    action({ kind: 'engine', node: id, state: data.state, throttle });
  }
  function setSpeed(v) {
    const speedKph = Number(v);
    updateNodeData(id, { speedKph });
    action({ kind: 'engine', node: id, state: data.state, throttle: data.throttle, speedKph });
  }
</script>

<div class="node engine" class:selected>
  <Handle type="target" position={Position.Left} id="fan" />
  <div class="node-head"><span>Engine</span><span class="spacer"></span><span class="st" data-s={data.state}>{STATES.find((s) => s.v === data.state)?.label}</span></div>
  <div class="states nodrag">
    {#each STATES as s}
      <button class:on={data.state === s.v} onclick={() => setState(s.v)} aria-pressed={data.state === s.v}>{s.label}</button>
    {/each}
  </div>
  <div class="sliders nodrag">
    <label><span>Throttle</span><input type="range" min="0" max="100" value={data.throttle} oninput={(e) => setThrottle(e.currentTarget.value)} /><span class="num">{data.throttle}%</span></label>
    <label><span>Speed</span><input type="range" min="0" max="200" value={data.speedKph} oninput={(e) => setSpeed(e.currentTarget.value)} /><span class="num">{data.speedKph} km/h</span></label>
  </div>
  <dl class="read">
    <div><dt>RPM</dt><dd class="num big">{live.rpm ?? 0}</dd></div>
    <div><dt>Coolant</dt><dd class="num">{live.cltC != null ? live.cltC.toFixed(0) + ' °C' : '—'}</dd></div>
    <div><dt>Oil</dt><dd class="num">{live.oilBar != null ? live.oilBar.toFixed(1) + ' bar' : '—'}</dd></div>
    <div><dt>Gear</dt><dd>{live.gear ?? '—'}</dd></div>
  </dl>
  <div class="foot"><span class="faint">Fan load</span><span class="spacer"></span><span class="faint">Alternator</span></div>
  <Handle type="source" position={Position.Right} id="alternator" class="handle-out" style="top: auto; bottom: 10px" />
</div>

<style>
  .engine {
    width: 250px;
  }
  .st[data-s='run'] {
    color: var(--st-on);
  }
  .st[data-s='crank'] {
    color: var(--st-warn);
  }
  .states {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
    padding: 8px 10px 4px;
  }
  .states button {
    padding: 5px 0;
    border-radius: var(--r-s);
    border: 1px solid var(--line-strong);
    background: var(--sunken);
    cursor: pointer;
    font-size: 12px;
  }
  .states button.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
    font-weight: 600;
  }
  .sliders {
    padding: 4px 10px;
  }
  .sliders label {
    display: grid;
    grid-template-columns: 56px 1fr 60px;
    gap: 6px;
    align-items: center;
    color: var(--muted);
  }
  .sliders .num {
    text-align: right;
    color: var(--ink);
  }
  .read {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 12px;
    margin: 0;
    padding: 6px 10px;
  }
  .read div {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    font-weight: 600;
  }
  dd.big {
    font-size: 15px;
  }
  .foot {
    display: flex;
    padding: 2px 10px 6px;
    font-size: 11px;
  }
  .foot .spacer {
    flex: 1;
  }
</style>
