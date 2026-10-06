/**
 * Persistent REPLs — Cowork's `JavaScript` and `REPL` tools.
 *
 * Both keep state between calls, so Claude can build up a dataset, inspect it,
 * then chart it without re-running the earlier steps.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { config } from '../config.mjs';
import { cwd } from '../session.mjs';
import { ok, fail, guard } from '../lib/result.mjs';
import { clamp } from '../lib/text.mjs';

/* ------------------------------------------------------- JavaScript REPL */

let jsContext = null;
let jsLog = [];

function inspect(value, depth = 0) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return depth === 0 ? value : JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2);
  } catch {
    return String(value);
  }
}

function createJsContext() {
  jsLog = [];
  const capture =
    (level) =>
    (...args) => {
      jsLog.push(args.map((a) => inspect(a, 1)).join(' '));
      if (level === 'error') jsLog[jsLog.length - 1] = `[error] ${jsLog[jsLog.length - 1]}`;
    };

  const require = createRequire(path.join(cwd(), 'noop.js'));
  const sandbox = {
    console: { log: capture('log'), info: capture('log'), warn: capture('warn'), error: capture('error'), debug: capture('log') },
    require,
    fetch,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    process,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    structuredClone,
    fs,
    path,
    os,
    __cowork: { home: config.home, space: cwd() },
  };
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  jsContext = vm.createContext(sandbox);
  return jsContext;
}

/**
 * Find the last top-level statement so its value can be reported the way a
 * REPL would. Returns null when the code does not end in an expression.
 */
function splitTrailingExpression(code) {
  let depth = 0;
  let quote = null;
  let lastBoundary = 0;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const prev = code[i - 1];

    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && code[i + 1] === '/') {
      const nl = code.indexOf('\n', i);
      i = nl === -1 ? code.length : nl - 1;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end === -1 ? code.length : end + 1;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0 && (ch === ';' || ch === '\n')) {
      if (code.slice(lastBoundary, i).trim()) lastBoundary = i + 1;
      else lastBoundary = i + 1;
    }
    void prev;
  }

  const tail = code.slice(lastBoundary).trim();
  if (!tail) return null;
  if (/^(return|if|for|while|do|switch|try|throw|var|let|const|function|class|import|export|break|continue|else|async\s+function)\b/.test(tail)) {
    return null;
  }
  return { head: code.slice(0, lastBoundary), tail };
}

async function javascriptTool({ code, restart }) {
  if (restart || !jsContext) createJsContext();
  jsLog = [];

  // Wrap in an async IIFE so `await` works at the top level. When the snippet
  // ends in an expression, return it so the REPL can echo the value.
  const split = splitTrailingExpression(code);
  const candidates = [];
  if (split) candidates.push(`(async () => {\n${split.head}\nreturn (\n${split.tail}\n);\n})()`);
  candidates.push(`(async () => {\n${code}\n})()`);

  let script = null;
  let compileError = null;
  for (const source of candidates) {
    try {
      script = new vm.Script(source, { filename: 'repl.js' });
      break;
    } catch (e) {
      compileError ??= e;
    }
  }
  if (!script) return fail(`Syntax error:\n${compileError?.message ?? 'could not compile'}`);

  let value;
  let threw = null;
  try {
    value = await script.runInContext(jsContext, { timeout: 120_000, displayErrors: true });
  } catch (e) {
    threw = e;
  }

  const parts = [];
  if (jsLog.length) parts.push(jsLog.join('\n'));
  if (threw) {
    parts.push(`[exception]\n${threw?.stack ?? String(threw)}`);
  } else if (value !== undefined) {
    parts.push(`=> ${inspect(value)}`);
  }
  if (!parts.length) parts.push('(no output)');

  return ok(clamp(parts.join('\n\n'), config.limits.maxOutputChars, 'REPL output'), {
    errored: Boolean(threw),
  });
}

/* ----------------------------------------------------------- Python REPL */

const DRIVER = String.raw`
import sys, json, io, traceback, base64, os

# Windows translates "\n" to "\r\n" on a text stream, which would corrupt the
# framing marker the host reads. Pin the newline handling.
try:
    sys.__stdout__.reconfigure(newline="\n", encoding="utf-8")
except Exception:
    pass

GLOBALS = {"__name__": "__cowork__"}
END = "<<<COWORK_END>>>"

def run(code):
    out, err = io.StringIO(), io.StringIO()
    so, se = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    result = None
    error = None
    try:
        try:
            compiled = compile(code, "<cowork>", "eval")
            result = eval(compiled, GLOBALS)
        except SyntaxError:
            exec(compile(code, "<cowork>", "exec"), GLOBALS)
    except BaseException:
        error = traceback.format_exc()
    finally:
        sys.stdout, sys.stderr = so, se
    return {
        "stdout": out.getvalue(),
        "stderr": err.getvalue(),
        "result": None if result is None else repr(result),
        "error": error,
    }

while True:
    line = sys.stdin.readline()
    if not line:
        break
    line = line.strip()
    if not line:
        continue
    try:
        payload = json.loads(line)
    except Exception:
        continue
    if payload.get("op") == "exit":
        break
    res = run(payload.get("code", ""))
    sys.__stdout__.write(json.dumps(res) + "\n" + END + "\n")
    sys.__stdout__.flush()
`;

