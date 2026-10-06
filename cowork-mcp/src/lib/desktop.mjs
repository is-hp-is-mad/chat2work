/**
 * Desktop control backend — the host side of Cowork's computer-use tool.
 *
 * On Windows this drives a persistent PowerShell host (see win-computer.ps1)
 * that owns the P/Invoke surface. Keeping it alive is the whole trick: a fresh
 * PowerShell costs ~300 ms per action, which makes a click-look-click loop
 * unusable.
 *
 * Coordinates: the model works in *screenshot* space. Screenshots are scaled
 * down to fit `maxDimension`, and every coordinate coming back from the model
 * is mapped through the last screenshot's origin and scale. That is the same
 * contract Anthropic's computer tool uses, and it is why a screenshot must
 * precede the first click.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, 'win-computer.ps1');
const MARKER = '\n<<<COWORK_END>>>\n';

/* ------------------------------------------------------------- key names */

const VK = {
  // Control keys, under both xdotool and everyday names.
  return: 0x0d, enter: 0x0d, kp_enter: 0x0d,
  escape: 0x1b, esc: 0x1b,
  tab: 0x09,
  space: 0x20,
  backspace: 0x08, back_space: 0x08,
  delete: [0x2e, true], del: [0x2e, true],
  insert: [0x2d, true],
  home: [0x24, true], end: [0x23, true],
  page_up: [0x21, true], pageup: [0x21, true], prior: [0x21, true],
  page_down: [0x22, true], pagedown: [0x22, true], next: [0x22, true],
  left: [0x25, true], up: [0x26, true], right: [0x27, true], down: [0x28, true],
  // Modifiers.
  shift: 0x10, shift_l: 0xa0, shift_r: 0xa1,
  ctrl: 0x11, control: 0x11, ctrl_l: 0xa2, ctrl_r: 0xa3,
  alt: 0x12, alt_l: 0xa4, alt_r: [0xa5, true], option: 0x12,
  super: [0x5b, true], win: [0x5b, true], meta: [0x5b, true], cmd: [0x5b, true], command: [0x5b, true],
  menu: [0x5d, true], apps: [0x5d, true],
  // Locks and system keys.
  caps_lock: 0x14, capslock: 0x14,
  num_lock: [0x90, true], scroll_lock: 0x91,
  print: 0x2c, printscreen: 0x2c, print_screen: 0x2c,
  pause: 0x13,
  // Punctuation, US layout OEM codes.
  minus: 0xbd, equal: 0xbb, plus: 0xbb,
  bracketleft: 0xdb, bracketright: 0xdd,
  backslash: 0xdc, semicolon: 0xba, apostrophe: 0xde, quoteright: 0xde,
  grave: 0xc0, quoteleft: 0xc0, comma: 0xbc, period: 0xbe, slash: 0xbf,
  // Media.
  audiomute: 0xad, audiolowervolume: 0xae, audioraisevolume: 0xaf,
  audionext: 0xb0, audioprev: 0xb1, audiostop: 0xb2, audioplay: 0xb3,
};

for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i;
for (let c = 0; c < 26; c++) VK[String.fromCharCode(97 + c)] = 0x41 + c;
for (let d = 0; d <= 9; d++) VK[String(d)] = 0x30 + d;

/** Characters that need a shifted key on a US layout. */
const SHIFTED = {
  '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8',
  '(': '9', ')': '0', _: 'minus', '+': 'equal', '{': 'bracketleft', '}': 'bracketright',
  '|': 'backslash', ':': 'semicolon', '"': 'apostrophe', '~': 'grave',
  '<': 'comma', '>': 'period', '?': 'slash',
};

const PLAIN = {
  '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash',
  ';': 'semicolon', "'": 'apostrophe', '`': 'grave', ',': 'comma', '.': 'period', '/': 'slash',
};

