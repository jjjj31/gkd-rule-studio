/**
 * 方案 C：用 D 盘真机数据集评测现有 14 种启发式策略。
 *
 * 指标：
 * - exact：候选序列化结果与官方标准答案字符串完全一致
 * - semantic：候选在快照上点击的节点集合恰好等于官方标注的目标节点
 *
 * 运行：
 *   npx vitest run --config bench/vitest.config.ts
 *   $env:BENCH_LIMIT=60; npx vitest run --config bench/vitest.config.ts
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { normalizeSnapshot } from "../src/lib/snapshotNormalize";
import { pickExistingNode } from "../src/lib/nodePicker";
import { generateRegionSelectorCandidates } from "../src/lib/regionCandidates";
import { validateSelectorPlan } from "../src/lib/selectorMatcher";
import { prepareSelectorEngine } from "../src/lib/selectorAdapter";
import type { RuleSettings, SelectorCandidate } from "../src/types/ruleDraft";
import type { ParsedGkdSnapshot } from "../src/types/gkdSnapshot";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const CLEAN_DIR = path.join(DATASET_DIR, "clean");
const SNAPSHOT_DIR = path.join(DATASET_DIR, "snapshots");
const REPORT_DIR = path.join(DATASET_DIR, "bench");
const LIMIT = Number(process.env.BENCH_LIMIT || 0);
const K_VALUES = [1, 3, 5];

interface CleanRecord {
  id: string;
  snapshotId: string;
  appId: string;
  appName: string;
  activityIds: string | string[] | null;
  groupName: string | null;
  selector: string;
  selectorShape: { kind: string; hasAt: boolean; attrs: string[] };
  target: { id: number; name: string; vid: string | null; text: string | null };
  features: string[];
}

function readJsonl(file: string): CleanRecord[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CleanRecord);
}

function normalizeSelector(value: string): string {
  return value.replace(/\s+/g, "").replace(/'/g, '"');
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

function clickedIds(snapshot: ParsedGkdSnapshot, candidate: SelectorCandidate): number[] {
  const validation = validateSelectorPlan(snapshot, candidate.plan);
  return validation.clickNodes.map((node) => node.id).sort((a, b) => a - b);
}

test("heuristic strategy benchmark", async () => {
  // 数据集里约 7% 快照由 GKD beta 版录制，需要加载 beta 引擎才能评估。
  await prepareSelectorEngine("beta").catch((error) => {
    console.warn("[bench] beta selector engine unavailable:", error?.message || error);
  });

  const records = readJsonl(path.join(CLEAN_DIR, "test.jsonl"));
  const selected = LIMIT > 0 ? records.slice(0, LIMIT) : records;
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const snapshotCache = new Map<string, ParsedGkdSnapshot | null>();
  const counters = Object.fromEntries(
    K_VALUES.map((k) => ["exact@" + k, 0]).concat(K_VALUES.map((k) => ["semantic@" + k, 0])),
  ) as Record<string, number>;
  let anySemantic = 0;
  let evaluated = 0;
  let noCandidates = 0;
  const failures: unknown[] = [];
  const byKind = new Map<string, { total: number; semantic1: number }>();
  const byVid = new Map<string, { total: number; semantic1: number }>();
  const started = Date.now();

  for (const record of selected) {
    let snapshot = snapshotCache.get(record.snapshotId);
    if (snapshot === undefined) {
      const file = path.join(SNAPSHOT_DIR, record.snapshotId, record.snapshotId + ".json");
      if (!fs.existsSync(file)) {
        snapshotCache.set(record.snapshotId, null);
        snapshot = null;
      } else {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        snapshot = normalizeSnapshot(raw, "", record.snapshotId);
        snapshotCache.set(record.snapshotId, snapshot);
      }
    }
    if (!snapshot) continue;

    const targetNode = snapshot.nodeById.get(record.target.id);
    if (!targetNode) continue;

    const candidates = generateRegionSelectorCandidates({
      snapshot,
      ruleSettings: settingsFor(record),
      pickResult: pickExistingNode(snapshot, targetNode),
    });
    evaluated += 1;

    if (candidates.length === 0) {
      noCandidates += 1;
      failures.push({
        id: record.id,
        appName: record.appName,
        reason: "no-candidates",
        gt: record.selector,
      });
      continue;
    }

    const gtNormalized = normalizeSelector(record.selector);
    const expected = [record.target.id];
    let firstSemanticRank = -1;

    for (const k of K_VALUES) {
      const slice = candidates.slice(0, k);
      if (slice.some((c) => normalizeSelector(c.rule.matches[0] || "") === gtNormalized)) {
        counters["exact@" + k] += 1;
      }
      const hit = slice.some((c) => {
        const ids = clickedIds(snapshot!, c);
        return ids.length === 1 && ids[0] === record.target.id;
      });
      if (hit) counters["semantic@" + k] += 1;
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const ids = clickedIds(snapshot, candidates[i]);
      if (ids.length === expected.length && ids[0] === expected[0]) {
        firstSemanticRank = i;
        break;
      }
    }
    if (firstSemanticRank >= 0) anySemantic += 1;

    const kindKey = record.selectorShape?.kind || "unknown";
    const kindStat = byKind.get(kindKey) || { total: 0, semantic1: 0 };
    kindStat.total += 1;
    if (firstSemanticRank === 0) kindStat.semantic1 += 1;
    byKind.set(kindKey, kindStat);

    const vidKey = record.target.vid ? "has-vid" : "no-vid";
    const vidStat = byVid.get(vidKey) || { total: 0, semantic1: 0 };
    vidStat.total += 1;
    if (firstSemanticRank === 0) vidStat.semantic1 += 1;
    byVid.set(vidKey, vidStat);

    if (firstSemanticRank !== 0 && failures.length < 200) {
      failures.push({
        id: record.id,
        appName: record.appName,
        groupName: record.groupName,
        kind: kindKey,
        hasVid: Boolean(record.target.vid),
        gt: record.selector,
        top1: candidates[0]?.rule.matches?.[0],
        top1Strategy: candidates[0]?.strategyName,
        top1Ids: clickedIds(snapshot, candidates[0]).slice(0, 5),
        firstSemanticRank,
      });
    }

    if (evaluated % 25 === 0) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`[bench] ${evaluated}/${selected.length} (${elapsed}s)`);
    }
  }

  const rate = (value: number) => (evaluated ? Number(((value / evaluated) * 100).toFixed(1)) : 0);
  const summary = {
    evaluated,
    noCandidates,
    exact: Object.fromEntries(K_VALUES.map((k) => ["top" + k, rate(counters["exact@" + k])])),
    semantic: Object.fromEntries(K_VALUES.map((k) => ["top" + k, rate(counters["semantic@" + k])])),
    anySemantic: rate(anySemantic),
    byKind: Object.fromEntries(
      [...byKind].map(([key, value]) => [
        key,
        { ...value, top1: Number(((value.semantic1 / value.total) * 100).toFixed(1)) },
      ]),
    ),
    byVid: Object.fromEntries(
      [...byVid].map(([key, value]) => [
        key,
        { ...value, top1: Number(((value.semantic1 / value.total) * 100).toFixed(1)) },
      ]),
    ),
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  };

  fs.writeFileSync(
    path.join(REPORT_DIR, "heuristic-report.json"),
    JSON.stringify({ summary, failures }, null, 2),
    "utf-8",
  );
  console.log("[bench] summary", JSON.stringify(summary, null, 2));
});
