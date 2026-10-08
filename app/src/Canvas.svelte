<script>
  // The vehicle canvas. Scene (docs/interfaces.md §3) ⇄ Svelte Flow nodes/edges; every structural edit
  // (add / move / delete / wire / data) is mirrored back into the scene and sent debounced 300 ms.
  // Interactive controls inside nodes send their own immediate `action`s.
  import { SvelteFlow, Background, Controls, MiniMap, useSvelteFlow } from '@xyflow/svelte';
  import { onDestroy } from 'svelte';
  import { scene, sendScene, components } from './ws.js';
  import { selection, contextMenu, canvasHint, flashHint, addRequest, theme } from './ui.js';
  import {
    sceneToFlow, flowToScene, sceneJson, validateConnection, edgeToScene, nextId, nodeDefaults,
    loadFromComponent, componentById, handleIndex,
  } from './scene.js';
  import FaultMenu from './FaultMenu.svelte';
  import { arrange } from '../../lib/layout.js';
  import { pinConfig } from '../../lib/populate.js';
  import ModuleNode from './nodes/ModuleNode.svelte';
  import LoadNode from './nodes/LoadNode.svelte';
  import SwitchNode from './nodes/SwitchNode.svelte';
  import RotaryNode from './nodes/RotaryNode.svelte';
  import KeypadNode from './nodes/KeypadNode.svelte';
  import CanGenNode from './nodes/CanGenNode.svelte';
  import EngineNode from './nodes/EngineNode.svelte';
  import BatteryNode from './nodes/BatteryNode.svelte';
  import WiperNode from './nodes/WiperNode.svelte';
  import PwmSourceNode from './nodes/PwmSourceNode.svelte';

  const nodeTypes = {
    module: ModuleNode, load: LoadNode, switch: SwitchNode, rotary: RotaryNode, keypad: KeypadNode,
    cangen: CanGenNode, engine: EngineNode, battery: BatteryNode, wiper: WiperNode, pwmsrc: PwmSourceNode,
  };

  const flow = useSvelteFlow();

  let nodes = $state.raw([]);
  let edges = $state.raw([]);
  let base = null;       // latest scene object (keeps project / firmware / globals)
  let lastJson = '';     // JSON of the scene as the canvas last saw / sent it
  let fitted = false;
  let lastReason = '';

  // Server / file → canvas.
  const unsubScene = scene.subscribe((s) => {
    if (!s) return;
    if (sceneJson(s) === lastJson) return;
    base = s;
    const selected = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    const f = sceneToFlow(s);
    nodes = f.nodes.map((n) => (selected.has(n.id) ? { ...n, selected: true } : n));
    edges = f.edges;
    lastJson = sceneJson(flowToScene(s, nodes, edges));
    // An imported scene (populate, Load…, first scene of the page) is laid out automatically: more than a
    // couple of node ids changed at once means it is not an interactive edit.
    const ids = new Set(f.nodes.map((n) => n.id));
    const changed = [...ids].filter((id) => !lastIds.has(id)).length + [...lastIds].filter((id) => !ids.has(id)).length;
    const imported = changed > 2;
    lastIds = ids;
    if (imported) scheduleArrange();
    else if (!fitted) {
      fitted = true;
      setTimeout(() => flow.fitView({ padding: 0.08, duration: 0 }), 60);
    }
  });
  let lastIds = new Set();

  // Lay the canvas out from the rendered node sizes (Svelte Flow `measured`), so wait until the new nodes
  // have been measured, then move them and fit the view. The moves flow back into the scene like a drag.
  let arrangeTimer = null;
  function scheduleArrange(tries = 0) {
    clearTimeout(arrangeTimer);
    arrangeTimer = setTimeout(() => {
      const live = flow.getNodes();
      if (tries < 20 && live.some((n) => !n.measured?.width)) return scheduleArrange(tries + 1);
      arrangeNow();
    }, 80);
  }
  function arrangeNow() {
    const live = new Map(flow.getNodes().map((n) => [n.id, n]));
    const size = (n) => { const m = live.get(n.id)?.measured; return m ? { w: m.width, h: m.height } : null; };
    const r = wrap?.getBoundingClientRect();
    const p = arrange({ nodes, edges }, { size, aspect: r && r.height ? r.width / r.height : 16 / 9 });
    nodes = nodes.map((n) => (p.has(n.id) ? { ...n, position: p.get(n.id) } : n));
    fitted = true;
    // fit only after the moved nodes have rendered, or the view fits the old bounds
    requestAnimationFrame(() => requestAnimationFrame(() => flow.fitView({ padding: 0.04, duration: 250 })));
  }
  onDestroy(() => clearTimeout(arrangeTimer));
  onDestroy(unsubScene);

  // Canvas → scene (debounced send happens in ws.sendScene).
  $effect(() => {
    const n = nodes, e = edges;
    if (!base) return;
    const s = flowToScene(base, n, e);
    const j = sceneJson(s);
    if (j === lastJson) return;
    lastJson = j;
    base = s;
    sendScene(s);
  });

  function sceneEdges() {
    return edges.map(edgeToScene);
  }

  function isValidConnection(c) {
    const r = validateConnection(base, sceneEdges(), c);
    lastReason = r.ok ? '' : r.reason;
    return r.ok;
  }
  function onbeforeconnect(c) {
    const r = validateConnection(base, sceneEdges(), c);
    if (!r.ok) { flashHint(r.reason); return false; }
    inheritFromPin(c);
    return { id: nextId('e', edges), source: c.source, target: c.target, sourceHandle: c.sourceHandle, targetHandle: c.targetHandle };
  }
  // A card wired to a module pin takes over that pin's name and behaviour from the project
  // (switch: toggle/momentary + level, knob: positions, load: the output name as its label).
  function inheritFromPin(c) {
    const mod = base?.modules?.find((m) => m.id === c.target);
    const node = nodes.find((x) => x.id === c.source);
    const cfg = mod && node ? pinConfig(mod, c.targetHandle) : null;
    if (!cfg || cfg.type !== node.type) return;
    const patch = node.type === 'rotary' ? { ...cfg.data, index: 0 } : node.type === 'load' ? { ...cfg.data, name: null } : cfg.data;
    nodes = nodes.map((x) => (x.id === node.id ? { ...x, data: { ...x.data, ...patch } } : x));
    flashHint(`${node.type === 'load' ? 'Load' : node.type === 'rotary' ? 'Knob' : node.type === 'pwmsrc' ? 'PWM source' : 'Switch'} named "${cfg.data.name ?? cfg.data.label}" from ${c.target} ${c.targetHandle}`);
  }

  function onconnectend(_event, state) {
    if (state && state.isValid === false && lastReason) flashHint(lastReason);
  }

  function selectFor(node, event) {
    if (node.type === 'module') {
      const row = event?.target?.closest?.('[data-out]');
      if (row) {
        const n = Number(row.dataset.out);
        const o = node.data.module.outputs.find((x) => x.n === n);
        selection.set({ kind: 'output', machine: node.id, n, label: `${node.id} ${o?.name ?? ''} (${n})` });
      } else selection.set({ kind: 'module', id: node.id });
      return;
    }
    if (node.type === 'load') selection.set({ kind: 'load', id: node.id });
    else if (node.type === 'battery') selection.set({ kind: 'battery', id: node.id });
    else if (node.type === 'engine') selection.set({ kind: 'engine', id: node.id });
    else if (node.type === 'wiper') selection.set({ kind: 'wiper', id: node.id });
    else selection.set({ kind: 'node', id: node.id, type: node.type });
  }

  function onnodeclick({ node, event }) {
    selectFor(node, event);
  }
  function onnodecontextmenu({ node, event }) {
    if (node.type !== 'load') return;
    event.preventDefault();
    contextMenu.set({ x: event.clientX, y: event.clientY, nodeId: node.id });
  }
  function onedgeclick({ edge }) {
    const tk = edge.targetHandle || '';
    if (tk.startsWith('out:')) {
      const n = handleIndex(tk);
      selection.set({ kind: 'output', machine: edge.target, n, label: `${edge.target} out ${n}` });
    }
  }
  function ondelete({ nodes: gone }) {
    if (gone.some((n) => n.id === $selection?.id)) selection.set(null);
  }

  function addNode(spec, position) {
    if (!base) { flashHint('Load or populate a scene first'); return; }
    const id = nextId('n', nodes);
    let data;
    if (spec.type === 'load') {
      const comp = componentById($components, spec.component);
      data = comp ? loadFromComponent(comp, spec.preset) : nodeDefaults('load');
    } else data = nodeDefaults(spec.type);
    nodes = [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), { id, type: spec.type, position, data, selected: true }];
    selectFor({ id, type: spec.type, data });
    flashHint(spec.type === 'load' ? 'Drag from the left handle onto a module output to supply it' : `${id} added`);
  }

  function ondragover(e) {
    if (e.dataTransfer?.types?.includes('application/x-cds')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }
  function ondrop(e) {
    const raw = e.dataTransfer?.getData('application/x-cds');
    if (!raw) return;
    e.preventDefault();
    let spec;
    try { spec = JSON.parse(raw); } catch { return; }
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNode(spec, { x: Math.round(p.x - 100), y: Math.round(p.y - 20) });
  }

  let wrap;
  const unsubAdd = addRequest.subscribe((spec) => {
    if (!spec || !wrap) return;
    const r = wrap.getBoundingClientRect();
    const p = flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    addNode(spec, { x: Math.round(p.x - 100), y: Math.round(p.y - 40) });
    addRequest.set(null);
  });
  onDestroy(unsubAdd);
</script>

<div class="canvas" bind:this={wrap} {ondragover} {ondrop} role="application" aria-label="Vehicle canvas">
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    colorMode={$theme}
    minZoom={0.15}
    maxZoom={2}
    deleteKey={['Delete', 'Backspace']}
    {isValidConnection}
    {onbeforeconnect}
    {onconnectend}
    {onnodeclick}
    {onnodecontextmenu}
    {onedgeclick}
    {ondelete}
    defaultEdgeOptions={{ interactionWidth: 14 }}
    proOptions={{ hideAttribution: false }}
  >
    <Background gap={24} />
    <Controls position="bottom-left" showLock={false} />
    <MiniMap position="bottom-right" pannable zoomable width={160} height={110} />
  </SvelteFlow>
  {#if $scene}<button class="btn sm arrange" onclick={arrangeNow} title="Loads beside the module output they hang on, knobs and switches beside the input they drive">Arrange</button>{/if}
  {#if $canvasHint}<div class="hint" role="status">{$canvasHint}</div>{/if}
  {#if !$scene}
    <div class="empty">
      <p>Waiting for a scene from the server.</p>
      <p class="muted">Start it with <code>npm start</code>, or open this page with <code>?mock=1</code> to try the UI on a built-in example scene.</p>
    </div>
  {/if}
  <FaultMenu />
</div>

<style>
  .arrange {
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 5;
  }
  .canvas {
    position: relative;
    width: 100%;
    height: 100%;
  }
  .hint {
    position: absolute;
    left: 50%;
    bottom: 18px;
    transform: translateX(-50%);
    padding: 7px 14px;
    background: var(--panel);
    border: 1px solid var(--line-strong);
    border-radius: 999px;
    box-shadow: var(--shadow);
    z-index: 10;
    max-width: 70%;
    text-align: center;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    text-align: center;
    pointer-events: none;
    font-size: 14px;
  }
  .empty p {
    margin: 4px 0;
  }
  code {
    font-family: var(--mono);
    background: var(--raised);
    padding: 1px 5px;
    border-radius: var(--r-s);
  }
</style>
