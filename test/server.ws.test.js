// End-to-end against the fakes: ws snapshot, action round trips to the bank and the bus,
// telemetry + keypad LED broadcast, REST and MCP over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startFakeBank } from './fakes/fake_bank.js';
import { startFakeBridge, until } from './fakes/fake_bridge.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-ws-'));
process.env.SIM_SCENES_DIR = tmp;
process.env.SIM_CACHE_DIR = path.join(tmp, 'cache');

const SCENE = {
  version: 1, name: 'wstest', project: null, firmware: {},
  modules: [
    { id: 'PDM-01', kind: 'pdm', baseId: 0x680, pos: { x: 0, y: 0 }, outputs: [{ n: 1, name: 'Low Beam', enabled: true, currentLimit: 12 }], inputs: [{ n: 1, name: 'di', enabled: true }], analogIn: [], digitalOut: [] },
    { id: 'CB-1', kind: 'canboard', baseId: 0x660, pos: { x: 0, y: 400 }, outputs: [], inputs: [], analogIn: [{ n: 1, name: 'Headlights', enabled: true }], digitalOut: [] },
  ],
  nodes: [
    { id: 'n1', type: 'load', pos: {}, data: { component: 'halogen_headlight', preset: 'H4 low 55 W', ratedW: 55, ratedA: 3.99, fault: null } },
    { id: 'n2', type: 'switch', pos: {}, data: { kind: 'toggle', level: '12v', state: false } },
    { id: 'n3', type: 'rotary', pos: {}, data: { positions: [{ name: 'OFF', mV: 500 }, { name: 'Park', mV: 1500 }, { name: 'Low', mV: 2500 }], index: 0, noiseMv: 20 } },
    { id: 'n4', type: 'keypad', pos: {}, data: { model: 'blink', keys: 8, nodeId: 21, pressed: [], leds: [] } },
    { id: 'n7', type: 'battery', pos: {}, data: { vocV: 12.6, riOhm: 0.015, altV: 14.2 } },
  ],
  edges: [
    { id: 'e1', from: { node: 'n1', handle: 'supply' }, to: { node: 'PDM-01', handle: 'out:1' } },
    { id: 'e2', from: { node: 'n2', handle: 'contact' }, to: { node: 'PDM-01', handle: 'di:1' } },
    { id: 'e3', from: { node: 'n3', handle: 'wiper' }, to: { node: 'CB-1', handle: 'ai:1' } },
  ],
  globals: { noisePct: 1 },
};
fs.mkdirSync(path.join(tmp, 'wstest'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'wstest', 'scene.sim.json'), JSON.stringify(SCENE));

let bank, hub, sim, srv, ws;
const inbox = [];
const nextMsg = (pred, ms = 3000) => until(() => inbox.find(pred), ms);

before(async () => {
  bank = await startFakeBank({ hello: [{ type: 'hello', machine: 'PDM-01', board: 'pdm', outputs: 8, inputs: 2, analog: 0, digitalOut: 0 }] });
  hub = await startFakeBridge();
  const { createSim } = await import('../server/sim.js');
  const { startServer } = await import('../server/index.js');
  sim = await createSim({ scene: 'wstest', bankPort: bank.port, busPort: hub.port, bridge: 'none', tickMs: 50 });
  srv = await startServer(sim, { port: 0 });
  ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.once('open', r));
});

