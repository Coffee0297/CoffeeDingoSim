import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, carLamps, lampLook } from '../app/src/car.js';

const load = (id, label, ratedW = 21, component = 'halogen_signal_bulb') => ({ id, type: 'load', data: { component, label, ratedW } });

test('classify reads side, zone, function and count from the name', () => {
  assert.deepEqual(classify('Right Low Beam x2 (1/2)'), { fn: 'low', side: 'R', zone: 'front', count: 1 });
  assert.deepEqual(classify('2x Left headlight'), { fn: 'low', side: 'L', zone: 'front', count: 2 });
  assert.equal(classify('Left Brake + Turn (1/2, P21/5W 21 W)').fn, 'brake');
  assert.equal(classify('Left Rear Indicator').zone, 'rear');
  assert.equal(classify('Right Front Sidemarker').fn, 'marker');
  assert.equal(classify('Left Plate (3/3)').zone, 'rear');
  assert.equal(classify('Horn'), null);
});

test('one node per bulb, "x2" without a part number makes two, shared bulbs merge', () => {
  const scene = { nodes: [
    load('a', 'Right Low Beam x2 (1/2)', 55, 'halogen_headlight'), load('b', 'Right Low Beam x2 (2/2)', 55, 'halogen_headlight'),
    load('c', 'Right High Beam x2 (1/2)', 60, 'halogen_headlight'), load('d', 'Right High Beam x2 (2/2)', 60, 'halogen_headlight'),
    load('e', '2x Left headlight', 55, 'halogen_headlight'),
    load('f', 'Left Tail (1/3)', 5), load('g', 'Left Brake + Turn (1/2)', 21),
    load('h', 'Horn', 40, 'horn'), load('i', 'Mystery lamp', 5),
  ] };
  const { lamps, unplaced } = carLamps(scene);
  const heads = lamps.filter((l) => l.key.includes('|head|'));
  assert.equal(heads.filter((l) => l.key.startsWith('R|')).length, 2);        // low + high share two H4 bulbs
  assert.equal(heads.filter((l) => l.key.startsWith('L|')).length, 2);        // "2x" made two
  assert.ok(heads.filter((l) => l.key.startsWith('R|')).every((l) => l.filaments.length === 2 && l.x > 100));
  const rear = lamps.find((l) => l.key === 'L|rear|rearlamp|0');
  assert.deepEqual(rear.filaments.map((f) => f.fn), ['tail', 'brake']);
  assert.deepEqual(unplaced.map((u) => u.node), ['i']);                       // horn is not a light at all
  // tail alone is dim, brake is full
  assert.ok(lampLook(rear, (n) => (n === 'f' ? 1 : 0)).b < 0.3);
  assert.equal(lampLook(rear, () => 1).b, 1);
  assert.equal(lampLook(rear, () => 0).b, 0);
});
