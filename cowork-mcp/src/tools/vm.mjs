/**
 * VM tools — Mount, inspect, and run commands inside the official Claude Cowork Linux MicroVM.
 */
import { z } from 'zod';
import { vm, isVmAvailable, getOfficialVhdxPath } from '../lib/vm.mjs';
import { ok, fail, guard } from '../lib/result.mjs';
import { clamp } from '../lib/text.mjs';
import { config } from '../config.mjs';

async function vmStatusTool() {
  const available = isVmAvailable();
  const vhdx = getOfficialVhdxPath();
  const mounted = vm.isMounted();

  const lines = [
    'Official Claude Cowork VM Status',
    '================================',
    `Available on host: ${available ? 'YES' : 'NO'}`,
    `VHDX location:     ${vhdx ?? '(not found)'}`,
    `Mounted in WSL:    ${mounted ? 'YES (/mnt/claude_rootfs)' : 'NO (idle / unmounted)'}`,
    `Auto-idle timeout: ${Math.round(vm.idleTimeoutMs / 60000)} minutes of inactivity`,
    `Auto-shutdown:     Active (cleans up on Claude Desktop close or crash via watchdog)`,
    '',
    'Environment Features:',
    '  - Linux Kernel:  Ubuntu 22.04 LTS (Jammy)',
    '  - Node.js:       v22.22.3',
    '  - Python:        3.10.12 (with docx, openpyxl, pptx, pypdf, pandas, numpy, etc.)',
    '  - Office Suite:  LibreOffice (headless document rendering)',
    '  - PDF Tools:     Poppler (pdftoppm), Pandoc',
    '',
    'Subscription Status: Fully unlocked for all accounts (including Claude Free). No Pro/Max needed.',
  ];

  return ok(lines.join('\n'), { available, mounted, vhdx });
}

async function vmMountTool({ action }) {
  if (!isVmAvailable()) {
    return fail('Official Claude Cowork rootfs.vhdx is not available on this machine.');
  }

  if (action === 'unmount') {
    const res = await vm.unmount('user request');
    return ok(res.ok ? 'Successfully unmounted official Cowork VM.' : `Unmount error: ${res.error}`);
  }

  // mount
  try {
    const res = await vm.mount();
    return ok(
      res.alreadyMounted
        ? 'Official Cowork VM is already mounted and active at /mnt/claude_rootfs.'
        : 'Successfully mounted official Cowork VM at /mnt/claude_rootfs.\nAuto-idle unmount timer and watchdog monitor activated.',
      { path: '/mnt/claude_rootfs' },
    );
  } catch (err) {
    return fail(`Failed to mount official Cowork VM: ${err.message}`);
  }
}

async function vmRunTool({ command }) {
  if (!isVmAvailable()) {
    return fail('Official Claude Cowork rootfs.vhdx is not available on this machine.');
  }

  try {
    const res = await vm.runInVm(command);
    const out = (res.stdout + (res.stderr ? `\nSTDERR:\n${res.stderr}` : '')).trim();
    if (res.status !== 0) {
      return fail(`Command failed with exit code ${res.status}:\n${clamp(out, config.limits.maxOutputChars, 'vm output')}`);
    }
    return ok(clamp(out || '(command completed with no output)', config.limits.maxOutputChars, 'vm output'), {
      exitCode: res.status,
    });
  } catch (err) {
    return fail(`VM execution error: ${err.message}`);
  }
}

export function registerVmTools(server) {
  server.registerTool(
    'VMStatus',
    {
      title: 'Official VM status',
      description:
        'Check the status of the optional official Claude Cowork Linux MicroVM (mounted state, idle timeout, preinstalled tools). Note: Cowork operates 100% host-native by default — this VM is completely optional.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(vmStatusTool),
  );

  server.registerTool(
    'VMMount',
    {
      title: 'Mount or unmount official VM',
      description:
        'Mount or unmount the optional official Claude Cowork Linux MicroVM. Automatically auto-unmounts after inactivity.',
      inputSchema: {
        action: z.enum(['mount', 'unmount']).describe('"mount" to attach VM, "unmount" to detach.'),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    guard(vmMountTool),
  );

  server.registerTool(
    'VMRun',
    {
      title: 'Run command in official Cowork VM',
      description:
        'Execute a command inside the optional official Claude Cowork Linux MicroVM (Ubuntu 22.04). Use Bash for ordinary host shell commands; only use VMRun when explicitly requested to run in the optional official Linux VM bundle.',
      inputSchema: {
        command: z.string().describe('Shell command to run inside the official VM environment.'),
      },
      annotations: { openWorldHint: false },
    },
    guard(vmRunTool),
  );
}
