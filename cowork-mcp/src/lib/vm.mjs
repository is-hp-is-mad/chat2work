/**
 * vm.mjs — Integration with official Claude Cowork MicroVM (rootfs.vhdx) via WSL2.
 *
 * Provides:
 *   - Auto-mount on demand (read-only, safe)
 *   - Automatic unmount after inactivity (idle timeout)
 *   - Automatic cleanup on server shutdown or sudden process exit (watchdog daemon)
 *   - Command execution inside the official Ubuntu environment (/mnt/claude_rootfs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const MOUNT_SH = path.resolve(ROOT, 'scripts', 'mount-vm.sh');
const UNMOUNT_SH = path.resolve(ROOT, 'scripts', 'unmount-vm.sh');
const WATCHDOG_JS = path.resolve(ROOT, 'scripts', 'vm-watchdog.mjs');

export function toWslPath(winPath) {
  const target = winPath || config?.home || process.cwd();
  const norm = path.resolve(target).replace(/\\/g, '/');
  const m = norm.match(/^([a-zA-Z]):\/(.*)$/);
  if (m) {
    return `/mnt/${m[1].toLowerCase()}/${m[2]}`;
  }
  return norm;
}

const DEFAULT_IDLE_MS = parseInt(process.env.COWORK_VM_IDLE_TIMEOUT ?? `${10 * 60 * 1000}`, 10);

export function getOfficialVhdxPath() {
  if (process.platform !== 'win32') return null;
  // 1. Explicit environment override
  if (process.env.COWORK_VM_ROOTFS && fs.existsSync(process.env.COWORK_VM_ROOTFS)) {
    return process.env.COWORK_VM_ROOTFS;
  }
  // 2. Official Claude AppData location
  if (process.env.APPDATA) {
    const p = path.join(process.env.APPDATA, 'Claude', 'vm_bundles', 'claudevm.bundle', 'rootfs.vhdx');
    if (fs.existsSync(p)) return p;
  }
  // 3. Pure local standalone backup locations
  const backups = [
    'D:\\Claude_Local_Backup\\claudevm.bundle\\rootfs.vhdx',
    path.join(ROOT, 'backup-vm', 'claudevm.bundle', 'rootfs.vhdx'),
  ];
  for (const b of backups) {
    try {
      if (fs.existsSync(b)) return b;
    } catch {}
  }
  return null;
}

export function isVmAvailable() {
  return getOfficialVhdxPath() !== null;
}

class VmManager {
  constructor() {
    this.status = 'unmounted'; // 'unmounted' | 'mounting' | 'mounted' | 'unmounting'
    this.lastUsed = 0;
    this.idleTimer = null;
    this.watchdogProc = null;
    this.idleTimeoutMs = DEFAULT_IDLE_MS;
  }

  isMounted() {
    if (this.status !== 'mounted') return false;
    try {
      const res = spawnSync('wsl', ['-u', 'root', 'sh', '-c', 'mountpoint -q /mnt/claude_rootfs'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  touch() {
    this.lastUsed = Date.now();
    this._resetIdleTimer();
  }

  _resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.idleTimeoutMs > 0 && this.status === 'mounted') {
      this.idleTimer = setTimeout(() => {
        this.unmount('idle timeout (inactivity)');
      }, this.idleTimeoutMs);
      this.idleTimer.unref?.();
    }
  }

  _startWatchdog() {
    if (this.watchdogProc) return;
    try {
      const child = spawn(process.execPath, [WATCHDOG_JS, String(process.pid)], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      this.watchdogProc = child;
    } catch (e) {
      // Non-critical if watchdog fails to spawn
    }
  }

  _stopWatchdog() {
    if (this.watchdogProc) {
      try {
        this.watchdogProc.kill();
      } catch {}
      this.watchdogProc = null;
    }
  }

  async mount() {
    const vhdx = getOfficialVhdxPath();
    if (!vhdx) {
      throw new Error('Official Claude Cowork rootfs.vhdx not found.');
    }

    if (this.isMounted()) {
      this.status = 'mounted';
      this.touch();
      return { ok: true, alreadyMounted: true };
    }

    this.status = 'mounting';
    try {
      // 1. Attach bare disk to WSL
      spawnSync('wsl', ['--mount', vhdx, '--vhd', '--bare'], { stdio: 'ignore', timeout: 20000 });

      // 2. Mount partition to /mnt/claude_rootfs in WSL
      const mountRes = spawnSync('wsl', ['-u', 'root', toWslPath(MOUNT_SH), toWslPath(config?.home)], {
        encoding: 'utf8',
        timeout: 30000,
      });

      if (mountRes.status !== 0) {
        this.status = 'unmounted';
        throw new Error(`Failed to mount VM filesystem in WSL: ${mountRes.stderr || mountRes.stdout}`);
      }

      this.status = 'mounted';
      this.touch();
      this._startWatchdog();
      return { ok: true, output: mountRes.stdout };
    } catch (err) {
      this.status = 'unmounted';
      throw err;
    }
  }

  async unmount(reason = 'requested') {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.status = 'unmounting';
    try {
      spawnSync('wsl', ['-u', 'root', toWslPath(UNMOUNT_SH)], {
        stdio: 'ignore',
        timeout: 15000,
      });

      const vhdx = getOfficialVhdxPath();
      if (vhdx) {
        spawnSync('wsl', ['--unmount', vhdx], { stdio: 'ignore', timeout: 15000 });
      }

      this._stopWatchdog();
      this.status = 'unmounted';
      return { ok: true, reason };
    } catch (err) {
      this.status = 'unmounted';
      return { ok: false, error: err.message };
    }
  }

  async runInVm(cmd, args = [], options = {}) {
    await this.mount();
    this.touch();

    const fullCmd = args.length ? `${cmd} ${args.join(' ')}` : cmd;

    const res = spawnSync('wsl', ['-u', 'root', 'chroot', '/mnt/claude_rootfs', '/bin/sh'], {
      input: fullCmd + '\n',
      encoding: 'utf8',
      timeout: options.timeout ?? 60000,
    });

    return {
      status: res.status,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  }

  shutdown() {
    this._stopWatchdog();
    if (this.status === 'mounted') {
      this.unmount('process shutdown');
    }
  }
}

export const vm = new VmManager();
