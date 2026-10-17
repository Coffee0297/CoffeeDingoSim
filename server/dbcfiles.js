// DBC files for CAN generator nodes: uploaded from the UI into the scene folder (scenes/<scene>/dbc/), listed
// back as messages and signals so the node can offer frames and slider ranges.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sceneDir, state } from './state.js';
import { parseDbc } from '../lib/dbc.js';

const safe = (n) => path.basename(String(n || 'upload.dbc')).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '') || 'upload.dbc';

/** Messages of a parsed DBC, small enough for the UI: id, name, dlc and each signal's range. */
export function describe(db) {
  return [...db.messages.values()].map((m) => ({
    id: m.id, name: m.name, dlc: m.dlc,
    signals: m.signals.map((s) => ({ name: s.name, min: s.min, max: s.max, factor: s.factor, unit: s.unit, values: s.values })),
  })).sort((a, b) => a.id - b.id);
}

/** Save `text` as `name` in the scene's dbc folder. Throws when it is not a DBC with at least one message. */
export function saveDbc(name, text) {
  const db = parseDbc(String(text || ''));
  if (!db.messages.size) throw new Error('No messages (BO_) in that file: is it a DBC?');
  const dir = path.join(sceneDir(state.sceneName || 'default'), 'dbc');   // no scene loaded yet: the default one
  fs.mkdirSync(dir, { recursive: true });
  const base = safe(name);
  const file = path.join(dir, /\.dbc$/i.test(base) ? base : base + '.dbc');
  fs.writeFileSync(file, text);
  return { path: path.relative(ROOT, file).split(path.sep).join('/'), messages: describe(db) };
}

/** The messages of a DBC the scene already points at (path relative to the Sim root, or absolute). */
export function readDbc(rel) {
  const p = path.resolve(ROOT, rel);
  if (!path.isAbsolute(rel) && !p.startsWith(ROOT)) throw new Error('outside the Sim folder');
  if (!fs.existsSync(p)) throw new Error(`${rel} is not there`);
  return { path: rel, messages: describe(parseDbc(fs.readFileSync(p, 'utf8'))) };
}
