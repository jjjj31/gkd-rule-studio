/**
 * 方案 B 离线评估：Few-Shot 检索能否召回"同类写法"的官方案例。
 * 指标不是准确率（那要跑大模型），而是检索相关性：
 * - kindMatch：Top-K 案例里是否存在与真值同类型（attr_only/sibling/hierarchy/union）的写法
 * - 相似度分布：Top-1 相似度均值
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import { retrieveFewShot, type FewShotRecord } from "../src/lib/fewShotRetrieval";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const CLEAN_DIR = path.join(DATASET_DIR, "clean");
const REPORT_DIR = path.join(DATASET_DIR, "bench");
const LIMIT = Number(process.env.RAG_LIMIT || 0);

function readJsonl(file: string): FewShotRecord[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FewShotRecord);
}

test("few-shot retrieval quality", () => {
  const library = readJsonl(path.join(CLEAN_DIR, "fewshot_library.jsonl"));
  const all = readJsonl(path.join(CLEAN_DIR, "test.jsonl"));
  const tests = LIMIT > 0 ? all.slice(0, LIMIT) : all;
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const kindOf = (record: FewShotRecord) => record.selectorShape?.kind || "unknown";
  let top1Kind = 0;
  let top3Kind = 0;
  let similaritySum = 0;
  let crossApp = 0;
  const kindMatrix = new Map<string, Map<string, number>>();

  for (const query of tests) {
    const hits = retrieveFewShot(library, query, 3);
    const expected = kindOf(query);
    if (hits.length === 0) continue;
    similaritySum += hits[0].score;
    if (kindOf(hits[0].record) === expected) top1Kind += 1;
    if (hits.some((hit) => kindOf(hit.record) === expected)) top3Kind += 1;
    if (hits[0].record.appId !== query.appId) crossApp += 1;

    const row = kindMatrix.get(expected) || new Map<string, number>();
    const got = kindOf(hits[0].record);
    row.set(got, (row.get(got) || 0) + 1);
    kindMatrix.set(expected, row);
  }

  const total = tests.length;
  const rate = (value: number) => Number(((value / total) * 100).toFixed(1));
  const summary = {
    total,
    librarySize: library.length,
    top1KindMatch: rate(top1Kind),
    top3KindMatch: rate(top3Kind),
    crossAppTop1: rate(crossApp),
    avgTop1Similarity: Number((similaritySum / total).toFixed(3)),
    kindMatrix: Object.fromEntries(
      [...kindMatrix].map(([expected, row]) => [
        expected,
        Object.fromEntries(row),
      ]),
    ),
  };
  fs.writeFileSync(
    path.join(REPORT_DIR, "rag-report.json"),
    JSON.stringify(summary, null, 2),
    "utf-8",
  );
  console.log("[rag]", JSON.stringify(summary, null, 2));
});
