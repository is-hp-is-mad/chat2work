/**
 * File tools — Cowork's `Read`, `Write`, `Edit`, `Glob`, `Grep`, `NotebookEdit`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';

import { config } from '../config.mjs';
import { cwd } from '../session.mjs';
import { resolvePath, pretty } from '../lib/paths.mjs';
import { ok, fail, mixed, guard } from '../lib/result.mjs';
import { clamp, numberLines, looksBinary, splitLines, detectEol, compilePattern, bytes } from '../lib/text.mjs';
import { walk, makeMatcher, toPosix, TYPE_GLOBS } from '../lib/walk.mjs';

const STRICT_EDIT = !/^(0|false|no|off)$/i.test(process.env.COWORK_STRICT_EDIT ?? '1');

/** Files this server has shown to Claude, with the mtime at the time of reading. */
const readTracker = new Map();

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
/** Claude Desktop rejects very large inline images; stay well under the limit. */
const MAX_IMAGE_BYTES = 3_500_000;

function noteRead(abs) {
  try {
    readTracker.set(abs, fs.statSync(abs).mtimeMs);
  } catch {
    readTracker.set(abs, 0);
  }
}

function requireFreshRead(abs, toolName) {
  if (!STRICT_EDIT) return null;
  if (!fs.existsSync(abs)) return null;
  const seen = readTracker.get(abs);
  if (seen === undefined) {
    return `${toolName} refused: this file has not been read in this session. Call Read on ${pretty(abs)} first so you edit against its real contents. (Set COWORK_STRICT_EDIT=0 to disable this check.)`;
  }
  const now = fs.statSync(abs).mtimeMs;
  if (now !== seen) {
    return `${toolName} refused: ${pretty(abs)} changed on disk since you read it. Read it again before editing.`;
  }
  return null;
}

/* ------------------------------------------------------------------ Read */

function readNotebook(abs) {
  const nb = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const cells = Array.isArray(nb.cells) ? nb.cells : [];
  const lang = nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? 'python';
  const out = [`Jupyter notebook: ${path.basename(abs)} — ${cells.length} cell(s), kernel language: ${lang}`, ''];

  cells.forEach((cell, i) => {
    const id = cell.id ?? `cell-${i}`;
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
    out.push(`### [${i}] ${cell.cell_type} (id: ${id})`);
    out.push('```' + (cell.cell_type === 'code' ? lang : 'markdown'));
    out.push(src.replace(/\n$/, ''));
    out.push('```');

    for (const output of cell.outputs ?? []) {
      if (output.output_type === 'stream') {
        const t = Array.isArray(output.text) ? output.text.join('') : String(output.text ?? '');
        out.push(`_${output.name ?? 'stdout'}:_`, '```', t.replace(/\n$/, ''), '```');
      } else if (output.output_type === 'error') {
        out.push(`_error:_ ${output.ename}: ${output.evalue}`);
      } else if (output.data) {
        const plain = output.data['text/plain'];
        if (plain) {
          const t = Array.isArray(plain) ? plain.join('') : String(plain);
          out.push('_result:_', '```', t.replace(/\n$/, ''), '```');
        }
        const imgKey = Object.keys(output.data).find((k) => k.startsWith('image/'));
        if (imgKey) out.push(`_[${imgKey} output omitted — ${bytes(String(output.data[imgKey]).length)}]_`);
      }
    }
    out.push('');
  });
  return out.join('\n');
}

function extractPdfText(abs) {
  const attempts = [
    { cmd: 'pdftotext', args: ['-layout', '-q', abs, '-'] },
    {
      cmd: process.platform === 'win32' ? 'python' : 'python3',
      args: [
        '-c',
        'import sys;from pypdf import PdfReader;r=PdfReader(sys.argv[1]);' +
          'print("\\n\\n".join(f"--- page {i+1} ---\\n"+(p.extract_text() or "") for i,p in enumerate(r.pages)))',
        abs,
      ],
    },
  ];
  for (const { cmd, args } of attempts) {
    try {
      const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
      if (res.status === 0 && res.stdout && res.stdout.trim()) return res.stdout;
    } catch {
      /* try the next extractor */
    }
  }
  return null;
}

