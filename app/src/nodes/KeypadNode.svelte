<script>
  // Keypad on the bus (Blink Marine / Grayhill). Keys send `keypad` press/release actions; the LED
  // ring of each key shows the colour the firmware commands (server `keypad` message).
  import { useSvelteFlow } from '@xyflow/svelte';
  import { action, keypadLeds } from '../ws.js';

  let { id, data, selected } = $props();
  const { updateNodeData } = useSvelteFlow();

  const keys = $derived(Math.max(1, Number(data.keys) || 8));
  const cols = $derived(keys <= 2 ? 2 : Math.ceil(keys / 2));
  const leds = $derived($keypadLeds[id] || data.leds || []);
  let held = $state({});

  const COLORS = {
    red: '#ff4d5e', green: '#3dd68c', blue: '#4da3ff', yellow: '#f5d442', amber: '#f5b342', orange: '#ff8a3d',
    white: '#f4f6fa', cyan: '#3dd6d0', magenta: '#e05ad6', violet: '#a77bff', purple: '#a77bff',
  };
  const ledOf = (k) => leds.find((l) => l.key === k);

  function press(k, down) {
    if (!!held[k] === down) return;
    held = { ...held, [k]: down };
    const pressed = Array.from({ length: keys }, (_, i) => (i === k ? down : !!held[i]));
    updateNodeData(id, { pressed });
    action({ kind: 'keypad', node: id, key: k, pressed: down });
  }
  function setKeys(v) {
    const n = Number(v);
    updateNodeData(id, { keys: n, pressed: Array(n).fill(false) });
  }
</script>

<div class="node keypad" class:selected>
  <div class="node-head"><span>Keypad</span><span class="spacer"></span><span class="muted num">node {data.nodeId}</span></div>
  <div class="node-controls nodrag">
    <select class="input" value={data.model} onchange={(e) => updateNodeData(id, { model: e.currentTarget.value })} aria-label="Keypad model">
      <option value="blink">Blink Marine PKP</option><option value="grayhill">Grayhill</option>
    </select>
    <select class="input" value={String(keys)} onchange={(e) => setKeys(e.currentTarget.value)} aria-label="Key count">
      {#each [2, 4, 6, 8, 10, 12, 15] as k}<option value={String(k)}>{k} keys</option>{/each}
    </select>
    <label>Node <input class="input num" type="number" min="1" max="127" value={data.nodeId}
      onchange={(e) => updateNodeData(id, { nodeId: Number(e.currentTarget.value) })} /></label>
  </div>
  <div class="grid nodrag" style:grid-template-columns="repeat({cols}, 40px)">
    {#each Array(keys) as _, k}
      {@const led = ledOf(k)}
      <button
        class="key" class:down={held[k]} class:blink={led?.blink}
        style:--led={led && led.color !== 'off' ? COLORS[led.color] || led.color : 'transparent'}
        onpointerdown={() => press(k, true)} onpointerup={() => press(k, false)} onpointerleave={() => press(k, false)}
        onkeydown={(e) => (e.key === ' ' || e.key === 'Enter') && press(k, true)}
        onkeyup={(e) => (e.key === ' ' || e.key === 'Enter') && press(k, false)}
        aria-pressed={!!held[k]} title={led ? `LED ${led.color}${led.blink ? ', blinking' : ''}` : 'LED off'}
      >{k + 1}</button>
    {/each}
  </div>
</div>

<style>
  .keypad {
    width: auto;
    min-width: 200px;
  }
  .grid {
    display: grid;
    gap: 6px;
    padding: 6px 10px 12px;
  }
  .key {
    width: 40px;
    height: 40px;
    border-radius: 9px;
    border: 1px solid var(--line-strong);
    background: radial-gradient(circle at 50% 40%, var(--raised), var(--sunken));
    box-shadow: inset 0 0 0 3px var(--led), 0 0 10px color-mix(in srgb, var(--led) 60%, transparent);
    cursor: pointer;
    font-weight: 600;
    color: var(--muted);
    user-select: none;
  }
  .key.down {
    transform: translateY(1px) scale(0.97);
    color: var(--ink);
    border-color: var(--accent);
  }
  .key.blink {
    animation: blink 0.8s steps(1) infinite;
  }
  @keyframes blink {
    50% {
      box-shadow: inset 0 0 0 3px transparent;
    }
  }
</style>
