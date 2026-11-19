/**
 * 排序策略实验：只改候选顺序，不改候选生成，量化“以用户所选控件为准”的收益。
 *
 * 运行：
 *   npx vitest run --config bench/vitest.config.ts rerank
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { normalizeSnapshot } from "../src/lib/snapshotNormalize";
import { pickExistingNode } from "../src/lib/nodePicker";
import { generateRegionSelectorCandidates } from "../src/lib/regionCandidates";
import { validateSelectorPlan } from "../src/lib/selectorMatcher";
import { prepareSelectorEngine } from "../src/lib/selectorAdapter";
import { buildVisualTargetIds } from "../src/lib/visualTarget";
import type { RuleSettings, SelectorCandidate } from "../src/types/ruleDraft";
import type { ParsedGkdSnapshot } from "../src/types/gkdSnapshot";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const CLEAN_DIR = path.join(DATASET_DIR, "clean");
const SNAPSHOT_DIR = path.join(DATASET_DIR, "snapshots");
const LIMIT = Number(process.env.BENCH_LIMIT || 0);

interface CleanRecord {
  id: string;
  snapshotId: string;
  appName: string;
  groupName: string | null;
  activityIds: string | string[] | null;
  selector: string;
  selectorShape: { kind: string };
  target: { id: number; vid: string | null };
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

function clickedIds(snapshot: ParsedGkdSnapshot, candidate: SelectorCandidate): number[] {
  return validateSelectorPlan(snapshot, candidate.plan)
    .clickNodes.map((node) => node.id)
    .sort((a, b) => a - b);
}

type Policy = {
  name: string;
  rank: (candidate: SelectorCandidate, context: PolicyContext) => number;
};

interface PolicyContext {
  pickedId: number;
  ancestorId?: number;
  visualIds: Set<number>;
  clickedIds: number[];
  pickedHasSignal: boolean;
}

function candidateIds(candidate: SelectorCandidate): number[] {
  return candidate.validation.clickNodes.map((node) => node.id);
}

function isUnique(candidate: SelectorCandidate): boolean {
  return candidate.validation.hitCount === 1;
}

const POLICIES: Policy[] = [
  { name: "baseline", rank: () => 0 },
  {
    name: "primaryUniqueFirst",
    rank: (c, ctx) => {
      const primary = ctx.clickedIds.some(
        (id) => id === ctx.pickedId || id === ctx.ancestorId,
      );
      if (primary) return isUnique(c) ? 0 : 1;
      return isUnique(c) ? 2 : 3;
    },
  },
  {
    name: "exactPickedFirst",
    rank: (c, ctx) => {
      const exact =
        ctx.clickedIds.length === 1 && ctx.clickedIds[0] === ctx.pickedId;
      if (exact) return 0;
      const primary = ctx.clickedIds.some(
        (id) => id === ctx.pickedId || id === ctx.ancestorId,
      );
      if (primary) return isUnique(c) ? 1 : 2;
      return isUnique(c) ? 3 : 4;
    },
  },
  {
    name: "exactThenVisual",
    rank: (c, ctx) => {
      const exact =
        ctx.clickedIds.length === 1 && ctx.clickedIds[0] === ctx.pickedId;
      if (exact) return 0;
      const visual =
        ctx.clickedIds.length > 0 &&
        ctx.clickedIds.every((id) => ctx.visualIds.has(id));
      if (visual) return isUnique(c) ? 1 : 2;
      return isUnique(c) ? 3 : 4;
    },
  },
  {
    name: "exactStrongThenVisual",
    rank: (c, ctx) => {
      const exact =
        ctx.clickedIds.length === 1 && ctx.clickedIds[0] === ctx.pickedId;
      const strong = c.baseScore >= 70;
      if (exact && strong) return 0;
      const visual =
        ctx.clickedIds.length > 0 &&
        ctx.clickedIds.every((id) => ctx.visualIds.has(id));
      if (visual && strong) return isUnique(c) ? 1 : 2;
      if (exact) return 3;
      if (visual) return isUnique(c) ? 4 : 5;
      return isUnique(c) ? 6 : 7;
    },
  },
  {
    name: "exactIfPickedHasSignal",
    rank: (c, ctx) => {
      const exact =
        ctx.clickedIds.length === 1 && ctx.clickedIds[0] === ctx.pickedId;
      if (exact && ctx.pickedHasSignal) return 0;
      const visual =
        ctx.clickedIds.length > 0 &&
        ctx.clickedIds.every((id) => ctx.visualIds.has(id));
      if (visual) return isUnique(c) ? 1 : 2;
      if (exact) return 3;
      return isUnique(c) ? 4 : 5;
    },
  },
  {
    name: "visualUniqueFirst",
    rank: (c, ctx) => {
      const inside = ctx.clickedIds.filter((id) => ctx.visualIds.has(id)).length;
      if (ctx.clickedIds.length > 0 && inside === ctx.clickedIds.length) {
        return isUnique(c) ? 0 : 1;
      }
      if (inside > 0) return 2;
      return isUnique(c) ? 3 : 4;
    },
  },
  {
    name: "primaryThenVisual",
    rank: (c, ctx) => {
      const primary = ctx.clickedIds.some(
        (id) => id === ctx.pickedId || id === ctx.ancestorId,
      );
      if (primary) return isUnique(c) ? 0 : 1;
      const visual =
        ctx.clickedIds.length > 0 &&
        ctx.clickedIds.every((id) => ctx.visualIds.has(id));
      if (visual) return isUnique(c) ? 2 : 3;
      return isUnique(c) ? 4 : 5;
    },
  },
];

test("rerank policy experiment", async () => {
  await prepareSelectorEngine("beta").catch(() => undefined);
  const records = readJsonl(path.join(CLEAN_DIR, "test.jsonl"));
  const selected = LIMIT > 0 ? records.slice(0, LIMIT) : records;
  const snapshotCache = new Map<string, ParsedGkdSnapshot | null>();
  const stats = new Map<string, { top1: number; top3: number; byKind: Map<string, { total: number; top1: number }> }>();
  for (const policy of POLICIES) {
    stats.set(policy.name, { top1: 0, top3: 0, byKind: new Map() });
  }
  let evaluated = 0;
  let recoveredFromRank2 = 0;

  for (const record of selected) {
    let snapshot = snapshotCache.get(record.snapshotId);
    if (snapshot === undefined) {
      const file = path.join(SNAPSHOT_DIR, record.snapshotId, record.snapshotId + ".json");
      snapshot = fs.existsSync(file)
        ? normalizeSnapshot(JSON.parse(fs.readFileSync(file, "utf-8")), "", record.snapshotId)
        : null;
      snapshotCache.set(record.snapshotId, snapshot);
    }
    if (!snapshot) continue;
    const targetNode = snapshot.nodeById.get(record.target.id);
    if (!targetNode) continue;

    const pick = pickExistingNode(snapshot, targetNode);
    const candidates = generateRegionSelectorCandidates({
      snapshot,
      ruleSettings: settingsFor(record),
      pickResult: pick,
    });
    evaluated += 1;
    const kind = record.selectorShape?.kind || "unknown";
    const pickedId = pick.pickedNode.id;
    const ancestorId = pick.clickableAncestor?.id;
    const visualIds = buildVisualTargetIds({
      snapshot,
      pickedNode: pick.pickedNode,
      clickableAncestor: pick.clickableAncestor,
    });

    for (const policy of POLICIES) {
      const ordered = candidates
        .map((candidate) => {
          const policyContext: PolicyContext = {
            pickedId,
            ancestorId,
            visualIds,
            clickedIds: candidateIds(candidate),
            pickedHasSignal: Boolean(
              pick.pickedNode.attr.text ||
                pick.pickedNode.attr.desc ||
                pick.pickedNode.attr.id ||
                pick.pickedNode.attr.vid ||
                pick.pickedNode.attr.clickable,
            ),
          };
          return {
            candidate,
            rank: policy.rank(candidate, policyContext),
          };
        })
        .map((item, index) => ({ ...item, index }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((item) => item.candidate);
      const hit = (c: SelectorCandidate | undefined) => {
        if (!c) return false;
        const ids = clickedIds(snapshot!, c);
        return ids.length === 1 && ids[0] === record.target.id;
      };
      const stat = stats.get(policy.name)!;
      if (hit(ordered[0])) {
        stat.top1 += 1;
        if (policy.name !== "baseline") {
          const baseIds = clickedIds(snapshot, candidates[0]);
          if (!(baseIds.length === 1 && baseIds[0] === record.target.id)) recoveredFromRank2 += 1;
        }
      }
      if (ordered.slice(0, 3).some(hit)) stat.top3 += 1;
      const kindStat = stat.byKind.get(kind) || { total: 0, top1: 0 };
      kindStat.total += 1;
      if (hit(ordered[0])) kindStat.top1 += 1;
      stat.byKind.set(kind, kindStat);
    }
  }

  const pct = (value: number) => Number(((value / evaluated) * 100).toFixed(1));
  const report = {
    evaluated,
    policies: [...stats.entries()].map(([name, stat]) => ({
      name,
      top1: pct(stat.top1),
      top3: pct(stat.top3),
      byKind: Object.fromEntries(
        [...stat.byKind.entries()].map(([kind, value]) => [
          kind,
          { total: value.total, top1: Number(((value.top1 / value.total) * 100).toFixed(1)) },
        ]),
      ),
    })),
  };
  fs.mkdirSync(path.join(DATASET_DIR, "bench"), { recursive: true });
  fs.writeFileSync(
    path.join(DATASET_DIR, "bench", "rerank-report.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );
  console.log(JSON.stringify(report, null, 2));
});
