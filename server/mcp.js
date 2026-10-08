// MCP server exposing the simulator tools as thin wrappers over the sim API.
// - Mounted on the http server at /mcp (streamable HTTP, stateless) by index.js.
// - `node server/mcp.js` = stdio transport. If a sim server already runs on PORT (default 8787),
//   stdio is proxied to its /mcp endpoint (one sim, many clients); otherwise a full sim (http + ws +
//   links) is started in-process. stdout is reserved for MCP; logs go to stderr.
// Tool names use `sim_<verb>` (not `sim.verb`: dots are not valid in many MCP clients' tool names).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const bool = (description) => ({ type: 'boolean', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

function nextId(scene, prefix) {
  const used = new Set([...(scene.nodes || []).map((n) => n.id), ...(scene.edges || []).map((e) => e.id)]);
  let i = 1;
  while (used.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}
const firstOf = (sim, type) => sim.state.scene?.nodes?.find((n) => n.type === type)?.id;

/** Tool table: name → {description, inputSchema, run(sim, args)} */
export const TOOLS = {
  sim_load_project: {
    description: 'Read a dingoConfig project file and list its modules (name, kind, base id). Does not change the scene.',
    inputSchema: obj({ path: str('project JSON path (absolute or relative to the repo)') }, ['path']),
    async run(sim, a) {
      const { importProject } = await import('./project.js');
      const { scene, notes } = await importProject(a.path, { name: sim.state.sceneName });
      return { modules: scene.modules.map((m) => ({ id: m.id, kind: m.kind, baseId: m.baseId, outputs: m.outputs.filter((o) => o.enabled).map((o) => `${o.n}: ${o.name}`) })), notes };
    },
  },
  sim_populate: {
    description: 'Build the scene from a project (modules, loads by output name, switches, rotaries, battery, engine).',
    inputSchema: obj({ projectPath: str('project JSON path; default = the scene project') }),
    async run(sim, a) { const r = await sim.populate(a.projectPath); return { modules: r.scene.modules.length, nodes: r.scene.nodes.length, edges: r.scene.edges.length, notes: r.notes }; },
  },
  sim_place_load: {
    description: 'Add a load node and hang it on a module output.',
    inputSchema: obj({ component: str('component id, e.g. halogen_headlight'), preset: str('preset name'), ratedW: num('rated watts'), ratedA: num('rated amps'), module: str('module id, e.g. PDM-01'), output: num('output number'), id: str('node id (optional)') }, ['component', 'module', 'output']),
    run(sim, a) {
      const sc = structuredClone(sim.state.scene);
      const id = a.id || nextId(sc, 'n');
      sc.nodes.push({ id, type: 'load', pos: { x: 0, y: 0 }, data: { component: a.component, preset: a.preset, ratedW: a.ratedW, ratedA: a.ratedA, fault: null, guess: false } });
      sc.edges.push({ id: nextId(sc, 'e'), from: { node: id, handle: 'supply' }, to: { node: a.module, handle: `out:${a.output}` } });
      sim.setScene(sc);
      return { node: id };
    },
  },
  sim_connect: {
    description: 'Add an edge between two handles, e.g. switch n2 contact → PDM-01 di:1.',
    inputSchema: obj({ fromNode: str('source node'), fromHandle: str('source handle'), toNode: str('target node'), toHandle: str('target handle') }, ['fromNode', 'fromHandle', 'toNode', 'toHandle']),
    run(sim, a) {
      const sc = structuredClone(sim.state.scene);
      const id = nextId(sc, 'e');
      sc.edges.push({ id, from: { node: a.fromNode, handle: a.fromHandle }, to: { node: a.toNode, handle: a.toHandle } });
      sim.setScene(sc);
      return { edge: id };
    },
  },
  sim_set_fault: {
    description: 'Set (or clear with kind "clear") a fault on a load: open|short|stall|intermittent|hires|wrongpart.',
    inputSchema: obj({ node: str('load node id'), kind: str('fault kind or clear'), atMs: num('ms after turn-on') }, ['node', 'kind']),
    run: (sim, a) => sim.action({ kind: 'fault', node: a.node, fault: a.kind === 'clear' ? null : { kind: a.kind, atMs: a.atMs ?? 0 } }),
  },
  sim_switch: {
    description: 'Set a switch node on/off.',
    inputSchema: obj({ node: str('switch node id'), state: bool('closed = true') }, ['node', 'state']),
    run: (sim, a) => sim.action({ kind: 'switch', node: a.node, state: a.state }),
  },
  sim_pwm: {
    description: 'Set a PWM source node: duty % of the active level, frequency Hz, on/off.',
    inputSchema: obj({ node: str('pwmsrc node id'), duty: num('duty % 0..100'), freq: num('Hz'), on: bool('output active') }, ['node']),
    run: (sim, a) => sim.action({ kind: 'pwm', node: a.node, duty: a.duty, freq: a.freq, on: a.on }),
  },
  sim_rotary: {
    description: 'Turn a rotary knob to a position index.',
    inputSchema: obj({ node: str('rotary node id'), index: num('position index') }, ['node', 'index']),
    run: (sim, a) => sim.action({ kind: 'rotary', node: a.node, index: a.index }),
  },
  sim_keypad_press: {
    description: 'Press or release a keypad button.',
    inputSchema: obj({ node: str('keypad node id'), key: num('button index (0-based)'), pressed: bool('pressed') }, ['node', 'key', 'pressed']),
    run: (sim, a) => sim.action({ kind: 'keypad', node: a.node, key: a.key, pressed: a.pressed }),
  },
  sim_engine: {
    description: 'Engine state off|ign|crank|run, throttle %, speed.',
    inputSchema: obj({ node: str('engine node id (default first engine)'), state: str('off|ign|crank|run'), throttle: num('%'), speedKph: num('km/h') }),
    run: (sim, a) => sim.action({ kind: 'engine', node: a.node || firstOf(sim, 'engine'), ...(a.state && { state: a.state }), ...(a.throttle !== undefined && { throttle: a.throttle }), ...(a.speedKph !== undefined && { speedKph: a.speedKph }) }),
  },
  sim_battery: {
    description: 'Battery open-circuit voltage / internal resistance / alternator voltage.',
    inputSchema: obj({ node: str('battery node id (default first battery)'), vocV: num('V'), riOhm: num('ohm'), altV: num('V') }),
    run: (sim, a) => sim.action({ kind: 'battery', node: a.node || firstOf(sim, 'battery'), ...Object.fromEntries(['vocV', 'riOhm', 'altV'].filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) }),
  },
  sim_temp: {
    description: 'Board temperature of one module (MCP9808).',
    inputSchema: obj({ module: str('module id'), c: num('degC') }, ['module', 'c']),
    run: (sim, a) => sim.action({ kind: 'temp', module: a.module, c: a.c }),
  },
  sim_renode: {
    description: 'Renode control: start|stop|pause|resume|runfor (seconds)|reset|sleep|wake (module).',
    inputSchema: obj({ cmd: str('start|stop|pause|resume|runfor|reset|sleep|wake'), seconds: num('for runfor'), module: str('for reset/sleep/wake'), firmware: str('start only: local firmware folder overriding the scene') }, ['cmd']),
    async run(sim, a) { const r = await sim.action({ kind: 'renode', ...a }); return { result: r ?? null, renode: { status: sim.state.renode.status, vtime: sim.state.renode.vtime } }; },
  },
  sim_state: {
    description: 'Decoded telemetry of one module (or all), plus Renode/link status.',
    inputSchema: obj({ module: str('module id (omit for all)') }),
    run(sim, a) {
      const s = sim.state;
      return { renode: { status: s.renode.status, vtime: s.renode.vtime }, bank: s.bank, bus: s.bus, bridge: s.bridge, battery: sim.stim.battery, modules: a.module ? s.modules[a.module] ?? null : s.modules };
    },
  },
  sim_trace: {
    description: 'Model current trace (bank, 10 Hz virtual) for a module, optionally one output, since a vtime.',
    inputSchema: obj({ module: str('module id'), output: num('output number'), since: num('vtime s') }, ['module']),
    run: (sim, a) => sim.trace(a.module, a.output, a.since ?? 0).slice(-600),
  },
  sim_record: {
    description: 'Start or stop recording (stop returns the run file name).',
    inputSchema: obj({ cmd: str('start|stop') }, ['cmd']),
    run: (sim, a) => sim.record({ cmd: a.cmd }),
  },
  sim_replay: {
    description: 'Replay a recorded run deterministically (Renode RunFor steps); records a new run.',
    inputSchema: obj({ run: str('run file name') }, ['run']),
    run: (sim, a) => sim.record({ cmd: 'replay', run: a.run }),
  },
  sim_golden_diff: {
    description: 'Diff a run against the golden run (or mark a run golden with mark=true).',
    inputSchema: obj({ run: str('run file name'), golden: str('golden run (default golden.run.json)'), tolPct: num('current tolerance %'), mark: bool('mark `run` as golden instead of diffing') }, ['run']),
    run: (sim, a) => (a.mark ? sim.record({ cmd: 'golden', run: a.run }) : sim.record({ cmd: 'diff', run: a.run, golden: a.golden, tolPct: a.tolPct })),
  },
};

/** Build an MCP `Server` bound to a sim. */
export function createMcpServer(sim) {
  const server = new Server({ name: 'coffeedingosim', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = TOOLS[req.params.name];
    if (!t) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] };
    try {
      const r = await t.run(sim, req.params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(r ?? { ok: true }, null, 1) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: e.message }] };
    }
  });
  return server;
}