/** Resolve one key token to `{ vk, extended }`, or null. */
function resolveKey(token) {
  const raw = String(token).trim();
  const name = raw.toLowerCase();

  if (PLAIN[raw]) return resolveKey(PLAIN[raw]);
  if (SHIFTED[raw]) return null; // caller must add shift; handled in parseChord

  const entry = VK[name];
  if (entry === undefined) return null;
  return Array.isArray(entry) ? { vk: entry[0], extended: entry[1] } : { vk: entry, extended: false };
}

/**
 * Parse "ctrl+shift+t" / "alt+Tab" / "Return" into a key sequence.
 * Shifted punctuation ("?" ) is expanded to shift + the base key.
 */
export function parseChord(combo) {
  const parts = String(combo)
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('Empty key combination');

  const keys = [];
  for (const part of parts) {
    if (SHIFTED[part]) {
      keys.push({ vk: VK.shift, extended: false });
      const base = resolveKey(SHIFTED[part]);
      if (!base) throw new Error(`Cannot map key "${part}"`);
      keys.push(base);
      continue;
    }
    const k = resolveKey(part);
    if (!k) {
      throw new Error(
        `Unknown key "${part}". Use names like: Return, Escape, Tab, space, BackSpace, Delete, ` +
          `Home, End, Page_Up, Page_Down, Up, Down, Left, Right, F1-F24, ctrl, alt, shift, super, ` +
          `or a single letter/digit.`,
      );
    }
    keys.push(k);
  }
  return keys;
}

/* ------------------------------------------------------------------ host */

let host = null;

export function platformSupported() {
  return process.platform === 'win32';
}

export function unsupportedReason() {
  if (process.platform === 'darwin') {
    return (
      'Desktop control is not implemented for macOS in this build. It needs Accessibility and Screen ' +
      'Recording permissions plus a CoreGraphics event backend; `cliclick` and `screencapture` would be the ' +
      'shortest route.'
    );
  }
  return (
    'Desktop control is not implemented for Linux in this build. On X11 it would map onto `xdotool` and ' +
    '`import`/`scrot`; Wayland needs a portal-based backend.'
  );
}

function powershellExe() {
  const probe = (cmd) => {
    try {
      const r = spawnSync('where', [cmd], { encoding: 'utf8' });
      if (r.status === 0) return String(r.stdout).split(/\r?\n/)[0].trim();
    } catch {
      /* ignore */
    }
    return null;
  };
  return probe('pwsh') || probe('powershell') || 'powershell.exe';
}

function startHost() {
  const child = spawn(
    powershellExe(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DRIVER],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const state = { child, buffer: '', pending: null, alive: true, stderr: '' };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    state.buffer += chunk.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = state.buffer.indexOf(MARKER)) !== -1) {
      const raw = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + MARKER.length);
      const waiter = state.pending;
      state.pending = null;
      if (!waiter) continue;
      try {
        waiter.resolve(JSON.parse(raw));
      } catch (e) {
        waiter.reject(new Error(`Malformed response from the desktop host: ${e.message}`));
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    state.stderr += c;
    if (state.stderr.length > 8000) state.stderr = state.stderr.slice(-8000);
  });
  const die = (err) => {
    state.alive = false;
    state.pending?.reject(err);
    state.pending = null;
    if (host === state) host = null;
  };
  child.on('exit', () => die(new Error(`The desktop host exited.${state.stderr ? `\n${state.stderr.trim()}` : ''}`)));
  child.on('error', (e) => die(e));

  return state;
}