async function readTool({ file_path, offset, limit }) {
  const abs = resolvePath(file_path, cwd());
  const stat = fs.statSync(abs);

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 500);
    const lines = entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => {
        if (e.isDirectory()) return `  ${e.name}/`;
        let size = '';
        try {
          size = ` (${bytes(fs.statSync(path.join(abs, e.name)).size)})`;
        } catch {
          /* ignore */
        }
        return `  ${e.name}${size}`;
      });
    return ok(
      `${pretty(abs)} is a directory containing ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`,
    );
  }

  const ext = path.extname(abs).toLowerCase();

  if (IMAGE_TYPES[ext]) {
    if (stat.size > MAX_IMAGE_BYTES) {
      return fail(
        `Image is ${bytes(stat.size)}, above the ${bytes(MAX_IMAGE_BYTES)} inline limit.`,
        'Resize it first, e.g. with Bash and ImageMagick / Python Pillow, then read the smaller copy.',
      );
    }
    noteRead(abs);
    const data = fs.readFileSync(abs).toString('base64');
    return mixed([
      { type: 'text', text: `${pretty(abs)} — ${bytes(stat.size)} ${ext.slice(1).toUpperCase()} image` },
      { type: 'image', data, mimeType: IMAGE_TYPES[ext] },
    ]);
  }

  if (ext === '.ipynb') {
    noteRead(abs);
    return ok(clamp(readNotebook(abs), config.limits.maxOutputChars, 'notebook'));
  }

  if (ext === '.pdf') {
    const extracted = extractPdfText(abs);
    if (extracted === null) {
      return fail(
        `Could not extract text from ${pretty(abs)} (${bytes(stat.size)}).`,
        'Install a PDF extractor, e.g. `pip install pypdf`, or install poppler so `pdftotext` is on PATH. Then read the file again.',
      );
    }
    noteRead(abs);
    return ok(`${pretty(abs)} — extracted text:\n\n${clamp(extracted, config.limits.maxOutputChars, 'PDF text')}`);
  }

  if (stat.size > config.limits.maxReadBytes) {
    return fail(
      `${pretty(abs)} is ${bytes(stat.size)}, larger than the ${bytes(config.limits.maxReadBytes)} read limit.`,
      'Use the offset/limit parameters to page through it, or Grep to find the parts you need.',
    );
  }

  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) {
    noteRead(abs);
    return ok(
      `${pretty(abs)} is a binary file (${bytes(stat.size)}). First 256 bytes as hex:\n\n` +
        buf
          .subarray(0, 256)
          .toString('hex')
          .replace(/(.{32})/g, '$1\n'),
    );
  }

  const content = buf.toString('utf8');
  const allLines = splitLines(content);
  const start = Math.max(0, (offset ?? 1) - 1);
  const count = limit ?? config.limits.readLines;
  const slice = allLines.slice(start, start + count);

  noteRead(abs);

  if (slice.length === 0) {
    return ok(
      `${pretty(abs)} has ${allLines.length} line(s); offset ${offset ?? 1} is past the end.`,
    );
  }

  const header = `${pretty(abs)} — lines ${start + 1}-${start + slice.length} of ${allLines.length}`;
  const body = numberLines(slice, start + 1);
  const more =
    start + slice.length < allLines.length
      ? `\n\n… ${allLines.length - start - slice.length} more line(s). Continue with offset=${start + slice.length + 1}.`
      : '';
  return ok(`${header}\n\n${clamp(body, config.limits.maxOutputChars, 'file')}${more}`);
}

/* ----------------------------------------------------------------- Write */

