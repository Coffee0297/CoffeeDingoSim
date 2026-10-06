import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newScene, validateScene, toBankScenes, applyAction, renderOptions } from '../lib/scene.js';

const mod = (id, kind, baseId, outputs = [], extra = {}) => ({
  id,
  kind,
  baseId,
  pos: { x: 0, y: 0 },
  outputs,
  inputs: [{ n: 1, name: 'di1', enabled: true, mode: 0, pull: 0, invert: false }],
  analogIn: [],
  digitalOut: [],
  ...extra,
});
const out = (n, primaryOutput = -1) => ({ n, name: `o${n}`, enabled: true, currentLimit: 10, primaryOutput });

function fixture() {
  const modules = [
    mod('PDM-01', 'pdm', 0x680, [out(1), out(2), out(3), out(4, 2)]), // out 4 follows out 3 (0-based 2)
    mod('CB-1', 'canboard', 0x660, [], {
      analogIn: [{ n: 1, name: 'Head', enabled: true, rotary: { enabled: true, numPos: 3, points: [500, 1500, 2500], positionNames: ['OFF', 'A', 'B'], tolerance: 200 } }],
      digitalOut: [{ n: 1, name: 'Wiper RUN', enabled: true }],
    }),
  ];
  const load = (id, component, family, ratedA) => ({ id, type: 'load', pos: { x: 0, y: 0 }, data: { component, family, preset: null, ratedA, ratedW: ratedA * 13.8, fault: null, guess: false } });
  const nodes = [
    load('a', 'halogen_headlight', 'filament', 4),
    load('b', 'halogen_headlight', 'filament', 4),
    load('h', 'seat_heater', 'heater', 6),
    { id: 'w', type: 'wiper', pos: {}, data: { component: 'wiper_motor', family: 'wiper', ratedA: 4, fault: null } },
    { id: 'r', type: 'rotary', pos: {}, data: { positions: [{ name: 'OFF', mV: 500 }, { name: 'A', mV: 1500 }, { name: 'B', mV: 2500 }], index: 0, noiseMv: 20 } },
    { id: 's', type: 'switch', pos: {}, data: { kind: 'toggle', level: '12v', state: false } },
    { id: 'k', type: 'keypad', pos: {}, data: { model: 'blink', keys: 4, nodeId: 21, pressed: [false, false, false, false], leds: [] } },
    { id: 'battery', type: 'battery', pos: {}, data: { vocV: 12.6, riOhm: 0.015, altV: 14.2 } },
    { id: 'engine', type: 'engine', pos: {}, data: { state: 'off', throttle: 0, speedKph: 0 } },
  ];
  let i = 0;
  const e = (fn, fh, tn, th) => ({ id: `e${++i}`, from: { node: fn, handle: fh }, to: { node: tn, handle: th } });
  const edges = [
    e('a', 'supply', 'PDM-01', 'out:1'),
    e('b', 'supply', 'PDM-01', 'out:1'),
    e('h', 'supply', 'PDM-01', 'out:3'),
    e('h', 'supply', 'PDM-01', 'out:4'),
    e('w', 'supply', 'PDM-01', 'out:2'),
    e('CB-1', 'do:1', 'w', 'run'),
    e('r', 'wiper', 'CB-1', 'ai:1'),
    e('s', 'contact', 'PDM-01', 'di:1'),
    e('engine', 'alternator', 'battery', 'alt'),
  ];
  return newScene('t', 'scenes/t/p.json', modules, { nodes, edges });
}

const fakeRender = (data, opts) => ({
  ratedA: data.ratedA,
  vExp: 0.5,
  tableMs: opts.tableMs,
  horizonMs: opts.horizonMs,
  table: [data.ratedA * 10, data.ratedA * 2],
  steadyA: data.ratedA,
  stallA: 0,
  shortA: 999,
  loopMs: data.family === 'heater' ? undefined : 500,
  settled: false,
  pwm: { onPhaseExp: 0.45 },
});

test('newScene shape and a valid fixture', () => {
  const s = fixture();
  assert.equal(s.version, 1);
  assert.deepEqual(s.project, { path: 'scenes/t/p.json', hash: null });
  assert.equal(s.globals.noisePct, 1);
  assert.deepEqual(validateScene(s), []);
});

test('validateScene catches bad edges, ids and overlapping CAN ranges', () => {
  const s = fixture();
  s.edges.push({ id: 'e1', from: { node: 'a', handle: 'supply' }, to: { node: 'PDM-01', handle: 'out:2' } });
  s.edges.push({ id: 'x1', from: { node: 'nope', handle: 'supply' }, to: { node: 'PDM-01', handle: 'out:1' } });
  s.edges.push({ id: 'x2', from: { node: 'r', handle: 'wiper' }, to: { node: 'PDM-01', handle: 'ai:1' } });
  s.nodes.push({ id: 'z', type: 'gizmo', data: {} });
  s.modules.push(mod('PDM-02', 'pdm', 0x690));
  const errs = validateScene(s).join('\n');
  assert.match(errs, /duplicate edge id e1/);
  assert.match(errs, /load a: more than one supply edge outside a paired output group/);
  assert.match(errs, /unknown node nope/);
  assert.match(errs, /PDM-01 has no target handle "ai:1"/);
  assert.match(errs, /unknown type gizmo/);
  assert.match(errs, /PDM-02: CAN id range overlaps PDM-01/);
  assert.deepEqual(validateScene(null), ['scene is not an object']);
});

