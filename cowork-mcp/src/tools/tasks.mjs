/**
 * Background tasks — `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`,
 * `TaskStop`, `TaskOutput`, `TaskCleanup`.
 *
 * A task is a background shell command that keeps running while work carries on.
 * Records survive restarts; a task that was running when Claude Desktop closed
 * is reported as `interrupted` rather than silently forgotten.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';

import { config, ensureLayout } from '../config.mjs';
import { cwd } from '../session.mjs';
import { resolvePath, pretty } from '../lib/paths.mjs';
import { ok, fail, guard } from '../lib/result.mjs';
import { clamp, stripAnsi, bytes } from '../lib/text.mjs';
import { findPosixShell } from './shell.mjs';

/** Live handles for tasks started by this process. */
const live = new Map();

function taskFile(id) {
  return path.join(config.dirs.taskRuns, `${id}.json`);
}
function logFile(id) {
  return path.join(config.dirs.taskRuns, `${id}.log`);
}

function saveTask(rec) {
  ensureLayout();
  const tmp = `${taskFile(rec.id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
  fs.renameSync(tmp, taskFile(rec.id));
  return rec;
}

function loadTask(id) {
  try {
    return JSON.parse(fs.readFileSync(taskFile(id), 'utf8'));
  } catch {
    return null;
  }
}

function allTasks() {
  ensureLayout();
  let names = [];
  try {
    names = fs.readdirSync(config.dirs.taskRuns).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((f) => {
      const rec = loadTask(path.basename(f, '.json'));
      if (!rec) return null;
      // A "running" task with no live handle means the server restarted under it.
      if (rec.status === 'running' && !live.has(rec.id)) {
        rec.status = 'interrupted';
        rec.endedAt ??= new Date().toISOString();
        saveTask(rec);
      }
      return rec;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function nextId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `task_${stamp}_${rand}`;
}

function appendLog(id, chunk) {
  try {
    fs.appendFileSync(logFile(id), chunk, 'utf8');
  } catch {
    /* logging must never break the task */
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else {
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

/* ------------------------------------------------------------ launching */

function startCommandTask(rec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-task-'));
  let exe;
  let args;
  if (process.platform === 'win32' && rec.shell !== 'bash') {
    const file = path.join(dir, 'task.ps1');
    fs.writeFileSync(
      file,
      'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}\n' +
        '$ProgressPreference = "SilentlyContinue"\n' +
        rec.command +
        '\n$c = $LASTEXITCODE; if ($null -eq $c) { $c = 0 }; exit $c\n',
      'utf8',
    );
    exe = 'powershell.exe';
    args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];
  } else {
    const file = path.join(dir, 'task.sh');
    fs.writeFileSync(file, `#!/usr/bin/env bash\nset -o pipefail\n${rec.command}\n`, 'utf8');
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      /* Windows */
    }
    exe = findPosixShell('bash');
    if (!exe) throw new Error('No usable bash was found. Install Git for Windows, set COWORK_BASH, or use the powershell shell.');
    args = [file];
  }

  const child = spawn(exe, args, {
    cwd: rec.cwd,
    env: { ...process.env, COWORK_HOME: config.home, COWORK_TASK_ID: rec.id, NO_COLOR: '1' },
    detached: process.platform !== 'win32',
    windowsHide: true,
  });

  rec.pid = child.pid;
  rec.startedAt = new Date().toISOString();
  rec.status = 'running';
  saveTask(rec);

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (d) => appendLog(rec.id, stripAnsi(d)));
  child.stderr?.on('data', (d) => appendLog(rec.id, stripAnsi(d)));
  child.on('error', (e) => {
    appendLog(rec.id, `\n[spawn error] ${e.message}\n`);
    rec.status = 'failed';
    rec.error = e.message;
    rec.endedAt = new Date().toISOString();
    saveTask(rec);
    live.delete(rec.id);
  });
  child.on('exit', (code, signal) => {
    rec.exitCode = code ?? (signal ? 128 : null);
    rec.status = rec.status === 'cancelled' ? 'cancelled' : code === 0 ? 'completed' : 'failed';
    rec.endedAt = new Date().toISOString();
    saveTask(rec);
    live.delete(rec.id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  live.set(rec.id, { kind: 'command', child });
  return rec;
}

/* ---------------------------------------------------------------- tools */

async function taskCreateTool({ title, command, cwd: workDir, shell }) {
  ensureLayout();

  if (!command) return fail('command is required.');

  const base = workDir ? resolvePath(workDir, cwd()) : cwd();
  const rec = {
    id: nextId(),
    title: title || String(command).split('\n')[0].slice(0, 80),
    type: 'command',
    status: 'pending',
    command,
    shell: shell ?? null,
    cwd: base,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    exitCode: null,
    error: null,
    notes: [],
  };
  fs.writeFileSync(logFile(rec.id), '', 'utf8');
  saveTask(rec);

  startCommandTask(rec);

  return ok(
    `Started task ${rec.id}: ${rec.title}\n` +
      `Working directory: ${pretty(rec.cwd)}\n\n` +
      `Carry on with other work. Check on it with TaskGet(task_id: "${rec.id}") or read its output with ` +
      `TaskOutput(task_id: "${rec.id}").`,
    { task_id: rec.id },
  );
}

function statusLine(rec) {
  const dur =
    rec.startedAt && rec.endedAt
      ? ` (${Math.round((Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 1000)}s)`
      : rec.startedAt
        ? ` (running ${Math.round((Date.now() - Date.parse(rec.startedAt)) / 1000)}s)`
        : '';
  return `${rec.id}  ${rec.status.padEnd(11)}${rec.title}${dur}`;
}

async function taskListTool({ status, limit }) {
  const tasks = allTasks().filter((t) => !status || t.status === status);
  if (!tasks.length) return ok(status ? `No tasks with status "${status}".` : 'No tasks yet.');
  const shown = tasks.slice(0, limit ?? 30);
  const running = tasks.filter((t) => t.status === 'running').length;
  return ok(
    `${tasks.length} task(s), ${running} running:\n\n${shown.map(statusLine).join('\n')}` +
      (tasks.length > shown.length ? `\n\n… ${tasks.length - shown.length} older.` : ''),
    { tasks: shown.map((t) => ({ id: t.id, status: t.status, title: t.title })) },
  );
}

async function taskGetTool({ task_id }) {
  allTasks(); // reconciles stale "running" records
  const rec = loadTask(task_id);
  if (!rec) return fail(`No task with id "${task_id}".`, 'Use TaskList to see what exists.');

  const lines = [
    `${rec.id} — ${rec.title}`,
    `  status:  ${rec.status}${rec.exitCode !== null && rec.exitCode !== undefined ? ` (exit ${rec.exitCode})` : ''}`,
    `  cwd:     ${rec.cwd}`,
    `  created: ${rec.createdAt}`,
    rec.startedAt ? `  started: ${rec.startedAt}` : null,
    rec.endedAt ? `  ended:   ${rec.endedAt}` : null,
    rec.error ? `  error:   ${rec.error}` : null,
  ].filter(Boolean);

  if (rec.notes?.length) lines.push(`  notes:\n${rec.notes.map((n) => `    - ${n}`).join('\n')}`);

  const body = rec.status === 'running' ? '\n\nStill running. Use TaskOutput to see progress so far.' : '';

  return ok(lines.join('\n') + body, { status: rec.status, exitCode: rec.exitCode ?? null });
}

async function taskOutputTool({ task_id, tail, filter }) {
  const rec = loadTask(task_id);
  if (!rec) return fail(`No task with id "${task_id}".`);
  let text = '';
  try {
    text = fs.readFileSync(logFile(task_id), 'utf8');
  } catch {
    return ok(`${task_id} has produced no output yet.`);
  }
  let lines = text.split(/\r?\n/);
  if (filter) {
    let re;
    try {
      re = new RegExp(filter);
    } catch (e) {
      return fail(`Invalid filter: ${e.message}`);
    }
    lines = lines.filter((l) => re.test(l));
  }
  const n = tail ?? 200;
  const slice = lines.slice(-n);
  const omitted = lines.length - slice.length;
  return ok(
    `${task_id} (${rec.status}) — last ${slice.length} line(s)` +
      (omitted > 0 ? `, ${omitted} earlier line(s) omitted` : '') +
      `\n\n${clamp(slice.join('\n'), config.limits.maxOutputChars, 'task output')}`,
  );
}

async function taskUpdateTool({ task_id, title, note, status }) {
  const rec = loadTask(task_id);
  if (!rec) return fail(`No task with id "${task_id}".`);
  if (title) rec.title = title;
  if (note) (rec.notes ??= []).push(`${new Date().toISOString()} — ${note}`);
  if (status) {
    if (rec.status === 'running' && status !== 'cancelled') {
      return fail('A running task cannot be relabelled; stop it first with TaskStop.');
    }
    rec.status = status;
  }
  saveTask(rec);
  return ok(`Updated ${task_id}.\n${statusLine(rec)}`);
}

async function taskStopTool({ task_id }) {
  const rec = loadTask(task_id);
  if (!rec) return fail(`No task with id "${task_id}".`);
  const handle = live.get(task_id);
  if (!handle) {
    if (rec.status === 'running') {
      rec.status = 'interrupted';
      rec.endedAt = new Date().toISOString();
      saveTask(rec);
      return ok(`${task_id} was no longer running (its process did not survive a restart). Marked interrupted.`);
    }
    return ok(`${task_id} is already ${rec.status}.`);
  }

  rec.status = 'cancelled';
  rec.endedAt = new Date().toISOString();
  saveTask(rec);

  killTree(handle.child.pid);
  live.delete(task_id);
  return ok(`Stopped ${task_id}.`);
}

async function taskCleanupTool({ keep }) {
  const tasks = allTasks();
  const finished = tasks.filter((t) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(t.status));
  const drop = finished.slice(keep ?? 20);
  let freed = 0;
  for (const t of drop) {
    for (const f of [taskFile(t.id), logFile(t.id)]) {
      try {
        freed += fs.statSync(f).size;
        fs.rmSync(f);
      } catch {
        /* already gone */
      }
    }
  }
  return ok(`Removed ${drop.length} finished task record(s), freeing ${bytes(freed)}. ${tasks.length - drop.length} kept.`);
}

/** Stop everything we launched — called on shutdown. */
export function shutdownTasks() {
  for (const [id, handle] of live) {
    killTree(handle.child.pid);
    const rec = loadTask(id);
    if (rec && rec.status === 'running') {
      rec.status = 'interrupted';
      rec.endedAt = new Date().toISOString();
      saveTask(rec);
    }
  }
  live.clear();
}

/* -------------------------------------------------------------- register */

export function registerTaskTools(server) {
  server.registerTool(
    'TaskCreate',
    {
      title: 'Start a non-blocking background job',
      description:
        'Start an asynchronous background shell command or job that runs without blocking or stalling the conversation. ' +
        'CRITICAL: Use this for long-running operations like junk file cleanup, large directory scans, builds, large downloads, or background services. ' +
        'Returns immediately with a task_id so you can report to the user and continue work. Inspect progress with TaskGet / TaskOutput.',
      inputSchema: {
        title: z.string().optional().describe('Short label for the job (e.g. "Disk cleanup scan", "Project build").'),
        command: z.string().describe('Shell command to run in the background.'),
        cwd: z.string().optional().describe('Working directory (default: the active space).'),
        shell: z.enum(['powershell', 'bash']).optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    guard(taskCreateTool),
  );

  server.registerTool(
    'TaskList',
    {
      title: 'List tasks',
      description: 'Show background tasks and their status, newest first.',
      inputSchema: {
        status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'interrupted']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(taskListTool),
  );

  server.registerTool(
    'TaskGet',
    {
      title: 'Inspect a task',
      description: 'Full detail on one task: status, timing, and its result once it finishes.',
      inputSchema: { task_id: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(taskGetTool),
  );

  server.registerTool(
    'TaskOutput',
    {
      title: 'Read task output',
      description: 'Read the output a task has produced so far. Use tail to limit how much comes back.',
      inputSchema: {
        task_id: z.string(),
        tail: z.number().int().min(1).max(5000).optional().describe('Last N lines (default 200).'),
        filter: z.string().optional().describe('Only lines matching this regular expression.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(taskOutputTool),
  );

  server.registerTool(
    'TaskUpdate',
    {
      title: 'Annotate a task',
      description: 'Rename a task or attach a note recording what you learned from it.',
      inputSchema: {
        task_id: z.string(),
        title: z.string().optional(),
        note: z.string().optional(),
        status: z.enum(['completed', 'failed', 'cancelled']).optional(),
      },
      annotations: { openWorldHint: false },
    },
    guard(taskUpdateTool),
  );

  server.registerTool(
    'TaskStop',
    {
      title: 'Stop a task',
      description: 'Terminate a running task and its child processes.',
      inputSchema: { task_id: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(taskStopTool),
  );

  server.registerTool(
    'TaskCleanup',
    {
      title: 'Prune finished tasks',
      description: 'Delete old finished task records and their logs, keeping the most recent ones.',
      inputSchema: { keep: z.number().int().min(0).max(500).optional().describe('How many to keep (default 20).') },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(taskCleanupTool),
  );
}