async function writeTool({ file_path, content }) {
  const abs = resolvePath(file_path, cwd());
  const blocked = requireFreshRead(abs, 'Write');
  if (blocked) return fail(blocked);

  const existed = fs.existsSync(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  noteRead(abs);

  const lines = splitLines(content).length;
  return ok(
    `${existed ? 'Overwrote' : 'Created'} ${pretty(abs)} — ${lines} line(s), ${bytes(Buffer.byteLength(content, 'utf8'))}.`,
    { path: abs, created: !existed, lines },
  );
}

/* ------------------------------------------------------------------ Edit */

async function editTool({ file_path, old_string, new_string, replace_all }) {
  const abs = resolvePath(file_path, cwd());
  if (!fs.existsSync(abs)) return fail(`No such file: ${pretty(abs)}`, 'Use Write to create it.');
  const blocked = requireFreshRead(abs, 'Edit');
  if (blocked) return fail(blocked);
  if (old_string === new_string) return fail('old_string and new_string are identical — nothing to do.');

  const original = fs.readFileSync(abs, 'utf8');
  const eol = detectEol(original);

  // Normalise the needle to the file's line endings so CRLF files still match.
  const needle = old_string.replace(/\r\n|\n|\r/g, eol);
  const replacement = new_string.replace(/\r\n|\n|\r/g, eol);

  let count = 0;
  let index = original.indexOf(needle);
  while (index !== -1) {
    count++;
    index = original.indexOf(needle, index + needle.length);
    if (count > 1 && !replace_all) break;
  }

  if (count === 0) {
    const compact = old_string.trim().split(/\r?\n/)[0]?.slice(0, 60) ?? '';
    return fail(
      `old_string not found in ${pretty(abs)}.`,
      `Read the file again and copy the exact text, including indentation. Nothing matching “${compact}…” is present.`,
    );
  }
  if (count > 1 && !replace_all) {
    return fail(
      `old_string appears ${count > 1 ? 'more than once' : 'once'} in ${pretty(abs)} — the edit would be ambiguous.`,
      'Include more surrounding context to make it unique, or pass replace_all: true.',
    );
  }

  const updated = replace_all ? original.split(needle).join(replacement) : original.replace(needle, replacement);
  fs.writeFileSync(abs, updated, 'utf8');
  noteRead(abs);

  const before = splitLines(original).length;
  const after = splitLines(updated).length;
  const delta = after - before;
  return ok(
    `Edited ${pretty(abs)} — ${count} replacement${count === 1 ? '' : 's'}` +
      (delta === 0 ? '.' : `, ${delta > 0 ? '+' : ''}${delta} line(s).`),
    { path: abs, replacements: count },
  );
}

/* ------------------------------------------------------------- MultiEdit */

async function multiEditTool({ file_path, edits }) {
  const abs = resolvePath(file_path, cwd());
  if (!fs.existsSync(abs)) return fail(`No such file: ${pretty(abs)}`, 'Use Write to create it.');
  const blocked = requireFreshRead(abs, 'MultiEdit');
  if (blocked) return fail(blocked);

  if (!Array.isArray(edits) || edits.length === 0) {
    return fail('edits must be a non-empty array of replacement instructions.');
  }

  let current = fs.readFileSync(abs, 'utf8');
  const eol = detectEol(current);
  let totalReplacements = 0;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const old_string = edit.old_string;
    const new_string = edit.new_string;
    const replace_all = Boolean(edit.replace_all);

    if (old_string === new_string) continue;

    const needle = old_string.replace(/\r\n|\n|\r/g, eol);
    const replacement = new_string.replace(/\r\n|\n|\r/g, eol);

    let count = 0;
    let index = current.indexOf(needle);
    while (index !== -1) {
      count++;
      index = current.indexOf(needle, index + needle.length);
      if (count > 1 && !replace_all) break;
    }

    if (count === 0) {
      const compact = old_string.trim().split(/\r?\n/)[0]?.slice(0, 60) ?? '';
      return fail(
        `Edit ${i + 1}/${edits.length} failed: old_string not found in ${pretty(abs)}.`,
        compact ? `First line: "${compact}"` : undefined,
      );
    }
    if (count > 1 && !replace_all) {
      return fail(
        `Edit ${i + 1}/${edits.length} failed: old_string matches ${count} places in ${pretty(abs)}.`,
        'Include more surrounding lines to make it unique, or pass replace_all: true.',
      );
    }

    current = replace_all ? current.split(needle).join(replacement) : current.replace(needle, replacement);
    totalReplacements += count;
  }

  fs.writeFileSync(abs, current, 'utf8');
  noteRead(abs);

  const lines = splitLines(current).length;
  return ok(
    `Applied ${edits.length} edit(s) (${totalReplacements} replacement(s)) to ${pretty(abs)} — now ${lines} line(s).`,
    { path: abs, edits: edits.length, replacements: totalReplacements, lines },
  );
}

