// ui.js — UI-only state shared across panels (selection, side tab, theme, context menu).
import { writable } from 'svelte/store';

/**
 * What the side chart follows:
 *  { kind:'load',    id, label }
 *  { kind:'output',  machine, n, label }
 *  { kind:'battery', id } | { kind:'engine', id } | { kind:'module', id } | { kind:'wiper', id }
 *  { kind:'node', id, type } | null
 */
export const selection = writable(null);

/** 'chart' | 'renode' | 'runs' | 'bus' */
export const sideTab = writable('chart');

/** { x, y, nodeId } for the load fault menu, or null. */
export const contextMenu = writable(null);

/** Transient hint shown at the bottom of the canvas (invalid wire reason, drop feedback). */
export const canvasHint = writable('');

function initialTheme() {
  try {
    const t = document.documentElement.dataset.theme;
    return t === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export const theme = writable(initialTheme());
theme.subscribe((t) => {
  try {
    document.documentElement.dataset.theme = t;
    localStorage.setItem('cds-theme', t);
  } catch {}
});

export function toggleTheme() {
  theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
}

let hintTimer = null;
export function flashHint(text, ms = 2500) {
  canvasHint.set(text);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => canvasHint.set(''), ms);
}

/** Palette → canvas: add a node at the viewport centre (keyboard / click path). {type, component?, preset?} */
export const addRequest = writable(null);
