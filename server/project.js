// dingoConfig ConfigFile import (fs side). Uses lib/project.js + lib/populate.js when present; the
// built-in fallback only maps modules (names, kinds, base ids, outputs, inputs, analog, DOs) and adds
// a battery and an engine, so the server is usable before the lib workstream lands.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './state.js';
import { getProjectLibs, getComponents } from './compat.js';

/** Read + hash a project file. */
export function readProject(p) {
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  const text = fs.readFileSync(abs, 'utf8');
  return { abs, json: JSON.parse(text), hash: crypto.createHash('sha1').update(text).digest('hex') };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
const OUT_KEYS = ['enabled', 'name', 'currentLimit', 'inrushCurrentLimit', 'inrushTime', 'resetMode', 'resetTime', 'resetCountLimit', 'pwmEnabled', 'fixedDutyCycle', 'frequency', 'primaryOutput'];
const IN_KEYS = ['name', 'enabled', 'mode', 'pull', 'invert'];

/** Fallback ConfigFile → modules[] (docs/interfaces.md §3). */
export function modulesFromConfig(cfg) {
  const mods = [];
  const pdm = (d, kind) => ({
    id: d.name, kind, baseId: d.baseId, pos: { x: 0, y: 0 },
    outputs: (d.outputs || []).map((o) => ({ n: o.number, ...pick(o, OUT_KEYS) })),
    inputs: (d.inputs || []).map((i) => ({ n: i.number, ...pick(i, IN_KEYS) })),
    analogIn: [], digitalOut: [],
  });
  for (const d of cfg.PdmDevices || []) mods.push(pdm(d, d.pdmType === 1 ? 'pdmmax' : 'pdm'));
  for (const d of cfg.PdmMaxDevices || []) mods.push(pdm(d, 'pdmmax'));
  for (const d of cfg.CanboardDevices || []) {
    mods.push({
      id: d.name, kind: 'canboard', baseId: d.baseId, pos: { x: 0, y: 0 }, outputs: [],
      inputs: (d.digitalIn || []).map((i) => ({ n: i.number, ...pick(i, IN_KEYS) })),
      analogIn: (d.analogIn || []).map((a) => ({ n: a.number, name: a.name, enabled: a.enabled, rotary: a.rotary ? pick(a.rotary, ['enabled', 'numPos', 'points', 'positionNames', 'tolerance']) : undefined })),
      digitalOut: (d.digitalOut || []).map((o) => ({ n: o.number, name: o.name, enabled: o.enabled })),
    });
  }
  mods.forEach((m, i) => { m.pos = { x: i * 320, y: 0 }; });
  return mods;
}

/**
 * Import a project and build a scene (populate when lib/populate.js is present).
 * @param {string} projectPath @param {any} baseScene current scene (firmware/globals are kept)
 * @returns {Promise<{scene:any, notes:string[]}>}
 */
export async function importProject(projectPath, baseScene = {}) {
  const { abs, json, hash } = readProject(projectPath);
  const libs = await getProjectLibs();
  let modules = null;
  if (libs.importProject) {
    try { modules = libs.importProject(json); modules = Array.isArray(modules) ? modules : modules?.modules; } catch (e) { console.warn(`[project] lib import failed: ${e.message}`); }
  }
  const extras = modules?.extras ?? {};
  if (!Array.isArray(modules)) modules = modulesFromConfig(json);
  if (!modules.length) {
    const skipped = (extras.skipped || []).map((s) => `${s.name} (${s.reason})`).join(', ');
    throw new Error(`no dingoPDM, PDM-Max or CANBoard devices found in ${path.basename(abs)}` + (skipped ? ` — skipped: ${skipped}` : ''));
  }
  let nodes = [], edges = [], notes = [];
  if (libs.populate) {
    try {
      const comps = await getComponents();
      // extras carry the project's DBC/ECU devices and keypads, which become CAN generator / keypad nodes
      const r = libs.populate(modules, comps.lib, { extras });
      nodes = r.nodes || []; edges = r.edges || []; notes = r.notes || [];
    } catch (e) { notes.push(`populate failed: ${e.message}`); }
  }
  for (const s of extras.skipped || []) notes.push(`${s.name} not simulated: ${s.reason}.`);
  if (!nodes.some((n) => n.type === 'battery')) nodes.push({ id: 'battery', type: 'battery', pos: { x: -400, y: 0 }, data: { vocV: 12.6, riOhm: 0.015, altV: 14.2 } });
  if (!nodes.some((n) => n.type === 'engine')) nodes.push({ id: 'engine', type: 'engine', pos: { x: -400, y: 200 }, data: { state: 'off', throttle: 0, speedKph: 0, dbc: 'renode/SimEngine.dbc' } });
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  const scene = {
    version: 1,
    name: baseScene.name || path.basename(path.dirname(abs)),
    project: { path: rel.startsWith('..') ? abs : rel, hash },
    firmware: baseScene.firmware || {},
    modules, nodes, edges,
    globals: baseScene.globals || { noisePct: 1 },
  };
  return { scene, notes };
}