/* ------------------------------------------------------------------ Glob */

async function globTool({ pattern, path: root, limit, include_ignored }) {
  const base = resolvePath(root ?? '.', cwd());
  const match = makeMatcher(pattern);
  const { files, truncated, scanned } = walk(base, {
    accept: (rel) => match(rel),
    includeIgnored: include_ignored ?? false,
  });

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const cap = limit ?? 500;
  const shown = files.slice(0, cap);

  if (shown.length === 0) {
    return ok(
      `No files match ${pattern} under ${pretty(base)} (${scanned} file(s) scanned).` +
        (include_ignored ? '' : '\nDirectories like node_modules and .git were skipped; pass include_ignored: true to search them.'),
    );
  }

  const lines = shown.map((f) => `${path.join(base, f.rel.split('/').join(path.sep))}`);
  const footer =
    files.length > shown.length
      ? `\n\n… ${files.length - shown.length} more match(es). Raise the limit or narrow the pattern.`
      : '';
  return ok(
    `${files.length} match(es) for ${pattern} under ${pretty(base)}, newest first:\n\n${lines.join('\n')}${footer}` +
      (truncated ? '\n\n[walk stopped at the file-count limit — results are partial]' : ''),
    { count: files.length, files: shown.map((f) => f.abs) },
  );
}

/* ------------------------------------------------------------------ Grep */

function grepFile(abs, regex, opts) {
  const { multiline, before, after, maxPerFile } = opts;
  let content;
  try {
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return null;
    content = buf.toString('utf8');
  } catch {
    return null;
  }

  const lines = splitLines(content);
  const hits = [];

  if (multiline) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(content)) !== null) {
      const lineNo = content.slice(0, m.index).split('\n').length;
      hits.push({ line: lineNo, text: lines[lineNo - 1] ?? '', match: m[0] });
      if (m[0].length === 0) regex.lastIndex++;
      if (hits.length >= maxPerFile) break;
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      const m = regex.exec(lines[i]);
      if (m) {
        hits.push({ line: i + 1, text: lines[i], match: m[0] });
        if (hits.length >= maxPerFile) break;
      }
    }
  }

  if (hits.length === 0) return null;
  return { hits, lines, total: hits.length, before, after };
}