let py = null;

function pythonExe() {
  return process.env.COWORK_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3');
}

function startPython() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-py-'));
  const driver = path.join(dir, 'driver.py');
  fs.writeFileSync(driver, DRIVER, 'utf8');

  const child = spawn(pythonExe(), ['-u', driver], {
    cwd: cwd(),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    windowsHide: true,
  });

  const state = { child, dir, buffer: '', pending: null, alive: true, startupError: '' };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    // Normalise CRLF so the framing marker matches on every platform.
    state.buffer += chunk.replace(/\r\n/g, '\n');
    const marker = '\n<<<COWORK_END>>>\n';
    let idx;
    while ((idx = state.buffer.indexOf(marker)) !== -1) {
      const raw = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + marker.length);
      const resolve = state.pending;
      state.pending = null;
      if (resolve) {
        try {
          resolve.ok(JSON.parse(raw));
        } catch (e) {
          resolve.fail(new Error(`Malformed response from the Python process: ${e.message}`));
        }
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => {
    state.startupError += c;
  });
  child.on('exit', () => {
    state.alive = false;
    state.pending?.fail(new Error(`The Python process exited.${state.startupError ? `\n${state.startupError}` : ''}`));
    state.pending = null;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  child.on('error', (e) => {
    state.alive = false;
    state.startupError += e.message;
    state.pending?.fail(e);
    state.pending = null;
  });

  return state;
}

function pythonEval(code, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!py?.alive) return reject(new Error('The Python process is not running.'));
    if (py.pending) return reject(new Error('The Python REPL is still busy with the previous call.'));

    const timer = setTimeout(() => {
      py.pending = null;
      try {
        py.child.kill();
      } catch {
        /* ignore */
      }
      py = null;
      reject(new Error(`Python code timed out after ${timeoutMs} ms; the REPL was restarted.`));
    }, timeoutMs);

    py.pending = {
      ok: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      fail: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    py.child.stdin.write(`${JSON.stringify({ code })}\n`);
  });
}

async function pythonTool({ code, restart, timeout }) {
  if (restart && py) {
    try {
      py.child.kill();
    } catch {
      /* ignore */
    }
    py = null;
  }
  if (!py?.alive) py = startPython();

  let res;
  try {
    res = await pythonEval(code, timeout ?? 180_000);
  } catch (e) {
    const detail = py?.startupError?.trim();
    return fail(
      e.message,
      detail
        ? `Python said:\n${detail}`
        : `Check that "${pythonExe()}" is on PATH, or set COWORK_PYTHON to the interpreter you want.`,
    );
  }

  const parts = [];
  if (res.stdout) parts.push(res.stdout.replace(/\s+$/, ''));
  if (res.stderr) parts.push(`[stderr]\n${res.stderr.replace(/\s+$/, '')}`);
  if (res.error) parts.push(`[exception]\n${res.error.replace(/\s+$/, '')}`);
  else if (res.result) parts.push(`=> ${res.result}`);
  if (!parts.length) parts.push('(no output)');

  return ok(clamp(parts.join('\n\n'), config.limits.maxOutputChars, 'Python output'), {
    errored: Boolean(res.error),
  });
}

export function shutdownRepls() {
  try {
    py?.child.kill();
  } catch {
    /* ignore */
  }
  py = null;
  jsContext = null;
}

/* -------------------------------------------------------------- register */

export function registerReplTools(server) {
  server.registerTool(
    'JavaScript',
    {
      title: 'Run JavaScript',
      description:
        'Execute JavaScript in a persistent Node.js context. Variables survive between calls. ' +
        'Top-level await works. `require`, `fetch`, `fs`, `path` and `os` are available. ' +
        'Good for quick calculations, JSON wrangling and API calls.',
      inputSchema: {
        code: z.string().describe('JavaScript to run. The final expression value is reported.'),
        restart: z.boolean().optional().describe('Discard all previous state first.'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(javascriptTool),
  );

  server.registerTool(
    'REPL',
    {
      title: 'Run Python',
      description:
        'Execute Python in a persistent interpreter. Variables, imports and loaded dataframes survive between calls. ' +
        'This is the right tool for data analysis, document generation (python-docx, openpyxl, reportlab) and plotting. ' +
        'Install packages with Bash first if they are missing.',
      inputSchema: {
        code: z.string().describe('Python source. A trailing expression is echoed as its repr.'),
        restart: z.boolean().optional().describe('Restart the interpreter, discarding all state.'),
        timeout: z.number().int().min(1000).max(900_000).optional().describe('Milliseconds before giving up (default 180000).'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(pythonTool),
  );
}
