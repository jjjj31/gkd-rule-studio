/**
 * 从训练集 `D:\gkd-dataset\clean\train.jsonl` 结合原始快照提取端侧可观测特征，
 * 蒸馏生成百 KB 级离线 Few-Shot 案例库 `src/data/distilledFewShot.json`。
 *
 * 严格只读取 `train.jsonl`，不接触 `val.jsonl` / `test.jsonl`，避免数据泄漏。
 *
 * 运行目录：仓库根目录；Shell：PowerShell
 *   node scripts/build-distilled-fewshot.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const TRAIN_PATH = path.join(DATASET_DIR, "clean", "train.jsonl");
const SNAPSHOT_DIR = path.join(DATASET_DIR, "snapshots");
const OUT_PATH = path.join(REPO_ROOT, "src", "data", "distilledFewShot.json");

const ANCHOR_WORDS = [
  "广告", "跳过", "关闭", "取消", "跳过广告", "跳过此广告", "关闭广告",
  "下次", "暂不", "以后再说", "稍后", "忽略", "残忍拒绝", "不感兴趣",
  "权限", "通知", "定位", "更新", "升级", "公告", "提示", "评分", "评价",
  "推荐", "反馈", "领取", "打开", "下载", "安装",
];

const OBFUSCATED_VIDS = new Set([
  "obfuscated",
  "0_resource_name_obfuscated",
  "arg",
  "pdd",
  "unused_res_a",
]);

function isObfuscatedVid(vid) {
  if (!vid) return false;
  if (OBFUSCATED_VIDS.has(vid)) return true;
  if (/^unused_res_/i.test(vid)) return true;
  if (/^[a-z0-9]{1,3}$/.test(vid) && /\d/.test(vid)) return true;
  return false;
}

function shortClass(name) {
  return (name || "View").split(".").pop() || "View";
}

function bucket(value, cuts) {
  if (value === null || value === undefined) return "na";
  for (const [edge, label] of cuts) {
    if (value <= edge) return label;
  }
  return cuts[cuts.length - 1][1] + "+";
}

function isCountdownText(text) {
  if (!text) return false;
  const s = text.trim();
  return /^跳过\s*\d+\s*s?$/i.test(s) || /^\d+\s*s?\s*后?\s*跳过$/i.test(s) || /^skip\s*\d+\s*s?$/i.test(s);
}

const snapCache = new Map();
function loadSnapshot(snapshotId) {
  if (snapCache.has(snapshotId)) return snapCache.get(snapshotId);
  const p = path.join(SNAPSHOT_DIR, String(snapshotId), `${snapshotId}.json`);
  const data = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : null;
  if (snapCache.size > 400) snapCache.clear();
  snapCache.set(snapshotId, data);
  return data;
}

function extractObservableTokens(record, snap) {
  const t = record.target;
  const ctx = record.context || { ancestors: [], siblings: [], anchors: [] };
  const tokens = new Set();

  tokens.add("cls:" + shortClass(t.name));
  tokens.add("desc:" + (t.desc ? "yes" : "no"));
  tokens.add("cc:" + bucket(t.childCount, [[0, "0"], [1, "1"], [3, "2-3"]]));
  tokens.add("depth:" + bucket(t.depth, [[3, "d0-3"], [5, "d4-5"], [8, "d6-8"]]));

  const nodes = snap?.nodes || [];
  const visNodes = nodes.filter((n) => n?.attr?.visibleToUser !== false);

  // vid uniqueness state
  if (!t.vid) {
    tokens.add("vid:no");
  } else if (isObfuscatedVid(t.vid)) {
    tokens.add("vid:obfuscated");
  } else {
    const hits = visNodes.filter((n) => n?.attr?.vid === t.vid).length;
    tokens.add(hits > 1 ? "vid:multi" : "vid:unique");
  }

  // text uniqueness state
  if (!t.text) {
    tokens.add("txt:no");
  } else if (isCountdownText(t.text)) {
    tokens.add("txt:countdown");
  } else {
    const hits = visNodes.filter((n) => n?.attr?.text === t.text).length;
    tokens.add(hits > 1 ? "txt:multi" : "txt:unique");
  }

  // clickability & parent/child click relation
  if (t.clickable) {
    tokens.add("click:self");
    const hasTextChild = visNodes.some(
      (n) => n.pid === t.id && (n?.attr?.text || n?.attr?.desc) && !n?.attr?.clickable,
    );
    if (!t.text && hasTextChild) {
      tokens.add("click:wraps_text_child");
    }
  } else {
    const firstClickAncIdx = (ctx.ancestors || []).findIndex((a) => a.clickable);
    if (firstClickAncIdx === 0) tokens.add("click:parent_direct");
    else if (firstClickAncIdx > 0) tokens.add("click:parent_deep");
    else tokens.add("click:none");
  }

  if ((ctx.siblings || []).some((s) => s.text || s.desc)) {
    tokens.add("ctx:sib_text");
  }
  if ((ctx.siblings || []).some((s) => s.vid && !isObfuscatedVid(s.vid))) {
    tokens.add("ctx:sib_vid");
  }
  if ((ctx.ancestors || []).some((a) => a.vid && !isObfuscatedVid(a.vid))) {
    tokens.add("ctx:anc_vid");
  }

  for (const anchor of ctx.anchors || []) {
    for (const w of anchor.anchorWords || []) {
      tokens.add("anchor:" + w);
    }
  }
  // Also scan target text/desc for anchor words
  const selfText = `${t.text || ""} ${t.desc || ""} ${t.vid || ""}`.toLowerCase();
  for (const w of ANCHOR_WORDS) {
    if (selfText.includes(w.toLowerCase())) tokens.add("anchor:" + w);
  }

  return [...tokens].sort();
}

function isCleanExample(record) {
  const sel = record.selector || "";
  if (sel.length < 4 || sel.length > 125) return false;
  // Avoid examples teaching obfuscated vids or brittle raw pixel coordinates
  if (/\bvid="(?:obfuscated|arg|pdd|unused_res_)/i.test(sel)) return false;
  if (/0_resource_name_obfuscated/i.test(sel)) return false;
  if (/getChild\(/.test(sel)) return false;
  return true;
}

const rawLines = fs.readFileSync(TRAIN_PATH, "utf-8").split("\n").filter((l) => l.trim());
const trainRecords = rawLines.map((l) => JSON.parse(l));

const enriched = [];
for (const rec of trainRecords) {
  if (!isCleanExample(rec)) continue;
  const snap = loadSnapshot(rec.snapshotId);
  const obsTokens = extractObservableTokens(rec, snap);
  // Structural core signature (excluding anchor words so rare anchors don't fragment into 1000 singletons)
  const coreSig = [
    rec.selectorShape?.kind || "attr_only",
    ...obsTokens.filter((tok) => !tok.startsWith("anchor:") && !tok.startsWith("depth:")),
  ].join("|");
  enriched.push({ rec, obsTokens, coreSig });
}

// Group by coreSig, sort within each group by clarity (shorter selector, diverse anchor coverage)
const groups = new Map();
for (const item of enriched) {
  const list = groups.get(item.coreSig) || [];
  list.push(item);
  groups.set(item.coreSig, list);
}

// Target ~240 distilled records: take top 1 from small groups, up to 2-3 from large frequent groups with distinct anchors/apps
const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
const selected = [];
const seenSelectors = new Set();

for (const [, items] of sortedGroups) {
  items.sort((a, b) => a.rec.selector.length - b.rec.selector.length);
  const quota = items.length >= 40 ? 3 : items.length >= 12 ? 2 : 1;
  const usedApps = new Set();
  let taken = 0;
  for (const item of items) {
    if (seenSelectors.has(item.rec.selector)) continue;
    if (usedApps.has(item.rec.appId) && items.length > quota) continue;
    seenSelectors.add(item.rec.selector);
    usedApps.add(item.rec.appId);
    selected.push(item);
    taken += 1;
    if (taken >= quota) break;
  }
  if (selected.length >= 240) break;
}

const compactRecords = selected.map(({ rec, obsTokens }) => ({
  i: rec.id,
  a: rec.appId,
  n: rec.appName,
  k: rec.selectorShape.kind,
  s: rec.selector,
  t: [
    shortClass(rec.target.name),
    rec.target.vid || null,
    rec.target.text || null,
    rec.target.desc || null,
    rec.target.clickable ? 1 : 0,
    rec.target.childCount ?? null,
  ],
  b: (rec.context?.siblings || []).slice(0, 2).map((sib) => [
    shortClass(sib.name),
    sib.vid || null,
    sib.text || null,
    sib.desc || null,
    sib.clickable ? 1 : 0,
  ]),
  f: obsTokens,
}));

fs.writeFileSync(OUT_PATH, JSON.stringify(compactRecords), "utf-8");
const sizeKB = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
console.log(`Distilled ${compactRecords.length} records -> ${OUT_PATH} (${sizeKB} KB)`);