async function grepTool(args) {
  const {
    pattern,
    path: root,
    glob,
    type,
    output_mode = 'files_with_matches',
    '-i': ci,
    '-n': showLineNumbers,
    '-A': afterArg,
    '-B': beforeArg,
    '-C': contextArg,
    multiline,
    fixed_strings,
    head_limit,
    include_ignored,
  } = args;

  const base = resolvePath(root ?? '.', cwd());
  let regex;
  try {
    regex = compilePattern(pattern, {
      caseInsensitive: !!ci,
      multiline: !!multiline,
      fixed: !!fixed_strings,
    });
  } catch (e) {
    return fail(`Invalid regular expression: ${e.message}`, 'Escape literal braces and brackets, or pass fixed_strings: true.');
  }

  const globPattern = glob ?? (type ? TYPE_GLOBS[type] : null);
  if (type && !TYPE_GLOBS[type]) {
    return fail(`Unknown type "${type}".`, `Known types: ${Object.keys(TYPE_GLOBS).join(', ')}`);
  }
  const matchName = globPattern ? makeMatcher(globPattern) : () => true;

  const { files, truncated } = walk(base, {
    accept: (rel) => matchName(rel),
    includeIgnored: include_ignored ?? false,
  });

  const before = beforeArg ?? contextArg ?? 0;
  const after = afterArg ?? contextArg ?? 0;
  const cap = head_limit ?? 250;

  const results = [];
  let totalMatches = 0;
  for (const f of files) {
    const r = grepFile(f.abs, regex, { multiline: !!multiline, before, after, maxPerFile: 500 });
    if (!r) continue;
    totalMatches += r.total;
    results.push({ file: f, ...r });
    if (output_mode === 'files_with_matches' && results.length >= cap) break;
  }

  if (results.length === 0) {
    return ok(
      `No matches for /${pattern}/ under ${pretty(base)}` +
        (globPattern ? ` (filtered to ${globPattern})` : '') +
        `. ${files.length} file(s) searched.`,
    );
  }

  const header =
    `${totalMatches} match(es) in ${results.length} file(s) for /${pattern}/ under ${pretty(base)}` +
    (globPattern ? ` (${globPattern})` : '');

  if (output_mode === 'files_with_matches') {
    const list = results.slice(0, cap).map((r) => r.file.abs);
    const footer = results.length > cap ? `\n\n… ${results.length - cap} more file(s).` : '';
    return ok(`${header}\n\n${list.join('\n')}${footer}`, { files: list, matches: totalMatches });
  }

  if (output_mode === 'count') {
    const list = results
      .slice(0, cap)
      .map((r) => `${String(r.total).padStart(6)}  ${r.file.abs}`);
    return ok(`${header}\n\n${list.join('\n')}`, { matches: totalMatches });
  }

  // content mode
  const out = [];
  let emitted = 0;
  outer: for (const r of results) {
    out.push(`\n${r.file.abs}`);
    let lastPrinted = -1;
    for (const hit of r.hits) {
      const from = Math.max(1, hit.line - before);
      const to = Math.min(r.lines.length, hit.line + after);
      if (lastPrinted !== -1 && from > lastPrinted + 1) out.push('  --');
      for (let ln = Math.max(from, lastPrinted + 1); ln <= to; ln++) {
        const sep = ln === hit.line ? ':' : '-';
        const prefix = showLineNumbers === false ? '' : `${ln}${sep}`;
        out.push(`  ${prefix}${r.lines[ln - 1] ?? ''}`);
        lastPrinted = ln;
      }
      emitted++;
      if (emitted >= cap) {
        out.push(`\n… stopped after ${cap} match(es); raise head_limit for more.`);
        break outer;
      }
    }
  }

  return ok(
    `${header}\n${clamp(out.join('\n'), config.limits.maxOutputChars, 'matches')}` +
      (truncated ? '\n\n[walk stopped at the file-count limit — results are partial]' : ''),
    { matches: totalMatches },
  );
}

/* ---------------------------------------------------------- NotebookEdit */

