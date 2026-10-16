// mDNS / DNS-SD announcement of the dingoConfig SLCAN-over-TCP bridge (service type `_slcan._tcp.local`), the
// way a WiFi-CAN bridge announces itself, so dingoConfig's "Search the network" (GET /api/adapters/discover)
// finds the simulator too. Answers PTR / ANY questions for the service with PTR + SRV + TXT + A.
// SIM_MDNS=0 turns it off. ponytail: IPv4 only, answers questions, sends no unsolicited announcements.
import dgram from 'node:dgram';
import os from 'node:os';

export const SERVICE = '_slcan._tcp.local';
const GROUP = '224.0.0.251', PORT = 5353;

function writeName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  return Buffer.concat([...parts.map((p) => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); }), Buffer.from([0])]);
}

function readName(msg, off) {
  const parts = []; let jumped = false, end = off, guard = 0;
  for (;;) {
    const len = msg[off];
    if (len === undefined) throw new Error('truncated');
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; jumped = true; off = ((len & 0x3f) << 8) | msg[off + 1]; if (++guard > 20) throw new Error('loop'); continue; }
    parts.push(msg.toString('utf8', off + 1, off + 1 + len)); off += len + 1;
  }
  return { name: parts.join('.'), next: jumped ? end : off };
}

function record(name, type, data, ttl = 120) {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(type === 12 ? 1 : 0x8001, 2);   // class IN (cache-flush on unique records)
  h.writeUInt32BE(ttl, 4); h.writeUInt16BE(data.length, 8);
  return Buffer.concat([writeName(name), h, data]);
}

/** The questions in a query: [{ name, type, unicast }] (pure, for tests). */
export function questions(msg) {
  if (msg.length < 12 || (msg[2] & 0x80)) return [];   // a response, not a query
  const n = msg.readUInt16BE(4), out = [];
  let off = 12;
  for (let i = 0; i < n; i++) {
    const { name, next } = readName(msg, off);
    out.push({ name, type: msg.readUInt16BE(next), unicast: !!(msg[next + 2] & 0x80) });
    off = next + 4;
  }
  return out;
}

/** The answer for one bridge (pure, for tests). */
export function answer({ instance, host, address, port }) {
  const full = `${instance}.${SERVICE}`;
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, port >> 8, port & 0xff]), writeName(host)]);
  const recs = [
    record(SERVICE, 12, writeName(full)),
    record(full, 33, srv),
    record(full, 16, Buffer.from([0])),                                     // empty TXT
    record(host, 1, Buffer.from(address.split('.').map(Number))),
  ];
  const head = Buffer.alloc(12); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(recs.length, 6);
  return Buffer.concat([head, ...recs]);
}

/** Announce the bridge. `getPort()` gives the bridge's TCP port or null while it is down. Returns stop(). */
export function announce({ instance = `CoffeeDingoSim on ${os.hostname()}`, getPort, address = '127.0.0.1', log = () => {} } = {}) {
  if (process.env.SIM_MDNS === '0') return () => {};
  const host = `${os.hostname().replace(/[^a-z0-9-]/gi, '-')}-sim.local`;
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', (e) => { log(`mdns: ${e.message}`); try { sock.close(); } catch {} });
  sock.on('message', (msg, rinfo) => {
    let qs; try { qs = questions(msg); } catch { return; }
    const q = qs.find((x) => x.name.toLowerCase() === SERVICE && (x.type === 12 || x.type === 255));
    const port = getPort();
    if (!q || !port) return;
    const a = answer({ instance, host, address, port });
    // unicast back to a one-shot querier (QU bit or not from 5353), else to the group
    if (q.unicast || rinfo.port !== PORT) sock.send(a, rinfo.port, rinfo.address);
    else sock.send(a, PORT, GROUP);
  });
  sock.bind(PORT, () => {
    for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs ?? []) {
      if (i.family === 'IPv4') try { sock.addMembership(GROUP, i.address); } catch { /* interface without multicast */ }
    }
    log(`mdns: announcing ${instance} (${SERVICE})`);
  });
  return () => { try { sock.close(); } catch {} };
}
