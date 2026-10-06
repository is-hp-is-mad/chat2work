#!/usr/bin/env node
/**
 * cowork-mcp — Claude Cowork's working surface, as an MCP server.
 *
 * Runs on the host with no VM and no sandbox, so Claude Desktop on any plan
 * gets the same tools Cowork provides: a persistent workspace, files, a shell,
 * REPLs, the web, skills, memory, and background tasks.
 */
import fs from 'node:fs';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { config, ensureLayout, allowedRoots } from './config.mjs';
import { activeSpace, listSpaces, cwd } from './session.mjs';
import { ok, guard } from './lib/result.mjs';

import { registerFileTools } from './tools/files.mjs';
import { registerShellTools, shutdownShells } from './tools/shell.mjs';
import { registerReplTools, shutdownRepls } from './tools/repl.mjs';
import { registerWebTools } from './tools/web.mjs';
import { registerTodoTools } from './tools/todo.mjs';
import { registerSpaceTools } from './tools/spaces.mjs';
import { registerSkillTools, collectSkills, generateSkillsSystemPrompt } from './tools/skills.mjs';
import { registerMemoryTools } from './tools/memory.mjs';
import { registerArtifactTools } from './tools/artifacts.mjs';
import { registerTaskTools, shutdownTasks } from './tools/tasks.mjs';
import { registerComputerTools, ACTIONS, actionShape } from './tools/computer.mjs';
import { registerVmTools } from './tools/vm.mjs';
import { registerBrowserTools } from './tools/browser.mjs';
import { vm, isVmAvailable } from './lib/vm.mjs';
import { shutdownDesktop, platformSupported } from './lib/desktop.mjs';
import { ensureChromeHostRegistered, getChromeHostStatus, TARGET_EXTENSION_ID } from './lib/chrome-host.mjs';
import { GUIDE, buildPrompt } from './guide.mjs';

const VERSION = '1.0.0';

/* --------------------------------------------------------------- logging */

function log(...args) {
  // stdout is the MCP transport — diagnostics must go to stderr.
  if (config.debug) process.stderr.write(`[cowork-mcp] ${args.join(' ')}\n`);
}

/* ------------------------------------------------------------ diagnostics */

async function statusTool() {
  const space = activeSpace();
  const spaces = listSpaces();
  const skills = collectSkills();

  const chromeStatus = getChromeHostStatus();

  const lines = [
    `cowork-mcp ${VERSION} — running on ${process.platform} ${process.arch}, Node ${process.version}`,
    '',
    'Locations',
    `  Workspace:     ${config.home}`,
    `  Set by:        ${config.homeSource}`,
    `  Active space:  ${space ? `${space.name} — ${space.path}` : '(none — relative paths resolve to the workspace root)'}`,
    `  Artifacts:     ${config.dirs.artifacts}`,
    `  Skills:        ${config.dirs.skills}`,
    `  Memory:        ${config.dirs.memory}`,
    '',
    'Configuration',
    `  Default shell: ${config.defaultShell}`,
    `  File access:   ${
      config.allowAll
        ? 'unrestricted — any path this OS account can reach'
        : `confined to:\n${allowedRoots().map((r) => `                 - ${r}`).join('\n')}`
    }`,
    `  Web search:    ${config.web.braveKey ? 'Brave' : config.web.tavilyKey ? 'Tavily' : 'DuckDuckGo (no key needed)'}`,
    `  Computer use:  ${platformSupported() ? 'available (screen, mouse, keyboard, clipboard, official Cowork parity)' : 'unavailable on this platform'}`,
    `  Chrome native: ${chromeStatus.ok ? `ready (ID: ${chromeStatus.targetExtensionId}, ${chromeStatus.registeredBrowsers.length} browser(s))` : 'not configured'}`,
    `  Visual review: ${chromeStatus.ok ? 'ready (BrowserScreenshot silent wake-up snapshot)' : 'unavailable'}`,
    `  Official VM:   ${isVmAvailable() ? `available (mounted: ${vm.isMounted() ? 'YES' : 'NO'}, auto-idle unmount: ${Math.round(vm.idleTimeoutMs / 60000)}m)` : 'not present'}`,
    `  Subscription:  Unlocked for all accounts (including Free, no Pro/Max needed)`,
    '',
    `Content: ${spaces.length} space(s), ${skills.length} skill(s) available.`,
  ];

  return ok(lines.join('\n'), {
    version: VERSION,
    home: config.home,
    homeSource: config.homeSource,
    unrestricted: config.allowAll,
    activeSpace: space?.name ?? null,
    chromeHost: chromeStatus,
  });
}

