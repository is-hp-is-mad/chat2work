/**
 * Execution tools — Cowork's `Bash` (plus `BashOutput` / `KillShell`).
 *
 * Commands run directly on the host: no VM, no sandbox. The path guard does
 * not apply here, because a shell command is by nature unrestricted — Claude
 * Desktop's own per-call approval is the control point.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';

import { config } from '../config.mjs';
import { cwd } from '../session.mjs';
import { resolvePath, pretty } from '../lib/paths.mjs';
import { ok, fail, guard } from '../lib/result.mjs';
import { clamp, stripAnsi } from '../lib/text.mjs';

/** Rolling buffer so a chatty background job cannot exhaust memory. */
class RingBuffer {
  constructor(maxChars = 2_000_000) {
    this.maxChars = maxChars;
    this.text = '';
    this.dropped = 0;
  }
  push(chunk) {
    this.text += chunk;
    if (this.text.length > this.maxChars) {
      const excess = this.text.length - this.maxChars;
      this.text = this.text.slice(excess);
      this.dropped += excess;
    }
  }
  /** Consume everything written since the last drain. */
  drain() {
    const out = this.text;
    this.text = '';
    return out;
  }
}

/** @type {Map<string, any>} */
const shells = new Map();
let shellCounter = 0;

function which(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(probe, [cmd], { encoding: 'utf8' });
    if (res.status === 0) {
      const first = String(res.stdout).split(/\r?\n/).find((l) => l.trim());
      return first ? first.trim() : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

const whichCache = new Map();
function whichCached(cmd) {
  if (!whichCache.has(cmd)) whichCache.set(cmd, which(cmd));
  return whichCache.get(cmd);
}

const POWERSHELL_PRELUDE = [
  '$ErrorActionPreference = "Continue"',
  '$ProgressPreference = "SilentlyContinue"',
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  'try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  '',
].join('\n');

const POWERSHELL_EPILOGUE = [
  '',
  '$__cw_code = $LASTEXITCODE',
  'if ($null -eq $__cw_code) { $__cw_code = 0 }',
  'exit $__cw_code',
].join('\n');

/**
 * Locate a POSIX shell. On Windows the `bash` on PATH is usually
 * `System32\bash.exe`, the WSL launcher — it cannot run a script written to a
 * Windows path, so prefer Git Bash when it is installed.
 */
function findPosixShell(preferred) {  if (process.platform !== 'win32') {
    return whichCached(preferred === 'sh' ? 'sh' : 'bash') || whichCached('sh') || 'bash';
  }
  const candidates = [process.env.COWORK_BASH];

  // Git for Windows ships bash; find it relative to whichever git is on PATH,
  // since it is often installed outside Program Files.
  const git = whichCached('git');
  if (git) {
    const gitRoot = path.dirname(path.dirname(git));
    candidates.push(
      path.join(gitRoot, 'bin', 'bash.exe'),
      path.join(gitRoot, 'usr', 'bin', 'bash.exe'),
      path.join(path.dirname(gitRoot), 'bin', 'bash.exe'),
    );
  }
  candidates.push(
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  );

  for (const candidate of candidates.filter(Boolean)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const onPath = whichCached('bash');
  // A WSL launcher would silently fail on a C:\ script path; say so instead.
  if (onPath && /system32[\\/]bash\.exe$/i.test(onPath)) return null;
  return onPath;
}

/**
 * Resolve which interpreter to use and materialise the command as a script
 * file. Writing a script sidesteps every cross-platform quoting trap.
 */
function prepareCommand(command, requested) {
  const shell = requested || config.defaultShell;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-'));

  if (shell === 'powershell' || shell === 'pwsh') {
    const exe =
      (shell === 'pwsh' ? whichCached('pwsh') : whichCached('pwsh') || whichCached('powershell')) ||
      'powershell.exe';
    const file = path.join(dir, 'cmd.ps1');
    fs.writeFileSync(file, POWERSHELL_PRELUDE + command + POWERSHELL_EPILOGUE, 'utf8');
    return { exe, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], dir, shell: 'powershell' };
  }

  if (shell === 'cmd') {
    const file = path.join(dir, 'cmd.bat');
    fs.writeFileSync(file, `@echo off\r\nchcp 65001 >nul\r\n${command}\r\n`, 'utf8');
    return { exe: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/c', file], dir, shell: 'cmd' };
  }

  const exe = findPosixShell(shell);
  if (!exe) {
    cleanupTemp(dir);
    throw new Error(
      'No usable bash was found. The only `bash` on PATH is the WSL launcher, which cannot run a Windows-path ' +
        'script. Install Git for Windows, point COWORK_BASH at a bash.exe, or use shell: "powershell".',
    );
  }
  const file = path.join(dir, 'cmd.sh');
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -o pipefail\n${command}\n`, 'utf8');
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* not meaningful on Windows */
  }
  return { exe, args: [file], dir, shell: shell === 'sh' ? 'sh' : 'bash' };
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* already gone */
  }
}

function cleanupTemp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ Bash */

async function bashTool({ command, description, timeout, run_in_background, cwd: workDir, shell }) {
  const base = workDir ? resolvePath(workDir, cwd()) : cwd();
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });

  const limit = Math.min(timeout ?? config.limits.bashTimeout, config.limits.bashTimeoutMax);
  const prep = prepareCommand(command, shell);

  const env = {
    ...process.env,
    COWORK_HOME: config.home,
    COWORK_SPACE: base,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };

  if (run_in_background) {
    if (shells.size >= config.limits.maxBackgroundShells) {
      return fail(
        `Too many background shells (${shells.size}). Kill one with KillShell before starting another.`,
      );
    }
    const id = `bash_${++shellCounter}`;
    const stdout = new RingBuffer();
    const stderr = new RingBuffer();
    const child = spawn(prep.exe, prep.args, {
      cwd: base,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const record = {
      id,
      command,
      description: description ?? '',
      cwd: base,
      shell: prep.shell,
      pid: child.pid,
      status: 'running',
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      stdout,
      stderr,
      child,
      tempDir: prep.dir,
    };
    shells.set(id, record);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => stdout.push(stripAnsi(d)));
    child.stderr?.on('data', (d) => stderr.push(stripAnsi(d)));
    child.on('error', (e) => {
      record.status = 'failed';
      record.endedAt = new Date().toISOString();
      stderr.push(`\n[spawn error] ${e.message}\n`);
      cleanupTemp(prep.dir);
    });
    child.on('exit', (code, signal) => {
      record.status = code === 0 ? 'completed' : 'failed';
      record.exitCode = code ?? (signal ? 128 : null);
      record.signal = signal ?? null;
      record.endedAt = new Date().toISOString();
      cleanupTemp(prep.dir);
    });

    return ok(
      `Started background shell ${id} (pid ${child.pid}) in ${pretty(base)}.\n` +
        `Command: ${command.split('\n')[0].slice(0, 200)}\n\n` +
        `Read its output with BashOutput(bash_id: "${id}") and stop it with KillShell(shell_id: "${id}").`,
      { bash_id: id, pid: child.pid },
    );
  }

  return await new Promise((resolve) => {
    const child = spawn(prep.exe, prep.args, {
      cwd: base,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupTemp(prep.dir);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, limit);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => {
      out += stripAnsi(d);
    });
    child.stderr?.on('data', (d) => {
      err += stripAnsi(d);
    });

    child.on('error', (e) => {
      finish(
        fail(
          `Failed to start ${prep.exe}: ${e.message}`,
          prep.shell === 'bash' && process.platform === 'win32'
            ? 'bash was not found. Install Git for Windows, or pass shell: "powershell".'
            : undefined,
        ),
      );
    });

    child.on('close', (code, signal) => {
      const parts = [];
      const head = description ? `${description}\n` : '';

      if (timedOut) {
        parts.push(`Command timed out after ${limit} ms and was killed.`);
      }
      const trimmedOut = out.replace(/\s+$/, '');
      const trimmedErr = err.replace(/\s+$/, '');
      if (trimmedOut) parts.push(trimmedOut);
      if (trimmedErr) parts.push(`[stderr]\n${trimmedErr}`);
      if (!trimmedOut && !trimmedErr && !timedOut) parts.push('(no output)');

      const exit = timedOut ? 124 : (code ?? (signal ? 128 : 0));
      if (exit !== 0) parts.push(`[exit code ${exit}${signal ? ` — ${signal}` : ''}]`);

      finish(
        ok(head + clamp(parts.join('\n\n'), config.limits.maxOutputChars, 'command output'), {
          exitCode: exit,
          timedOut,
        }),
      );
    });
  });
}

/* ------------------------------------------------------------ BashOutput */

async function bashOutputTool({ bash_id, filter }) {
  const record = shells.get(bash_id);
  if (!record) {
    const known = [...shells.keys()];
    return fail(
      `No background shell with id "${bash_id}".`,
      known.length ? `Known shells: ${known.join(', ')}` : 'No background shells are running.',
    );
  }

  let out = record.stdout.drain();
  let err = record.stderr.drain();

  if (filter) {
    let re;
    try {
      re = new RegExp(filter);
    } catch (e) {
      return fail(`Invalid filter regex: ${e.message}`);
    }
    const keep = (t) => t.split(/\r?\n/).filter((l) => re.test(l)).join('\n');
    out = keep(out);
    err = keep(err);
  }

  const header =
    `${record.id} — ${record.status}` +
    (record.exitCode !== null ? ` (exit ${record.exitCode})` : '') +
    `\n${record.command.split('\n')[0].slice(0, 200)}`;

  const body = [];
  if (out.trim()) body.push(out.replace(/\s+$/, ''));
  if (err.trim()) body.push(`[stderr]\n${err.replace(/\s+$/, '')}`);
  if (!body.length) body.push(record.status === 'running' ? '(no new output yet)' : '(no new output)');

  return ok(`${header}\n\n${clamp(body.join('\n\n'), config.limits.maxOutputChars, 'shell output')}`, {
    status: record.status,
    exitCode: record.exitCode,
  });
}

/* -------------------------------------------------------------- KillShell */

async function killShellTool({ shell_id }) {
  if (shell_id === 'all') {
    let n = 0;
    for (const [, rec] of shells) {
      if (rec.status === 'running') {
        killTree(rec.pid);
        rec.status = 'killed';
        rec.endedAt = new Date().toISOString();
        n++;
      }
    }
    return ok(`Killed ${n} running background shell(s).`);
  }

  const record = shells.get(shell_id);
  if (!record) return fail(`No background shell with id "${shell_id}".`);
  if (record.status !== 'running') return ok(`${shell_id} was already ${record.status}.`);
  killTree(record.pid);
  record.status = 'killed';
  record.endedAt = new Date().toISOString();
  cleanupTemp(record.tempDir);
  return ok(`Killed ${shell_id} (pid ${record.pid}).`);
}

/* --------------------------------------------------------- ListShells ---- */

async function listShellsTool() {
  if (shells.size === 0) return ok('No background shells.');
  const rows = [...shells.values()].map(
    (r) =>
      `${r.id.padEnd(10)} ${r.status.padEnd(10)} pid ${String(r.pid ?? '-').padEnd(8)} ${pretty(r.cwd)}\n` +
      `           ${r.command.split('\n')[0].slice(0, 160)}`,
  );
  return ok(`${shells.size} background shell(s):\n\n${rows.join('\n')}`);
}

/** Kill everything we started — called on server shutdown. */
export function shutdownShells() {
  for (const [, rec] of shells) {
    if (rec.status === 'running') killTree(rec.pid);
    cleanupTemp(rec.tempDir);
  }
  shells.clear();
}

/* -------------------------------------------------------------- register */

export function registerShellTools(server) {
  const shellEnum =
    process.platform === 'win32'
      ? ['powershell', 'pwsh', 'cmd', 'bash']
      : ['bash', 'sh'];

  server.registerTool(
    'Bash',
    {
      title: 'Run a shell command',
      description:
        `Run a command on this machine (default shell: ${config.defaultShell}). Use it for git, package managers, ` +
        'build tools, data processing and anything else the file tools do not cover. ' +
        'Prefer Read/Write/Edit/Glob/Grep over cat/echo/find/grep — they give better output. ' +
        'Long-running work should use run_in_background, then BashOutput to collect results.',
      inputSchema: {
        command: z.string().describe('The command to run. Multi-line scripts are fine.'),
        description: z.string().optional().describe('One clear sentence about what this does, shown to the user.'),
        timeout: z
          .number()
          .int()
          .min(1000)
          .max(config.limits.bashTimeoutMax)
          .optional()
          .describe(`Milliseconds before the command is killed (default ${config.limits.bashTimeout}).`),
        run_in_background: z.boolean().optional().describe('Return immediately and keep the command running.'),
        cwd: z.string().optional().describe('Working directory (default: the active space).'),
        shell: z.enum(shellEnum).optional().describe(`Interpreter to use (default ${config.defaultShell}).`),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(bashTool),
  );

  server.registerTool(
    'BashOutput',
    {
      title: 'Read background shell output',
      description:
        'Fetch output produced by a background shell since the last time you read it. ' +
        'Also reports whether the command is still running and its exit code.',
      inputSchema: {
        bash_id: z.string().describe('Id returned by Bash(run_in_background: true).'),
        filter: z.string().optional().describe('Only return lines matching this regular expression.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(bashOutputTool),
  );

  server.registerTool(
    'KillShell',
    {
      title: 'Stop a background shell',
      description: 'Terminate a background shell and its child processes. Pass "all" to stop every running shell.',
      inputSchema: {
        shell_id: z.string().describe('Shell id, or "all".'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(killShellTool),
  );

  server.registerTool(
    'ListShells',
    {
      title: 'List background shells',
      description: 'Show every background shell this session has started, with status and working directory.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(listShellsTool),
  );
}

export const __test__ = { prepareCommand, shells, RingBuffer };
export { findPosixShell };
