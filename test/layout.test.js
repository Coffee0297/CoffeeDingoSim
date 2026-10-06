import test from 'node:test';
import assert from 'node:assert/strict';
import { arrange } from '../lib/layout.js';

const mod = (id, kind, baseId) => ({ id, type: 'module', data: { module: { kind, baseId } } });
const sz = { module: { w: 200, h: 300 }, load: { w: 150, h: 100 }, rotary: { w: 120, h: 80 }, battery: { w: 100, h: 60 } };
const size = (n) => sz[n.type];
const overlap = (a, sa, b, sb) => a.x < b.x + sb.w && b.x < a.x + sa.w && a.y < b.y + sb.h && b.y < a.y + sa.h;

test('loads sit right of their module in output order, knobs left, nothing overlaps', () => {
  const nodes = [mod('PDM-01', 'pdm', 0x680), mod('CB-1', 'canboard', 0x660),
    { id: 'l3', type: 'load' }, { id: 'l1', type: 'load' }, { id: 'k1', type: 'rotary' }, { id: 'bat', type: 'battery' }];
  const edges = [
    { source: 'l3', target: 'PDM-01', sourceHandle: 'supply', targetHandle: 'out:3' },
    { source: 'l1', target: 'PDM-01', sourceHandle: 'supply', targetHandle: 'out:1' },
    { source: 'k1', target: 'CB-1', sourceHandle: 'wiper', targetHandle: 'ai:1' },
  ];
  const p = arrange({ nodes, edges }, { size });
  assert.equal(p.size, nodes.length);
  assert.ok(p.get('l1').x > p.get('PDM-01').x + 200, 'load right of its PDM');
  assert.ok(p.get('l1').y < p.get('l3').y, 'output 1 above output 3');
  assert.ok(p.get('k1').x + 120 <= p.get('CB-1').x, 'knob left of its CANBoard');
  assert.ok(p.get('CB-1').x < p.get('PDM-01').x, 'CANBoards before PDMs');
  assert.ok(p.get('bat').y < p.get('PDM-01').y, 'unwired nodes in the top band');
  const ids = [...p.keys()];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = nodes.find((n) => n.id === ids[i]), b = nodes.find((n) => n.id === ids[j]);
    assert.ok(!overlap(p.get(a.id), size(a), p.get(b.id), size(b)), `${a.id} overlaps ${b.id}`);
  }
});
