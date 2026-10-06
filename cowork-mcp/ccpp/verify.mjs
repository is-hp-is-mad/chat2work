#!/usr/bin/env node
/**
 * Load a patched extension in a throwaway Chrome and report any console errors
 * from its own pages.
 *
 *   node ccpp/verify.mjs <extension-dir>
 *
 * A blank side panel is almost always a module-scope ReferenceError, which is
 * invisible to `node --check`. This catches that class of failure without
 * needing a human to click anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const dir = path.resolve(process.argv[2] ?? 'ClaudeInChrome-1.0.85-patch');
const PORT = 9333 + (process.pid % 500);

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['chrome'], { encoding: 'utf8' });
  return probe.status === 0 ? String(probe.stdout).split(/\r?\n/)[0].trim() : null;
}

/** Chrome derives the extension id from the manifest `key`. */
function extensionId(manifest) {
  if (!manifest.key) return null;
  const h = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest();
  return [...h.subarray(0, 16)]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROFILE_TAG = 'ccpp-verify-';

/**
 * Kill a Chrome and everything it spawned. `child.kill()` only reaps the
 * parent on Windows; the renderer and GPU processes survive and pile up.
 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

/** Sweep up any Chrome left behind by an earlier run that died badly. */
function killStrays() {
  if (process.platform !== 'win32') return 0;
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${PROFILE_TAG}*' } | ` +
        `ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8' },
  );
  const pids = String(ps.stdout || '')
    .split(/\r?\n/)
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter(Number.isInteger);
  for (const pid of pids) killTree(pid);
  return pids.length;
}

/** Print one surface's result. Returns 1 when it failed. */
function report(label, problems) {
  // Network noise is expected offline and in a signed-out profile.
  const real = problems.filter(
    (p) => !/Failed to load resource|net::ERR_|ERR_INTERNET|401|403|Failed to fetch|NetworkError/i.test(p),
  );
  if (real.length === 0) {
    console.log(`  ✓ ${label}`);
    return 0;
  }
  console.log(`  ✗ ${label}`);
  for (const p of [...new Set(real)].slice(0, 6)) {
    console.log(`      ${p.split('\n')[0].slice(0, 200)}`);
  }
  return 1;
}

async function devtools(pathname, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${pathname} → HTTP ${res.status}: ${text.slice(0, 160)}`);
  }
}

/** Newer Chrome only accepts PUT for /json/new; older ones only GET. */
async function openPage(url) {
  for (const method of ['PUT', 'GET']) {
    try {
      const t = await devtools(`/json/new?${encodeURIComponent(url)}`, method);
      if (t?.webSocketDebuggerUrl) return t;
    } catch {
      /* try the other verb */
    }
  }
  return null;
}

/** Attach to a target and collect console errors + uncaught exceptions. */
async function inspect(wsUrl, label, settleMs = 4000, isDocument = true) {
  const ws = new WebSocket(wsUrl);
  const problems = [];
  let id = 0;

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`could not attach to ${label}`)), { once: true });
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`${d.text} ${d.exception?.description ?? ''}`.trim());
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(msg.params.args.map((a) => a.description ?? a.value ?? '').join(' '));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      problems.push(`${msg.params.entry.text} (${msg.params.entry.url ?? ''})`);
    }
  });

  const send = (method) => ws.send(JSON.stringify({ id: ++id, method }));
  send('Runtime.enable');
  send('Log.enable');

  await sleep(settleMs);

  // A page that failed to load reports no console errors at all, which would
  // read as a pass. Confirm something actually rendered. Service workers have
  // no DOM, so they are judged on their console output alone.
  if (!isDocument) {
    ws.close();
    return problems;
  }

  const probe = await new Promise((resolve) => {
    const probeId = ++id;
    const onMessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id === probeId) {
        ws.removeEventListener('message', onMessage);
        resolve(msg.result?.result?.value ?? null);
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(
      JSON.stringify({
        id: probeId,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          expression:
            '({url:location.href,nodes:document.body?document.body.querySelectorAll("*").length:0,' +
            'title:document.title})',
        },
      }),
    );
    setTimeout(() => resolve(null), 3000);
  });

  ws.close();
  if (!probe) problems.push('the page did not respond to evaluation');
  else if (!probe.url.startsWith('chrome-extension://')) {
    problems.push(`the page is not an extension page (${probe.url}) — the extension did not load`);
  } else if (probe.nodes < 3) {
    problems.push(`the page rendered ${probe.nodes} element(s) — it is blank`);
  }
  return problems;
}

/** One request/response round trip on a CDP websocket. */
function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`${method}: timed out`));
    }, 15_000);
  });
}

/**
 * Chrome 137+ removed `--load-extension`. The supported route is the CDP
 * Extensions domain, which needs --enable-unsafe-extension-debugging.
 */
async function loadUnpackedViaCdp(extensionPath) {
  const version = await devtools('/json/version');
  if (!version.webSocketDebuggerUrl) throw new Error('no browser-level debugging endpoint');
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not attach to the browser target')), { once: true });
  });
  try {
    const res = await cdp(ws, 'Extensions.loadUnpacked', { path: extensionPath });
    return res.id ?? null;
  } finally {
    ws.close();
  }
}

