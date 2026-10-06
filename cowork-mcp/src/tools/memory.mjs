/**
 * Memory — Cowork's durable notes between conversations.
 *
 * One fact per file, with front matter, under <home>/Memory. An index file
 * (MEMORY.md) lists them so the whole set can be surfaced cheaply at the start
 * of a conversation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { config, ensureLayout } from '../config.mjs';
import { ok, fail, guard } from '../lib/result.mjs';
import { pretty } from '../lib/paths.mjs';
import { clamp } from '../lib/text.mjs';
import { parseFrontMatter } from './skills.mjs';

const INDEX = 'MEMORY.md';
const TYPES = ['user', 'project', 'feedback', 'reference'];

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function memoryFiles() {
  ensureLayout();
  let entries = [];
  try {
    entries = fs.readdirSync(config.dirs.memory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== INDEX)
    .map((e) => {
      const file = path.join(config.dirs.memory, e.name);
      const raw = fs.readFileSync(file, 'utf8');
      const { meta, body } = parseFrontMatter(raw);
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        /* ignore */
      }
      return {
        name: meta.name || path.basename(e.name, '.md'),
        description: meta.description || '',
        type: meta.type || meta['metadata.type'] || 'project',
        file,
        body: body.trim(),
        raw,
        mtime,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function rewriteIndex() {
  const items = memoryFiles();
  const lines = [
    '# Memory index',
    '',
    'One line per memory. Read the linked file for the detail.',
    '',
    ...items.map((m) => `- [${m.name}](${path.basename(m.file)}) — ${m.description || m.body.split('\n')[0].slice(0, 100)}`),
    '',
  ];
  fs.writeFileSync(path.join(config.dirs.memory, INDEX), lines.join('\n'), 'utf8');
  return items.length;
}

async function memoryTool({ action, name, description, content, type, query, limit }) {
  ensureLayout();

  if (action === 'list') {
    const items = memoryFiles();
    if (!items.length) {
      return ok(
        `No memories stored. Save one with Memory(action: "write", …) when you learn something durable ` +
          `about the user, an ongoing project, or how they want you to work.\nLocation: ${pretty(config.dirs.memory)}`,
      );
    }
    const byType = {};
    for (const m of items) (byType[m.type] ??= []).push(m);
    const sections = Object.entries(byType).map(
      ([t, list]) => `${t}:\n${list.map((m) => `  - ${m.name}: ${m.description || m.body.split('\n')[0].slice(0, 120)}`).join('\n')}`,
    );
    return ok(`${items.length} memor${items.length === 1 ? 'y' : 'ies'}:\n\n${sections.join('\n\n')}`, {
      memories: items.map((m) => ({ name: m.name, type: m.type, description: m.description })),
    });
  }

  if (action === 'read') {
    const items = memoryFiles();
    if (name) {
      const found = items.find((m) => m.name.toLowerCase() === String(name).toLowerCase());
      if (!found) return fail(`No memory named "${name}".`, items.length ? `Stored: ${items.map((m) => m.name).join(', ')}` : undefined);
      return ok(`${found.file}\n\n${found.raw.trim()}`);
    }
    if (!items.length) return ok('No memories stored yet.');
    const all = items
      .slice(0, limit ?? 40)
      .map((m) => `## ${m.name} (${m.type})\n${m.description ? `${m.description}\n\n` : ''}${m.body}`)
      .join('\n\n---\n\n');
    return ok(clamp(all, config.limits.maxOutputChars, 'memories'));
  }

  if (action === 'search') {
    if (!query) return fail('query is required for search.');
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const scored = memoryFiles()
      .map((m) => {
        const hay = `${m.name} ${m.description} ${m.body}`.toLowerCase();
        const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit ?? 10);
    if (!scored.length) return ok(`Nothing in memory matches "${query}".`);
    return ok(
      scored.map(({ m }) => `## ${m.name} (${m.type})\n${m.description}\n\n${m.body}`).join('\n\n---\n\n'),
    );
  }

  if (action === 'write') {
    if (!name || !content) return fail('Both name and content are required when writing a memory.');
    const slug = slugify(name);
    if (!slug) return fail('name must contain letters or digits.');
    const memType = TYPES.includes(type) ? type : 'project';
    const file = path.join(config.dirs.memory, `${slug}.md`);
    const existed = fs.existsSync(file);

    const doc = [
      '---',
      `name: ${slug}`,
      `description: ${(description || content.split('\n')[0]).replace(/\n/g, ' ').slice(0, 200)}`,
      'metadata:',
      `  type: ${memType}`,
      '---',
      '',
      content.trim(),
      '',
    ].join('\n');
    fs.writeFileSync(file, doc, 'utf8');
    const count = rewriteIndex();

    return ok(
      `${existed ? 'Updated' : 'Saved'} memory "${slug}" (${memType}) at ${file}. ${count} memor${count === 1 ? 'y' : 'ies'} total.`,
      { name: slug, path: file },
    );
  }

  if (action === 'delete') {
    if (!name) return fail('name is required.');
    const slug = slugify(name);
    const file = path.join(config.dirs.memory, `${slug}.md`);
    if (!fs.existsSync(file)) return fail(`No memory named "${slug}".`);
    fs.rmSync(file);
    rewriteIndex();
    return ok(`Deleted memory "${slug}".`);
  }

  return fail(`Unknown action "${action}".`);
}

export function registerMemoryTools(server) {
  server.registerTool(
    'Memory',
    {
      title: 'Durable memory',
      description:
        'Notes that persist across conversations, stored as files on this machine. ' +
        'Read them at the start of a session to pick up context; write one when you learn something durable — ' +
        'who the user is, what an ongoing project needs, or how they have asked you to work. ' +
        'Do not store things that only matter to the current conversation.',
      inputSchema: {
        action: z.enum(['list', 'read', 'search', 'write', 'delete']),
        name: z.string().optional().describe('Short kebab-case identifier for the memory.'),
        description: z.string().optional().describe('One line summarising it, used when listing.'),
        content: z.string().optional().describe('The memory itself, in Markdown.'),
        type: z.enum(TYPES).optional().describe('user | project | feedback | reference. Default project.'),
        query: z.string().optional().describe('Search terms.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { openWorldHint: false },
    },
    guard(memoryTool),
  );
}
