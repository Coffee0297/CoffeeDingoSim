// Fake ProfetLoadBank NDJSON listener (docs/interfaces.md §5) for server tests.
import net from 'node:net';

/**
 * @param {{port?:number, hello?:object[]}} [opts]
 * @returns {Promise<{port:number, received:any[], send:(o:any)=>void, waitFor:(pred:(m:any)=>boolean, ms?:number)=>Promise<any>,
 *   dropClients:()=>void, close:()=>Promise<void>, clients:number}>}
 */
export async function startFakeBank(opts = {}) {
  const received = [];
  const socks = new Set();
  const waiters = [];
  const server = net.createServer((s) => {
    socks.add(s);
    let buf = '';
    for (const h of opts.hello || []) s.write(JSON.stringify(h) + '\n');
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        received.push(msg);
        if (msg.type === 'list') s.write(JSON.stringify({ type: 'machines', items: (opts.hello || []).map((h) => ({ machine: h.machine, board: h.board, outputs: h.outputs })) }) + '\n');
        for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
      }
    });
    s.on('error', () => {});
    s.on('close', () => socks.delete(s));
  });
  await new Promise((r) => server.listen(opts.port || 0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port, received,
    get clients() { return socks.size; },
    send(o) { for (const s of socks) s.write(JSON.stringify(o) + '\n'); },
    waitFor(pred, ms = 3000) {
      const hit = received.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('fake bank: timeout')); } }, ms);
      });
    },
    dropClients() { for (const s of socks) s.destroy(); },
    close() { for (const s of socks) s.destroy(); return new Promise((r) => server.close(() => r())); },
  };
}
