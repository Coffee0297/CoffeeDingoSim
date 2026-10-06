// TCP client to the ProfetLoadBank NDJSON listener (docs/interfaces.md §5) with reconnect/backoff.
// Emits: 'connect', 'disconnect', 'hello', 'trace', 'event', 'machines', 'bankError' (the bank's
// {type:'error'} replies), 'message' (any).
import net from 'node:net';
import { EventEmitter } from 'node:events';

/** Object.assign that keeps getters live (copies property descriptors). */
const mixin = (target, src) => Object.defineProperties(target, Object.getOwnPropertyDescriptors(src));

/**
 * @param {{host?:string, port?:number, minBackoffMs?:number, maxBackoffMs?:number}} [opts]
 */
export function createBank(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port || 7800;
  const minBackoff = opts.minBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 5000;

  const em = new EventEmitter();
  let sock = null;
  let buf = '';
  let backoff = minBackoff;
  let timer = null;
  let stopped = true;
  let connected = false;
  const lastScene = new Map(); // machine → last scene message, resent after reconnect
  let lastVbatt = null;

  function schedule() {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; connect(); }, backoff);
    backoff = Math.min(maxBackoff, backoff * 2);
  }

  function connect() {
    if (stopped || sock) return;
    const s = net.createConnection({ host, port });
    sock = s;
    s.setNoDelay(true);
    s.on('connect', () => {
      connected = true;
      backoff = minBackoff;
      buf = '';
      em.emit('connect');
      for (const msg of lastScene.values()) write(msg);
      if (lastVbatt) write(lastVbatt);
      write({ type: 'list' });
    });
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { em.emit('garbage', line); continue; }
        em.emit('message', msg);
        // the bank's {type:'error'} must not become an EventEmitter 'error' (that throws when unhandled)
        if (msg.type) em.emit(msg.type === 'error' ? 'bankError' : msg.type, msg);
      }
    });
    const drop = (err) => {
      if (sock !== s) return;
      sock = null;
      const was = connected;
      connected = false;
      if (was) em.emit('disconnect', err?.message);
      else em.emit('unreachable', err?.message);
      schedule();
    };
    s.on('error', drop);
    s.on('close', () => drop());
  }

  function write(obj) {
    if (!sock || !connected) return false;
    try { sock.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  return mixin(em, {
    get connected() { return connected; },
    port,
    /** Start connecting (and keep reconnecting until `stop()`). */
    start() { stopped = false; if (!sock) connect(); return this; },
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (sock) { try { sock.destroy(); } catch { /* ignore */ } sock = null; }
      connected = false;
    },
    /** Raw send; returns false when not connected. */
    send: write,
    /** Full scene replace for one machine; remembered and resent on reconnect. */
    sendScene(msg) { lastScene.set(msg.machine, { type: 'scene', ...msg }); return write({ type: 'scene', ...msg }); },
    forgetScene(machine) { lastScene.delete(machine); },
    /** Resend the remembered scene of one machine (a bank that said `hello` after we connected). */
    resendScene(machine) { const m = lastScene.get(machine); return m ? write(m) : false; },
    fault(machine, out, load, kind, atMs = 0) { return write({ type: 'fault', machine, out, load, kind, atMs }); },
    vbatt(machine, v) { const m = { type: 'vbatt', machine, v: Number(v.toFixed(3)) }; if (machine === '*') lastVbatt = m; return write(m); },
    gpio(machine, pin, value) { return write({ type: 'gpio', machine, pin, value: value ? 1 : 0 }); },
    adc(machine, ch, mV) { return write({ type: 'adc', machine, ch, mV: Math.round(mV) }); },
    temp(machine, c) { return write({ type: 'temp', machine, c }); },
    list() { return write({ type: 'list' }); },
  });
}
