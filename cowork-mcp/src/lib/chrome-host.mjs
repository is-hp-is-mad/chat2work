/**
 * Claude in Chrome Native Messaging Host management.
 *
 * Ensures the Windows Native Messaging Host is registered for Google Chrome,
 * Microsoft Edge, Brave, Chromium, Arc, Vivaldi, and Opera.
 *
 * Hardcodes support for the custom Claude in Chrome gateway extension ID:
 * `epfodlfclfpfflchbjjlgljipcmnpccp`
 * alongside the official Anthropic extension IDs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..', '..');

export const TARGET_EXTENSION_ID = 'epfodlfclfpfflchbjjlgljipcmnpccp';

export const KNOWN_STATIC_IDS = [
  'epfodlfclfpfflchbjjlgljipcmnpccp', // Gateway custom key ID
  'ijjejglpcllkbdcbjkpjaelkckdkgjif', // User local active loaded unpacked extension ID
  'eiojlicalbnmomfnfckcnfgfnnohipkf', // D:\claude-in-chrome-for-gateway
  'helnofaajebpepbnlckcdfgoljinkoge', // D:\chat2work\browser-extension\claude-gateway
  'idfgjjeamlkegmpebnibnkkmkancfbio', // D:\Agent4Chrome\claude-gateway
];

/** Official Anthropic extension IDs */
export const OFFICIAL_EXTENSION_IDS = [
  'fcoeoabgfenejglbffodgkkbkcdhcgfn', // Official Prod Claude in Chrome
  'dihbgbndebgnbjfmelmegjepbnkhlgni', // Internal / Dev
  'dngcpimnedloihjnnfngkgjoidhnaolf', // Staging / Beta
];

/**
 * Calculate Chrome unpacked extension ID from directory path (Chromium GenerateIdForPath algorithm).
 */
export function calculateExtensionId(dirPath) {
  try {
    const resolved = path.resolve(dirPath);
    const hash = crypto.createHash('sha256').update(resolved, 'utf8').digest();
    let id = '';
    for (let i = 0; i < 16; i++) {
      const byte = hash[i];
      const hi = (byte >> 4) & 0x0f;
      const lo = byte & 0x0f;
      id += String.fromCharCode(97 + hi);
      id += String.fromCharCode(97 + lo);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * Collect all known extension IDs: hardcoded targets, official IDs, and dynamic unpacked paths.
 */
export function getKnownExtensionIds() {
  const ids = new Set([TARGET_EXTENSION_ID, ...KNOWN_STATIC_IDS, ...OFFICIAL_EXTENSION_IDS]);

  // Check standalone repository
  const standaloneDir = path.resolve(PROJECT_ROOT, '..', 'claude-in-chrome-for-gateway');
  if (fs.existsSync(standaloneDir)) {
    const sId = calculateExtensionId(standaloneDir);
    if (sId) ids.add(sId);
  }

  // Check sibling browser-extension directory
  const siblingGatewayDir = path.resolve(PROJECT_ROOT, '..', 'browser-extension', 'claude-gateway');
  if (fs.existsSync(siblingGatewayDir)) {
    const siblingId = calculateExtensionId(siblingGatewayDir);
    if (siblingId) ids.add(siblingId);
  }

  // Check common paths if present
  for (const p of [
    'D:\\claude-in-chrome-for-gateway',
    'C:\\claude-in-chrome-for-gateway',
    'D:\\chat2work\\browser-extension\\claude-gateway',
    'D:\\Agent4Chrome\\claude-gateway',
    'C:\\Agent4Chrome\\claude-gateway',
  ]) {
    try {
      if (fs.existsSync(p)) {
        const id = calculateExtensionId(p);
        if (id) ids.add(id);
      }
    } catch {
      /* ignore */
    }
  }

  // Also auto-discover any Chrome profiles where extension settings are stored
  try {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const syncDir = path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Sync Extension Settings');
    const localDir = path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Local Extension Settings');
    for (const d of [syncDir, localDir]) {
      if (fs.existsSync(d)) {
        const list = fs.readdirSync(d);
        for (const item of list) {
          if (/^[a-p]{32}$/.test(item)) {
            ids.add(item);
          }
        }
      }
    }
  } catch {}

  return Array.from(ids);
}

export const ALL_EXTENSION_IDS = getKnownExtensionIds();

export const HOST_NAME = 'com.anthropic.claude_browser_extension';

export const BROWSER_REGISTRY_KEYS = [
  { name: 'Chrome', key: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}` },
  { name: 'Edge', key: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}` },
  { name: 'Brave', key: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${HOST_NAME}` },
  { name: 'Chromium', key: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}` },
  { name: 'Arc', key: `HKCU\\Software\\ArcBrowser\\Arc\\NativeMessagingHosts\\${HOST_NAME}` },
  { name: 'Vivaldi', key: `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${HOST_NAME}` },
  { name: 'Opera', key: `HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts\\${HOST_NAME}` },
];

export function getHostDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'Claude', 'ChromeNativeHost');
}

