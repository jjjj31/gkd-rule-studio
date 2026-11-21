/**
 * 跨版本稳定性基准：在快照 A 上生成的 Top-1 规则，拿到同一应用、同一 Activity、
 * 同一目标控件的另一张快照 B 上，是否还唯一点中那个控件。
 *
 * 这是"规则质量"的第二条轴：现有 heuristic 基准只衡量同一张快照上点得对不对，
 * 看不出 index/depth/宽高这类条件换版本后会不会失配。
 *
 * 运行：
 *   npx vitest run --config bench/vitest.config.ts bench/cross-version.bench
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { normalizeSnapshot } from "../src/lib/snapshotNormalize";
import { pickExistingNode } from "../src/lib/nodePicker";
import { generateRegionSelectorCandidates } from "../src/lib/regionCandidates";
import { validateSelectorPlan } from "../src/lib/selectorMatcher";
import type { RuleSettings } from "../src/types/ruleDraft";
import type { ParsedGkdSnapshot } from "../src/types/gkdSnapshot";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const CLEAN_DIR = path.join(DATASET_DIR, "clean");
const SNAPSHOT_DIR = path.join(DATASET_DIR, "snapshots");
const REPORT_DIR = path.join(DATASET_DIR, "bench");
const LIMIT = Number(process.env.BENCH_LIMIT || 0);
const SPLITS = ["train", "val", "test"] as const;

interface CleanRecord {
  id: string;
  snapshotId: string;
  appId: string;
  groupName: string | null;
  activityIds: string | string[] | null;
  target: { id: number; name: string; vid: string | null; text: string | null };
}

interface Pair {
  appId: string;
  from: CleanRecord;
  to: CleanRecord;
}

interface VariantStat {
  aHit: number;
  bHit: number;
  bothHit: number;
  total: number;
}

const VARIANTS = ["base", "stableTop5", "stableAll", "stableStrategy"] as const;
type Variant = (typeof VARIANTS)[number];

/** 跨版本稳定性实测排名（见 cross-version-report.json 的 byStrategy）。 */
const STRATEGY_TIER: Record<string, number> = {
  stableResourceSemantic: 1,
  exactId: 2,
  exactVid: 2,
  typePlusExactAttr: 2,
  textSkipGuarded: 2,
};

/** 结构类条件换版本最容易失配：宽高、childCount、index、depth。 */
function isStructuralSelector(selector: string): boolean {
  return /\b(index|depth|width|height|childCount)\s*[!=<>]/.test(selector);
}

function pickIndex(
  variant: Variant,
  candidates: ReturnType<typeof generateRegionSelectorCandidates>,
): number {
  if (variant === "base" || candidates.length === 0) return 0;
  const pool = variant === "stableTop5" ? candidates.slice(0, 5) : candidates;
  const found = pool.findIndex(
    (candidate) => !isStructuralSelector(candidate.rule.matches.join(" ")),
  );
  return found >= 0 ? found : 0;
}

function readJsonl(file: string): CleanRecord[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CleanRecord);
}

function settingsFor(record: CleanRecord): RuleSettings {
  const group = record.groupName || "";
  const activity = Array.isArray(record.activityIds)
    ? record.activityIds[0] || ""
    : record.activityIds || "";
  if (/开屏/.test(group)) {
    return {
      groupName: group || "开屏广告",
      activityIds: "",
      matchTime: 30000,
      actionMaximum: 1,
      actionCd: null,
      resetMatch: "app",
    };
  }
  if (/弹窗|公告|提示|更新/.test(group)) {
    return {
      groupName: group || "全屏广告",
      activityIds: activity,
      matchTime: 10000,
      actionMaximum: 1,
      actionCd: null,
      resetMatch: "activity",
    };
  }
  return {
    groupName: group || "全屏广告",
    activityIds: activity,
    matchTime: null,
    actionMaximum: 1,
    actionCd: 3000,
    resetMatch: "match",
  };
}

/** 同一个控件在不同快照里的稳定标识：优先 vid，其次文字 + 控件类型。 */
function targetKey(record: CleanRecord): string | null {
  const { vid, text, name } = record.target;
  if (vid) return `vid:${vid}`;
  if (text) return `text:${text}|${name}`;
  return null;
}

function activityKey(record: CleanRecord): string {
  return Array.isArray(record.activityIds)
    ? record.activityIds.join(",")
    : record.activityIds || "";
}

function hashParity(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash % 2;
}

function buildPairs(records: CleanRecord[]): Pair[] {
  const groups = new Map<string, CleanRecord[]>();
  for (const record of records) {
    const key = targetKey(record);
    if (!key) continue;
    const groupKey = `${record.appId}|${activityKey(record)}|${key}`;
    const list = groups.get(groupKey) || [];
    list.push(record);
    groups.set(groupKey, list);
  }

  const pairs: Pair[] = [];
  for (const list of groups.values()) {
    const snapshotIds = new Set(list.map((record) => record.snapshotId));
    if (snapshotIds.size < 2) continue;
    for (const from of list) {
      for (const to of list) {
        if (from.snapshotId === to.snapshotId) continue;
        pairs.push({ appId: from.appId, from, to });
      }
    }
  }
  return pairs;
}