async function main() {
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    console.error(`${dir} has no manifest.json`);
    process.exit(2);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error('Chrome was not found. Set CHROME_PATH to the executable.');
    process.exit(2);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const id = extensionId(manifest);
  if (!id) {
    console.error('The manifest has no `key`, so the extension id is not deterministic.');
    process.exit(2);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_TAG));
  const swept = killStrays();
  console.log(`\nVerifying ${path.basename(dir)} (${manifest.name} ${manifest.version})`);
  console.log(`  chrome:    ${chrome}`);
  console.log(`  extension: ${id}`);
  if (swept) console.log(`  swept ${swept} stray Chrome process(es) from an earlier run`);
  console.log();

  // Headless by default: a verification run should never put a window on the
  // user's screen. CCPP_HEADED=1 when a transform needs to be watched.
  const headed = /^(1|true|yes)$/i.test(process.env.CCPP_HEADED ?? '');
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    // Chrome 137+ dropped --load-extension; this enables the CDP route instead.
    '--enable-unsafe-extension-debugging',
    `--load-extension=${dir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--window-size=900,700',
    'about:blank',
  ];
  if (!headed) args.unshift('--headless=new', '--disable-gpu');

  const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

  let chromeStderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c) => {
    chromeStderr += c;
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    killTree(child.pid);
    killStrays();
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* Chrome may still hold a handle; the temp dir is disposable */
    }
  };

  // Cover every way this script can end, including Ctrl-C and a crash.
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }
  process.on('uncaughtException', (e) => {
    cleanup();
    console.error(`\n${e.stack ?? e}\n`);
    process.exit(2);
  });

  try {
    // Wait for the debugging endpoint.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try {
        await devtools('/json/version');
        up = true;
      } catch {
        await sleep(500);
      }
    }
    if (!up) throw new Error('Chrome did not expose a debugging endpoint');

    await sleep(2500); // let the service worker boot

    // If the command-line switch was ignored (Chrome 137+), load it over CDP.
    let targets = await devtools('/json/list');
    if (!targets.some((t) => t.url?.includes(id))) {
      try {
        await loadUnpackedViaCdp(dir);
        console.log('  loaded via CDP Extensions.loadUnpacked\n');
        await sleep(3000);
        targets = await devtools('/json/list');
      } catch (e) {
        console.log(`  could not load the extension: ${e.message}\n`);
      }
    }

    const findings = [];

    // 1. The extension's own background service worker.
    const worker = targets.find((t) => t.url?.includes(id) && t.type === 'service_worker');
    if (worker) {
      const problems = await inspect(worker.webSocketDebuggerUrl, 'service worker', 3000, false);
      findings.push(['service worker', problems]);
    } else {
      console.log('  targets Chrome reported:');
      for (const t of targets) console.log(`    ${t.type.padEnd(16)} ${(t.url ?? '').slice(0, 90)}`);
      const loadErrors = chromeStderr
        .split(/\r?\n/)
        .filter((l) => /extension|manifest/i.test(l))
        .slice(0, 8);
      if (loadErrors.length) {
        console.log('  Chrome said:');
        for (const l of loadErrors) console.log(`    ${l.trim().slice(0, 180)}`);
      }
      console.log();
      findings.push(['service worker', ['(no service worker target — it may have failed to register)']]);
    }

    // 2. Each extension page, opened fresh.
    for (const page of ['sidepanel.html', 'options.html', 'ccpp-settings.html']) {
      if (!fs.existsSync(path.join(dir, page))) continue;
      const opened = await openPage(`chrome-extension://${id}/${page}`);
      if (!opened?.webSocketDebuggerUrl) {
        findings.push([page, ['(could not open the page)']]);
        continue;
      }
      const problems = await inspect(opened.webSocketDebuggerUrl, page);
      findings.push([page, problems]);
      await devtools(`/json/close/${opened.id}`).catch(() => {});
    }

    let failed = 0;
    for (const [label, problems] of findings) {
      failed += report(label, problems);
    }

    // Second pass: the patched path. Seed API-key mode and confirm the pages
    // still render — the whole point of the patch is that they do.
    const seedPage = await openPage(`chrome-extension://${id}/ccpp-settings.html`);
    if (seedPage?.webSocketDebuggerUrl) {
      const ws = new WebSocket(seedPage.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener('open', r, { once: true }));
      await cdp(ws, 'Runtime.evaluate', {
        awaitPromise: true,
        expression: `new Promise(r=>chrome.storage.local.set({
          authMode:"apiKey", anthropicApiKey:"sk-ant-verify-placeholder",
          customModels:[{id:"claude-sonnet-4-6",name:"Sonnet 4.6"}],
          compatMode:true, systemPrompt:"verify"
        },()=>r(1)))`,
      }).catch(() => {});
      ws.close();
      await devtools(`/json/close/${seedPage.id}`).catch(() => {});
      await sleep(500);

      console.log('\n  with authMode = apiKey:');
      for (const page of ['sidepanel.html', 'options.html']) {
        const opened = await openPage(`chrome-extension://${id}/${page}`);
        if (!opened?.webSocketDebuggerUrl) {
          failed += report(`${page} (apiKey)`, ['(could not open the page)']);
          continue;
        }
        const problems = await inspect(opened.webSocketDebuggerUrl, page);
        failed += report(`${page} (apiKey)`, problems);
        await devtools(`/json/close/${opened.id}`).catch(() => {});
      }
    }

    console.log(
      failed === 0
        ? '\nNo module-scope or render errors. Still worth a real click-through.\n'
        : `\n${failed} surface(s) reported errors.\n`,
    );
    cleanup();
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error(`\nVerification could not run: ${e.message}\n`);
    cleanup();
    process.exit(2);
  }
}

main();
