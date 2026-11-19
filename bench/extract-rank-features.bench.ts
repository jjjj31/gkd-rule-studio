/**
 * 生成排序模型训练数据：每条样本生成候选，候选特征 + 是否唯一命中目标。
 *
 * 运行：
 *   npx vitest run --config bench/vitest.config.ts extract-rank
 */
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { test } from "vitest";
import { normalizeSnapshot } from "../src/lib/snapshotNormalize";
import { pickExistingNode } from "../src/lib/nodePicker";
import { generateRegionSelectorCandidates } from "../src/lib/regionCandidates";
import { prepareSelectorEngine } from "../src/lib/selectorAdapter";
import { validateSelectorPlan } from "../src/lib/selectorMatcher";
import {
  createRankContext,
  extractRankFeatures,
  RANK_FEATURE_NAMES,
} from "../src/lib/rankFeatures";
import type { RuleSettings } from "../src/types/ruleDraft";
import type { ParsedGkdSnapshot } from "../src/types/gkdSnapshot";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const CLEAN_DIR = path.join(DATASET_DIR, "clean");
const SNAPSHOT_DIR = path.join(DATASET_DIR, "snapshots");
const OUTPUT_DIR = path.join(DATASET_DIR, "rank");
const LIMIT = Number(process.env.BENCH_LIMIT || 0);
const SPLITS = ["train", "val", "test"] as const;

interface CleanRecord {
  id: string;
  snapshotId: string;
  appId: string;
  appName: string;
  groupName: string | null;
  activityIds: string | string[] | null;
  selector: string;
  selectorShape: { kind: string };
  target: { id: number };
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

test("extract rank features", async () => {
  await prepareSelectorEngine("beta").catch(() => undefined);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUTPUT_DIR, "feature-names.json"),
    JSON.stringify(RANK_FEATURE_NAMES, null, 2),
    "utf-8",
  );

  const snapshotCache = new Map<string, ParsedGkdSnapshot | null>();
  const manifest: Record<string, unknown> = {
    featureNames: RANK_FEATURE_NAMES.length,
    splits: {},
  };

  for (const split of SPLITS) {
    const records = readJsonl(path.join(CLEAN_DIR, `${split}.jsonl`));
    const selected = LIMIT > 0 ? records.slice(0, LIMIT) : records;
    const output = path.join(OUTPUT_DIR, `${split}.jsonl`);
    const stream = fs.createWriteStream(output, "utf-8");
    let queries = 0;
    let candidates = 0;
    let positives = 0;
    let queriesWithPositive = 0;

    for (const record of selected) {
      let snapshot = snapshotCache.get(record.snapshotId);
      if (snapshot === undefined) {
        const file = path.join(
          SNAPSHOT_DIR,
          record.snapshotId,
          record.snapshotId + ".json",
        );
        snapshot = fs.existsSync(file)
          ? normalizeSnapshot(
              JSON.parse(fs.readFileSync(file, "utf-8")),
              "",
              record.snapshotId,
            )
          : null;
        snapshotCache.set(record.snapshotId, snapshot);
      }
      if (!snapshot) continue;
      const target = snapshot.nodeById.get(record.target.id);
      if (!target) continue;

      const pick = pickExistingNode(snapshot, target);
      const rankContext = createRankContext({
        snapshot,
        pickedNode: pick.pickedNode,
        clickableAncestor: pick.clickableAncestor,
      });
      const generated = generateRegionSelectorCandidates({
        snapshot,
        ruleSettings: settingsFor(record),
        pickResult: pick,
      });

      queries += 1;
      let hasPositive = false;
      for (let index = 0; index < generated.length; index += 1) {
        const candidate = generated[index];
        const selectorValidation = validateSelectorPlan(
          snapshot,
          candidate.plan,
        );
        const label =
          selectorValidation.hitCount === 1 &&
          selectorValidation.clickNodes[0]?.id === target.id
            ? 1
            : 0;
        if (label === 1) {
          positives += 1;
          hasPositive = true;
        }
        candidates += 1;
        const line =
          JSON.stringify({
            query: `${split}:${record.id}`,
            split,
            appId: record.appId,
            kind: record.selectorShape?.kind ?? "unknown",
            label,
            baselineRank: index,
            strategy: candidate.strategyName,
            features: extractRankFeatures(candidate, rankContext),
          }) + "\n";
        if (!stream.write(line)) {
          // 等待缓冲区排空，避免大文件占满内存。
          await once(stream, "drain");
        }
      }
      if (hasPositive) queriesWithPositive += 1;
    }

    stream.end();
    await once(stream, "finish");
    manifest.splits = {
      ...(manifest.splits as Record<string, unknown>),
      [split]: { queries, queriesWithPositive, candidates, positives },
    };
  }

  fs.writeFileSync(
    path.join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
});