async function notebookEditTool({ notebook_path, cell_id, new_source, cell_type, edit_mode = 'replace' }) {
  const abs = resolvePath(notebook_path, cwd());
  if (!fs.existsSync(abs)) return fail(`No such notebook: ${pretty(abs)}`);
  const blocked = requireFreshRead(abs, 'NotebookEdit');
  if (blocked) return fail(blocked);

  const nb = JSON.parse(fs.readFileSync(abs, 'utf8'));
  nb.cells ??= [];

  const indexOf = (id) => {
    if (id === undefined || id === null || id === '') return -1;
    const byId = nb.cells.findIndex((c) => c.id === id);
    if (byId !== -1) return byId;
    const asNum = Number.parseInt(String(id), 10);
    return Number.isInteger(asNum) && asNum >= 0 && asNum < nb.cells.length ? asNum : -1;
  };

  const toSource = (s) => String(s ?? '').split(/(?<=\n)/);

  if (edit_mode === 'delete') {
    const i = indexOf(cell_id);
    if (i === -1) return fail(`No cell with id/index "${cell_id}".`);
    const [removed] = nb.cells.splice(i, 1);
    fs.writeFileSync(abs, JSON.stringify(nb, null, 1), 'utf8');
    noteRead(abs);
    return ok(`Deleted ${removed.cell_type} cell at index ${i} from ${pretty(abs)}. ${nb.cells.length} cell(s) remain.`);
  }

  if (edit_mode === 'insert') {
    if (!cell_type) return fail('cell_type is required when inserting a cell ("code" or "markdown").');
    const at = cell_id === undefined || cell_id === null || cell_id === '' ? nb.cells.length : indexOf(cell_id) + 1;
    const cell = {
      cell_type,
      id: `c${Math.random().toString(36).slice(2, 10)}`,
      metadata: {},
      source: toSource(new_source),
    };
    if (cell_type === 'code') {
      cell.execution_count = null;
      cell.outputs = [];
    }
    nb.cells.splice(at, 0, cell);
    fs.writeFileSync(abs, JSON.stringify(nb, null, 1), 'utf8');
    noteRead(abs);
    return ok(`Inserted a ${cell_type} cell at index ${at} in ${pretty(abs)} (id: ${cell.id}).`);
  }

  const i = indexOf(cell_id);
  if (i === -1) return fail(`No cell with id/index "${cell_id}".`, 'Read the notebook to see cell ids.');
  nb.cells[i].source = toSource(new_source);
  if (cell_type && cell_type !== nb.cells[i].cell_type) {
    nb.cells[i].cell_type = cell_type;
    if (cell_type === 'code') {
      nb.cells[i].execution_count ??= null;
      nb.cells[i].outputs ??= [];
    } else {
      delete nb.cells[i].execution_count;
      delete nb.cells[i].outputs;
    }
  }
  if (nb.cells[i].cell_type === 'code') nb.cells[i].outputs = [];
  fs.writeFileSync(abs, JSON.stringify(nb, null, 1), 'utf8');
  noteRead(abs);
  return ok(`Replaced the source of cell ${i} (${nb.cells[i].cell_type}) in ${pretty(abs)}.`);
}

/* -------------------------------------------------------------- register */