/** `(req, res) => Promise` handler for /mcp (stateless streamable HTTP: one server per request). */
export function httpHandler(sim) {
  return async (req, res) => {
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: POST only)' }, id: null }));
    }
    const server = createMcpServer(sim);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}

// ------------------------------------------------------------ stdio main --------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log = console.error; // stdout belongs to MCP
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const port = Number(process.env.PORT) || 8787;
  const base = `http://127.0.0.1:${port}`;
  let running = false;
  try { running = (await fetch(`${base}/api/snapshot`, { signal: AbortSignal.timeout(1500) })).ok; } catch { running = false; }
  const stdio = new StdioServerTransport();
  if (running) {
    // proxy: stdio ⇄ the running sim's /mcp
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const remote = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    stdio.onmessage = (m) => remote.send(m).catch((e) => console.error('[mcp proxy]', e.message));
    remote.onmessage = (m) => stdio.send(m);
    remote.onerror = (e) => console.error('[mcp proxy]', e.message);
    await remote.start();
    await stdio.start();
    console.error(`[mcp] stdio proxied to ${base}/mcp`);
  } else {
    const { createSim, ensureDirs } = await import('./sim.js');
    const { startServer } = await import('./index.js');
    ensureDirs();
    const sim = await createSim();
    try { await startServer(sim, { port }); } catch (e) { console.error(`[mcp] http server not started: ${e.message}`); }
    await createMcpServer(sim).connect(stdio);
    console.error(`[mcp] stdio server ready (sim in-process, scene ${sim.state.sceneName})`);
  }
}
