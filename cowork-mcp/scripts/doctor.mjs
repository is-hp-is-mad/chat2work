#!/usr/bin/env node
/**
 * Check that everything cowork-mcp depends on is present, and report what is
 * optional versus what is actually broken.
 *
 *   node scripts/doctor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { config, ensureLayout, allowedRoots, claudeDesktopConfigFile } from '../src/config.mjs';
import { collectSkills } from '../src/tools/skills.mjs';
import { getChromeHostStatus, ensureChromeHostRegistered } from '../src/lib/chrome-host.mjs';
import { getBrowserPipeName } from '../src/lib/browser-pipe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let problems = 0;
let warnings = 0;

const pass = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => {
  warnings++;
  console.log(`  ~ ${msg}`);
};
const fail = (msg) => {
  problems++;
  console.log(`  ✗ ${msg}`);
};

function probe(cmd, args = ['--version']) {
  try {
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 });
    if (res.status === 0) return String(res.stdout || res.stderr).split(/\r?\n/)[0].trim();
  } catch {
    /* not installed */
  }
  return null;
}

function pythonPackages(exe) {
  const code =
    'import importlib,sys\n' +
    'mods = {"python-docx":"docx","openpyxl":"openpyxl","python-pptx":"pptx","pypdf":"pypdf",' +
    '"reportlab":"reportlab","pandas":"pandas","matplotlib":"matplotlib","pdfplumber":"pdfplumber"}\n' +
    'for pip, mod in mods.items():\n'
    + '    try:\n'
    + '        importlib.import_module(mod); print("yes " + pip)\n'
    + '    except ImportError:\n'
    + '        print("no  " + pip)\n';
  const res = spawnSync(exe, ['-c', code], { encoding: 'utf8', timeout: 60_000 });
  if (res.status !== 0) return null;
  return String(res.stdout).trim().split(/\r?\n/);
}

console.log(`\ncowork-mcp doctor — ${process.platform} ${process.arch}\n`);

console.log('Runtime');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) pass(`Node ${process.version}`);
else fail(`Node ${process.version} — version 20 or newer is required.`);

const sdk = path.resolve(HERE, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
if (fs.existsSync(sdk)) pass(`@modelcontextprotocol/sdk ${JSON.parse(fs.readFileSync(sdk, 'utf8')).version}`);
else fail('Dependencies are not installed — run `npm install` in this folder.');

console.log('\nWorkspace');
try {
  ensureLayout();
  pass(`home ${config.home}`);
  for (const [key, dir] of Object.entries(config.dirs)) {
    if (!fs.existsSync(dir)) fail(`${key} directory missing: ${dir}`);
  }
  fs.writeFileSync(path.join(config.dirs.state, '.write-probe'), 'ok');
  fs.rmSync(path.join(config.dirs.state, '.write-probe'));
  pass('the workspace is writable');
} catch (e) {
  fail(`cannot use the workspace: ${e.message}`);
}
if (config.allowAll) warn('COWORK_ALLOW_ALL is set — the path guard is off and every path is writable.');
else pass(`path guard on, ${allowedRoots().length} allowed root(s)`);

console.log('\nClaude Desktop');
const cfgFile = claudeDesktopConfigFile();
if (!fs.existsSync(cfgFile)) {
  warn(`no config at ${cfgFile} — run \`npm run install-desktop\` after launching Claude Desktop once.`);
} else {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    const entries = Object.entries(cfg.mcpServers ?? {});
    const mine = entries.filter(([, v]) => JSON.stringify(v.args ?? []).includes('cowork'));
    if (mine.length) pass(`registered as "${mine.map(([k]) => k).join('", "')}"`);
    else warn('not registered yet — run `npm run install-desktop`.');
  } catch (e) {
    fail(`${cfgFile} is not valid JSON: ${e.message}`);
  }
}

