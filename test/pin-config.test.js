// Cards take their name and behaviour from the pin they are wired to, for both project formats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseProjectFull } from '../lib/project.js';
import { populate, pinConfig } from '../lib/populate.js';
import * as comps from '../lib/components.js';

// written by dingoConfig 0.3.0's own domain/application assemblies (ConfigFile + its JSON options)
const upstream = parseProjectFull(fs.readFileSync(new URL('./fixtures/upstream-0.3.0.json', import.meta.url), 'utf8'));
const mod = (id) => upstream.modules.find((m) => m.id === id);

test('upstream 0.3.0: digital inputs give switches with name, toggle/momentary and level', () => {
  assert.deepEqual(pinConfig(mod('PDM-A'), 'di:1'), { type: 'switch', data: { name: 'Ignition', kind: 'toggle', level: '12v' } });
  assert.deepEqual(pinConfig(mod('PDM-A'), 'di:2').data.kind, 'momentary');
  assert.deepEqual(pinConfig(mod('CB-A'), 'di:1').data, { name: 'Brake Pedal', kind: 'toggle', level: 'gnd' });
});

test('upstream 0.3.0: the offset/step rotary becomes a knob with its ladder', () => {
  const r = pinConfig(mod('CB-A'), 'ai:1');
  assert.equal(r.type, 'rotary');
  assert.equal(r.data.name, 'Headlight Switch');
  assert.deepEqual(r.data.positions.map((p) => p.mV), [500, 1500, 2500, 3500]);   // fOffset 500, fStep 1000, fMaxPos 3
});

test('analog input in switch mode becomes a switch on the ai pin; populate wires every card', () => {
  assert.deepEqual(pinConfig(mod('CB-A'), 'ai:2'), { type: 'switch', data: { name: 'Fog Switch', kind: 'toggle', level: '12v' } });
  const r = populate(upstream.modules, comps, { extras: upstream.extras });
  const card = (id) => r.nodes.find((n) => n.id === id);
  assert.equal(card('CB-A.ai1').type, 'rotary');
  assert.equal(card('CB-A.ai2').type, 'switch');
  assert.ok(r.edges.some((e) => e.from.node === 'CB-A.ai2' && e.to.handle === 'ai:2'));
  assert.equal(card('PDM-A.di2').data.name, 'Horn Button');
});

test('fork format: calibrated points and position names; outputs name their loads', () => {
  const fork = parseProjectFull({
    PdmDevices: [{ name: 'P', baseId: 0x680, outputs: [{ number: 1, name: 'Left Low Beam', enabled: true }], inputs: [] }],
    CanboardDevices: [{ name: 'C', baseId: 0x660, digitalIn: [{ number: 3, name: 'Ignition', enabled: true, mode: 0, pull: 2 }],
      analogIn: [{ number: 1, name: 'Headlights', enabled: true, rotary: { enabled: true, numPos: 3, tolerance: 150, points: [500, 1500, 2500], positionNames: ['OFF', 'Park', 'Low'] } }] }],
  });
  const c = fork.modules.find((m) => m.id === 'C');
  assert.deepEqual(pinConfig(c, 'ai:1').data.positions, [{ name: 'OFF', mV: 500 }, { name: 'Park', mV: 1500 }, { name: 'Low', mV: 2500 }]);
  assert.deepEqual(pinConfig(c, 'di:3').data, { name: 'Ignition', kind: 'toggle', level: '12v' });
  assert.deepEqual(pinConfig(fork.modules.find((m) => m.id === 'P'), 'out:1'), { type: 'load', data: { label: 'Left Low Beam' } });
  assert.equal(pinConfig(c, 'di:9'), null);
});
