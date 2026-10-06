/**
 * Configuration & workspace layout for cowork-mcp.
 *
 * Mirrors Claude Cowork's host-side layout:
 *   <home>/Projects/<space>/   spaces (Cowork "spaces"/projects)
 *   <home>/Artifacts/          generated outputs
 *   <home>/Skills/<name>/      skills (SKILL.md + resources)
 *   <home>/Memory/             durable memory
 *   <home>/Uploads/            files handed to Claude
 *   <home>/.cowork/            server state (todos, tasks, logs)
 *
 * The home defaults to Claude Desktop's own `coworkUserFilesPath` when that is
 * set, so this server operates on the same folder the real Cowork would use.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();

/** The folder layout a workspace root implies. */
function layoutFor(home) {
  return {
    projects: path.join(home, 'Projects'),
    artifacts: path.join(home, 'Artifacts'),
    skills: path.join(home, 'Skills'),
    memory: path.join(home, 'Memory'),
    uploads: path.join(home, 'Uploads'),
    state: path.join(home, '.cowork'),
    logs: path.join(home, '.cowork', 'logs'),
    taskRuns: path.join(home, '.cowork', 'tasks'),
  };
}

/** Claude Desktop's per-user config directory, per platform. */
export function claudeDesktopConfigDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude');
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', 'Claude');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Claude');
}

export function claudeDesktopConfigFile() {
  return path.join(claudeDesktopConfigDir(), 'claude_desktop_config.json');
}

function readDesktopCoworkPath() {
  try {
    const raw = fs.readFileSync(claudeDesktopConfigFile(), 'utf8');
    const json = JSON.parse(raw);
    const p = json?.coworkUserFilesPath;
    if (typeof p === 'string' && p.trim()) return p;
  } catch {
    /* not installed / unreadable — fall through to default */
  }
  return null;
}

/**
 * Where a workspace choice is remembered between runs, so relocating it does
 * not mean editing claude_desktop_config.json (which Claude Desktop rewrites
 * from time to time, dropping anything it does not recognise).
 */
export const LOCAL_CONFIG_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'cowork.config.json',
);