/** Send one request to the host and await its reply. */
async function send(action, args = {}, timeoutMs = 30_000) {
  if (!platformSupported()) throw new Error(unsupportedReason());
  if (!host?.alive) host = startHost();

  if (host.pending) throw new Error('The desktop host is still busy with the previous action.');

  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      host.pending = null;
      reject(new Error(`Desktop action "${action}" timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    host.pending = {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    host.child.stdin.write(`${JSON.stringify({ action, ...args })}\n`);
  });

  if (!reply.ok) throw new Error(reply.error || `Desktop action "${action}" failed.`);
  return reply.result ?? {};
}

export function shutdownDesktop() {
  try {
    if (host?.alive) {
      host.child.stdin.write(`${JSON.stringify({ action: 'exit' })}\n`);
      host.child.kill();
    }
  } catch {
    /* already gone */
  }
  host = null;
}

/* --------------------------------------------------------- screen state */

/** The frame of reference established by the most recent screenshot. */
let lastShot = null;
let selectedDisplay = null;

export function screenState() {
  return { lastShot, selectedDisplay };
}

export async function displays() {
  const { displays: list } = await send('displays');
  return list;
}

export async function selectDisplay(id) {
  const list = await displays();
  if (list.length === 0) throw new Error('No displays were found.');
  if (id === 'auto' || id === undefined || id === null) {
    const primary = list.find((d) => d.primary) ?? list[0];
    selectedDisplay = primary;
    lastShot = null;
    return primary;
  }
  const numId = Number.parseInt(String(id), 10);
  let found = Number.isFinite(numId) ? list.find((d) => d.id === numId) : null;
  if (!found && typeof id === 'string') {
    const q = id.toLowerCase();
    found = list.find((d) => d.name?.toLowerCase().includes(q));
  }
  if (!found) {
    throw new Error(`No display matching "${id}". Available: ${list.map((d) => `[${d.id}] ${d.name}`).join(', ')}`);
  }
  selectedDisplay = found;
  lastShot = null; // the frame of reference changed
  return found;
}

/**
 * Capture the selected display (or a region of it) and return the file path
 * plus the mapping needed to translate model coordinates back to the screen.
 */
export async function screenshot({ maxDimension = 1568, quality = 75, region } = {}) {
  const list = await displays();
  const target = selectedDisplay ?? list.find((d) => d.primary) ?? list[0];
  if (!target) throw new Error('No displays were found.');

  const area = region
    ? {
        x: target.x + Math.round(region.x),
        y: target.y + Math.round(region.y),
        width: Math.round(region.width),
        height: Math.round(region.height),
      }
    : { x: target.x, y: target.y, width: target.width, height: target.height };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-shot-'));
  const file = path.join(dir, 'screen.jpg');

  const { shot } = await send('screenshot', {
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    maxDim: maxDimension,
    quality,
    path: file,
  });

  lastShot = { ...shot, displayId: target.id, dir };
  return lastShot;
}

/** Map a model-supplied screenshot coordinate to a physical screen point. */
export function toScreen(x, y) {
  if (!lastShot) {
    throw new Error(
      'No screenshot has been taken yet, so there is no coordinate frame to work in. ' +
        'Take a screenshot first — coordinates you give are interpreted in screenshot space.',
    );
  }
  const { originX, originY, scale, width, height } = lastShot;
  if (x < 0 || y < 0 || x > width || y > height) {
    throw new Error(
      `Coordinate (${x}, ${y}) is outside the last screenshot, which is ${width}x${height}. ` +
        'Give coordinates as they appear in the image you were shown.',
    );
  }
  return {
    x: Math.round(originX + x / scale),
    y: Math.round(originY + y / scale),
  };
}

/* ---------------------------------------------------------------- verbs */

export const desktop = {
  ping: () => send('ping'),
  cursorPosition: () => send('cursor_position'),
  move: (x, y) => send('move', { x, y }),
  mouseDown: (button = 'left') => send('mouse_down', { button }),
  mouseUp: (button = 'left') => send('mouse_up', { button }),
  wheel: (dx, dy) => send('wheel', { dx, dy }),
  keyDown: (vk, extended) => send('key_down', { vk, extended }),
  keyUp: (vk, extended) => send('key_up', { vk, extended }),
  chord: (keys) =>
    send('chord', { vks: keys.map((k) => k.vk), extended: keys.map((k) => Boolean(k.extended)) }),
  type: (text) => send('type', { text }, 120_000),
  readClipboard: () => send('read_clipboard'),
  writeClipboard: (text) => send('write_clipboard', { text }),
  windows: () => send('windows'),
  focus: (handle) => send('focus', { handle }),
  launch: (program, args = []) => send('launch', { program, args }),
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
