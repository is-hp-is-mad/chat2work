/**
 * Skills — Cowork's `Skill` tool.
 *
 * A skill is a folder containing SKILL.md (with YAML front matter) plus any
 * supporting scripts or templates. Invoking a skill returns its instructions
 * so Claude follows them for the rest of the task.
 *
 * Two sources are merged:
 *   - built-ins shipped with this server (skills/ next to src/)
 *   - user skills under <home>/Skills, which shadow built-ins by name
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { config, ensureLayout } from '../config.mjs';
import { ok, fail, guard } from '../lib/result.mjs';
import { pretty, resolvePath } from '../lib/paths.mjs';
import { clamp, bytes } from '../lib/text.mjs';
import { walk } from '../lib/walk.mjs';
import { cwd } from '../session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_SKILLS_DIR = path.resolve(HERE, '..', '..', 'skills');

/** Minimal YAML front-matter reader — the subset SKILL.md actually uses. */
export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let currentKey = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const listItem = /^\s*-\s+(.*)$/.exec(rawLine);
    if (listItem && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(unquote(listItem[1].trim()));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    currentKey = kv[1];
    const value = kv[2].trim();
    meta[currentKey] = value === '' ? '' : unquote(value);
  }
  return { meta, body: text.slice(m[0].length) };
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

function readSkillDir(dir, source) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontMatter(raw);
  return {
    name: meta.name || path.basename(dir),
    description: meta.description || '',
    version: meta.version || '',
    requires: meta.requires || meta['python-packages'] || '',
    source,
    dir,
    file,
    body,
  };
}

/** All skills, user ones shadowing built-ins. */
export function collectSkills() {
  ensureLayout();
  /** @type {Map<string, any>} */
  const byName = new Map();

  for (const [root, source] of [
    [BUILTIN_SKILLS_DIR, 'built-in'],
    [config.dirs.skills, 'user'],
  ]) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const skill = readSkillDir(path.join(root, entry.name), source);
      if (skill) byName.set(skill.name.toLowerCase(), skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function listResources(dir) {
  const { files } = walk(dir, { maxFiles: 200 });
  return files
    .filter((f) => f.rel !== 'SKILL.md')
    .map((f) => `  ${f.rel} — ${bytes(f.size)}`);
}

/** Expand official Cowork placeholders like ${CLAUDE_SKILL_DIR} and ${CLAUDE_PLUGIN_ROOT} */
export function expandSkillPlaceholders(text, skillDir) {
  const normalized = skillDir.replace(/\\/g, '/');
  return text
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, normalized)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, normalized);
}

/** Official Cowork XML system prompt block for skills */
export function generateSkillsSystemPrompt(skills = collectSkills()) {
  const skillsXml = skills
    .map((s) => {
      return `<skill>\n<name>\n${s.name}\n</name>\n<description>\n${s.description}\n</description>\n<invoke_with>\nSkill tool\n</invoke_with>\n</skill>`;
    })
    .join('\n');

  return (
    '<skills_instructions>\n' +
    'Skills give you specialized instructions and domain knowledge for particular kinds of tasks. Before starting a task, check whether one of the skills in <available_skills> below covers it.\n\n' +
    'How to use a skill:\n' +
    '- A skill listed with a <location> is on disk: read <location>/SKILL.md (or <location> itself when it names a .md file) with the Read tool and follow its instructions.\n' +
    '- A skill listed with <invoke_with>Skill tool</invoke_with>: call the Skill tool with the skill\'s <name> exactly as listed (`skill: "<name>"`) and follow the instructions it loads. Load such a skill this way rather than by searching for or reading its files: skills refer to their own folders with the placeholders `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SKILL_DIR}`, which only the Skill tool fills in (they are not environment variables, so a command copied from a file you read yourself runs with them blank).\n\n' +
    'Important:\n' +
    '- All skills, tools, and VM environments are completely available on Free accounts — no Pro, Max, or paid subscription is ever required.\n' +
    '- Only use skills listed in <available_skills> below\n' +
    '- Once a skill\'s instructions are loaded in the current turn, follow them rather than loading the skill again\n' +
    '</skills_instructions>\n\n' +
    `<available_skills>\n${skillsXml}\n</available_skills>\n`
  );
}

/* ------------------------------------------------------------------ tools */

async function skillTool(input = {}) {
  const rawName = input.skill || input.name;
  if (!rawName) {
    return fail('Skill name must be specified via `skill` or `name`.');
  }
  const skills = collectSkills();
  const found = skills.find((s) => s.name.toLowerCase() === String(rawName).toLowerCase());
  if (!found) {
    return fail(
      `No skill named "${rawName}".`,
      skills.length
        ? `Available: ${skills.map((s) => s.name).join(', ')}. Use SkillList for descriptions.`
        : 'No skills are installed yet.',
    );
  }

  const resources = listResources(found.dir);
  const header =
    `Skill: ${found.name} (${found.source})\n` +
    `Location: ${found.dir}\n` +
    (found.requires ? `Requires: ${found.requires}\n` : '') +
    (resources.length ? `\nBundled files (read them with Read as needed):\n${resources.join('\n')}\n` : '');

  const expandedBody = expandSkillPlaceholders(found.body.trim(), found.dir);

  return ok(
    `${header}\n--- instructions ---\n\n${clamp(expandedBody, config.limits.maxOutputChars, 'skill instructions')}\n\n` +
      `--- end of instructions ---\n\nFollow these for the rest of this task.`,
    { name: found.name, dir: found.dir },
  );
}