export function registerFileTools(server) {
  server.registerTool(
    'Read',
    {
      title: 'Read a file',
      description:
        'Read any file on this machine: text (with line numbers), images (rendered inline), PDFs (text extracted), ' +
        'Jupyter notebooks (cells and outputs), or a directory listing. Prefer this over `cat` in Bash. ' +
        'Absolute paths anywhere on the filesystem work; relative paths resolve against the active space. ' +
        'Use offset/limit to page through large files.',
      inputSchema: {
        file_path: z.string().describe('Path to the file. Relative paths resolve against the active space.'),
        offset: z.number().int().min(1).optional().describe('1-indexed line to start from.'),
        limit: z.number().int().min(1).optional().describe(`Lines to read (default ${config.limits.readLines}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(readTool),
  );

  server.registerTool(
    'Write',
    {
      title: 'Write a file',
      description:
        'Create a file or replace its entire contents. Parent directories are created automatically. ' +
        'Any path on this machine is reachable, so double-check the destination before overwriting something ' +
        'the user did not ask you to touch. To change part of an existing file use Edit instead — ' +
        'it is safer and cheaper.',
      inputSchema: {
        file_path: z.string().describe('Path to write.'),
        content: z.string().describe('Full contents of the file.'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    guard(writeTool),
  );

  server.registerTool(
    'Edit',
    {
      title: 'Edit a file',
      description:
        'Replace an exact string in a file. old_string must match the file byte-for-byte including indentation, ' +
        'and must be unique unless replace_all is true. Read the file first.',
      inputSchema: {
        file_path: z.string().describe('Path to the file to modify.'),
        old_string: z.string().describe('Exact text to find.'),
        new_string: z.string().describe('Text to replace it with.'),
        replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring uniqueness.'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(editTool),
  );

  server.registerTool(
    'MultiEdit',
    {
      title: 'Batch edit a file',
      description:
        'Apply multiple edits to a single file in a single tool call. Each edit replaces an exact old_string ' +
        'with a new_string in sequence. Read the file first.',
      inputSchema: {
        file_path: z.string().describe('Path to the file to modify.'),
        edits: z
          .array(
            z.object({
              old_string: z.string().describe('Exact text to find.'),
              new_string: z.string().describe('Text to replace it with.'),
              replace_all: z.boolean().optional().describe('Replace every occurrence instead of requiring uniqueness.'),
            }),
          )
          .min(1)
          .describe('List of replacement instructions applied in order.'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(multiEditTool),
  );

  server.registerTool(
    'Glob',
    {
      title: 'Find files by name',
      description:
        'Fast filename search. Supports **, *, ?, [abc] and {a,b}. Results are sorted newest-first. ' +
        'A pattern without a slash matches at any depth, so "*.py" finds every Python file.',
      inputSchema: {
        pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts" or "*.md".'),
        path: z.string().optional().describe('Directory to search (default: the active space).'),
        limit: z.number().int().min(1).max(5000).optional().describe('Maximum paths to return (default 500).'),
        include_ignored: z.boolean().optional().describe('Also search node_modules, .git, dist and similar.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(globTool),
  );

  server.registerTool(
    'Grep',
    {
      title: 'Search file contents',
      description:
        'Regular-expression search across files. Use output_mode "content" to see matching lines, ' +
        '"files_with_matches" (default) for paths only, or "count" for per-file totals.',
      inputSchema: {
        pattern: z.string().describe('JavaScript-flavoured regular expression.'),
        path: z.string().optional().describe('File or directory to search (default: the active space).'),
        glob: z.string().optional().describe('Only search files matching this glob, e.g. "**/*.ts".'),
        type: z.enum(Object.keys(TYPE_GLOBS)).optional().describe('Shorthand file-type filter.'),
        output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
        '-i': z.boolean().optional().describe('Case-insensitive.'),
        '-n': z.boolean().optional().describe('Show line numbers in content mode (default true).'),
        '-A': z.number().int().min(0).max(50).optional().describe('Lines of trailing context.'),
        '-B': z.number().int().min(0).max(50).optional().describe('Lines of leading context.'),
        '-C': z.number().int().min(0).max(50).optional().describe('Lines of context on both sides.'),
        multiline: z.boolean().optional().describe('Let the pattern span line breaks.'),
        fixed_strings: z.boolean().optional().describe('Treat the pattern as a literal string.'),
        head_limit: z.number().int().min(1).max(5000).optional().describe('Cap on results (default 250).'),
        include_ignored: z.boolean().optional().describe('Also search node_modules, .git, dist and similar.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(grepTool),
  );

  server.registerTool(
    'NotebookEdit',
    {
      title: 'Edit a Jupyter notebook',
      description:
        'Replace, insert or delete a cell in a .ipynb file. Identify the cell by its id or its index. ' +
        'Read the notebook first to see the ids.',
      inputSchema: {
        notebook_path: z.string().describe('Path to the .ipynb file.'),
        cell_id: z.string().optional().describe('Cell id, or a numeric index as a string.'),
        new_source: z.string().optional().describe('New cell source (not needed for delete).'),
        cell_type: z.enum(['code', 'markdown']).optional().describe('Required when inserting.'),
        edit_mode: z.enum(['replace', 'insert', 'delete']).optional().describe('Default "replace".'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(notebookEditTool),
  );
}

export const __test__ = { readTracker, requireFreshRead };
