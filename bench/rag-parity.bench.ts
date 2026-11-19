// @ts-nocheck
/**
 * 校验 src/lib/fewShotRetrieval.ts 与 workbench/rag.mjs 的检索结果一致。
 * 两边任何一侧改权重或 prompt 结构导致漂移，这里会直接失败。
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "vitest";
import {
  featureSimilarity,
  retrieveFewShot,
  buildFewShotPrompt,
} from "../src/lib/fewShotRetrieval";
import * as jsRag from "../workbench/rag.mjs";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const CLEAN_DIR = path.join(DATASET_DIR, "clean");

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test("workbench rag.mjs matches src/lib/fewShotRetrieval.ts", () => {
  const library = readJsonl(path.join(CLEAN_DIR, "fewshot_library.jsonl"));
  const tests = readJsonl(path.join(CLEAN_DIR, "test.jsonl")).slice(0, 60);

  for (const query of tests) {
    const tsHits = retrieveFewShot(library, query, 3);
    const jsHits = jsRag.retrieveFewShot(library, query, 3);
    expect(jsHits.map((hit) => hit.record.id)).toEqual(tsHits.map((hit) => hit.record.id));
    tsHits.forEach((hit, index) => {
      expect(jsHits[index].score).toBeCloseTo(hit.score, 10);
      expect(jsRag.featureSimilarity(query.features, hit.record.features)).toBeCloseTo(
        featureSimilarity(query.features, hit.record.features),
        10,
      );
    });
    expect(jsRag.buildFewShotPrompt(query, jsHits)).toBe(buildFewShotPrompt(query, tsHits));
  }
});