test("cross-version stability benchmark", async () => {
  const records = SPLITS.flatMap((split) =>
    readJsonl(path.join(CLEAN_DIR, `${split}.jsonl`)),
  );
  const allPairs = buildPairs(records);
  const pairs = LIMIT > 0 ? allPairs.slice(0, LIMIT) : allPairs;

  const cache = new Map<string, ParsedGkdSnapshot | null>();
  const loadSnapshot = (snapshotId: string) => {
    const cached = cache.get(snapshotId);
    if (cached !== undefined) return cached;
    const file = path.join(SNAPSHOT_DIR, snapshotId, snapshotId + ".json");
    const snapshot = fs.existsSync(file)
      ? normalizeSnapshot(
          JSON.parse(fs.readFileSync(file, "utf-8")),
          "",
          snapshotId,
        )
      : null;
    cache.set(snapshotId, snapshot);
    return snapshot;
  };

  let evaluated = 0;
  let stable = 0;
  let stableTop3 = 0;
  let stableTop5 = 0;
  let anyCandidate = 0;
  let noHit = 0;
  let wrongSingle = 0;
  let multiHit = 0;
  const firstStableRanks: number[] = [];
  const byAnchor = new Map<string, { total: number; stable: number }>();
  const byFlag = new Map<string, { total: number; stable: number }>();
  const byStrategy = new Map<string, { total: number; stable: number }>();
  const byStrategyHalf = new Map<string, { total: number; stable: number }>();
  const recoverableStrategies = new Map<string, number>();
  const variantStats = new Map<Variant, VariantStat>(
    VARIANTS.map((variant) => [
      variant,
      { aHit: 0, bHit: 0, bothHit: 0, total: 0 },
    ]),
  );
  const failures: unknown[] = [];
  const started = Date.now();

  for (const pair of pairs) {
    const fromSnapshot = loadSnapshot(pair.from.snapshotId);
    const toSnapshot = loadSnapshot(pair.to.snapshotId);
    if (!fromSnapshot || !toSnapshot) continue;
    const fromTarget = fromSnapshot.nodeById.get(pair.from.target.id);
    const toTarget = toSnapshot.nodeById.get(pair.to.target.id);
    if (!fromTarget || !toTarget) continue;

    const candidates = generateRegionSelectorCandidates({
      snapshot: fromSnapshot,
      ruleSettings: settingsFor(pair.from),
      pickResult: pickExistingNode(fromSnapshot, fromTarget),
    });
    if (candidates.length === 0) continue;
    evaluated += 1;

    for (const variant of VARIANTS) {
      let index = pickIndex(variant, candidates);
      if (variant === "stableStrategy") {
        const pool = candidates.slice(0, 8);
        let bestTier = Number.POSITIVE_INFINITY;
        index = 0;
        for (let i = 0; i < pool.length; i += 1) {
          const ids = validateSelectorPlan(fromSnapshot, pool[i].plan).clickNodes;
          if (ids.length !== 1 || ids[0].id !== fromTarget.id) continue;
          const tier = STRATEGY_TIER[pool[i].strategyName] ?? 3;
          if (tier < bestTier) {
            bestTier = tier;
            index = i;
          }
        }
      }
      const chosen = candidates[index];
      const aIds = validateSelectorPlan(fromSnapshot, chosen.plan).clickNodes;
      const bIds = validateSelectorPlan(toSnapshot, chosen.plan).clickNodes;
      const aHit = aIds.length === 1 && aIds[0].id === fromTarget.id;
      const bHit = bIds.length === 1 && bIds[0].id === toTarget.id;
      const stat = variantStats.get(variant)!;
      stat.total += 1;
      if (aHit) stat.aHit += 1;
      if (bHit) stat.bHit += 1;
      if (aHit && bHit) stat.bothHit += 1;
    }

    const top = candidates[0];
    const validation = validateSelectorPlan(toSnapshot, top.plan);
    const ids = validation.clickNodes.map((node) => node.id);
    const matched = ids.length === 1 && ids[0] === toTarget.id;
    if (matched) stable += 1;
    else if (ids.length === 0) noHit += 1;
    else if (ids.length === 1) wrongSingle += 1;
    else multiHit += 1;

    // 同一条候选列表里还有没有能命中 B 的候选？有就说明是排序问题，不是生成问题。
    const firstStableRank = candidates.findIndex((candidate) => {
      const check = validateSelectorPlan(toSnapshot, candidate.plan);
      return (
        check.clickNodes.length === 1 && check.clickNodes[0].id === toTarget.id
      );
    });
    if (firstStableRank >= 0) {
      anyCandidate += 1;
      firstStableRanks.push(firstStableRank);
      if (firstStableRank < 3) stableTop3 += 1;
      if (firstStableRank < 5) stableTop5 += 1;
      if (!matched) {
        const name = candidates[firstStableRank].strategyName;
        recoverableStrategies.set(name, (recoverableStrategies.get(name) || 0) + 1);
      }
    }

    const selector = top.rule.matches.join(" ");
    const anchor = selector.includes("vid=")
      ? "vid"
      : selector.includes("text")
        ? "text"
        : selector.includes("id=")
          ? "id"
          : "structural";
    const anchorStat = byAnchor.get(anchor) || { total: 0, stable: 0 };
    anchorStat.total += 1;
    if (matched) anchorStat.stable += 1;
    byAnchor.set(anchor, anchorStat);

    const strategyStat = byStrategy.get(top.strategyName) || { total: 0, stable: 0 };
    strategyStat.total += 1;
    if (matched) strategyStat.stable += 1;
    byStrategy.set(top.strategyName, strategyStat);

    // 按 appId 奇偶分半，检查写法稳定性排名不是同一批数据拟合出来的。
    const half = hashParity(pair.appId) === 0 ? "even" : "odd";
    const halfKey = `${half}|${top.strategyName}`;
    const halfStat = byStrategyHalf.get(halfKey) || { total: 0, stable: 0 };
    halfStat.total += 1;
    if (matched) halfStat.stable += 1;
    byStrategyHalf.set(halfKey, halfStat);

    const flags: string[] = [];
    if (/\bindex\s*[!=<>]/.test(selector)) flags.push("usesIndex");
    if (/\bdepth\s*[!=<>]/.test(selector)) flags.push("usesDepth");
    if (/\b(width|height)\s*[!=<>]/.test(selector)) flags.push("usesSize");
    if (/\bchildCount\s*[!=<>]/.test(selector)) flags.push("usesChildCount");
    for (const flag of flags) {
      const stat = byFlag.get(flag) || { total: 0, stable: 0 };
      stat.total += 1;
      if (matched) stat.stable += 1;
      byFlag.set(flag, stat);
    }

    if (!matched && failures.length < 60) {
      failures.push({
        appId: pair.appId,
        from: pair.from.id,
        to: pair.to.id,
        groupName: pair.from.groupName,
        selector: top.rule.matches[0],
        strategy: top.strategyName,
        anchor,
        flags,
        toHitIds: ids.slice(0, 5),
      });
    }

    if (evaluated % 200 === 0) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[bench] ${evaluated}/${pairs.length} (${elapsed}s)`);
    }
  }

  const rate = (value: number) => Number(((value / Math.max(1, evaluated)) * 100).toFixed(1));
  const summary = {
    pairs: pairs.length,
    evaluated,
    stable: rate(stable),
    stableTop3: rate(stableTop3),
    stableTop5: rate(stableTop5),
    anyCandidate: rate(anyCandidate),
    recoverableByRanking: rate(anyCandidate - stable),
    medianFirstStableRank: firstStableRanks.length
      ? firstStableRanks.sort((a, b) => a - b)[Math.floor(firstStableRanks.length / 2)]
      : null,
    noHit: rate(noHit),
    wrongSingle: rate(wrongSingle),
    multiHit: rate(multiHit),
    byAnchor: Object.fromEntries(
      [...byAnchor].map(([key, value]) => [
        key,
        { total: value.total, stable: Number(((value.stable / value.total) * 100).toFixed(1)) },
      ]),
    ),
    byFlag: Object.fromEntries(
      [...byFlag].map(([key, value]) => [
        key,
        { total: value.total, stable: Number(((value.stable / value.total) * 100).toFixed(1)) },
      ]),
    ),
    byStrategy: Object.fromEntries(
      [...byStrategy]
        .sort((a, b) => b[1].total - a[1].total)
        .map(([key, value]) => [
          key,
          { total: value.total, stable: Number(((value.stable / value.total) * 100).toFixed(1)) },
        ]),
    ),
    byStrategyHalf: Object.fromEntries(
      [...byStrategyHalf]
        .sort()
        .map(([key, value]) => [
          key,
          { total: value.total, stable: Number(((value.stable / value.total) * 100).toFixed(1)) },
        ]),
    ),
    recoverableStrategies: Object.fromEntries(
      [...recoverableStrategies].sort((a, b) => b[1] - a[1]),
    ),
    byVariant: Object.fromEntries(
      [...variantStats].map(([key, value]) => [
        key,
        {
          total: value.total,
          aHit: Number(((value.aHit / Math.max(1, value.total)) * 100).toFixed(1)),
          bHit: Number(((value.bHit / Math.max(1, value.total)) * 100).toFixed(1)),
          bothHit: Number(((value.bothHit / Math.max(1, value.total)) * 100).toFixed(1)),
        },
      ]),
    ),
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(REPORT_DIR, "cross-version-report.json"),
    JSON.stringify({ summary, failures }, null, 2),
    "utf-8",
  );
  console.log("[bench] summary", JSON.stringify(summary, null, 2));
});
