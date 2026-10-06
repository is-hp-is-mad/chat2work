#!/usr/bin/env node
/**
 * Register (or remove) this server in Claude Desktop's config.
 *
 *   node scripts/install.mjs            add / update the entry
 *   node scripts/install.mjs --remove   take it out again
 *   node scripts/install.mjs --print    show what would be written
 *
 * Options:
 *   --name <id>          entry name in mcpServers (default "cowork")
 *   --home <path>        COWORK_HOME to use
 *   --allow <dir>        extra directory outside the home (repeatable)
 *   --allow-all          disable the path guard entirely
 *   --brave-key <key>    BRAVE_API_KEY for better web search
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeDesktopConfigFile, claudeDesktopConfigDir, config } from '../src/config.mjs';
import { ensureChromeHostRegistered } from '../src/lib/chrome-host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'src', 'index.mjs');

function parseArgs(argv) {
  const out = { allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--remove' || a === '-r') out.remove = true;
    else if (a === '--print' || a === '-p') out.print = true;
    else if (a === '--allow-all') out.allowAll = true;
    else if (a === '--name') out.name = next();
    else if (a === '--home') out.home = next();
    else if (a === '--allow') out.allow.push(next());
    else if (a === '--brave-key') out.braveKey = next();
    else if (a === '--help' || a === '-h') out.help = true;
    else console.warn(`Ignoring unknown option: ${a}`);
  }
  return out;
}

function buildEntry(args) {
  const env = {};
  if (args.home) env.COWORK_HOME = path.resolve(args.home);
  if (args.allow.length) env.COWORK_ALLOWED_DIRS = args.allow.map((d) => path.resolve(d)).join(path.delimiter === ';' ? ';' : ':');
  if (args.allowAll) env.COWORK_ALLOW_ALL = '1';
  if (args.braveKey) env.BRAVE_API_KEY = args.braveKey;

  const entry = { command: process.execPath, args: [ENTRY] };
  if (Object.keys(env).length) entry.env = env;
  return entry;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    return;
  }

  const name = args.name || 'cowork';
  const file = claudeDesktopConfigFile();
  const entry = buildEntry(args);

  if (args.print) {
    console.log(`Would write to ${file}:\n`);
    console.log(JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
    return;
  }

  if (!fs.existsSync(claudeDesktopConfigDir())) {
    console.error(
      `Claude Desktop's config folder was not found at:\n  ${claudeDesktopConfigDir()}\n\n` +
        `Install Claude Desktop and launch it once, then run this again.`,
    );
    process.exitCode = 1;
    return;
  }

  let json = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try {
      json = JSON.parse(raw);
    } catch (e) {
      console.error(`${file} is not valid JSON (${e.message}). Fix or remove it, then run this again.`);
      process.exitCode = 1;
      return;
    }
    const backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(backup, raw, 'utf8');
    console.log(`Backed up the existing config to\n  ${backup}`);
  }

  json.mcpServers ??= {};

  if (args.remove) {
    if (!json.mcpServers[name]) {
      console.log(`No "${name}" entry in ${file} — nothing to remove.`);
      return;
    }
    delete json.mcpServers[name];
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    console.log(`Removed "${name}" from ${file}.\nRestart Claude Desktop for it to take effect.`);
    return;
  }

  const existed = Boolean(json.mcpServers[name]);
  // Preserve env the user added by hand unless this run overrides it.
  if (existed && json.mcpServers[name].env) {
    entry.env = { ...json.mcpServers[name].env, ...(entry.env ?? {}) };
  }
  json.mcpServers[name] = entry;
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');

  // Ensure Chrome Native Messaging Host is registered in HKCU
  try {
    const reg = ensureChromeHostRegistered();
    if (reg.ok) {
      console.log(`Chrome Native Messaging Host: registered for ${reg.browsers?.length ?? 0} browser(s)`);
    }
  } catch (e) {
    console.warn(`Warning: Could not register Chrome Native Host: ${e.message}`);
  }

  console.log(
    [
      '',
      `${existed ? 'Updated' : 'Added'} the "${name}" MCP server in`,
      `  ${file}`,
      '',
      'Entry:',
      JSON.stringify(entry, null, 2)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
      '',
      `Workspace: ${entry.env?.COWORK_HOME ?? config.home}`,
      '',
      'Next: quit Claude Desktop completely (check the tray / menu bar) and start it again.',
      'Then open a new chat and type "run Status" to confirm it is connected.',
      '',
    ].join('\n'),
  );
}

main();