after(async () => {
  ws?.close();
  await srv?.close();
  await sim?.close();
  await bank?.close();
  await hub?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('snapshot on connect', async () => {
  const snap = await nextMsg((m) => m.type === 'snapshot');
  assert.equal(snap.scene.name, 'wstest');
  assert.equal(snap.scene.modules.length, 2);
  assert.ok(Array.isArray(snap.components) && snap.components.length > 0, 'components listed');
  assert.ok(Array.isArray(snap.runs));
  assert.equal(snap.renode.status, 'stopped');
  assert.equal(typeof snap.modules, 'object');
});

test('bank gets the rendered scene and the switch level on connect', async () => {
  const sc = await bank.waitFor((m) => m.type === 'scene' && m.machine === 'PDM-01');
  assert.equal(sc.outputs['1'].loads.length, 1);
  assert.equal(sc.outputs['1'].loads[0].id, 'n1');
  assert.ok(sc.outputs['1'].loads[0].table.length > 10, 'filament inrush table rendered');
  await bank.waitFor((m) => m.type === 'vbatt' && m.machine === '*');
});

test('switch action → bank gpio, with ws result', async () => {
  ws.send(JSON.stringify({ type: 'action', id: 1, action: { kind: 'switch', node: 'n2', state: true } }));
  const r = await nextMsg((m) => m.type === 'result' && m.id === 1);
  assert.equal(r.ok, true);
  const g = await bank.waitFor((m) => m.type === 'gpio' && m.value === 1);
  assert.deepEqual(g, { type: 'gpio', machine: 'PDM-01', pin: 'DI1', value: 1 });
});

test('rotary action → bank adc mV within noise', async () => {
  ws.send(JSON.stringify({ type: 'action', action: { kind: 'rotary', node: 'n3', index: 2 } }));
  const a = await bank.waitFor((m) => m.type === 'adc' && m.machine === 'CB-1' && m.mV > 2000);
  assert.equal(a.ch, 1);
  assert.ok(Math.abs(a.mV - 2500) <= 20);
});

test('keypad action → button frame on the bus; LED frame → keypad message', async () => {
  ws.send(JSON.stringify({ type: 'action', action: { kind: 'keypad', node: 'n4', key: 3, pressed: true } }));
  await hub.waitLine((l) => l === 't1958' + '0800000000000000'); // 21 + 0x180 = 0x195, bit 3
  // firmware → keypad: +0x200 on colours. 8 keys → 1 byte per colour: red byte0, green byte1, blue byte2.
  // key0 red (bit0 byte0), key1 green (bit1 byte1), key2 white (bit2 in bytes 0,1,2)
  hub.sendLine('t2158' + '0506040000000000');
  const k = await nextMsg((m) => m.type === 'keypad' && m.node === 'n4');
  assert.equal(k.leds[0].color, 'red');
  assert.equal(k.leds[1].color, 'green');
  assert.equal(k.leds[2].color, 'white');
  assert.equal(k.leds[3].color, 'off');
});

test('module frames → telemetry broadcast; bus log throttled', async () => {
  hub.sendLine('t6838' + '2900000000000000'); // PDM-01 Msg1: out1 4.1 A
  hub.sendLine('t6858' + '0100000000000000'); // Msg3: out1 On
  const t = await nextMsg((m) => m.type === 'telemetry' && m.module === 'PDM-01' && m.outputs?.[0]?.currentA === 4.1 && m.outputs[0].state === 'On');
  assert.equal(t.asleep, false);
  for (let i = 0; i < 60; i++) hub.sendLine('t6838' + '2900000000000000');
  await new Promise((r) => setTimeout(r, 300));
  const busMsgs = inbox.filter((m) => m.type === 'bus');
  assert.ok(busMsgs.length > 0 && busMsgs.length <= 22, `bus messages throttled (${busMsgs.length})`);
});

test('fault action → bank fault for the load output', async () => {
  ws.send(JSON.stringify({ type: 'action', action: { kind: 'fault', node: 'n1', fault: { kind: 'stall', atMs: 0 } } }));
  const f = await bank.waitFor((m) => m.type === 'fault');
  assert.deepEqual(f, { type: 'fault', machine: 'PDM-01', out: 1, load: 'n1', kind: 'stall', atMs: 0 });
});

test('scene replace broadcasts scene and persists', async () => {
  const sc = structuredClone(SCENE);
  sc.globals.noisePct = 2;
  ws.send(JSON.stringify({ type: 'scene', scene: sc }));
  const m = await nextMsg((x) => x.type === 'scene' && x.scene.globals.noisePct === 2);
  assert.equal(m.scene.name, 'wstest');
  const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'wstest', 'scene.sim.json'), 'utf8'));
  assert.equal(disk.globals.noisePct, 2);
});

test('renode action without Renode → error toast, no crash', async () => {
  ws.send(JSON.stringify({ type: 'action', id: 9, action: { kind: 'renode', cmd: 'pause' } }));
  const r = await nextMsg((m) => m.type === 'result' && m.id === 9);
  assert.equal(r.ok, false);
  assert.ok(inbox.some((m) => m.type === 'toast' && m.level === 'error'));
});

test('REST snapshot + MCP tools over HTTP', async () => {
  const base = `http://127.0.0.1:${srv.port}`;
  const snap = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snap.type, 'snapshot');
  const runs = await (await fetch(`${base}/api/runs`)).json();
  assert.ok(Array.isArray(runs));
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const names = body.result.tools.map((t) => t.name);
  for (const n of ['sim_switch', 'sim_renode', 'sim_state', 'sim_golden_diff', 'sim_trace']) assert.ok(names.includes(n), n);
  const call = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sim_state', arguments: { module: 'PDM-01' } } }),
  });
  const cr = await call.json();
  const st = JSON.parse(cr.result.content[0].text);
  assert.equal(st.modules.module, 'PDM-01');
});

test('ws: a scene sent by one client reaches every other open client', async () => {
  const other = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const got = [];
  other.on('message', (d) => got.push(JSON.parse(d.toString())));
  await new Promise((r) => other.once('open', r));
  const sc = JSON.parse(JSON.stringify(SCENE));
  sc.nodes.push({ id: 'w1', type: 'wiper', pos: {}, data: { ratedW: 60, slowRps: 0.7, fastRps: 1.2, park: 'ford' } });
  ws.send(JSON.stringify({ type: 'scene', id: 77, scene: sc }));
  const m = await until(() => got.find((x) => x.type === 'scene' && x.scene?.nodes?.some((n) => n.id === 'w1')), 3000);
  assert.equal(m.scene.nodes.find((n) => n.id === 'w1').data.park, 'ford');
  other.close();
});

test('ws: the snapshot names the UI build it serves (stale tabs reload onto it)', async () => {
  const c = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const snap = await new Promise((r) => c.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.type === 'snapshot') r(m); }));
  assert.ok('uiBuild' in snap);
  if (snap.uiBuild) assert.match(snap.uiBuild, /^index-.+\.js$/);   // null when the UI is not built
  c.close();
});