console.log('\nClaude in Chrome (Gateway Edition)');
if (process.platform === 'win32') {
  let hostStatus = getChromeHostStatus();
  if (!hostStatus.ok) {
    try {
      const reg = ensureChromeHostRegistered();
      if (reg.ok) {
        pass('Native messaging host auto-registered');
      }
      hostStatus = getChromeHostStatus();
    } catch (e) {
      fail(`Native messaging host setup error: ${e.message}`);
    }
  }

  if (hostStatus.binaryExists) {
    pass(`Native host binary: ${hostStatus.binaryPath}`);
  } else {
    fail(`Native host binary missing: ${hostStatus.binaryPath}`);
  }

  if (hostStatus.hasTargetId) {
    pass(`Target extension ID allowed: ${hostStatus.targetExtensionId}`);
  } else {
    fail(`Target extension ID ${hostStatus.targetExtensionId} not in allowed_origins`);
  }

  if (hostStatus.registeredBrowsers.length > 0) {
    pass(`Registry verified for ${hostStatus.registeredBrowsers.join(', ')}`);
  } else {
    fail('NativeMessagingHosts registry key missing in HKCU');
  }

  // Check Named Pipe
  try {
    const pipeName = getBrowserPipeName();
    const pipes = fs.readdirSync('\\\\.\\pipe\\');
    const simplePipe = pipeName.replace(/^\\\\\.\\pipe\\/, '');
    if (pipes.includes(simplePipe)) {
      pass(`Named pipe active: ${pipeName}`);
    } else {
      warn(`Named pipe not currently active (${pipeName}) — start Google Chrome with extension enabled`);
    }
  } catch {
    /* ignore pipe probe error */
  }
} else {
  warn('Claude in Chrome native host integration is only supported on Windows');
}

console.log('\nShell');
if (process.platform === 'win32') {
  const ps = probe('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (ps) pass(`Windows PowerShell ${ps}`);
  else fail('powershell.exe was not found — the Bash tool cannot run.');
  const pwsh = probe('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  if (pwsh) pass(`PowerShell ${pwsh}`);
  const { findPosixShell } = await import('../src/tools/shell.mjs');
  const posix = findPosixShell('bash');
  if (posix) pass(`POSIX shell: ${posix} (shell: "bash" available)`);
  else warn('no usable bash — the only one on PATH is the WSL launcher, which cannot run Windows-path scripts. Install Git for Windows if you want POSIX shell commands.');
} else {
  const bash = probe('bash');
  if (bash) pass(bash);
  else fail('bash was not found.');
}

console.log('\nPython (REPL tool and the document skills)');
const pyExe = process.env.COWORK_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pyVersion = probe(pyExe);
if (!pyVersion) {
  warn(`${pyExe} not found — the REPL tool and the docx/xlsx/pptx/pdf skills will not work. Install Python 3.`);
} else {
  pass(pyVersion);
  const pkgs = pythonPackages(pyExe);
  if (!pkgs) warn('could not probe installed packages');
  else {
    const missing = pkgs.filter((l) => l.startsWith('no ')).map((l) => l.slice(4).trim());
    const present = pkgs.filter((l) => l.startsWith('yes')).map((l) => l.slice(4).trim());
    if (present.length) pass(`installed: ${present.join(', ')}`);
    if (missing.length) {
      warn(`missing: ${missing.join(', ')}`);
      console.log(`      install with:  ${pyExe} -m pip install ${missing.join(' ')}`);
    }
  }
}

console.log('\nOptional tools');
const soffice = probe('soffice', ['--version']) || probe('libreoffice', ['--version']);
if (soffice) pass(`LibreOffice — ${soffice} (document conversion available)`);
else warn('LibreOffice not found — Artifact(action:"convert") to PDF/Office formats will not work.');
const pandoc = probe('pandoc');
if (pandoc) pass(pandoc);
else warn('pandoc not found — Markdown/HTML conversion falls back to LibreOffice.');
const git = probe('git');
if (git) pass(git);

console.log('\nOptional keys');
if (config.web.braveKey) pass('BRAVE_API_KEY set — Brave web search');
else if (config.web.tavilyKey) pass('TAVILY_API_KEY set — Tavily web search');
else warn('no search key — WebSearch uses DuckDuckGo, which is free but occasionally rate-limits.');

console.log('\nSkills');
const skills = collectSkills();
if (skills.length) pass(`${skills.length} available: ${skills.map((s) => s.name).join(', ')}`);
else fail('no skills found — the skills/ folder is missing from this checkout.');

console.log(
  `\n${problems === 0 ? 'No problems found.' : `${problems} problem(s) found.`}` +
    `${warnings ? ` ${warnings} optional feature(s) unavailable.` : ''}\n`,
);
process.exit(problems ? 1 : 0);
