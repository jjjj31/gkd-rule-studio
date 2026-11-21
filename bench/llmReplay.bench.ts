/**
 * 不调用模型，只重放已落盘的 A 路径证据。
 *
 * 用途：修正判分口径或失败分类后，重新验证原始候选并生成最终报告，
 * 避免为一次分类修正重跑 30 条真实请求。
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import {
  verifyAiCandidates,
  type AiCandidateVerification,
} from "../src/lib/aiCandidateVerification";
import type { AiRuleCandidate } from "../src/lib/aiModel";
import { validateAiCandidateAgainstSnapshot } from "../src/lib/selectorMatcher";
import { matchGkdSelectorString } from "../src/lib/selectorAdapter";
import { normalizeSnapshot } from "../src/lib/snapshotNormalize";
import type { ParsedGkdSnapshot } from "../src/types/gkdSnapshot";
import type { AppRuleDraft, RuleDraft } from "../src/types/ruleDraft";
import {
  AI_FAILURE_CATEGORY_LABELS,
  classifyVerificationFailure,
  type AiFailureEvidence,
} from "./llmEvidence";
import { splitSelectorBranches } from "./selectorUnion";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const SNAPSHOT_DIR = path.join(DATASET_DIR, "snapshots");
const REPORT_DIR = process.env.GKD_LLM_REPORT_DIR || path.join(DATASET_DIR, "bench");
const EVIDENCE_PATH = path.join(REPORT_DIR, "llm-evidence.json");
const RAW_EVIDENCE_PATH = path.join(REPORT_DIR, "llm-evidence.raw.json");
const REPORT_JSON_PATH = path.join(REPORT_DIR, "llm-report.json");

interface ReplayCandidate {
  candidate: AiRuleCandidate;
  verification: AiCandidateVerification;
  selectors: string[];
  failure: AiFailureEvidence | null;
}

interface ReplayRecord {
  id: string;
  snapshotId: string;
  appId: string;
  appName: string;
  activityId: string | null;
  officialSelector: string;
  target: {
    id: number;
    name: string;
    vid: string | null;
    text: string | null;
    desc: string | null;
    clickable: boolean;
    bounds: [number, number, number, number];
  };
  targetVisualIds: number[];
  snapshotNodeCount: number;
  screenshotPath: string;
  prompt: {
    system: string;
    user: string;
    full: string;
    fullChars: number;
    compactChars: number;
    treeTruncated: boolean;
    charTruncated: boolean;
    imageAttached: boolean;
  };
  request: {
    status: "parsed" | "parse_error" | "request_error" | "skipped";
    elapsedMs: number | null;
    rawContent: string;
    error: string | null;
    usage: unknown;
    responseChars: number | null;
  };
  candidates: ReplayCandidate[];
  semantic: {
    top1Exact: boolean;
    top3Exact: boolean;
    anyExact: boolean;
    top1VisualPass: boolean;
  };
  standard: {
    top1Exact: boolean;
    top3Exact: boolean;
    anyExact: boolean;
    officialHitIds: number[];
  };
  failure: AiFailureEvidence | null;
}

test("replay LLM evidence and render failure report", async () => {
  const records = readJson<ReplayRecord[]>(EVIDENCE_PATH);
  if (!fs.existsSync(RAW_EVIDENCE_PATH)) {
    fs.copyFileSync(EVIDENCE_PATH, RAW_EVIDENCE_PATH);
  }

  for (const record of records) {
    replayRecord(record);
  }

  const report = readJson<Record<string, unknown>>(REPORT_JSON_PATH);
  const summary = report.summary as Record<string, unknown>;
  const ruleFailureRecords = records.filter(
    (record) =>
      record.failure !== null && record.request.status !== "request_error",
  );
  const transportFailureRecords = records.filter(
    (record) =>
      record.failure !== null && record.request.status === "request_error",
  );
  const sampleFailureCategories = countFailureCategories(
    ruleFailureRecords.map((record) => record.failure),
  );
  const candidateFailureCategories = countFailureCategories(
    records.flatMap((record) =>
      record.candidates.map((candidate) => candidate.failure),
    ),
  );
  summary.failedSamples = records.filter((record) => record.failure).length;
  summary.ruleFailureSamples = ruleFailureRecords.length;
  summary.transportFailureCount = transportFailureRecords.length;
  summary.sampleFailureCategories = sampleFailureCategories;
  summary.candidateFailureCategories = candidateFailureCategories;
  const parsedRecords = records.filter(
    (record) => record.request.status === "parsed",
  );
  const standardRate = (key: "top1Exact" | "top3Exact" | "anyExact") =>
    parsedRecords.length === 0
      ? 0
      : Math.round(
          (parsedRecords.filter((record) => record.standard?.[key]).length /
            parsedRecords.length) *
            1000,
        ) / 10;
  summary.standardTop1 = standardRate("top1Exact");
  summary.standardTop3 = standardRate("top3Exact");
  summary.standardAny = standardRate("anyExact");
  report.failures = buildFailureSummaries(records);
  report.replayedAt = new Date().toISOString();
  report.replayNote =
    "已按语义 Top-1 和官方 selector 命中集合双口径重放：Activity 范围不符不算语义失败，布尔属性按快照值校验。";

  const evidenceJsonlPath = path.join(REPORT_DIR, "llm-evidence.jsonl");
  fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(records, null, 2), "utf-8");
  fs.writeFileSync(
    evidenceJsonlPath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf-8",
  );
  fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(REPORT_DIR, "llm-report.md"),
    renderSummaryMarkdown(report),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(REPORT_DIR, "llm-failures.md"),
    renderFailureReport(records, report),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(REPORT_DIR, "llm-manual-batch.md"),
    renderManualBatch(records),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(REPORT_DIR, "llm-manual-answer-key.md"),
    renderManualAnswerKey(records),
    "utf-8",
  );
});

function replayRecord(record: ReplayRecord): void {
  if (record.request.status !== "parsed" || record.candidates.length === 0) {
    return;
  }
  const snapshot = loadSnapshot(record.snapshotId);
  const targetNode = snapshot.nodeById.get(record.target.id);
  if (!targetNode) {
    throw new Error(`${record.id}: target node #${record.target.id} missing`);
  }
  const candidates = record.candidates.map((entry) => entry.candidate);
  const verifications = verifyAiCandidates(snapshot, candidates, targetNode);
  record.candidates = candidates.map((candidate, index) => {
    const verification = verifications[index]!;
    return {
      candidate,
      verification,
      selectors: selectorsOfCandidate(candidate),
      failure: classifyVerificationFailure({
        snapshot,
        candidate,
        verification,
        targetNode,
      }),
    };
  });

  const top1HitNodeIds = candidates[0]
    ? candidateHitIds(candidates[0], snapshot)
    : [];
  const top3HitNodeIds = uniqueSorted(
    candidates.slice(0, 3).flatMap((candidate) =>
      candidateHitIds(candidate, snapshot),
    ),
  );
  const anyHitNodeIds = uniqueSorted(
    candidates.flatMap((candidate) => candidateHitIds(candidate, snapshot)),
  );
  const top1Exact = hitsExactly(top1HitNodeIds, targetNode.id);
  record.semantic = {
    top1Exact,
    top3Exact: hitsExactly(top3HitNodeIds, targetNode.id),
    anyExact: hitsExactly(anyHitNodeIds, targetNode.id),
    top1VisualPass: verifications[0]?.status === "pass",
  };
  const candidateHitIdList = candidates.map((candidate) =>
    candidateHitIds(candidate, snapshot),
  );
  const officialHitIds = uniqueSorted(
    splitSelectorBranches(record.officialSelector).flatMap(
      (branch) => matchGkdSelectorString(snapshot, branch).clickIds,
    ),
  );
  record.standard = {
    top1Exact: hitsStandard(candidateHitIdList[0] ?? [], officialHitIds),
    top3Exact: candidateHitIdList
      .slice(0, 3)
      .some((ids) => hitsStandard(ids, officialHitIds)),
    anyExact: candidateHitIdList.some((ids) =>
      hitsStandard(ids, officialHitIds),
    ),
    officialHitIds,
  };
  record.failure = top1Exact
    ? null
    : record.candidates[0]?.failure ??
      fallbackFailure(
        "Top-1 未唯一命中目标，但本地验证没有给出六类失败码。",
        record.candidates[0]?.verification.failureCodes ?? [],
        record.candidates[0]?.selectors ?? [],
      );
}

function buildFailureSummaries(records: ReplayRecord[]): unknown[] {
  return records
    .filter((record) => record.failure)
    .map((record) => {
      const top1 = record.candidates[0];
      return {
        id: record.id,
        stage: record.request.status === "parsed" ? "verify" : "request",
        targetId: record.target.id,
        requestStatus: record.request.status,
        top1Status: top1?.verification.status ?? null,
        top1MatchedNodeIds: top1?.verification.matchedNodeIds ?? [],
        top1FailureCodes: top1?.verification.failureCodes ?? [],
        top1Diagnostics: top1?.verification.diagnostics.slice(0, 3) ?? [],
        candidateCount: record.candidates.length,
        failureCategory: record.failure!.category,
        failureLabel: record.failure!.label,
        failureConfidence: record.failure!.confidence,
        selectors: top1?.selectors ?? record.failure!.selectors,
        error: record.request.error,
      };
    });
}

function renderFailureReport(
  records: ReplayRecord[],
  report: Record<string, unknown>,
): string {
  const summary = report.summary as Record<string, unknown>;
  const model = report.model as Record<string, unknown>;
  const crossVersion = summary.crossVersion as Record<string, unknown>;
  const failures = records.filter((record) => record.failure);
  const ruleFailures = failures.filter(
    (record) => record.request.status !== "request_error",
  );
  const transportFailures = failures.filter(
    (record) => record.request.status === "request_error",
  );
  const sampleCounts = countFailureCategories(
    ruleFailures.map((record) => record.failure),
  );
  const candidateCounts = countFailureCategories(
    records.flatMap((record) =>
      record.candidates.map((candidate) => candidate.failure),
    ),
  );
  const crossDetails = (crossVersion.details as Array<Record<string, unknown>>) ?? [];
  const unstable = crossDetails.filter((detail) => detail.top1Stable !== true);
  const lines = [
    "# LLM 生成 GKD 规则：A 路径取证报告",
    "",
    `模型运行时间：${report.generatedAt}`,
    `重放与报告生成时间：${new Date().toISOString()}`,
    `模型：${model.model ?? "-"}`,
    `样本：${summary.requestedSamples ?? "-"} 条 paired test 样本`,
    "",
    "## 结论",
    "",
    `- JSON 解析成功：${summary.jsonParseSuccessRate}%（${summary.parsed}/${summary.liveAttempts}）。`,
    `- 语义 Top-1：${summary.semanticTop1}%（${summary.semanticTop1AllAttempts}% 按全部请求计）。`,
    `- 语义 Top-3：${summary.semanticTop3}%；任一候选命中：${summary.semanticAny}%。`,
    `- 官方答案效果 Top-1：${summary.standardTop1}%；Top-3：${summary.standardTop3}%；任一候选：${summary.standardAny}%。`,
    `- 规则失败 ${ruleFailures.length} 条；另有 ${transportFailures.length} 条网络/请求失败，不计入规则失败。`,
    `- 名义上失败最多的两类：选错节点 ${sampleCounts["选错节点"] ?? 0} 条，属性名/值错 ${sampleCounts["属性名/值错"] ?? 0} 条。`,
    `- 跨版本 Top-1 稳定：${crossVersion.top1StableRate}%（${crossVersion.top1Stable}/${crossVersion.pairs}）；不稳定的快照对见下文。`,
    "",
    "一句话结论：名义上选错节点最多（5 条），但其中 3 条是官方 selector 多分支造成的判分风险；去掉这 3 条后，明确可归因的选错节点只有 2 条。当前最该先补的两条硬规则仍是“第一条候选必须命中用户选中的节点”和“vid/id/class 只能从材料中出现过的值里取”。",
    "",
    "## 判分口径",
    "",
    "- 语义 Top-1：只把 `candidate[0]` 的 selector-only 命中集合恰好等于目标节点 ID 视为命中。",
    "- 官方答案效果：candidate 唯一命中的节点只要落在官方 selector 的命中集合里，就算达到标准答案效果。",
    "- 本地验证：使用视觉摞和 Activity 范围做诊断；Activity 范围不符只算本地验证失败，不算语义失败。",
    "- 官方 selector 可能包含多个并列分支；目标节点只有一个，因此“命中官方 selector 的另一个分支”仍会按目标 ID 判为选错节点。下文列出需要人工复核的案例。",
    "- 网络失败不是规则生成失败；格式解析失败是模型输出没有形成合法 JSON5。",
    "",
    "## 失败分类",
    "",
    "### Top-1 语义失败",
    "",
    "| 类别 | 样本数 |",
    "| --- | ---: |",
    ...categoryRows(sampleCounts),
    "",
    "### 全部候选的本地失败",
    "",
    "| 类别 | 候选数 |",
    "| --- | ---: |",
    ...categoryRows(candidateCounts),
    "",
    "候选级计数包含同一题里未排到 Top-1 的候选，也包含 Activity 范围不符等本地问题；它用于看模型输出分布，不等同于 Top-1 失败率。",
    "",
    "## 失败明细",
    "",
  ];

  for (const [index, record] of failures.entries()) {
    const top1 = record.candidates[0];
    const category =
      record.request.status === "request_error"
        ? "请求失败（网络）"
        : record.failure!.label;
    lines.push(
      `### ${index + 1}. ${record.id} · ${record.appName} · ${category}`,
      "",
      `- 快照：${record.snapshotId}；截图：${record.screenshotPath}`,
      `- 目标节点：#${record.target.id} ${record.target.name}；text=${JSON.stringify(record.target.text)}；vid=${record.target.vid ?? "-"}；bounds=${record.target.bounds.join(",")}`,
      `- 官方 selector：\`${record.officialSelector}\``,
      `- 请求状态：${record.request.status}${record.request.error ? `；错误：${record.request.error}` : ""}`,
      `- Top-1 命中节点：${top1?.verification.matchedNodeIds.join(", ") || "0 命中"}`,
      `- Top-1 selector：${top1?.selectors.map((selector) => `\`${selector}\``).join("；") || "-"}`,
      `- 失败原因：${record.failure?.reasons.join("；") || record.request.error || "-"}`,
      "",
    );
    if (record.candidates.length > 0) {
      lines.push("候选逐条核对：", "");
      for (const candidate of record.candidates) {
        lines.push(
          `- \`${candidate.candidate.id}\` / ${candidate.candidate.title}`,
          `  - 验证：${candidate.verification.status}；命中节点：${candidate.verification.matchedNodeIds.join(", ") || "0 命中"}`,
          `  - selectors：${candidate.selectors.map((selector) => `\`${selector}\``).join("；") || "-"}`,
          `  - 本地失败：${candidate.failure?.label ?? "无"}${candidate.failure ? `（${candidate.failure.confidence}）` : ""}`,
          ...(candidate.failure?.reasons.length
            ? [`  - 诊断：${candidate.failure.reasons.join("；")}`]
            : []),
        );
      }
      lines.push("");
    }
  }

  lines.push(
    "## 跨版本不稳定快照对",
    "",
    `共 ${unstable.length}/${crossDetails.length} 对 Top-1 不稳定：`,
    "",
    "| 从 | 到 | 目标节点 | Top-1 命中 |",
    "| --- | --- | ---: | --- |",
    ...unstable.map(
      (detail) =>
        `| ${detail.fromId} | ${detail.toId} | #${detail.targetId} | ${(detail.top1HitNodeIds as number[]).join(", ") || "0 命中"} |`,
    ),
    "",
    "## 需要人工复核的判分风险",
    "",
    "- `14971296:5` / `20601909:5`：官方 selector 同时包含“发现新版本”和“取消”，模型选择“取消”，按目标 ID 判为选错节点。",
    "- `15211473:25`：官方 selector 同时包含“继续拼单”和“先去逛逛”，模型选择“先去逛逛”，按目标 ID 判为选错节点。",
    "- 这两组说明当前“只按 target ID 判分”的口径会把官方 selector 的并列分支判错；在改提示词前，建议先确认这些题的目标是否应允许多个合法点击节点。",
    "",
    "## 下一步提示词硬规则",
    "",
    "1. 第一条候选必须命中用户选中节点本身，或与它矩形重合的视觉摞；禁止用同屏兄弟 CTA、取消按钮、关闭按钮代替目标。",
    "2. `vid`、`id`、`class`、`text`、`desc` 只能使用材料中出现过的值；没有稳定资源名时，用目标文字加真实祖先链，不要猜 `tvQx`、`lLayout_bg` 这类名字。",
    "3. 如果目标是正向 CTA（去抢购、继续拼单、发现新版本），不要默认改写成关闭/取消/跳过；除非材料明确显示目标不可点击。",
    "4. 输出只允许一个合法 JSON5 代码块；不要输出未闭合的候选对象，也不要在候选之间复用同一个 selector。",
    "",
    "## 证据文件",
    "",
    "- 逐样本完整材料与模型原文：`llm-evidence.json` / `llm-evidence.jsonl`",
    "- 重放前原始证据：`llm-evidence.raw.json`",
    "- 网页版 Gemini 题包：`llm-manual-batch.md`",
    "- 答案键：`llm-manual-answer-key.md`",
    "",
  );
  return lines.join("\n");
}

function renderSummaryMarkdown(report: Record<string, unknown>): string {
  const summary = report.summary as Record<string, unknown>;
  const model = report.model as Record<string, unknown>;
  const crossVersion = summary.crossVersion as Record<string, unknown>;
  return [
    "# GKD LLM 规则生成基线（A 路径，已重放）",
    "",
    `生成时间：${report.generatedAt}`,
    `重放时间：${report.replayedAt}`,
    `模型：${model.model}`,
    "",
    `- JSON 解析成功率：${summary.jsonParseSuccessRate}%（${summary.parsed}/${summary.liveAttempts}）`,
    `- 语义 Top-1：${summary.semanticTop1}%`,
    `- 语义 Top-3：${summary.semanticTop3}%`,
    `- 官方答案效果 Top-1：${summary.standardTop1}%`,
    `- 官方答案效果 Top-3：${summary.standardTop3}%`,
    `- 语义失败样本：${summary.failedSamples}`,
    `- 跨版本 Top-1 稳定：${crossVersion.top1StableRate}%（${crossVersion.top1Stable}/${crossVersion.pairs}）`,
    "",
    "失败分类与逐条证据见 `llm-failures.md`。",
    "",
  ].join("\n");
}

function renderManualBatch(records: ReplayRecord[]): string {
  const selected = selectManualCases(records);
  const lines = [
    "# GKD 规则生成：网页版 Gemini 取证题包",
    "",
    `生成时间：${new Date().toISOString()}`,
    `题目数：${selected.length}`,
    "",
    "用法：一次只把下面一个案例的“系统提示”和“用户材料”发给网页版 Gemini。",
    "不要同时粘贴答案键。每个案例只保留模型返回的一个 ```json5 代码块。",
    "如果网页版支持图片，请附上案例里的截图；不支持就只发文字材料。",
    "",
  ];
  for (const [index, record] of selected.entries()) {
    lines.push(
      `## 案例 ${index + 1} · ${record.id} · ${record.appName}`,
      "",
      `- 快照：${record.snapshotId}`,
      `- 目标节点：#${record.target.id} ${record.target.name}`,
      `- 截图：${record.screenshotPath}`,
      "",
      "### 系统提示",
      "",
      "~~~text",
      record.prompt.system,
      "~~~",
      "",
      "### 用户材料",
      "",
      "~~~text",
      record.prompt.user,
      "~~~",
      "",
    );
  }
  return lines.join("\n");
}

function renderManualAnswerKey(records: ReplayRecord[]): string {
  const selected = selectManualCases(records);
  const lines = [
    "# GKD 规则生成：网页版 Gemini 取证答案键",
    "",
    "用途：模型答完后逐题对照。不要把本文件贴给模型。",
    "",
  ];
  for (const [index, record] of selected.entries()) {
    lines.push(
      `## 案例 ${index + 1} · ${record.id}`,
      "",
      `- 应用：${record.appName}（${record.appId}）`,
      `- Activity：${record.activityId ?? "-"}`,
      `- 目标节点：#${record.target.id} ${record.target.name}`,
      `- 目标文字：${record.target.text ? JSON.stringify(record.target.text) : "-"}`,
      `- 目标 vid：${record.target.vid ?? "-"}`,
      `- 视觉摞节点 ID：${record.targetVisualIds.join(", ") || "-"}`,
      `- 官方 selector：\`${record.officialSelector}\``,
      `- 自动基线失败：${record.failure?.label ?? "无"}`,
      "",
      "模型候选核对：",
      "",
    );
    if (record.candidates.length === 0) {
      lines.push(
        `- 请求状态：${record.request.status}`,
        `- 原始错误：${record.request.error ?? "-"}`,
        "",
      );
      continue;
    }
    for (const candidate of record.candidates) {
      lines.push(
        `- ${candidate.candidate.id} / ${candidate.candidate.title}`,
        `  - selectors: ${candidate.selectors.map((selector) => `\`${selector}\``).join("；") || "-"}`,
        `  - 验证：${candidate.verification.status}；命中节点 ${candidate.verification.matchedNodeIds.join(", ") || "无"}`,
        `  - 失败：${candidate.failure?.label ?? "无"}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function selectManualCases(records: ReplayRecord[]): ReplayRecord[] {
  const failures = records.filter((record) => record.failure);
  const rest = records.filter((record) => !record.failure);
  return [...failures, ...rest].slice(0, Math.min(9, records.length));
}

function countFailureCategories(
  failures: Array<AiFailureEvidence | null>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const failure of failures) {
    if (!failure) continue;
    counts[failure.label] = (counts[failure.label] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

function categoryRows(counts: Record<string, number>): string[] {
  const rows = Object.entries(counts).map(
    ([label, count]) => `| ${label} | ${count} |`,
  );
  return rows.length > 0 ? rows : ["| 暂无 | 0 |"];
}

function fallbackFailure(
  reason: string,
  failureCodes: string[],
  selectors: string[],
): AiFailureEvidence {
  return {
    category: "unclassified",
    label: AI_FAILURE_CATEGORY_LABELS.unclassified,
    confidence: "low",
    reasons: [reason],
    failureCodes,
    selectors,
  };
}

function loadSnapshot(snapshotId: string): ParsedGkdSnapshot {
  const file = path.join(SNAPSHOT_DIR, snapshotId, snapshotId + ".json");
  return normalizeSnapshot(JSON.parse(fs.readFileSync(file, "utf-8")), "", snapshotId);
}

function selectorsOfCandidate(candidate: AiRuleCandidate): string[] {
  return candidate.app.groups.flatMap((group) =>
    group.rules.flatMap((rule) => [
      ...rule.matches,
      ...(rule.anyMatches ?? []),
      ...(rule.excludeMatches ?? []),
      ...(rule.excludeAllMatches ?? []),
    ]),
  );
}

function candidateHitIds(
  candidate: AiRuleCandidate,
  snapshot: ParsedGkdSnapshot,
): number[] {
  const validation = validateAiCandidateAgainstSnapshot(
    selectorOnlyCandidate(candidate),
    snapshot,
  );
  return uniqueSorted(validation.clickNodes.map((node) => node.id));
}

function selectorOnlyCandidate(candidate: AiRuleCandidate): AiRuleCandidate {
  return {
    ...candidate,
    app: stripAppScope(candidate.app),
  };
}

function stripAppScope(app: AppRuleDraft): AppRuleDraft {
  return {
    ...app,
    groups: app.groups.map((group) => {
      const clone = {
        ...group,
        rules: group.rules.map(stripRuleScope),
      };
      delete clone.activityIds;
      delete clone.excludeActivityIds;
      delete clone.versionCode;
      delete clone.versionName;
      delete clone.versionCodes;
      delete clone.versionNames;
      delete clone.excludeVersionCodes;
      delete clone.excludeVersionNames;
      return clone;
    }),
  };
}

function stripRuleScope(rule: RuleDraft): RuleDraft {
  const clone = { ...rule };
  delete clone.activityIds;
  delete clone.excludeActivityIds;
  delete clone.versionCode;
  delete clone.versionName;
  delete clone.versionCodes;
  delete clone.versionNames;
  delete clone.excludeVersionCodes;
  delete clone.excludeVersionNames;
  return clone;
}

function hitsExactly(nodeIds: number[], targetId: number): boolean {
  return nodeIds.length === 1 && nodeIds[0] === targetId;
}

function hitsStandard(nodeIds: number[], officialIds: number[]): boolean {
  return nodeIds.length === 1 && officialIds.includes(nodeIds[0]!);
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}
