/**
 * Session state: the active space (Cowork's "space" = a project workspace),
 * plus the per-space todo list.
 *
 * State lives on disk so it survives Claude Desktop restarts, exactly like a
 * Cowork space does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureLayout } from './config.mjs';
import { JsonStore } from './lib/store.mjs';

const store = new JsonStore(path.join(config.dirs.state, 'state.json'), {
  activeSpace: null,
  spaces: {},
});

/** Space names are folder names — keep them boring and portable. */
export function normalizeSpaceName(name) {
  const clean = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  if (!clean) throw new Error('Space name must contain at least one usable character');
  return clean;
}

export function spacePath(name) {
  return path.join(config.dirs.projects, normalizeSpaceName(name));
}

export function listSpaces() {
  ensureLayout();
  let entries = [];
  try {
    entries = fs.readdirSync(config.dirs.projects, { withFileTypes: true });
  } catch {
    return [];
  }
  const meta = store.read().spaces || {};
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const full = path.join(config.dirs.projects, e.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      return {
        name: e.name,
        path: full,
        description: meta[e.name]?.description ?? '',
        created: meta[e.name]?.created ?? null,
        lastUsed: meta[e.name]?.lastUsed ?? null,
        modified: new Date(mtime).toISOString(),
      };
    })
    .sort((a, b) => (b.lastUsed ?? b.modified).localeCompare(a.lastUsed ?? a.modified));
}

export function createSpace(name, description = '') {
  ensureLayout();
  const clean = normalizeSpaceName(name);
  const dir = spacePath(clean);
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  store.update((s) => {
    s.spaces ??= {};
    s.spaces[clean] = {
      description: description || s.spaces[clean]?.description || '',
      created: s.spaces[clean]?.created ?? new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    };
    return s;
  });
  return { name: clean, path: dir, existed };
}

export function useSpace(name) {
  const clean = normalizeSpaceName(name);
  const dir = spacePath(clean);
  if (!fs.existsSync(dir)) throw new Error(`No space named "${clean}". Create it first with Space(action="create").`);
  store.update((s) => {
    s.activeSpace = clean;
    s.spaces ??= {};
    s.spaces[clean] ??= { description: '', created: new Date().toISOString() };
    s.spaces[clean].lastUsed = new Date().toISOString();
    return s;
  });
  return { name: clean, path: dir };
}

export function deleteSpaceRecord(name) {
  const clean = normalizeSpaceName(name);
  store.update((s) => {
    if (s.spaces) delete s.spaces[clean];
    if (s.activeSpace === clean) s.activeSpace = null;
    return s;
  });
}

export function activeSpace() {
  const s = store.read();
  if (!s.activeSpace) return null;
  const dir = spacePath(s.activeSpace);
  if (!fs.existsSync(dir)) return null;
  return { name: s.activeSpace, path: dir };
}

export function setSpaceDescription(name, description) {
  const clean = normalizeSpaceName(name);
  store.update((s) => {
    s.spaces ??= {};
    s.spaces[clean] ??= { created: new Date().toISOString() };
    s.spaces[clean].description = description;
    return s;
  });
}

/**
 * The base directory every relative path resolves against:
 * the active space when there is one, otherwise the Cowork home.
 */
export function cwd() {
  return activeSpace()?.path ?? config.home;
}

/** Per-space todo list file. */
export function todoFile() {
  const space = activeSpace();
  const dir = space ? path.join(config.dirs.state, 'todos') : config.dirs.state;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, space ? `${space.name}.json` : 'todos.json');
}
