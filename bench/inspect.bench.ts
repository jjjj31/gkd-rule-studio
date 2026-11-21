/**
 * 单样本候选检查工具。
 *   $env:BENCH_SAMPLE="17456625:9"; npx vitest run --config bench/vitest.config.ts inspect
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { normalizeSnapshot } from "../src/lib/snapshotNormalize";
import { pickExistingNode } from "../src/lib/nodePicker";
import { generateRegionSelectorCandidates } from "../src/lib/regionCandidates";
import { validateSelectorPlan } from "../src/lib/selectorMatcher";
import type { RuleSettings } from "../src/types/ruleDraft";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const SAMPLE = process.env.BENCH_SAMPLE || "";

test.skipIf(!SAMPLE)("inspect one sample", async () => {
  const file = path.join(DATASET_DIR, "clean", "test.jsonl");
  const record = fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((row) => row.id === SAMPLE);
  if (!record) throw new Error(`sample not found: ${SAMPLE}`);

  const raw = JSON.parse(
    fs.readFileSync(
      path.join(DATASET_DIR, "snapshots", record.snapshotId, record.snapshotId + ".json"),
      "utf-8",
    ),
  );
  const snapshot = normalizeSnapshot(raw, "", record.snapshotId);
  const target = snapshot.nodeById.get(record.target.id);
  if (!target) throw new Error("target node missing");

  const settings: RuleSettings = {
    groupName: record.groupName || "全屏广告",
    activityIds: "",
    matchTime: null,
    actionMaximum: 1,
    actionCd: 3000,
    resetMatch: "match",
  };
  const candidates = generateRegionSelectorCandidates({
    snapshot,
    ruleSettings: settings,
    pickResult: pickExistingNode(snapshot, target),
  });

  console.log("GT      :", record.selector);
  console.log("TARGET  :", JSON.stringify(record.target));
  console.log("SIBLINGS:", JSON.stringify(record.context.siblings?.slice(0, 6)));
  console.log("CANDIDATES:", candidates.length);
  candidates.slice(0, 15).forEach((candidate, index) => {
    const ids = validateSelectorPlan(snapshot, candidate.plan).clickNodes.map((n) => n.id);
    console.log(
      `  #${index} score=${candidate.risk.finalScore} penalty=${candidate.rankPenalty ?? 0} ` +
        `[${candidate.strategyName}] ids=${JSON.stringify(ids)} :: ${candidate.rule.matches[0]}`,
    );
  });
});