function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeLocalConfig(patch) {
  const next = { ...readLocalConfig(), ...patch };
  fs.writeFileSync(LOCAL_CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function int(v, dflt) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : dflt;
}

function splitList(v) {
  if (!v) return [];
  return String(v)
    .split(path.delimiter === ';' ? /[;,]/ : /[:,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Workspace root, in order of precedence:
 *   1. COWORK_HOME
 *   2. a root previously chosen through the Space tool (cowork.config.json)
 *   3. Claude Desktop's own coworkUserFilesPath, if it has one
 *   4. ~/Claude
 *
 * Only step 4 is a guess; the rest are explicit choices.
 */
function resolveHome() {
  const local = readLocalConfig();
  const chosen =
    process.env.COWORK_HOME?.trim() ||
    (typeof local.home === 'string' && local.home.trim() ? local.home.trim() : null) ||
    readDesktopCoworkPath() ||
    path.join(HOME, 'Claude');
  return { home: path.resolve(chosen), source: sourceOf(local) };
}

function sourceOf(local) {
  if (process.env.COWORK_HOME?.trim()) return 'COWORK_HOME';
  if (typeof local.home === 'string' && local.home.trim()) return 'chosen with the Space tool';
  if (readDesktopCoworkPath()) return "Claude Desktop's coworkUserFilesPath";
  return 'default (~/Claude)';
}

const resolved = resolveHome();

export const config = {
  /** Root of all Cowork user files. Mutable at runtime — see setHome(). */
  home: resolved.home,
  homeSource: resolved.source,
  dirs: layoutFor(resolved.home),

  /**
   * Extra directories the path guard accepts, when it is on at all.
   */
  allowedDirs: splitList(process.env.COWORK_ALLOWED_DIRS),

  /**
   * No sandbox: file tools may touch any path the OS lets them.
   * Set COWORK_RESTRICT=1 to confine them to the workspace instead.
   * COWORK_ALLOW_ALL is still honoured for anyone who set it explicitly.
   */
  allowAll: bool(process.env.COWORK_ALLOW_ALL, true) && !bool(process.env.COWORK_RESTRICT, false),

  /** Shell selection. */
  defaultShell: process.env.COWORK_SHELL?.trim() || (process.platform === 'win32' ? 'powershell' : 'bash'),

  limits: {
    /** Max characters returned from a single tool call before truncation. */
    maxOutputChars: int(process.env.COWORK_MAX_OUTPUT, 60_000),
    /** Max bytes read from a file in one Read call. */
    maxReadBytes: int(process.env.COWORK_MAX_READ_BYTES, 8 * 1024 * 1024),
    /** Default line count for Read. */
    readLines: int(process.env.COWORK_READ_LINES, 2000),
    /** Default Bash timeout (ms) and ceiling. */
    bashTimeout: int(process.env.COWORK_BASH_TIMEOUT, 120_000),
    bashTimeoutMax: int(process.env.COWORK_BASH_TIMEOUT_MAX, 900_000),
    /** Max files walked by Glob/Grep. */
    maxWalkFiles: int(process.env.COWORK_MAX_WALK, 200_000),
    /** Max concurrent background shells. */
    maxBackgroundShells: int(process.env.COWORK_MAX_SHELLS, 32),
  },

  web: {
    userAgent:
      process.env.COWORK_USER_AGENT?.trim() ||
      'Mozilla/5.0 (compatible; cowork-mcp/1.0; +https://modelcontextprotocol.io)',
    timeout: int(process.env.COWORK_WEB_TIMEOUT, 30_000),
    maxBytes: int(process.env.COWORK_WEB_MAX_BYTES, 5 * 1024 * 1024),
    braveKey: process.env.BRAVE_API_KEY?.trim() || '',
    tavilyKey: process.env.TAVILY_API_KEY?.trim() || '',
    searchBackend: process.env.COWORK_SEARCH_BACKEND?.trim() || 'auto',
  },

  debug: bool(process.env.COWORK_DEBUG, false),
};

/** Directories that always exist. */
export function ensureLayout() {
  for (const dir of Object.values(config.dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const readme = path.join(config.home, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        '# Claude Cowork files',
        '',
        'This folder is managed by **cowork-mcp**, a Model Context Protocol server that gives',
        'Claude Desktop the same working surface as Claude Cowork — on your machine directly,',
        'with no virtual machine.',
        '',
        '| Folder | Purpose |',
        '| --- | --- |',
        '| `Projects/` | Spaces. One folder per piece of ongoing work. |',
        '| `Artifacts/` | Documents, reports and files Claude produces for you. |',
        '| `Skills/` | Reusable instructions Claude can load on demand (`SKILL.md`). |',
        '| `Memory/` | Notes Claude keeps between conversations. |',
        '| `Uploads/` | Drop files here for Claude to work on. |',
        '| `.cowork/` | Server state: todos, background tasks, logs. |',
        '',
        'Everything here is plain files. Delete anything you do not want kept.',
        '',
      ].join('\n'),
      'utf8',
    );
  }
}

/** All roots the path guard accepts. */
export function allowedRoots() {
  const roots = [config.home, ...config.allowedDirs];
  return roots.map((r) => path.resolve(r));
}

/**
 * Move the workspace root. The choice is persisted, so it survives a restart
 * without touching claude_desktop_config.json.
 *
 * @param {string} dir
 * @returns {{home: string, created: boolean, envOverride: string|null}}
 */
export function setHome(dir) {
  const next = path.resolve(String(dir ?? '').trim());
  if (!next || next === path.parse(next).root) {
    throw new Error('Refusing to use a filesystem root as the workspace. Pick a folder.');
  }

  const existed = fs.existsSync(next);
  if (existed && !fs.statSync(next).isDirectory()) {
    throw new Error(`${next} exists but is not a directory.`);
  }
  fs.mkdirSync(next, { recursive: true });

  // Prove it is usable before committing to it.
  const probe = path.join(next, '.cowork-write-probe');
  try {
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe);
  } catch (e) {
    throw new Error(`Cannot write to ${next}: ${e.message}`);
  }

  config.home = next;
  config.dirs = layoutFor(next);
  config.homeSource = 'chosen with the Space tool';
  writeLocalConfig({ home: next });
  ensureLayout();

  return {
    home: next,
    created: !existed,
    envOverride: process.env.COWORK_HOME?.trim() || null,
  };
}
