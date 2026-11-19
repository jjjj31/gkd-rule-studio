"""Train a small pointwise ranker for GKD selector candidates.

Input:  D:\\gkd-dataset\\rank\\{train,val,test}.jsonl
Output: D:\\gkd-dataset\\rank\\ranker.json

The exported JSON is consumed by src/lib/ranker.ts. Features are standardized
with the training mean/scale, so TypeScript inference only needs a dot product.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from dataclasses import dataclass

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

DATASET_DIR = os.environ.get("GKD_DATASET_DIR", r"D:\gkd-dataset")
RANK_DIR = os.path.join(DATASET_DIR, "rank")


@dataclass
class Query:
    query: str
    kind: str
    features: list[list[float]]
    labels: list[int]
    baseline_rank: list[int]


def load_split(name: str) -> list[Query]:
    grouped: dict[str, Query] = {}
    path = os.path.join(RANK_DIR, f"{name}.jsonl")
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            query = grouped.get(row["query"])
            if query is None:
                query = Query(
                    query=row["query"],
                    kind=row.get("kind", "unknown"),
                    features=[],
                    labels=[],
                    baseline_rank=[],
                )
                grouped[row["query"]] = query
            query.features.append(row["features"])
            query.labels.append(int(row["label"]))
            query.baseline_rank.append(int(row["baselineRank"]))
    return list(grouped.values())


def build_matrix(queries: list[Query]) -> tuple[np.ndarray, np.ndarray]:
    features: list[list[float]] = []
    labels: list[int] = []
    for query in queries:
        features.extend(query.features)
        labels.extend(query.labels)
    return np.asarray(features, dtype=np.float64), np.asarray(labels, dtype=np.int32)


def evaluate(model: Pipeline, queries: list[Query]) -> dict[str, float]:
    top1 = top3 = top5 = any_hit = 0
    baseline_top1 = 0
    by_kind: dict[str, list[int]] = defaultdict(lambda: [0, 0])

    for query in queries:
        matrix = np.asarray(query.features, dtype=np.float64)
        scores = model.decision_function(matrix)
        order = np.argsort(-scores)
        labels = np.asarray(query.labels)

        hit1 = int(labels[order[0]] == 1)
        top1 += hit1
        top3 += int(labels[order[:3]].max() == 1)
        top5 += int(labels[order[:5]].max() == 1)
        any_hit += int(labels.max() == 1)
        baseline_top1 += int(
            labels[np.asarray(query.baseline_rank) == 0][0] == 1
        )
        by_kind[query.kind][0] += hit1
        by_kind[query.kind][1] += 1

    total = max(1, len(queries))
    return {
        "queries": len(queries),
        "top1": round(100 * top1 / total, 2),
        "top3": round(100 * top3 / total, 2),
        "top5": round(100 * top5 / total, 2),
        "anyHit": round(100 * any_hit / total, 2),
        "baselineTop1": round(100 * baseline_top1 / total, 2),
        "byKind": {
            kind: {
                "total": values[1],
                "top1": round(100 * values[0] / max(1, values[1]), 2),
            }
            for kind, values in sorted(by_kind.items())
        },
    }


def main() -> None:
    train = load_split("train")
    val = load_split("val")
    test = load_split("test")

    # 没有正例的查询无法学习排序，只保留有正确候选的查询参与训练。
    train_with_positive = [query for query in train if max(query.labels) == 1]
    val_with_positive = [query for query in val if max(query.labels) == 1]
    x_train, y_train = build_matrix(train_with_positive)

    best = None
    for class_weight in (None, "balanced"):
        for c_value in (0.05, 0.1, 0.3, 1.0, 3.0, 10.0):
            model = Pipeline(
                [
                    ("scaler", StandardScaler()),
                    (
                        "lr",
                        LogisticRegression(
                            C=c_value,
                            class_weight=class_weight,
                            max_iter=5000,
                            solver="lbfgs",
                        ),
                    ),
                ]
            )
            model.fit(x_train, y_train)
            metrics = evaluate(model, val)
            # 先看 Top-1，再看 Top-3；都相同则偏向更小的 C（更稳）。
            key = (metrics["top1"], metrics["top3"], -c_value)
            if best is None or key > best[0]:
                best = (key, class_weight, c_value, metrics)
                print(
                    f"val C={c_value} class_weight={class_weight} "
                    f"top1={metrics['top1']} top3={metrics['top3']}"
                )

    assert best is not None
    _, class_weight, c_value, val_metrics = best

    # 超参确定后，用 train+val 重新训练，测试集完全不参与选择。
    train_all = train_with_positive + val_with_positive
    x_all, y_all = build_matrix(train_all)
    final_model = Pipeline(
        [
            ("scaler", StandardScaler()),
            (
                "lr",
                LogisticRegression(
                    C=c_value,
                    class_weight=class_weight,
                    max_iter=5000,
                    solver="lbfgs",
                ),
            ),
        ]
    )
    final_model.fit(x_all, y_all)
    test_metrics = evaluate(final_model, test)

    scaler: StandardScaler = final_model.named_steps["scaler"]
    lr: LogisticRegression = final_model.named_steps["lr"]
    feature_names = json.load(
        open(os.path.join(RANK_DIR, "feature-names.json"), encoding="utf-8")
    )
    export = {
        "featureNames": feature_names,
        "mean": scaler.mean_.tolist(),
        "scale": scaler.scale_.tolist(),
        "coef": lr.coef_[0].tolist(),
        "intercept": float(lr.intercept_[0]),
        "training": {
            "classWeight": class_weight,
            "C": c_value,
            "rows": int(x_all.shape[0]),
            "queries": len(train_all),
            "val": val_metrics,
            "test": test_metrics,
        },
    }
    output = os.path.join(RANK_DIR, "ranker.json")
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(export, handle, ensure_ascii=False, indent=2)

    print("\nfinal test:")
    print(json.dumps(test_metrics, ensure_ascii=False, indent=2))
    print(f"\nwrote {output}")


if __name__ == "__main__":
    main()
