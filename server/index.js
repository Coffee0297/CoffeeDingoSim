// HTTP (static SPA + REST, docs/interfaces.md §8) + WebSocket /ws + MCP over streamable HTTP at /mcp.
// Start: `npm start` (PORT default 8787, SIM_SCENE default example, SIM_BRIDGE default tcp:7778).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ROOT, events } from './state.js';
import { createSim, ensureDirs } from './sim.js';
import { readProject } from './project.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
const DIST = path.join(ROOT, 'app', 'dist');

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const t = Buffer.concat(chunks).toString('utf8');
      try { resolve(t ? JSON.parse(t) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>CoffeeDingoSim</title><body style="font-family:sans-serif;padding:2em"><h1>CoffeeDingoSim</h1><p>The UI is not built yet: run <code>npm run build</code> (or <code>npm run dev</code>), then reload.</p><p>REST: <a href="/api/snapshot">/api/snapshot</a></p></body>');
    return;
  }
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let p = path.normalize(path.join(DIST, url));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, 'index.html'); // SPA fallback
  // index.html must be revalidated or the browser keeps an old page pointing at an old bundle after a rebuild;
  // Vite's hashed assets/ files change name with their content and can be cached for good
  const cache = /[\\/]assets[\\/]/.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': cache });
  fs.createReadStream(p).pipe(res);
}

/**
 * Create the HTTP + WS server around a sim.
 * @param {any} sim from createSim() @param {{port?:number, host?:string, mcp?:boolean}} [opts]
 * @returns {Promise<{server:http.Server, wss:WebSocketServer, port:number, close:()=>Promise<void>}>}
 */
export async function startServer(sim, opts = {}) {
  let mcpHandler = null;
  if (opts.mcp !== false) {
    try { mcpHandler = (await import('./mcp.js')).httpHandler(sim); } catch (e) { console.warn(`[mcp] http transport disabled: ${e.message}`); }
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
      if (p === '/mcp' && mcpHandler) return await mcpHandler(req, res);
      if (!p.startsWith('/api/')) return serveStatic(req, res);
      if (req.method === 'GET' && p === '/api/snapshot') return sendJson(res, 200, sim.snapshot());
      if (req.method === 'GET' && p === '/api/components') return sendJson(res, 200, sim.comps.listComponents());
      if (req.method === 'GET' && p === '/api/project') {
        const q = u.searchParams.get('path') || sim.state.scene?.project?.path;
        if (!q) return sendJson(res, 400, { error: 'path required' });
        return sendJson(res, 200, readProject(q).json);
      }
      if (req.method === 'POST' && p === '/api/scene') { const b = await readBody(req); return sendJson(res, 200, sim.setScene(b.scene || b)); }
      if (req.method === 'GET' && p === '/api/firmware/releases') return sendJson(res, 200, await sim.listReleases());
      if (req.method === 'GET' && p === '/api/runs') return sendJson(res, 200, sim.listRuns());
      if (req.method === 'GET' && p.startsWith('/api/run/')) return sendJson(res, 200, sim.getRun(decodeURIComponent(p.slice(9))));
      if (req.method === 'GET' && p === '/api/trace') return sendJson(res, 200, sim.trace(u.searchParams.get('module'), Number(u.searchParams.get('output')) || 0, Number(u.searchParams.get('since')) || 0));
      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    send(sim.snapshot());
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return send({ type: 'toast', level: 'error', text: 'bad JSON' }); }
      try {
        const result = await handleUiMessage(sim, msg);
        if (msg.id !== undefined) send({ type: 'result', id: msg.id, ok: true, result });
      } catch (e) {
        send({ type: 'toast', level: 'error', text: e.message });
        if (msg.id !== undefined) send({ type: 'result', id: msg.id, ok: false, error: e.message });
      }
    });
  });
  const onBroadcast = (m) => {
    const s = JSON.stringify(m);
    for (const c of wss.clients) if (c.readyState === 1) c.send(s);
  };
  events.on('broadcast', onBroadcast);

  const port = opts.port ?? (Number(process.env.PORT) || 8787);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, opts.host || '127.0.0.1', resolve); });
  const actual = server.address().port;
  return {
    server, wss, port: actual,
    async close() {
      events.off('broadcast', onBroadcast);
      for (const c of wss.clients) c.terminate();
      await new Promise((r) => wss.close(() => r()));
      await new Promise((r) => server.close(() => r()));
    },
  };
}

/** Dispatch one UI → server message (docs/interfaces.md §8). */
export async function handleUiMessage(sim, msg) {
  switch (msg.type) {
    case 'scene': return sim.setScene(msg.scene);
    case 'action': return sim.action(msg.action);
    case 'populate': return sim.populate(msg.projectPath);
    case 'record': return sim.record(msg);
    case 'loadScene': return sim.loadScene(msg.name);
    case 'snapshot': return sim.snapshot();
    default: throw new Error(`unknown message type ${msg.type}`);
  }
}

// ------------------------------------------------------------ main --------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message || e));
  process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message || e));
  ensureDirs();
  const sim = await createSim();
  const srv = await startServer(sim);
  console.log(`CoffeeDingoSim on http://127.0.0.1:${srv.port}  (ws /ws, mcp /mcp, scene ${sim.state.sceneName})`);
  const quit = async () => { await sim.close(); await srv.close(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
