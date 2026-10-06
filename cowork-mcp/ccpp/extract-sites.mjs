#!/usr/bin/env node
/**
 * Dump every CCPP patch site with surrounding context so the transformation
 * each one performs can be read off precisely.
 *
 *   node ccpp/extract-sites.mjs <patched-extension-dir> [context-chars]
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? 'ClaudeInChrome-1.0.77-patch';
const CTX = Number(process.argv[3] ?? 900);
const MARKER = /__ccpp[A-Za-z_:$]*|\$ccpp\$[A-Za-z]+/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|json|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const report = [];
let total = 0;

for (const file of walk(root)) {
  if (path.basename(file) === '__ccpp_bootstrap.json') continue;
  const text = fs.readFileSync(file, 'utf8');
  MARKER.lastIndex = 0;
  let m;
  const seen = new Set();
  while ((m = MARKER.exec(text)) !== null) {
    // `$ccpp$eo` appears many times as a plain identifier; report it once per file.
    const key = m[0].startsWith('$ccpp$') ? `${file}:${m[0]}` : `${file}:${m.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total++;
    const from = Math.max(0, m.index - CTX);
    const to = Math.min(text.length, m.index + m[0].length + CTX);
    report.push(
      `\n${'='.repeat(100)}\n` +
        `SITE ${total}: ${m[0]}\n` +
        `FILE: ${path.relative(root, file)}  offset ${m.index}\n` +
        `${'-'.repeat(100)}\n` +
        text.slice(from, to),
    );
  }
}

const out = `CCPP patch sites in ${root}\n${total} site(s)\n${report.join('\n')}\n`;
fs.writeFileSync('ccpp/patch-sites.txt', out, 'utf8');
console.log(`${total} sites written to ccpp/patch-sites.txt (${out.length} chars)`);
