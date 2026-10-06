// Firmware selection: GitHub releases of Coffee0297/CoffeeDingoFW (tag or `testing-latest`) or a
// local build folder / .elf path. Downloads land in cache/firmware/<tag>/.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from './state.js';

export const REPO = process.env.SIM_FW_REPO || 'Coffee0297/CoffeeDingoFW';
/** board kind → firmware board name (elf prefix and platform repl name) */
export const BOARD = { pdm: 'dingopdm_v7', pdmmax: 'dingopdmmax_v1', canboard: 'canboard_v2' };

function headers() {
  const h = { 'User-Agent': 'CoffeeDingoSim', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

/**
 * List releases that carry .elf assets.
 * @returns {Promise<{tag:string, name?:string, prerelease?:boolean, published?:string, assets:{name:string,url:string}[]}[]>}
 */
export async function listReleases({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const list = await res.json();
  return list
    .map((r) => ({
      tag: r.tag_name, name: r.name, prerelease: r.prerelease, published: r.published_at,
      assets: (r.assets || []).filter((a) => a.name.endsWith('.elf')).map((a) => ({ name: a.name, url: a.browser_download_url })),
    }))
    .filter((r) => r.assets.length);
}

/** Find the `<board>_FW_v*.elf` asset for a kind in a release. */
export function pickAsset(release, kind) {
  const board = BOARD[kind];
  return release.assets.find((a) => a.name.startsWith(`${board}_FW_v`) && a.name.endsWith('.elf')) || null;
}

/** Download (cached) the elf for `kind` from release `tag`. Returns the local path. */
export async function downloadRelease(tag, kind, { fetchImpl = fetch, cacheDir = path.join(CACHE_DIR, 'firmware') } = {}) {
  const dir = path.join(cacheDir, tag);
  const board = BOARD[kind];
  // `testing-latest` is a moving tag: always re-check; fixed tags reuse the cache
  if (tag !== 'testing-latest' && fs.existsSync(dir)) {
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${board}_FW_v`) && f.endsWith('.elf'));
    if (hit) return path.join(dir, hit);
  }
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, { headers: headers() });
  if (!res.ok) throw new Error(`release ${tag}: HTTP ${res.status}`);
  const r = await res.json();
  const rel = { tag: r.tag_name, assets: (r.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url })) };
  const asset = pickAsset(rel, kind);
  if (!asset) throw new Error(`release ${tag} has no ${board}_FW_v*.elf`);
  const dest = path.join(dir, asset.name);
  if (fs.existsSync(dest)) return dest;
  const bin = await fetchImpl(asset.url, { headers: { 'User-Agent': 'CoffeeDingoSim', Accept: 'application/octet-stream' } });
  if (!bin.ok) throw new Error(`download ${asset.name}: HTTP ${bin.status}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dest + '.part', Buffer.from(await bin.arrayBuffer()));
  fs.renameSync(dest + '.part', dest);
  return dest;
}

/** Resolve a local source: a .elf file, or a folder containing `<board>.elf` / `<board>_FW_v*.elf`. */
export function resolveLocal(p, kind) {
  const board = BOARD[kind];
  if (!p) throw new Error(`no local path for ${kind}`);
  if (p.endsWith('.elf')) {
    if (!fs.existsSync(p)) throw new Error(`firmware not found: ${p}`);
    return p;
  }
  for (const cand of [path.join(p, `${board}.elf`), path.join(p, 'build', `${board}.elf`)]) if (fs.existsSync(cand)) return cand;
  if (fs.existsSync(p)) {
    const hit = fs.readdirSync(p).find((f) => f.startsWith(`${board}_FW_v`) && f.endsWith('.elf'));
    if (hit) return path.join(p, hit);
  }
  throw new Error(`no ${board}.elf in ${p}`);
}

/**
 * Resolve the elf for every board kind used by the scene.
 * scene.firmware[kind] = {source:'release', tag} | {source:'local', path}; a plain string is a tag or path.
 * `override` (CI `--firmware build/`) replaces every kind with a local folder.
 * @returns {Promise<Record<string,string>>} kind → elf path
 */
export async function resolveFirmware(scene, { override, fetchImpl } = {}) {
  const kinds = [...new Set((scene.modules || []).map((m) => m.kind))];
  const out = {};
  for (const kind of kinds) {
    let sel = override ? { source: 'local', path: override } : scene.firmware?.[kind];
    if (typeof sel === 'string') sel = sel.match(/[\\/]|\.elf$/) ? { source: 'local', path: sel } : { source: 'release', tag: sel };
    sel ||= { source: 'release', tag: 'testing-latest' };
    out[kind] = sel.source === 'local' ? resolveLocal(sel.path, kind) : await downloadRelease(sel.tag || 'testing-latest', kind, { fetchImpl });
  }
  return out;
}