/* ------------------------------------------------------------------ main */

async function main() {
  ensureLayout();

  // Ensure Claude in Chrome Native Messaging Host is registered
  try {
    const chromeReg = ensureChromeHostRegistered();
    if (chromeReg.ok) {
      log(`Claude in Chrome host ensured (ID: ${chromeReg.targetExtensionId}, ${chromeReg.browsers?.length ?? 0} browser(s))`);
    }
  } catch (e) {
    log(`Failed to verify Claude in Chrome host: ${e.message}`);
  }

  const server = new McpServer(
    { name: 'cowork', version: VERSION, title: 'Cowork' },
    {
      instructions: GUIDE,
      capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
    },
  );

  // Count tools as they register, for the startup log line.
  let toolCount = 0;
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (...args) => {
    toolCount += 1;
    return registerTool(...args);
  };

  registerSpaceTools(server);
  registerFileTools(server);
  registerShellTools(server);
  registerReplTools(server);
  registerWebTools(server);
  registerTodoTools(server);
  registerSkillTools(server);
  registerMemoryTools(server);
  registerArtifactTools(server);
  registerTaskTools(server);
  registerComputerTools(server);
  registerVmTools(server);
  registerBrowserTools(server);

  // Case-insensitive & snake_case alias proxy on server._registeredTools
  // Allows callers using 'computer' -> 'Computer', 'computer_batch' -> 'ComputerBatch',
  // and direct official actions ('screenshot', 'left_click', etc.) -> 'Computer'
  const origTools = server._registeredTools;
  server._registeredTools = new Proxy(origTools, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop];
      if (typeof prop !== 'string') return target[prop];

      const lower = prop.toLowerCase();
      if (lower === 'tabs_context_mcp') return target.TabsContext;
      if (lower === 'tabs_create_mcp') return target.TabsCreate;
      if (lower === 'tabs_close_mcp') return target.TabsClose;
      if (lower === 'click') return target.BrowserClick;

      const match = Object.keys(target).find((k) => k.toLowerCase() === lower);
      if (match) return target[match];

      const pascal = prop.replace(/(^|_)([a-z0-9])/gi, (_, __, letter) => letter.toUpperCase());
      if (pascal in target) return target[pascal];

      if (ACTIONS.includes(lower) && target.Computer) {
        return {
          title: `Action: ${prop}`,
          description: `Direct invocation of official computer action "${prop}".`,
          inputSchema: actionShape,
          annotations: { destructiveHint: true, openWorldHint: true },
          handler: async (args) => {
            return target.Computer.handler({ action: lower, ...args });
          },
        };
      }

      return target[prop];
    },
  });

  server.registerTool(
    'Status',
    {
      title: 'Cowork status',
      description:
        'Report where this server is working, what is configured, and which optional features are available. ' +
        'Run this when a path or capability question comes up, or when something is not behaving as expected.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(statusTool),
  );

  /* ---------------------------------------------------------- resources */

  server.registerResource(
    'guide',
    'cowork://guide',
    {
      title: 'How to work in Cowork',
      description:
        'Operating instructions: works on every plan including Claude Free; use this connector first whenever the user wants files on their computer changed; spaces, skills, memory, artifacts and when to use each tool.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }] }),
  );

  server.registerResource(
    'workspace',
    'cowork://workspace',
    {
      title: 'Current workspace',
      description: 'The active space, the folder layout, and what is in it.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const space = activeSpace();
      const spaces = listSpaces();
      const body = [
        '# Workspace',
        '',
        `- Home: \`${config.home}\``,
        `- Active space: ${space ? `**${space.name}** — \`${space.path}\`` : '_none_'}`,
        `- Relative paths resolve against: \`${cwd()}\``,
        '',
        '## Spaces',
        '',
        spaces.length
          ? spaces.map((s) => `- **${s.name}**${s.description ? ` — ${s.description}` : ''} (\`${s.path}\`)`).join('\n')
          : '_No spaces yet._',
        '',
      ].join('\n');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: body }] };
    },
  );

  server.registerResource(
    'skills',
    'cowork://skills',
    {
      title: 'Available skills',
      description: 'Every skill this server can load, with when to use each.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const skills = collectSkills();
      const promptXml = generateSkillsSystemPrompt(skills);
      const markdownList = [
        '# Skills',
        '',
        'Load one with the `Skill` tool (e.g. `Skill(skill: "docx")`) before starting that kind of work.',
        '',
        ...skills.map((s) => `- **${s.name}** (${s.source}) — ${s.description}`),
        '',
        '## Official System Prompt Format',
        '',
        '```xml',
        promptXml.trim(),
        '```',
        '',
      ].join('\n');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: markdownList }] };
    },
  );

  server.registerResource(
    'memory',
    'cowork://memory',
    {
      title: 'Memory index',
      description: 'Notes kept between conversations.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const file = path.join(config.dirs.memory, 'MEMORY.md');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Memory index\n\n_Nothing stored yet._\n';
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  /* ------------------------------------------------------------ prompts */

  server.registerPrompt(
    'cowork',
    {
      title: 'Work like Cowork',
      description: 'Load the Cowork operating instructions and pick up the current workspace context.',
      argsSchema: { task: z.string().optional().describe('What you want done, if you already know.') },
    },
    ({ task }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: buildPrompt('cowork', { task }) } }],
    }),
  );

  server.registerPrompt(
    'new-space',
    {
      title: 'Start a new project space',
      description: 'Create a space, set up its context file, and plan the work.',
      argsSchema: {
        name: z.string().describe('Name for the space.'),
        goal: z.string().describe('What you are trying to achieve.'),
      },
    },
    ({ name, goal }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: buildPrompt('new-space', { name, goal }) } }],
    }),
  );

  server.registerPrompt(
    'make-document',
    {
      title: 'Produce a document',
      description: 'Write a Word, Excel, PowerPoint or PDF deliverable using the built-in skills.',
      argsSchema: {
        kind: z.string().describe('docx, xlsx, pptx or pdf.'),
        brief: z.string().describe('What the document should contain and who it is for.'),
      },
    },
    ({ kind, brief }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: buildPrompt('make-document', { kind, brief }) } }],
    }),
  );

  server.registerPrompt(
    'research',
    {
      title: 'Research a question',
      description: 'Run the research skill end to end and produce a sourced report.',
      argsSchema: { question: z.string().describe('The question to answer.') },
    },
    ({ question }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: buildPrompt('research', { question }) } }],
    }),
  );

  server.registerPrompt(
    'resume',
    {
      title: 'Resume where we left off',
      description: 'Reload memory, the active space and its todo list, then continue.',
      argsSchema: {},
    },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: buildPrompt('resume', {}) } }] }),
  );

  /* --------------------------------------------------------- lifecycle */

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready — home=${config.home}, tools=${toolCount}`);

  let shuttingDown = false;
  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    try {
      shutdownShells();
      shutdownRepls();
      shutdownTasks();
      shutdownDesktop();
      vm.shutdown();
    } catch (e) {
      log(`cleanup error: ${e?.message}`);
    }
    // Let the event loop drain the handles we just closed; forcing an exit
    // while they are mid-close trips a libuv assertion on Windows.
    process.exitCode = 0;
    const bail = setTimeout(() => process.exit(0), 750);
    bail.unref?.();
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => shutdown(signal));
  }
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.on('uncaughtException', (e) => {
    process.stderr.write(`[cowork-mcp] uncaught: ${e?.stack ?? e}\n`);
  });
  process.on('unhandledRejection', (e) => {
    process.stderr.write(`[cowork-mcp] unhandled rejection: ${e?.stack ?? e}\n`);
  });
}

main().catch((e) => {
  process.stderr.write(`[cowork-mcp] failed to start: ${e?.stack ?? e}\n`);
  process.exit(1);
});
