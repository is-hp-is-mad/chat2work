#!/usr/bin/env node
import { ensureChromeHostRegistered, getChromeHostStatus } from '../src/lib/chrome-host.mjs';

console.log('Ensuring Claude in Chrome Native Messaging Host is registered...');
const reg = ensureChromeHostRegistered();
if (reg.ok) {
  console.log(`[OK] Native Messaging Host verified/added.`);
  console.log(`     Target Extension ID : ${reg.targetExtensionId}`);
  console.log(`     Host Binary Path    : ${reg.binaryPath}`);
  console.log(`     Manifest Path       : ${reg.manifestPath}`);
  console.log('\nBrowser registry status:');
  for (const b of reg.browsers || []) {
    console.log(`  - [${b.name}] : ${b.action} (${b.key})`);
  }
} else {
  console.error('[ERROR]', reg.reason || 'Failed to register host.');
  process.exitCode = 1;
}
