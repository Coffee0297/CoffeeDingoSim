import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConnection, sceneToFlow, flowToScene, sceneJson, nextId, loadFromComponent, BUILTIN_COMPONENTS, keywordComponent } from '../app/src/scene.js';
import { buildScene } from '../app/src/mock.js';

const conn = (source, sourceHandle, target, targetHandle) => ({ source, sourceHandle, target, targetHandle });

test('mock scene round-trips through the flow conversion unchanged', () => {
  const s = buildScene();
  const f = sceneToFlow(s);
  assert.equal(f.nodes.length, s.modules.length + s.nodes.length);
  assert.equal(f.edges.length, s.edges.length);
  assert.equal(sceneJson(flowToScene(s, f.nodes, f.edges)), sceneJson(s));
});

test('edge rules: compatible handles only', () => {
  const s = buildScene();
  const edges = s.edges;
  const v = (c) => validateConnection(s, edges, c);
  // new load n9 is already on PDM-02 out 6 — a fresh one is needed for positive checks
  const s2 = { ...s, nodes: [...s.nodes, { id: 'n99', type: 'load', pos: {}, data: {} }] };
  assert.equal(validateConnection(s2, edges, conn('n99', 'supply', 'PDM-01', 'out:3')).ok, true);
  assert.equal(validateConnection(s2, edges, conn('n99', 'supply', 'PDM-01', 'out:1')).ok, true, 'loads may share an output');
  assert.equal(v(conn('n10', 'contact', 'PDM-01', 'out:3')).ok, false, 'switch cannot feed an output');
  assert.equal(v(conn('n1', 'supply', 'PDM-01', 'di:1')).ok, false, 'load cannot drive an input');
  assert.equal(v(conn('n1', 'supply', 'PDM-02', 'out:2')).ok, false, 'a load has one supply edge');
  assert.equal(v(conn('n12', 'wiper', 'CB-1', 'ai:1')).ok, false, 'input already driven');
  assert.equal(v(conn('n12', 'wiper', 'CB-1', 'ai:2')).ok, true);
  assert.equal(v(conn('n1', 'supply', 'PDM-01', 'out:1')).ok, false, 'duplicate');
});

test('paired outputs accept the same load', () => {
  const s = buildScene();
  s.modules[0].outputs[1].primaryOutput = 0; // out 2 follows out 1 (0-based index)
  assert.equal(validateConnection(s, s.edges, conn('n1', 'supply', 'PDM-01', 'out:2')).ok, true);
  assert.equal(validateConnection(s, s.edges, conn('n1', 'supply', 'PDM-01', 'out:3')).ok, false);
});

test('ids, presets and keywords', () => {
  assert.equal(nextId('n', [{ id: 'n1' }, { id: 'n17' }, { id: 'PDM-01' }]), 'n18');
  const d = loadFromComponent(BUILTIN_COMPONENTS.find((c) => c.id === 'halogen_headlight'), 'H4 low 55 W');
  assert.equal(d.ratedW, 55);
  assert.equal(d.ratedA, 3.99);
  assert.equal(keywordComponent('Low Beam x2').id, 'halogen_headlight');
  assert.equal(keywordComponent('Fuel Pump').id, 'fuel_pump');
  assert.equal(keywordComponent('Spare'), null);
});

test('load card titles name the bulb, wired inputs name the pin', async () => {
  const { loadTitle, wiredInput } = await import('../app/src/scene.js');
  assert.equal(loadTitle('Right Low Beam x2 (1/2)', true), 'Right Low Beam · bulb 1 of 2');
  assert.equal(loadTitle('Wiper Motor (2/2)'), 'Wiper Motor · part 2 of 2');
  assert.equal(loadTitle('Horn'), 'Horn');
  assert.equal(loadTitle(undefined), '');
  const edges = [{ from: { node: 'CB-1.di2', handle: 'contact' }, to: { node: 'CB-1', handle: 'di:2' } },
    { from: { node: 'CB-1.ai1', handle: 'wiper' }, to: { node: 'CB-1', handle: 'ai:1' } }];
  assert.equal(wiredInput(edges, 'CB-1.di2'), 'CB-1 DI2');
  assert.equal(wiredInput(edges, 'CB-1.ai1'), 'CB-1 AI1');
  assert.equal(wiredInput(edges, 'nope'), null);
});
