/**
 * Artifacts — the files Claude produces for the user.
 *
 * Cowork surfaces these in its own panel; here they live in <home>/Artifacts
 * and can be opened in whatever application the OS associates with them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';

import { config, ensureLayout } from '../config.mjs';
import { cwd, activeSpace } from '../session.mjs';
import { resolvePath, pretty } from '../lib/paths.mjs';
import { ok, fail, guard } from '../lib/result.mjs';
import { bytes } from '../lib/text.mjs';
import { walk } from '../lib/walk.mjs';

function openExternally(target) {
  if (process.platform === 'win32') {
    // `start` is a cmd builtin; the empty string is the window title argument.
    const child = spawn('cmd', ['/d', '/c', 'start', '""', target], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [target], { detached: true, stdio: 'ignore' });
  child.unref();
}

function revealInFileManager(target) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', ['/select,', path.normalize(target)], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', ['-R', target], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [path.dirname(target)], { detached: true, stdio: 'ignore' }).unref();
  }
}

function which(cmd) {
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return res.status === 0 ? String(res.stdout).split(/\r?\n/)[0].trim() : null;
}

function uniquePath(dir, filename) {
  let candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  for (let i = 2; i < 1000; i++) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

async function artifactTool({ action, name, content, path: target, format, overwrite, limit }) {
  ensureLayout();

  if (action === 'create') {
    if (!name || content === undefined) return fail('Both name and content are required.');
    const safe = path.basename(String(name).replace(/[\\/:*?"<>|]+/g, '-')).trim();
    if (!safe) return fail('name must be a usable filename.');
    const dest = overwrite ? path.join(config.dirs.artifacts, safe) : uniquePath(config.dirs.artifacts, safe);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
    return ok(
      `Wrote artifact ${path.basename(dest)} (${bytes(Buffer.byteLength(content, 'utf8'))}) to ${dest}.\n` +
        `Open it with Artifact(action: "open", path: "${path.basename(dest)}").`,
      { path: dest },
    );
  }

  if (action === 'list') {
    const { files } = walk(config.dirs.artifacts, { maxFiles: 2000 });
    if (!files.length) return ok(`No artifacts yet. They live in ${config.dirs.artifacts}.`);
    const rows = [...files]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit ?? 100)
      .map((f) => `  ${f.rel} — ${bytes(f.size)}, ${new Date(f.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}`);
    return ok(`${files.length} artifact(s) in ${config.dirs.artifacts}, newest first:\n\n${rows.join('\n')}`);
  }

  if (action === 'open' || action === 'reveal') {
    if (!target) return fail('path is required.');
    // Bare names are looked up in the Artifacts folder first.
    let abs;
    const inArtifacts = path.join(config.dirs.artifacts, target);
    if (!path.isAbsolute(target) && fs.existsSync(inArtifacts)) abs = inArtifacts;
    else abs = resolvePath(target, cwd());

    if (!fs.existsSync(abs)) return fail(`No such file: ${abs}`);
    if (action === 'reveal') {
      revealInFileManager(abs);
      return ok(`Showing ${pretty(abs)} in the file manager.`);
    }
    openExternally(abs);
    return ok(`Opened ${pretty(abs)} in the default application for ${path.extname(abs) || 'this file type'}.`);
  }

  if (action === 'convert') {
    if (!target || !format) return fail('Both path and format are required for convert.');
    const abs = resolvePath(target, cwd());
    if (!fs.existsSync(abs)) return fail(`No such file: ${abs}`);
    const outDir = path.dirname(abs);

    const soffice = which('soffice') || which('libreoffice');
    const pandoc = which('pandoc');
    const srcExt = path.extname(abs).toLowerCase();

    // pandoc handles markdown/html sources better; LibreOffice handles Office formats.
    const useP = pandoc && ['.md', '.markdown', '.html', '.htm', '.rst', '.txt'].includes(srcExt) && format !== 'pdf';
    if (useP) {
      const out = path.join(outDir, `${path.basename(abs, srcExt)}.${format}`);
      const res = spawnSync(pandoc, [abs, '-o', out], { encoding: 'utf8', timeout: 300_000 });
      if (res.status !== 0) return fail(`pandoc failed: ${res.stderr || res.stdout}`);
      return ok(`Converted to ${out} with pandoc.`, { path: out });
    }

    if (!soffice) {
      return fail(
        `Converting to ${format} needs LibreOffice (soffice) or pandoc, and neither is on PATH.`,
        process.platform === 'win32'
          ? 'Install LibreOffice, then restart Claude Desktop so the server picks up the new PATH.'
          : 'Install libreoffice or pandoc with your package manager.',
      );
    }
    const res = spawnSync(soffice, ['--headless', '--convert-to', format, '--outdir', outDir, abs], {
      encoding: 'utf8',
      timeout: 300_000,
    });
    const out = path.join(outDir, `${path.basename(abs, srcExt)}.${format}`);
    if (!fs.existsSync(out)) {
      return fail(`Conversion produced no output.\n${res.stdout || ''}\n${res.stderr || ''}`.trim());
    }
    return ok(`Converted to ${out} (${bytes(fs.statSync(out).size)}) with LibreOffice.`, { path: out });
  }

  if (action === 'folder') {
    const space = activeSpace();
    return ok(
      `Artifacts folder: ${config.dirs.artifacts}\n` +
        `Cowork home: ${config.home}\n` +
        `Active space: ${space ? `${space.name} — ${space.path}` : '(none)'}`,
    );
  }

  return fail(`Unknown action "${action}".`);
}

export function registerArtifactTools(server) {
  server.registerTool(
    'Artifact',
    {
      title: 'Deliver a file to the user',
      description:
        'Manage the files you produce for the user. "create" writes one into the Artifacts folder, ' +
        '"open" launches it in its default application, "reveal" shows it in the file manager, ' +
        'and "convert" turns a document into another format using LibreOffice or pandoc. ' +
        'Use this at the end of a piece of work so the user can actually see the result.',
      inputSchema: {
        action: z.enum(['create', 'list', 'open', 'reveal', 'convert', 'folder']),
        name: z.string().optional().describe('Filename for "create", e.g. "q4-review.md".'),
        content: z.string().optional().describe('File contents for "create".'),
        path: z.string().optional().describe('File to open, reveal or convert. A bare name resolves inside Artifacts.'),
        format: z.string().optional().describe('Target format for "convert": pdf, docx, xlsx, pptx, html…'),
        overwrite: z.boolean().optional().describe('Replace an existing artifact instead of adding a numbered copy.'),
        limit: z.number().int().min(1).max(2000).optional(),
      },
      annotations: { openWorldHint: false },
    },
    guard(artifactTool),
  );
}