async function skillListTool() {
  const skills = collectSkills();
  if (!skills.length) {
    return ok(
      `No skills installed. Built-ins live in ${BUILTIN_SKILLS_DIR}; your own go in ${pretty(config.dirs.skills)}.`,
    );
  }
  const rows = skills.map((s) => {
    const tag = s.source === 'user' ? ' [yours]' : '';
    return `- ${s.name}${tag}: ${s.description || '(no description)'}`;
  });
  return ok(
    `${skills.length} skill(s) available. Invoke one with Skill(name: "…") before doing that kind of work:\n\n${rows.join('\n')}`,
    { skills: skills.map((s) => ({ name: s.name, description: s.description, source: s.source })) },
  );
}

async function skillSaveTool({ name, description, content, overwrite }) {
  ensureLayout();
  const clean = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!clean) return fail('name must contain letters or digits.');

  const dir = path.join(config.dirs.skills, clean);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) && !overwrite) {
    return fail(`A skill named "${clean}" already exists at ${file}.`, 'Pass overwrite: true to replace it.');
  }

  fs.mkdirSync(dir, { recursive: true });
  const front = ['---', `name: ${clean}`, `description: ${description}`, '---', ''].join('\n');
  fs.writeFileSync(file, front + content.replace(/^---[\s\S]*?---\r?\n/, '').trimStart() + '\n', 'utf8');

  return ok(
    `Saved skill "${clean}" to ${file}.\n` +
      `It is available immediately via Skill(name: "${clean}"). Add supporting files to ${dir} and reference them from the instructions.`,
    { name: clean, path: file },
  );
}

async function skillDeleteTool({ name }) {
  const clean = String(name).trim().toLowerCase();
  const dir = path.join(config.dirs.skills, clean);
  if (!fs.existsSync(dir)) {
    const builtin = path.join(BUILTIN_SKILLS_DIR, clean);
    if (fs.existsSync(builtin)) return fail(`"${clean}" is a built-in skill and cannot be deleted.`, 'Shadow it by saving a skill with the same name.');
    return fail(`No user skill named "${clean}".`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return ok(`Deleted the skill "${clean}".`);
}

async function skillImportTool({ path: src, name }) {
  const abs = resolvePath(src, cwd());
  if (!fs.existsSync(abs)) return fail(`No such path: ${abs}`);
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) {
    return fail(
      `${abs} is not a directory.`,
      'Skills are folders containing SKILL.md. Unpack a .skill/.zip archive first, then import the folder.',
    );
  }
  if (!fs.existsSync(path.join(abs, 'SKILL.md'))) return fail(`${abs} has no SKILL.md.`);

  const parsed = readSkillDir(abs, 'user');
  const target = path.join(config.dirs.skills, name || parsed.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(abs, target, { recursive: true });
  return ok(`Imported skill "${path.basename(target)}" into ${target}.`);
}

/* -------------------------------------------------------------- register */

export function registerSkillTools(server) {
  server.registerTool(
    'Skill',
    {
      title: 'Load a skill',
      description:
        'Load a skill: a set of expert instructions for a specific kind of work, such as producing Word, Excel, ' +
        'PowerPoint or PDF files. Call this BEFORE starting that kind of work, not after. ' +
        'Run SkillList first if you are unsure what is available.',
      inputSchema: {
        skill: z.string().optional().describe('Skill name to invoke, exactly as listed in <available_skills> (e.g. "docx").'),
        name: z.string().optional().describe('Skill name (alias for skill).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(skillTool),
  );

  server.registerTool(
    'SkillList',
    {
      title: 'List skills',
      description: 'List every available skill with a one-line description of when to use it.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(skillListTool),
  );

  server.registerTool(
    'SkillSave',
    {
      title: 'Save a skill',
      description:
        'Store reusable instructions as a skill so they can be loaded in future conversations. ' +
        'Write them as directions to a competent colleague: when to use this, the steps, the pitfalls.',
      inputSchema: {
        name: z.string().describe('Short kebab-case name.'),
        description: z.string().describe('One line: when should this skill be used?'),
        content: z.string().describe('The instructions, in Markdown.'),
        overwrite: z.boolean().optional().describe('Replace an existing skill with this name.'),
      },
      annotations: { openWorldHint: false },
    },
    guard(skillSaveTool),
  );

  server.registerTool(
    'SkillDelete',
    {
      title: 'Delete a skill',
      description: 'Remove one of your saved skills. Built-in skills cannot be removed.',
      inputSchema: { name: z.string() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    guard(skillDeleteTool),
  );

  server.registerTool(
    'SkillImport',
    {
      title: 'Import a skill folder',
      description:
        'Copy a skill folder (one containing SKILL.md) into your skill library. ' +
        'For a .skill or .zip archive, unpack it with Bash first, then import the folder.',
      inputSchema: {
        path: z.string().describe('Folder containing SKILL.md.'),
        name: z.string().optional().describe('Install under a different name.'),
      },
      annotations: { openWorldHint: false },
    },
    guard(skillImportTool),
  );
}
