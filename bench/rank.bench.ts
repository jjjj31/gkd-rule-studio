/**
 * 排序模型基准：用训练好的权重给候选打分，和当前规则排序对比。
 *
 * 依赖：
 *   npx vitest run --config bench/vitest.config.ts extract-rank   # 生成候选特征
 *   python bench/train_ranker.py                                  # 训练并导出权重
 *
 * 运行：
 *   npx vitest run --config bench/vitest.config.ts rank.bench
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const RANK_DIR = path.join(DATASET_DIR, "rank");
const REPORT_DIR = path.join(DATASET_DIR, "bench");
const K_VALUES = [1, 3, 5] as const;

interface RankerModel {
  featureNames: string[];
  mean: number[];
  scale: number[];
  coef: number[];
  intercept: number;
}

interface RankRow {
  query: string;
  kind: string;
  label: number;
  baselineRank: number;
  strategy: string;
  features: number[];
}

test("ranker benchmark", () => {
  const modelPath = path.join(RANK_DIR, "ranker.json");
  const testPath = path.join(RANK_DIR, "test.jsonl");
  if (!fs.existsSync(modelPath) || !fs.existsSync(testPath)) {
    throw new Error(
      "缺少排序数据，请先运行 extract-rank 和 bench/train_ranker.py",
    );
  }

  const model = JSON.parse(fs.readFileSync(modelPath, "utf-8")) as RankerModel;
  const grouped = new Map<string, RankRow[]>();
  for (const line of fs.readFileSync(testPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as RankRow;
    const list = grouped.get(row.query) || [];
    list.push(row);
    grouped.set(row.query, list);
  }

  const scores = (row: RankRow) => {
    let total = model.intercept;
    for (let i = 0; i < row.features.length; i += 1) {
      const z = (row.features[i] - model.mean[i]) / (model.scale[i] || 1);
      total += model.coef[i] * z;
    }
    return total;
  };

  const counters: Record<string, number> = Object.fromEntries(
    K_VALUES.map((k) => ["model@" + k, 0]),
  );
  const baseline: Record<string, number> = Object.fromEntries(
    K_VALUES.map((k) => ["base@" + k, 0]),
  );
  const byKind = new Map<string, { total: number; model1: number }>();
  let anyHit = 0;
  let baseline1 = 0;
  let model1 = 0;
  const disagreements: unknown[] = [];

  for (const [query, rows] of grouped) {
    const ranked = [...rows]
      .map((row) => ({ row, score: scores(row) }))
      .sort((a, b) => b.score - a.score);
    const baseOrder = [...rows].sort((a, b) => a.baselineRank - b.baselineRank);
    const labels = ranked.map((item) => item.row.label);

    for (const k of K_VALUES) {
      if (labels.slice(0, k).includes(1)) counters["model@" + k] += 1;
      if (baseOrder.slice(0, k).some((row) => row.label === 1)) {
        baseline["base@" + k] += 1;
      }
    }

    const modelHit = labels[0] === 1;
    const baseHit = baseOrder[0]?.label === 1;
    if (modelHit) model1 += 1;
    if (baseHit) baseline1 += 1;
    if (labels.includes(1)) anyHit += 1;

    const kind = rows[0]?.kind || "unknown";
    const stat = byKind.get(kind) || { total: 0, model1: 0 };
    stat.total += 1;
    if (modelHit) stat.model1 += 1;
    byKind.set(kind, stat);

    if (modelHit !== baseHit) {
      disagreements.push({
        query,
        kind,
        modelHit,
        baseHit,
        modelTopStrategy: ranked[0]?.row.strategy,
        baseTopStrategy: baseOrder[0]?.strategy,
      });
    }
  }

  const total = Math.max(1, grouped.size);
  const rate = (value: number) => Number(((value / total) * 100).toFixed(2));
  const weights = model.featureNames
    .map((name, index) => ({ name, coef: Number(model.coef[index].toFixed(4)) }))
    .sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef));

  const summary = {
    queries: grouped.size,
    model: Object.fromEntries(
      K_VALUES.map((k) => ["top" + k, rate(counters["model@" + k])]),
    ),
    baseline: Object.fromEntries(
      K_VALUES.map((k) => ["top" + k, rate(baseline["base@" + k])]),
    ),
    modelTop1: rate(model1),
    baselineTop1: rate(baseline1),
    anyHit: rate(anyHit),
    byKind: Object.fromEntries(
      [...byKind].map(([key, value]) => [
        key,
        {
          total: value.total,
          modelTop1: Number(((value.model1 / value.total) * 100).toFixed(2)),
        },
      ]),
    ),
    topWeights: weights.slice(0, 5),
    weakWeights: weights.filter(
      (item) => Math.abs(item.coef) < 0.05,
    ).length,
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(REPORT_DIR, "rank-report.json"),
    JSON.stringify({ summary, disagreements }, null, 2),
    "utf-8",
  );
  console.log("[bench] summary", JSON.stringify(summary, null, 2));
});
