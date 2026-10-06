/**
 * Glob matching + directory walking, dependency-free.
 *
 * Supports the subset every agent actually uses: `**`, `*`, `?`, `[abc]`,
 * `[!abc]` and brace alternation `{a,b}`. Matching is always done on
 * forward-slash paths so Windows and POSIX behave identically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';

/** Directories skipped unless the caller explicitly asks for them. */
export const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.gradle',
  '.idea',
  '.vscode-test',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.cache',
  '.DS_Store',
  'Thumbs.db',
]);

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Expand `{a,b}` alternations into separate patterns. */
function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  let depth = 0;
  let close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [pattern];

  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const body = pattern.slice(open + 1, close);

  const parts = [];
  let level = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '{') level++;
    if (ch === '}') level--;
    if (ch === ',' && level === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);

  return parts.flatMap((p) => expandBraces(`${head}${p}${tail}`));
}

function segmentToRegex(seg) {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      let j = i + 1;
      let negate = false;
      if (seg[j] === '!' || seg[j] === '^') {
        negate = true;
        j++;
      }
      let cls = '';
      for (; j < seg.length && seg[j] !== ']'; j++) {
        cls += seg[j] === '\\' ? '\\\\' : seg[j];
      }
      if (j >= seg.length) {
        out += '\\[';
      } else {
        out += `[${negate ? '^' : ''}${cls}]`;
        i = j;
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/** Compile one glob (no braces left) to an anchored RegExp. */
function globToRegex(pattern) {
  const segments = pattern.split('/');
  let out = '^';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    if (seg === '**') {
      // `**/` matches zero or more directories.
      out += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    out += segmentToRegex(seg);
    if (!last) out += '/';
  }
  return new RegExp(`${out}$`, process.platform === 'win32' ? 'i' : '');
}

/**
 * Build a matcher for a glob pattern.
 * A bare pattern with no `/` also matches at any depth (`*.ts` ≡ `**​/*.ts`),
 * which is what users mean essentially every time.
 */
export function makeMatcher(pattern) {
  const raw = toPosix(String(pattern ?? '').trim());
  if (!raw) return () => true;
  const variants = expandBraces(raw).flatMap((p) => (p.includes('/') ? [p] : [p, `**/${p}`]));
  const regexes = variants.map(globToRegex);
  return (relPosixPath) => regexes.some((re) => re.test(relPosixPath));
}

/** Common file-type shorthands, matching ripgrep's `--type`. */
export const TYPE_GLOBS = {
  js: '**/*.{js,jsx,mjs,cjs}',
  ts: '**/*.{ts,tsx,mts,cts}',
  py: '**/*.{py,pyi}',
  rust: '**/*.rs',
  go: '**/*.go',
  java: '**/*.java',
  c: '**/*.{c,h}',
  cpp: '**/*.{cc,cpp,cxx,hh,hpp,hxx}',
  cs: '**/*.cs',
  rb: '**/*.rb',
  php: '**/*.php',
  swift: '**/*.swift',
  kotlin: '**/*.{kt,kts}',
  sh: '**/*.{sh,bash,zsh}',
  ps1: '**/*.{ps1,psm1}',
  json: '**/*.json',
  yaml: '**/*.{yaml,yml}',
  toml: '**/*.toml',
  xml: '**/*.{xml,xsd,xsl}',
  html: '**/*.{html,htm}',
  css: '**/*.{css,scss,sass,less}',
  md: '**/*.{md,markdown,mdx}',
  sql: '**/*.sql',
  txt: '**/*.txt',
  csv: '**/*.{csv,tsv}',
  notebook: '**/*.ipynb',
};

/**
 * Walk a directory tree.
 * @param {string} root
 * @param {object} opts
 * @param {(rel: string, entry: fs.Dirent, abs: string) => boolean} [opts.accept]
 * @param {boolean} [opts.includeIgnored]
 * @param {boolean} [opts.followSymlinks]
 * @param {number} [opts.maxFiles]
 * @param {number} [opts.maxDepth]
 * @returns {{files: {rel: string, abs: string, size: number, mtimeMs: number}[], truncated: boolean, scanned: number}}
 */
export function walk(root, opts = {}) {
  const {
    accept = () => true,
    includeIgnored = false,
    followSymlinks = false,
    maxFiles = config.limits.maxWalkFiles,
    maxDepth = 64,
  } = opts;

  const files = [];
  let scanned = 0;
  let truncated = false;
  const seenDirs = new Set();

  /** @param {string} dir @param {string} relDir @param {number} depth */
  const visit = (dir, relDir, depth) => {
    if (truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip quietly, this is normal on a real machine
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!followSymlinks) continue;
        try {
          const st = fs.statSync(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      if (isDir) {
        if (!includeIgnored && DEFAULT_IGNORES.has(entry.name)) continue;
        if (followSymlinks) {
          let key;
          try {
            key = fs.realpathSync.native(abs);
          } catch {
            continue;
          }
          if (seenDirs.has(key)) continue;
          seenDirs.add(key);
        }
        visit(abs, rel, depth + 1);
        continue;
      }

      if (!isFile) continue;
      if (!includeIgnored && DEFAULT_IGNORES.has(entry.name)) continue;
      scanned++;
      if (!accept(rel, entry, abs)) continue;
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(abs);
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        /* raced with a delete — keep the entry with zeros */
      }
      files.push({ rel, abs, size, mtimeMs });
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
    }
  };

  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`No such directory: ${root}`);
  }
  if (stat.isFile()) {
    return {
      files: [{ rel: path.basename(root), abs: root, size: stat.size, mtimeMs: stat.mtimeMs }],
      truncated: false,
      scanned: 1,
    };
  }
  visit(root, '', 0);
  return { files, truncated, scanned };
}