export function getManifestPath() {
  return path.join(getHostDir(), `${HOST_NAME}.json`);
}

export function getHostExePath() {
  return path.join(getHostDir(), 'chrome-native-host.exe');
}

/**
 * Locate official chrome-native-host.exe binary from Claude Desktop installations.
 */
export function findSourceBinary() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const candidates = [
    // 1. Bundled fallback binary in package bin/ directory
    path.join(PROJECT_ROOT, 'bin', 'chrome-native-host.exe'),
    // 2. Standard user-level Claude install
    path.join(localAppData, 'Programs', 'Claude', 'resources', 'chrome-native-host.exe'),
    path.join(localAppData, 'Claude', 'resources', 'chrome-native-host.exe'),
    // 3. Machine-wide Program Files install
    path.join(programFiles, 'Claude', 'resources', 'chrome-native-host.exe'),
    path.join(programFilesX86, 'Claude', 'resources', 'chrome-native-host.exe'),
    // 4. MSIX / WindowsApps known paths
    path.join(programFiles, 'WindowsApps', 'Claude_2.19675.1.0_x64__pzs8sxrjxfjjc', 'app', 'resources', 'chrome-native-host.exe'),
    'D:\\WindowsApps\\Claude_2.19675.1.0_x64__pzs8sxrjxfjjc\\app\\resources\\chrome-native-host.exe',
    path.join(programFiles, 'WindowsApps', 'Claude_2.19675.0.0_x64__pzs8sxrjxfjjc', 'app', 'resources', 'chrome-native-host.exe'),
    'D:\\WindowsApps\\Claude_2.19675.0.0_x64__pzs8sxrjxfjjc\\app\\resources\\chrome-native-host.exe',
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).size > 10_000) return c;
    } catch {
      /* ignore */
    }
  }

  // Dynamic probe in WindowsApps across available drives (C, D, E)
  for (const root of ['C:\\Program Files\\WindowsApps', 'D:\\WindowsApps', 'E:\\WindowsApps']) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root);
      for (const e of entries) {
        if (/^Claude_/i.test(e)) {
          const target = path.join(root, e, 'app', 'resources', 'chrome-native-host.exe');
          try {
            if (fs.existsSync(target) && fs.statSync(target).size > 10_000) return target;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  return null;
}

/**
 * Ensure chrome-native-host.exe is installed in Claude's AppData directory.
 * Uses readFileSync/writeFileSync to bypass WindowsApps CopyFile restrictions.
 */
export function ensureHostBinary() {
  const dest = getHostExePath();
  const dir = getHostDir();

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(dest)) {
    try {
      const size = fs.statSync(dest).size;
      if (size > 10_000) return dest;
    } catch {
      /* proceed to copy */
    }
  }

  const src = findSourceBinary();
  if (!src) {
    return fs.existsSync(dest) ? dest : null;
  }

  try {
    const data = fs.readFileSync(src);
    fs.writeFileSync(dest, data);
    return dest;
  } catch (err) {
    if (fs.existsSync(dest)) return dest;
    throw new Error(`Failed to copy chrome-native-host.exe from ${src} to ${dest}: ${err.message}`);
  }
}

/**
 * Ensure the Native Messaging Host manifest JSON exists and includes all extension IDs.
 */
export function ensureManifest() {
  const dir = getHostDir();
  const manifestPath = getManifestPath();
  const exePath = getHostExePath();

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const origins = ALL_EXTENSION_IDS.map((id) => `chrome-extension://${id}/`);

  let currentOrigins = [];
  let needsWrite = true;

  if (fs.existsSync(manifestPath)) {
    try {
      const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      currentOrigins = content.allowed_origins ?? [];
      const hasAll = origins.every((o) => currentOrigins.includes(o));
      const hasPath = content.path && content.path.toLowerCase() === exePath.toLowerCase();
      if (hasAll && hasPath) {
        needsWrite = false;
      }
    } catch {
      needsWrite = true;
    }
  }

  if (needsWrite) {
    // Union origins
    const mergedOrigins = Array.from(new Set([...origins, ...currentOrigins]));
    const manifest = {
      name: HOST_NAME,
      description: 'Claude Browser Extension Native Host (Cowork Gateway Edition)',
      path: exePath,
      type: 'stdio',
      allowed_origins: mergedOrigins,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  return manifestPath;
}

/**
 * Check if a registry key exists and has the expected manifest path.
 */
export function checkRegistryKey(keyPath, expectedValue) {
  if (process.platform !== 'win32') return false;
  try {
    const res = spawnSync('reg.exe', ['query', keyPath, '/ve'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      if (!expectedValue) return true;
      return res.stdout.toLowerCase().includes(expectedValue.toLowerCase());
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Set a registry key default value to the manifest path.
 */
export function setRegistryKey(keyPath, manifestPath) {
  if (process.platform !== 'win32') return false;
  try {
    const res = spawnSync('reg.exe', ['add', keyPath, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
      encoding: 'utf8',
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Main entry point: Check and ensure Native Host manifest and all browser registry keys are set.
 * Returns report of what was checked/added.
 */
export function ensureChromeHostRegistered() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Only supported on Windows' };
  }

  const binary = ensureHostBinary();
  const manifest = ensureManifest();

  const results = [];
  let anyAdded = false;

  for (const { name, key } of BROWSER_REGISTRY_KEYS) {
    const exists = checkRegistryKey(key, manifest);
    if (!exists) {
      const added = setRegistryKey(key, manifest);
      results.push({ name, key, action: added ? 'added' : 'failed' });
      if (added) anyAdded = true;
    } else {
      results.push({ name, key, action: 'verified' });
    }
  }

  return {
    ok: true,
    targetExtensionId: TARGET_EXTENSION_ID,
    hostName: HOST_NAME,
    binaryPath: binary,
    manifestPath: manifest,
    browsers: results,
    anyAdded,
  };
}

/**
 * Return current status of Claude in Chrome native host integration.
 */
export function getChromeHostStatus() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'Only supported on Windows' };
  }

  const manifestPath = getManifestPath();
  const exePath = getHostExePath();
  const exeExists = fs.existsSync(exePath);

  let hasTargetId = false;
  let origins = [];

  if (fs.existsSync(manifestPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      origins = data.allowed_origins ?? [];
      hasTargetId = origins.includes(`chrome-extension://${TARGET_EXTENSION_ID}/`);
    } catch {}
  }

  const registeredBrowsers = [];
  for (const { name, key } of BROWSER_REGISTRY_KEYS) {
    if (checkRegistryKey(key, manifestPath)) {
      registeredBrowsers.push(name);
    }
  }

  return {
    ok: exeExists && hasTargetId && registeredBrowsers.length > 0,
    targetExtensionId: TARGET_EXTENSION_ID,
    hasTargetId,
    binaryExists: exeExists,
    binaryPath: exePath,
    manifestPath,
    origins,
    registeredBrowsers,
  };
}
