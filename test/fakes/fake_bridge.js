// Fake SlcanTcpBridge (docs/interfaces.md §6): an SLCAN TCP server for server tests. Answers O/C/S/L/F/Z
// with `\r`, V with `V1013\r`, N with `NSIM0\r`; records injected frame lines.
import net from 'node:net';

/** @returns {Promise<{port:number, lines:string[], sendLine:(l:string)=>void, sendRaw:(s:string)=>void,
 *   waitLine:(pred:(l:string)=>boolean, ms?:number)=>Promise<string>, close:()=>Promise<void>, clients:number}>} */
export async function startFakeBridge(opts = {}) {
  const lines = [];
  const socks = new Set();
  const waiters = [];
  const server = net.createServer((s) => {
    socks.add(s);
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        lines.push(l);
        const c = l[0];
        if ('OCSLFZ'.includes(c)) s.write('\r');
        else if (c === 'V') s.write('V1013\r');
        else if (c === 'N') s.write('NSIM0\r');
        else if (c !== 't' && c !== 'T') s.write('\x07');
        for (const w of [...waiters]) if (w.pred(l)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(l); }
      }
    });
    s.on('error', () => {});
    s.on('close', () => socks.delete(s));
  });
  await new Promise((r) => server.listen(opts.port || 0, '127.0.0.1', r));
  return {
    port: server.address().port, lines,
    get clients() { return socks.size; },
    sendLine(l) { for (const s of socks) s.write(l + '\r'); },
    sendRaw(chunk) { for (const s of socks) s.write(chunk); },
    waitLine(pred, ms = 3000) {
      const hit = lines.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('fake bridge: timeout')); } }, ms);
      });
    },
    close() { for (const s of socks) s.destroy(); return new Promise((r) => server.close(() => r())); },
  };
}

/** Wait until `pred()` is truthy (polling), or reject after `ms`. */
export function until(pred, ms = 3000, every = 20) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let v;
      try { v = pred(); } catch { v = false; }
      if (v) { clearInterval(iv); resolve(v); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('until: timeout')); }
    }, every);
  });
}
