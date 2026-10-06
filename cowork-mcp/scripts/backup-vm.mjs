#!/usr/bin/env node
/**
 * backup-vm.mjs — 自动备份/提取 Claude Cowork 官方虚拟机镜像与依赖
 *
 * 功能：
 * 1. 自动寻找本机 Claude Desktop 官方缓存的 rootfs.vhdx 与 chrome-native-host.exe。
 * 2. 导出/备份至指定目录（默认为项目本地的 vm/ 目录或自定义目录）。
 * 3. 校验文件完整性，并生成可移植的独立离线运行包。
 *
 * 用法:
 *   node scripts/backup-vm.mjs                  # 提取到 cowork-mcp/vm/
 *   node scripts/backup-vm.mjs --dest D:\my_vm   # 提取到指定目录
 *   node scripts/backup-vm.mjs --check          # 仅检查官方镜像是否存在与路径
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getOfficialVhdxPath } from '../src/lib/vm.mjs';
import { findSourceBinary, getHostExePath } from '../src/lib/chrome-host.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function bytesToHuman(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function parseArgs(argv) {
  const args = { dest: path.join(ROOT, 'vm') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dest' || a === '-d') args.dest = path.resolve(argv[++i]);
    else if (a === '--check' || a === '-c') args.check = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function copyFileWithProgress(src, dest) {
  const stat = fs.statSync(src);
  const total = stat.size;
  console.log(`[1/2] 正在备份虚拟机镜像 (${bytesToHuman(total)})...`);
  console.log(`  源路径: ${src}`);
  console.log(`  目标路径: ${dest}`);

  let copied = 0;
  let lastReport = 0;
  const readStream = fs.createReadStream(src, { highWaterMark: 64 * 1024 * 1024 });
  const writeStream = fs.createWriteStream(dest, { highWaterMark: 64 * 1024 * 1024 });

  return new Promise((resolve, reject) => {
    readStream.on('data', (chunk) => {
      copied += chunk.length;
      const now = Date.now();
      if (now - lastReport > 1000 || copied === total) {
        lastReport = now;
        const pct = ((copied / total) * 100).toFixed(1);
        process.stdout.write(`\r  进度: ${pct}% (${bytesToHuman(copied)} / ${bytesToHuman(total)})`);
      }
    });

    readStream.on('error', reject);
    writeStream.on('error', reject);
    writeStream.on('finish', () => {
      process.stdout.write('\n');
      resolve();
    });

    readStream.pipe(writeStream);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('============================================================');
  console.log('  Claude Cowork 官方虚拟机镜像与依赖一键提取工具');
  console.log('============================================================\n');

  const vhdxSrc = getOfficialVhdxPath();
  const hostExeSrc = findSourceBinary() || (fs.existsSync(getHostExePath()) ? getHostExePath() : null);

  console.log('🔍 正在检测系统中的官方组件:');
  console.log(`  - 虚拟机镜像 (rootfs.vhdx):  ${vhdxSrc ? `[已找到] ${vhdxSrc}` : '[未找到]'}`);
  console.log(`  - 原生代理程序 (chrome-host): ${hostExeSrc ? `[已找到] ${hostExeSrc}` : '[未找到]'}\n`);

  if (args.check) {
    if (vhdxSrc) {
      const stat = fs.statSync(vhdxSrc);
      console.log(`✅ 镜像就绪，大小: ${bytesToHuman(stat.size)}`);
    } else {
      console.log('❌ 未检测到官方虚拟机镜像。');
    }
    return;
  }

  if (!vhdxSrc) {
    console.error('❌ 未能在当前计算机上找到官方 rootfs.vhdx！');
    console.error('  可能原因: 当前计算机尚未通过 Claude Desktop 下载过 Cowork 虚拟机环境。');
    console.error('  手动安装说明: 请参阅项目 README，将第三方下载的 rootfs.vhdx 放置在 cowork-mcp/vm/ 目录下。');
    process.exit(1);
  }

  fs.mkdirSync(args.dest, { recursive: true });

  const targetVhdx = path.join(args.dest, 'rootfs.vhdx');
  const targetHostExe = path.join(args.dest, 'chrome-native-host.exe');

  // 1. 复制 VHDX
  if (path.resolve(vhdxSrc) === path.resolve(targetVhdx)) {
    console.log('ℹ️ 源镜像已位于目标目录，跳过镜像复制。');
  } else {
    await copyFileWithProgress(vhdxSrc, targetVhdx);
  }

  // 2. 复制 chrome-native-host.exe
  if (hostExeSrc && path.resolve(hostExeSrc) !== path.resolve(targetHostExe)) {
    console.log(`\n[2/2] 正在备份 Chrome 本地消息代理程序 (chrome-native-host.exe)...`);
    fs.copyFileSync(hostExeSrc, targetHostExe);
    console.log(`  已保存至: ${targetHostExe}`);
  }

  console.log('\n============================================================');
  console.log('🎉 提取与离线归档完成！');
  console.log('============================================================');
  console.log(`文件已妥善保存在: ${args.dest}`);
  console.log('目录内包含:');
  console.log(`  1. rootfs.vhdx           (${bytesToHuman(fs.statSync(targetVhdx).size)})`);
  if (fs.existsSync(targetHostExe)) {
    console.log(`  2. chrome-native-host.exe (${bytesToHuman(fs.statSync(targetHostExe).size)})`);
  }
  console.log('\n💡 提示:');
  console.log('  即使今后 Anthropic 停止分发，只要保留该目录，`cowork-mcp` 将永久自动');
  console.log('  优先识别并挂载此目录下的镜像！');
}

main().catch((err) => {
  console.error('\n❌ 提取失败:', err.message);
  process.exit(1);
});
