#!/usr/bin/env node
/**
 * 发版脚本:根据 APK 文件生成 update.json（版本清单）。
 *
 * 用法:
 *   node scripts/publish-update.mjs <apk-path> [options]
 *
 * 参数:
 *   <apk-path>              APK 文件路径
 *
 * 选项:
 *   --notes <text>          发版说明(可选,可多次指定)
 *   --forced                标记为强制更新(默认可选)
 *   --output <path>         输出 update.json 的路径(默认 stdout)
 *   --apk-name <name>       覆盖 APK 在清单中的文件名(默认取路径中的文件名)
 *   --version <ver>         覆盖版本号(默认从 package.json 读取)
 *
 * 示例:
 *   node scripts/publish-update.mjs android/app/build/outputs/apk/debug/app-debug.apk --notes "修复了某个 bug"
 *   node scripts/publish-update.mjs out.apk --output release/update.json --version 0.2.0
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help") {
  console.log(`用法: node scripts/publish-update.mjs <apk-path> [options]

选项:
  --notes <text>      发版说明(可多次指定,合并为数组)
  --forced            标记为强制更新
  --output <path>     输出路径(默认 stdout)
  --apk-name <name>   覆盖 APK 文件名
  --version <ver>     覆盖版本号(默认从 package.json 读取)
`);
  process.exit(0);
}

// 解析参数
let apkPath = "";
let output = null;
let versionOverride = null;
let forced = false;
const notes = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--output" && args[i + 1]) {
    output = args[++i];
  } else if (arg === "--version" && args[i + 1]) {
    versionOverride = args[++i];
  } else if (arg === "--notes" && args[i + 1]) {
    notes.push(args[++i]);
  } else if (arg === "--forced") {
    forced = true;
  } else if (!arg.startsWith("--")) {
    apkPath = arg;
  }
}

if (!apkPath) {
  console.error("错误:未指定 APK 文件路径");
  process.exit(1);
}

apkPath = resolve(apkPath);

// 读取 package.json 版本号
let versionName;
if (versionOverride) {
  versionName = versionOverride;
} else {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    versionName = pkg.version;
  } catch {
    console.error("错误:无法读取 package.json(或 --version 未指定)");
    process.exit(1);
  }
}

// 计算 versionCode:简单的 x.y.z → x*10000 + y*100 + z,或用 git describe
function versionNameToCode(name) {
  const parts = name.split(".").map(Number);
  if (parts.length >= 3 && parts.every((n) => Number.isInteger(n))) {
    return parts[0] * 10000 + parts[1] * 100 + parts[2];
  }
  // fallback:用名称哈希的前 8 位
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  return parseInt(hash, 16);
}

const versionCode = versionNameToCode(versionName);

// 计算 APK sha256
const apkData = readFileSync(apkPath);
const sha256 = createHash("sha256").update(apkData).digest("hex");
const apkName = basename(apkPath);

// 构造版本清单
const manifest = {
  versionCode,
  versionName,
  forced: forced ? 1 : 0,
  apkUrl: `https://github.com/jjjj31/gkd-rule-studio/releases/download/v${versionName}/GKD-Rule-Studio-Android-${versionName}-debug.apk`,
  mirrors: [
    `https://ghproxy.net/https://github.com/jjjj31/gkd-rule-studio/releases/download/v${versionName}/GKD-Rule-Studio-Android-${versionName}-debug.apk`,
  ],
  sha256,
  notes: notes.length > 0 ? notes.join("\n") : undefined,
};

// 输出
const json = JSON.stringify(manifest, null, 2) + "\n";
if (output) {
  writeFileSync(resolve(output), json, "utf8");
  console.log(`update.json 已写入 ${resolve(output)}`);
} else {
  process.stdout.write(json);
}

console.log(`\n版本: ${versionName} (versionCode=${versionCode})`);
console.log(`APK: ${apkName} (${(apkData.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`SHA-256: ${sha256}`);
console.log(`强制更新: ${forced ? "是" : "否"}`);
if (notes.length > 0) {
  console.log(`发版说明: ${notes.join("; ")}`);
}
