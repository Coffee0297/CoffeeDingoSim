// Fan-out of the hub's SLCAN line stream to the dingoConfig transport (docs/interfaces.md §6).
// Modes: `serial:COM6` (serialport, 115200 nominal), `tcp:7778` (TCP server the fork connects to
// as tcp://127.0.0.1:7778), `none`. The fork's `I` (identify) and `X` (accept filter) extensions are
// answered here, never forwarded to the hub. Plain SLCAN commands (O C S L F Z V N) are answered
// locally too, so the original dingoConfig sees a well-behaved adapter even while Renode is down.
import net from 'node:net';
import { EventEmitter } from 'node:events';

/** Object.assign that keeps getters live (copies property descriptors). */
const mixin = (target, src) => Object.defineProperties(target, Object.getOwnPropertyDescriptors(src));

/**
 * Parse a mode string: `serial:COM6`, `tcp:7778`, `tcp` (7778), `none`.
 * @returns {{kind:'serial'|'tcp'|'none', path?:string, port?:number}}
 */
export function parseMode(mode) {
  const m = String(mode || 'none').trim();
  if (m.startsWith('serial:')) return { kind: 'serial', path: m.slice(7) };
  if (m === 'tcp') return { kind: 'tcp', port: 7778 };
  if (m.startsWith('tcp:')) { const p = Number(m.slice(4)); return { kind: 'tcp', port: Number.isInteger(p) && p >= 0 ? p : 7778 }; }
  if (/^COM\d+$/i.test(m) || m.startsWith('/dev/')) return { kind: 'serial', path: m };
  return { kind: 'none' };
}

/**
 * @param {{mode?:string, getBaseId?:()=>number|null, toHub?:(line:string)=>void, host?:string}} opts
 *   getBaseId: first PDM base id (for `I`); toHub: forwards a frame line to the hub.
 */
export function createBridge(opts = {}) {
  const em = new EventEmitter();
  const getBaseId = opts.getBaseId || (() => null);
  const toHub = opts.toHub || (() => {});
  let mode = parseMode(opts.mode);
  let filterId = -1;
  let server = null;
  let serial = null;
  const clients = new Set(); // each: { write(str), splitBuf }

  function reply(client, s) { try { client.write(s); } catch { /* client gone */ } }

  /** Handle one line from dingoConfig. Exported for tests via `handleClientLine`. */
  function handleClientLine(client, line) {
    if (!line) return;
    const c = line[0];
    switch (c) {
      case 'I': {
        const base = getBaseId();
        const hex = ((base ?? 0) & 0x7ff).toString(16).toUpperCase().padStart(3, '0');
        reply(client, `I${hex}\r`);
        return;
      }
      case 'X': {
        const m = /^[0-9a-fA-F]{1,3}/.exec(line.slice(1));
        filterId = m ? parseInt(m[0], 16) & 0x7ff : -1;
        em.emit('filter', filterId);
        return;
      }
      case 'V': reply(client, 'V1013\r'); return;
      case 'N': reply(client, 'NSIM0\r'); return;
      case 'O': case 'C': case 'S': case 'L': case 'F': case 'Z': case 's': case 'M': case 'm':
        reply(client, '\r'); return;
      case 't': case 'T': case 'r': case 'R':
        toHub(line);
        reply(client, c === 't' || c === 'r' ? 'z\r' : 'Z\r');
        em.emit('rx', line);
        return;
      default:
        reply(client, '\x07');
    }
  }

  function attach(client) {
    clients.add(client);
    em.emit('clients', clients.size);
  }
  function detach(client) {
    clients.delete(client);
    em.emit('clients', clients.size);
  }
  function feedClient(client, chunk) {
    client.splitBuf += chunk.toString('latin1');
    let i;
    while ((i = client.splitBuf.search(/[\r\n]/)) >= 0) {
      const line = client.splitBuf.slice(0, i);
      client.splitBuf = client.splitBuf.slice(i + 1);
      handleClientLine(client, line);
    }
    if (client.splitBuf.length > 64) client.splitBuf = '';
  }

  /** Called with every hub line (no CR). Applies the `X` filter to frame lines. */
  function fromHub(line) {
    if (!clients.size || !line) return;
    const c = line[0];
    if (c !== 't' && c !== 'T') return; // bridge replies to our own commands stay with bus.js
    if (filterId >= 0) {
      const id = c === 't' ? parseInt(line.slice(1, 4), 16) : parseInt(line.slice(1, 9), 16);
      if (id !== filterId) return;
    }
    for (const cl of clients) reply(cl, line + '\r');
  }

  async function start() {
    await stop();
    filterId = -1;
    if (mode.kind === 'tcp') {
      server = net.createServer((sock) => {
        sock.setNoDelay(true);
        const client = { write: (s) => sock.write(s), splitBuf: '' };
        attach(client);
        sock.on('data', (d) => feedClient(client, d));
        sock.on('error', () => {});
        sock.on('close', () => detach(client));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(mode.port, opts.host || '127.0.0.1', () => { server.off('error', reject); resolve(); });
      }).catch((e) => { server = null; em.emit('error', e); throw e; });
      if (mode.port === 0) mode.port = server.address().port;
      em.emit('ready', describe());
    } else if (mode.kind === 'serial') {
      let SerialPort;
      try { ({ SerialPort } = await import('serialport')); } catch (e) { em.emit('error', new Error(`serialport unavailable: ${e.message}`)); throw e; }
      await new Promise((resolve, reject) => {
        serial = new SerialPort({ path: mode.path, baudRate: 115200, autoOpen: false });
        serial.open((err) => (err ? reject(err) : resolve()));
      }).catch((e) => { serial = null; em.emit('error', e); throw e; });
      const client = { write: (s) => serial?.write(s), splitBuf: '' };
      attach(client);
      serial.on('data', (d) => feedClient(client, d));
      serial.on('error', (e) => em.emit('error', e));
      serial.on('close', () => { detach(client); serial = null; em.emit('closed'); });
      em.emit('ready', describe());
    }
    return describe();
  }

  async function stop() {
    for (const c of [...clients]) detach(c);
    if (server) { const s = server; server = null; await new Promise((r) => s.close(() => r())); }
    if (serial) { const s = serial; serial = null; await new Promise((r) => s.close(() => r())); }
  }

  function describe() {
    return { mode: mode.kind === 'tcp' ? `tcp:${mode.port}` : mode.kind === 'serial' ? `serial:${mode.path}` : 'none', clients: clients.size, filterId };
  }

  return mixin(em, {
    start, stop, fromHub, describe,
    handleClientLine,
    async setMode(m) { mode = parseMode(m); return start(); },
    get filterId() { return filterId; },
    get port() { return mode.port; },
  });
}