test('toBankScenes groups loads per output, splits paired outputs, picks render options per family', () => {
  const s = fixture();
  const msgs = toBankScenes(s, fakeRender);
  assert.deepEqual(
    msgs.map((m) => m.machine),
    ['PDM-01', 'CB-1'],
  );
  const p = msgs[0];
  assert.equal(p.type, 'scene');
  assert.equal(p.vbattV, 13.8);
  assert.equal(p.noisePct, 1);
  assert.deepEqual(Object.keys(p.outputs).sort(), ['1', '2', '3', '4']);
  assert.deepEqual(p.outputs['1'].loads.map((l) => l.id), ['a', 'b']);
  assert.equal(p.outputs['1'].loads[0].tableMs, 1);
  assert.equal(p.outputs['1'].loads[0].horizonMs, 10000);
  assert.equal(p.outputs['1'].loads[0].loopMs, 500); // passthrough
  assert.equal(p.outputs['1'].loads[0].settled, false);
  assert.deepEqual(p.outputs['1'].loads[0].pwm, { onPhaseExp: 0.45 });
  assert.deepEqual(p.outputs['2'].loads.map((l) => l.id), ['w']); // wiper node is a supply too
  // heater on paired 3+4: halved on both, slow render options
  for (const k of ['3', '4']) {
    const [h] = p.outputs[k].loads;
    assert.equal(h.id, 'h');
    assert.equal(h.ratedA, 3);
    assert.equal(h.steadyA, 3);
    assert.deepEqual(h.table, [30, 6]);
    assert.equal(h.tableMs, 100);
    assert.equal(h.horizonMs, 600000);
    assert.equal(h.split, 0.5);
  }
  assert.deepEqual(msgs[1].outputs, {});
  // a load wired only to the primary of a pair is still shared by the follower
  const s2 = { ...s, edges: s.edges.filter((e) => !(e.from.node === 'h' && e.to.handle === 'out:4')) };
  const p2 = toBankScenes(s2, fakeRender)[0];
  assert.equal(p2.outputs['4'].loads[0].ratedA, 3);
  // fault overlay comes from the node
  const s3 = applyAction(s, { kind: 'fault', node: 'a', fault: { kind: 'open', atMs: 0 } });
  assert.deepEqual(toBankScenes(s3, fakeRender)[0].outputs['1'].loads[0].fault, { kind: 'open', atMs: 0 });
  assert.deepEqual(renderOptions('compressor'), { tableMs: 100, horizonMs: 600000 });
  assert.deepEqual(renderOptions('motor'), { tableMs: 1, horizonMs: 10000 });
});

test('applyAction is pure and covers the UI actions', () => {
  const s = fixture();
  const frozen = JSON.stringify(s);
  let t = applyAction(s, { kind: 'switch', node: 's', state: true });
  assert.equal(t.nodes.find((n) => n.id === 's').data.state, true);
  t = applyAction(t, { kind: 'rotary', node: 'r', index: 9 });
  assert.equal(t.nodes.find((n) => n.id === 'r').data.index, 2); // clamped
  t = applyAction(t, { kind: 'keypad', node: 'k', key: 3, pressed: true });
  assert.deepEqual(t.nodes.find((n) => n.id === 'k').data.pressed, [false, false, false, true]);
  t = applyAction(t, { kind: 'fault', node: 'a', fault: { kind: 'stall', atMs: 50 } });
  assert.deepEqual(t.nodes.find((n) => n.id === 'a').data.fault, { kind: 'stall', atMs: 50 });
  t = applyAction(t, { kind: 'fault', node: 'a', fault: null });
  assert.equal(t.nodes.find((n) => n.id === 'a').data.fault, null);
  t = applyAction(t, { kind: 'battery', node: 'battery', vocV: 12.0 });
  assert.deepEqual(t.nodes.find((n) => n.id === 'battery').data, { vocV: 12.0, riOhm: 0.015, altV: 14.2 });
  t = applyAction(t, { kind: 'engine', node: 'engine', state: 'run', throttle: 20 });
  assert.deepEqual(t.nodes.find((n) => n.id === 'engine').data, { state: 'run', throttle: 20, speedKph: 0 });
  t = applyAction(t, { kind: 'temp', module: 'PDM-01', c: 85 });
  assert.equal(t.modules[0].tempC, 85);
  assert.equal(applyAction(t, { kind: 'renode', cmd: 'start' }), t);
  assert.throws(() => applyAction(t, { kind: 'fault', node: 'a', fault: { kind: 'melt' } }), RangeError);
  assert.throws(() => applyAction(t, { kind: 'engine', node: 'engine', state: 'warp' }), RangeError);
  assert.throws(() => applyAction(t, { kind: 'switch', node: 'missing', state: true }), RangeError);
  assert.equal(JSON.stringify(s), frozen); // input untouched
  assert.deepEqual(validateScene(t), []);
});
