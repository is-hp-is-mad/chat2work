/**
 * Path resolution and the (optional) workspace guard.
 *
 * Cowork isolates work inside a VM. We have no sandbox, so instead we resolve
 * every path against the active space and check it against a set of allowed
 * roots. `COWORK_ALLOW_ALL=1` turns the check off entirely.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { config, allowedRoots } from '../config.mjs';

export class PathDenied extends Error {
  constructor(target, roots) {
    super(
      `Path is outside the allowed workspace: ${target}\n` +
        `Allowed roots:\n${roots.map((r) => `  - ${r}`).join('\n')}\n` +
        `This restriction only applies because COWORK_RESTRICT=1 is set. ` +
        `Widen it with COWORK_ALLOWED_DIRS, or unset COWORK_RESTRICT to allow any path.`,
    );
    this.name = 'PathDenied';
  }
}

/** Expand `~`, env vars and make absolute relative to `base`. */
export function expand(p, base) {
  let out = String(p ?? '').trim();
  if (!out) throw new Error('Empty path');
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(1));
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] ?? m);
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, k) => process.env[k] ?? m);
  if (!path.isAbsolute(out)) out = path.resolve(base, out);
  return path.resolve(out);
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a user-supplied path and enforce the guard.
 * Symlinks are resolved as far as they exist so a link cannot escape the roots.
 */
export function resolvePath(p, base) {
  const abs = expand(p, base ?? config.home);
  if (config.allowAll) return abs;

  const roots = allowedRoots();
  const real = realpathUpwards(abs);
  if (roots.some((r) => isInside(real, realpathUpwards(r)))) return abs;
  throw new PathDenied(abs, roots);
}

/** realpath of the nearest existing ancestor, with the rest appended. */
function realpathUpwards(p) {
  let cur = p;
  const tail = [];
  for (;;) {
    try {
      return path.resolve(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when the guard would allow this path. Never throws. */
export function isAllowed(p, base) {
  try {
    resolvePath(p, base);
    return true;
  } catch {
    return false;
  }
}

/** Display a path relative to the Cowork home when possible. */
export function pretty(p) {
  const abs = path.resolve(p);
  if (isInside(abs, config.home)) {
    const rel = path.relative(config.home, abs);
    return rel === '' ? '~cowork' : `~cowork/${rel.split(path.sep).join('/')}`;
  }
  return abs;
}
