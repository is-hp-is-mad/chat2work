#!/usr/bin/env node
/**
 * vm-watchdog.mjs — Background daemon monitoring the parent MCP process.
 *
 * If Claude Desktop or the MCP server exits (or is killed via Task Manager),
 * this daemon detects that the parent PID is gone and automatically unmounts
 * the official Claude Cowork VHD image from WSL2.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const unmountScript = path.resolve(HERE, 'unmount-vm.sh');

const parentPid = parseInt(process.argv[2], 10);
if (!parentPid || isNaN(parentPid)) {
  process.exit(1);
}

function isParentAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but no permission
  }
}

function doCleanup() {
  try {
    spawnSync('wsl', ['-u', 'root', unmountScript], { stdio: 'ignore', timeout: 15000 });
  } catch {}
  const vhdxPath = process.env.APPDATA 
    ? path.join(process.env.APPDATA, 'Claude', 'vm_bundles', 'claudevm.bundle', 'rootfs.vhdx')
    : null;
  if (vhdxPath) {
    try {
      spawnSync('wsl', ['--unmount', vhdxPath], { stdio: 'ignore', timeout: 15000 });
    } catch {}
  }
}

// Poll every 3 seconds
const interval = setInterval(() => {
  if (!isParentAlive(parentPid)) {
    clearInterval(interval);
    doCleanup();
    process.exit(0);
  }
}, 3000);

// Prevent this monitor from keeping standard event loop open if explicitly cancelled
interval.unref();

// Keep process running until parent exits
const heartbeat = setInterval(() => {}, 60000);
