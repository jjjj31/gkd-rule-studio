#!/usr/bin/env node
/**
 * 校验线上更新清单是否可获取且自洽——App「检查更新」依赖的东西。
 *
 * App 请求 https://github.com/<repo>/releases/latest/download/update.json，
 * 这个脚本用同样的地址做端到端检查，发版后跑一次就能确认更新功能没断。
 *
 * 用法:
 *   node scripts/check-update.mjs [owner/repo]
 *
 * 退出码: 0 = 正常; 1 = 清单不可用或自相矛盾。
 */

const repo =
  process.argv[2] || process.env.GKD_RELEASE_REPO || "jjjj31/gkd-rule-studio";
const manifestUrl = `https://github.com/${repo}/releases/latest/download/update.json`;
const TIMEOUT_MS = 20000;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { redirect: "follow", signal: controller.signal, ...init });
  } finally {
    clearTimeout(timer);
  }
}

let response;
try {
  response = await fetchWithTimeout(manifestUrl);
} catch (cause) {
  fail(`无法访问 ${manifestUrl}: ${cause.message}`);
}

if (response.status === 404) {
  fail(
    `清单不存在（HTTP 404）：${manifestUrl}\n` +
      `  → 最新 Release 没有上传 update.json，App 会报「检查更新失败:HTTP 404」。\n` +
      `  → 用 .github/workflows/release.yml 发版，或手动执行:\n` +
      `     node scripts/publish-update.mjs <apk> --apk-name app-debug.apk --output update.json\n` +
      `     gh release upload <tag> update.json`,
  );
}
if (!response.ok) {
  fail(`清单地址返回 HTTP ${response.status}: ${manifestUrl}`);
}

let manifest;
try {
  manifest = JSON.parse(await response.text());
} catch (cause) {
  fail(`清单不是合法 JSON: ${cause.message}`);
}

for (const key of ["versionCode", "versionName", "apkUrl"]) {
  if (manifest[key] === undefined || manifest[key] === "") {
    fail(`清单缺少必要字段 ${key}`);
  }
}
if (!Number.isInteger(manifest.versionCode) || manifest.versionCode <= 0) {
  fail(`versionCode 非法: ${manifest.versionCode}`);
}
if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.sha256)) {
  fail(`sha256 缺失或不是 64 位十六进制（App 会拒绝安装未校验的包）`);
}

// apkUrl 必须真的能下载，否则用户点「下载并安装」才失败。
let apkStatus = 0;
try {
  const apkRes = await fetchWithTimeout(manifest.apkUrl, {
    method: "GET",
    headers: { Range: "bytes=0-0" },
  });
  apkStatus = apkRes.status;
} catch (cause) {
  fail(`APK 直链不可访问: ${manifest.apkUrl} (${cause.message})`);
}
if (apkStatus !== 200 && apkStatus !== 206) {
  fail(`APK 直链返回 HTTP ${apkStatus}: ${manifest.apkUrl}`);
}

console.log("✓ 更新清单可用");
console.log(`  地址: ${manifestUrl}`);
console.log(`  版本: ${manifest.versionName} (versionCode=${manifest.versionCode})`);
console.log(`  APK : ${manifest.apkUrl} (HTTP ${apkStatus})`);
console.log(`  sha256: ${manifest.sha256}`);
