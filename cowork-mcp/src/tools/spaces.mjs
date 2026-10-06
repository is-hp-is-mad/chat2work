/**
 * Spaces — Cowork's persistent project workspaces.
 *
 * A space is just a folder under <home>/Projects. Selecting one makes it the
 * base directory for every relative path in every other tool, which is what
 * gives a long-running piece of work its own home.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { config, ensureLayout, setHome, LOCAL_CONFIG_FILE } from '../config.mjs';
import {
  listSpaces,
  createSpace,
  useSpace,
  activeSpace,
  spacePath,
  deleteSpaceRecord,
  setSpaceDescription,
  normalizeSpaceName,
} from '../session.mjs';
import { ok, fail, guard } from '../lib/result.mjs';
import { pretty } from '../lib/paths.mjs';
import { bytes } from '../lib/text.mjs';
import { walk } from '../lib/walk.mjs';

const CONTEXT_FILE = 'CONTEXT.md';

function contextTemplate(name, description) {
  return [
    `# ${name}`,
    '',
    description || '_What this space is for._',
    '',
    '## Current state',
    '',
    '- ',
    '',
    '## Decisions',
    '',
    '- ',
    '',
    '## Next up',
    '',
    '- ',
    '',
  ].join('\n');
}

function summarize(dir) {
  const { files, truncated } = walk(dir, { maxFiles: 5000 });
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const recent = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 15);
  return { count: files.length, totalBytes, recent, truncated };
}

async function spaceTool({ action, name, description, path: target }) {
  ensureLayout();

  if (action === 'root') {
    if (!target) {
      const spaces = listSpaces();
      return ok(
        `Workspace root: ${config.home}\n` +
          `  set by: ${config.homeSource}\n` +
          `  holds:  ${spaces.length} space(s)\n\n` +
          `Layout:\n` +
          Object.entries(config.dirs)
            .map(([k, v]) => `  ${k.padEnd(13)} ${v}`)
            .join('\n') +
          `\n\nMove it with Space(action: "root", path: "D:\\\\somewhere"). Existing spaces are ` +
          `not copied — move the folders yourself if you want them to come along.`,
        { home: config.home, source: config.homeSource },
      );
    }

    const before = config.home;
    let result;
    try {
      result = setHome(target);
    } catch (e) {
      return fail(e.message);
    }
    const note = result.envOverride
      ? `\n\nNote: COWORK_HOME is set to ${result.envOverride} in this server's environment, and env wins ` +
        `on the next restart. Remove it from claude_desktop_config.json to make this stick.`
      : `\n\nRemembered in ${LOCAL_CONFIG_FILE}, so it survives a restart.`;
    return ok(
      `Workspace root moved.\n  from: ${before}\n  to:   ${result.home}${result.created ? ' (created)' : ''}\n` +
        `The folder layout has been created there. Anything under the old root is untouched.${note}`,
      { home: result.home },
    );
  }

  if (action === 'list') {
    const spaces = listSpaces();
    const current = activeSpace();
    if (!spaces.length) {
      return ok(
        `No spaces yet. Create one with Space(action: "create", name: "…") — it becomes a folder under ${pretty(config.dirs.projects)}.`,
      );
    }
    const rows = spaces.map((s) => {
      const mark = current?.name === s.name ? '*' : ' ';
      const desc = s.description ? ` — ${s.description}` : '';
      return `${mark} ${s.name}${desc}\n    ${s.path}\n    last used: ${s.lastUsed ?? 'never'}`;
    });
    return ok(
      `${spaces.length} space(s) (* = active):\n\n${rows.join('\n\n')}`,
      { spaces, active: current?.name ?? null },
    );
  }

  if (action === 'current' || action === 'info') {
    const target = name ? { name: normalizeSpaceName(name), path: spacePath(name) } : activeSpace();
    if (!target) {
      return ok(
        `No active space. Relative paths currently resolve against ${pretty(config.home)}.\n` +
          `Pick one with Space(action: "use", name: "…") or create a new one.`,
      );
    }
    if (!fs.existsSync(target.path)) return fail(`Space "${target.name}" no longer exists on disk.`);

    const s = summarize(target.path);
    const meta = listSpaces().find((x) => x.name === target.name);
    const recent = s.recent.map((f) => `  ${f.rel} — ${bytes(f.size)}, ${new Date(f.mtimeMs).toISOString()}`);
    const ctx = path.join(target.path, CONTEXT_FILE);
    const ctxNote = fs.existsSync(ctx) ? `\n\n${CONTEXT_FILE} exists — read it to pick up where you left off.` : '';

    return ok(
      `Space "${target.name}"\n` +
        `  path: ${target.path}\n` +
        (meta?.description ? `  about: ${meta.description}\n` : '') +
        `  contents: ${s.count} file(s), ${bytes(s.totalBytes)}\n\n` +
        (recent.length ? `Most recently changed:\n${recent.join('\n')}` : 'The space is empty.') +
        ctxNote,
      { name: target.name, path: target.path, files: s.count },
    );
  }

  if (action === 'create') {
    if (!name) return fail('name is required when creating a space.');
    const { name: clean, path: dir, existed } = createSpace(name, description ?? '');
    const ctx = path.join(dir, CONTEXT_FILE);
    if (!fs.existsSync(ctx)) fs.writeFileSync(ctx, contextTemplate(clean, description ?? ''), 'utf8');
    useSpace(clean);
    return ok(
      `${existed ? 'Reused existing' : 'Created'} space "${clean}" at ${dir} and made it active.\n` +
        `A ${CONTEXT_FILE} is there for notes that should outlive this conversation.`,
      { name: clean, path: dir },
    );
  }

  if (action === 'use') {
    if (!name) return fail('name is required when switching spaces.');
    let target;
    try {
      target = useSpace(name);
    } catch (e) {
      const available = listSpaces().map((s) => s.name);
      return fail(e.message, available.length ? `Existing spaces: ${available.join(', ')}` : undefined);
    }
    const ctx = path.join(target.path, CONTEXT_FILE);
    const ctxBody = fs.existsSync(ctx) ? `\n\n--- ${CONTEXT_FILE} ---\n${fs.readFileSync(ctx, 'utf8').slice(0, 8000)}` : '';
    return ok(
      `Active space is now "${target.name}" (${target.path}). Relative paths resolve here.${ctxBody}`,
      { name: target.name, path: target.path },
    );
  }

  if (action === 'describe') {
    if (!name || description === undefined) return fail('Both name and description are required.');
    setSpaceDescription(name, description);
    return ok(`Updated the description for "${normalizeSpaceName(name)}".`);
  }

  if (action === 'delete') {
    if (!name) return fail('name is required when deleting a space.');
    const clean = normalizeSpaceName(name);
    const dir = spacePath(clean);
    if (!fs.existsSync(dir)) return fail(`No space named "${clean}".`);
    const s = summarize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    deleteSpaceRecord(clean);
    return ok(`Deleted space "${clean}" and its ${s.count} file(s) (${bytes(s.totalBytes)}) from ${dir}.`);
  }

  return fail(`Unknown action "${action}".`);
}

export function registerSpaceTools(server) {
  server.registerTool(
    'Space',
    {
      title: 'Manage workspaces',
      description:
        'Spaces are persistent project folders — the equivalent of a Cowork space. The active space is the base ' +
        'directory for every relative path used by Read, Write, Edit, Glob, Grep and Bash. ' +
        'Create one at the start of any piece of work that will span more than one conversation, and switch back ' +
        'to it later to resume. Each space has a CONTEXT.md worth reading and updating.\n\n' +
        'Use action "root" to see where the workspace lives, or to move it somewhere else entirely — ' +
        'it does not have to sit under your home directory.',
      inputSchema: {
        action: z
          .enum(['list', 'create', 'use', 'current', 'info', 'describe', 'delete', 'root'])
          .describe('What to do. "current" reports the active space; "info" inspects any space; "root" gets or sets the workspace root.'),
        name: z.string().optional().describe('Space name — a plain folder name.'),
        description: z.string().optional().describe('One line about what the space is for.'),
        path: z.string().optional().describe('For action "root": the new workspace root. Omit to just report it.'),
      },
      annotations: { openWorldHint: false },
    },
    guard(spaceTool),
  );
}
