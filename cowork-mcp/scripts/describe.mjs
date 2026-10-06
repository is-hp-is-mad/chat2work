#!/usr/bin/env node
/**
 * Print exactly what this server exposes, for wiring it into any MCP client.
 *
 *   node scripts/describe.mjs          human-readable
 *   node scripts/describe.mjs --json   machine-readable
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'src', 'index.mjs');
const asJson = process.argv.includes('--json');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [ENTRY],
  stderr: 'ignore',
});
const client = new Client({ name: 'describe', version: '1.0.0' });
await client.connect(transport);

const info = client.getServerVersion();
const caps = client.getServerCapabilities();
const { tools } = await client.listTools();
const { resources } = await client.listResources();
const { prompts } = await client.listPrompts();

if (asJson) {
  console.log(
    JSON.stringify(
      {
        connection: { transport: 'stdio', command: process.execPath, args: [ENTRY] },
        server: info,
        capabilities: caps,
        tools: tools.map((t) => ({ name: t.name, title: t.title, inputSchema: t.inputSchema })),
        resources: resources.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })),
        prompts: prompts.map((p) => ({ name: p.name, arguments: p.arguments })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`\nserver      ${info.name} ${info.version}`);
  console.log(`protocol    MCP over stdio`);
  console.log(`command     ${process.execPath}`);
  console.log(`args        ${ENTRY}`);
  console.log(`capabilities ${Object.keys(caps ?? {}).join(', ')}`);

  console.log(`\ntools (${tools.length})`);
  for (const t of tools) {
    const required = t.inputSchema?.required ?? [];
    const props = Object.keys(t.inputSchema?.properties ?? {});
    const sig = props.length
      ? props.map((p) => (required.includes(p) ? p : `${p}?`)).join(', ')
      : '';
    console.log(`  ${t.name.padEnd(18)} (${sig})`);
  }

  console.log(`\nresources (${resources.length})`);
  for (const r of resources) console.log(`  ${r.uri.padEnd(22)} ${r.mimeType}  ${r.name}`);

  console.log(`\nprompts (${prompts.length})`);
  for (const p of prompts) {
    const args = (p.arguments ?? []).map((a) => (a.required ? a.name : `${a.name}?`)).join(', ');
    console.log(`  ${p.name.padEnd(16)} (${args})`);
  }
  console.log();
}

await client.close();
process.exit(0);
