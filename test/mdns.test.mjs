// node test/mdns.test.mjs — the mDNS answer the Sim gives for _slcan._tcp, and query parsing
import assert from 'node:assert/strict';
import { questions, answer, SERVICE } from '../server/mdns.js';

// a one-shot PTR question with the unicast bit, as dingoConfig sends it
const name = Buffer.concat([...SERVICE.split('.').map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0])]);
const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), name, Buffer.from([0, 12, 0x80, 1])]);
assert.deepEqual(questions(q), [{ name: SERVICE, type: 12, unicast: true }]);

const a = answer({ instance: 'Garage', host: 'pc-sim.local', address: '127.0.0.1', port: 7778 });
assert.equal(a.readUInt16BE(2), 0x8400);          // authoritative response
assert.equal(a.readUInt16BE(6), 4);               // PTR, SRV, TXT, A
assert.deepEqual(questions(a), []);               // a response is not a query
assert.ok(a.includes(Buffer.from('Garage')) && a.includes(Buffer.from([0x1e, 0x62])), 'instance name and port 7778');
console.log('mdns ok');
