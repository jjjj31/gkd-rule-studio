/**
 * LLM 规则生成基线。
 *
 * 默认只跑 30 条 test.jsonl，先验证管线；用 GKD_LLM_LIMIT=0 跑全量。
 * 没有 API Key 时仍会构建 prompt、统计字符数，并写一份 not-run 报告；
 * 设置 GKD_LLM_PROMPT_ONLY=1 可以只做 prompt 预算，不产生 API 费用。
 */
import fs from "node:fs";
import path from "node:path";
import { test } from "vitest";
import {
  AiCandidateParseError,
  aiMessageTextContent,
  buildAiGenerateMessages,
  normalizeAiConfig,
  requestAiCandidatesDetailed,
  type AiRequestResult,
  type AiRuleCandidate,
  type AiTokenUsage,
} from "../src/lib/aiModel";
import {
  verifyAiCandidates,
  type AiCandidateVerification,
} from "../src/lib/aiCandidateVerification";
import { buildHelpPrompt } from "../src/lib/helpPrompt";
import {
  buildQueryFromSnapshot,
  formatFewShotExamples,
  retrieveFewShot,
  type FewShotHit,
  type FewShotRecord,
} from "../src/lib/fewShotRetrieval";
import { pickExistingNode } from "../src/lib/nodePicker";
import { matchGkdSelectorString } from "../src/lib/selectorAdapter";
import { validateAiCandidateAgainstSnapshot } from "../src/lib/selectorMatcher";
import { normalizeSnapshot } from "../src/lib/snapshotNormalize";
import { buildVisualTargetIds } from "../src/lib/visualTarget";
import type { AppRuleDraft, RuleDraft, RuleSettings } from "../src/types/ruleDraft";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../src/types/gkdSnapshot";
import {
  classifyRequestError,
  classifyVerificationFailure,
  type AiFailureEvidence,
} from "./llmEvidence";
import { splitSelectorBranches } from "./selectorUnion";

const DATASET_DIR = process.env.GKD_DATASET_DIR || "D:\\gkd-dataset";
const CLEAN_DIR = path.join(DATASET_DIR, "clean");
const SNAPSHOT_DIR = path.join(DATASET_DIR, "snapshots");
const REPORT_DIR = process.env.GKD_LLM_REPORT_DIR || path.join(DATASET_DIR, "bench");
const SPLITS = ["train", "val", "test"] as const;
const PROMPT_ONLY = process.env.GKD_LLM_PROMPT_ONLY === "1";
const FULL_TREE = process.env.GKD_LLM_FULL_TREE === "1";
const INCLUDE_IMAGE = process.env.GKD_LLM_IMAGE === "1";
const FEWSHOT_COUNT = readNumber("GKD_LLM_FEWSHOT", 0);
const LIMIT = readLimit();
const SAMPLE_MODE = readSampleMode();
const API_KEY =
  process.env.GKD_LLM_API_KEY?.trim() ||
  process.env.OPENAI_API_KEY?.trim() ||
  "";
const BASE_URL =
  process.env.GKD_LLM_BASE_URL?.trim() ||
  process.env.OPENAI_BASE_URL?.trim() ||
  "https://api.openai.com/v1";
const MODEL =
  process.env.GKD_LLM_MODEL?.trim() ||
  process.env.OPENAI_MODEL?.trim() ||
  "gpt-4.1-mini";

interface CleanRecord {
  id: string;
  snapshotId: string;
  appId: string;
  appName: string;
  activityIds: string | string[] | null;
  groupName: string | null;
  selector: string;
  target: {
    id: number;
    name: string;
    vid: string | null;
    text: string | null;
  };
}

interface Pair {
  appId: string;
  from: CleanRecord;
  to: CleanRecord;
}

interface PromptStat {
  id: string;
  promptChars: number;
  bodyChars: number;
  estimatedTokens: number;
}

interface GeneratedSample {
  record: CleanRecord;
  candidates: AiRuleCandidate[];
}

interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageResponses: number;
  estimatedResponses: number;
}

interface EvidenceCandidate {
  candidate: AiRuleCandidate;
  verification: AiCandidateVerification;
  selectors: string[];
  failure: AiFailureEvidence | null;
}

interface EvidenceRecord {
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
  fewShot: {
    count: number;
    ids: string[];
    chars: number;
  };
  prompt: {
    system: string;
    user: string;
    full: string;
    fullChars: number;
    compactChars: number;
    fullTree: boolean;
    imageChars: number;
    treeTruncated: boolean;
    charTruncated: boolean;
    imageAttached: boolean;
  };
  request: {
    status: "parsed" | "parse_error" | "request_error" | "skipped";
    elapsedMs: number | null;
    rawContent: string;
    error: string | null;
    usage: AiTokenUsage | null;
    responseChars: number | null;
  };
  candidates: EvidenceCandidate[];
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

interface CrossVersionDetail {
  fromId: string;
  toId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  targetId: number;
  top1Stable: boolean;
  top3Stable: boolean;
  anyStable: boolean;
  top1HitNodeIds: number[];
  top3HitNodeIds: number[];
  anyHitNodeIds: number[];
}

test("LLM rule generation baseline", async () => {
  const records = readJsonl(path.join(CLEAN_DIR, "test.jsonl"));
  const allRecords = SPLITS.flatMap((split) =>
    readJsonl(path.join(CLEAN_DIR, `${split}.jsonl`)),
  );
  const allPairs = buildPairs(allRecords);
  const pairedRecordIds = new Set(allPairs.map((pair) => pair.from.id));
  const samplePool =
    SAMPLE_MODE === "paired"
      ? records.filter((record) => pairedRecordIds.has(record.id))
      : records;
  const requestedIds = (process.env.GKD_LLM_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const filteredPool =
    requestedIds.length > 0
      ? samplePool.filter((record) => requestedIds.includes(record.id))
      : samplePool;
  const selected = LIMIT > 0 ? filteredPool.slice(0, LIMIT) : filteredPool;
  const fewShotLibrary = FEWSHOT_COUNT > 0 ? readFewShotLibrary() : [];
  const snapshotCache = new Map<string, ParsedGkdSnapshot | null>();
  const promptStats: PromptStat[] = [];
  const failures: unknown[] = [];
  const evidenceRecords: EvidenceRecord[] = [];
  const generated = new Map<string, GeneratedSample>();
  const config = normalizeAiConfig({
    baseURL: BASE_URL,
    apiKey: API_KEY,
    model: MODEL,
    temperature: readNumber("GKD_LLM_TEMPERATURE", 0),
    timeoutMs: readNumber("GKD_LLM_TIMEOUT_MS", 180_000),
    supportsMultimodal: INCLUDE_IMAGE,
  });
  const started = Date.now();
  let liveAttempts = 0;
  let responseCount = 0;
  let parseSuccess = 0;
  let localValidationPass = 0;
  let allRulesPass = 0;
  let semanticTop1 = 0;
  let semanticTop3 = 0;
  let semanticAny = 0;
  let standardTop1Count = 0;
  let standardTop3Count = 0;
  let standardAnyCount = 0;
  let anyValidationPass = 0;
  let candidateCount = 0;
  const requestErrors = new Map<string, number>();
  const tokens: TokenTotals = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    usageResponses: 0,
    estimatedResponses: 0,
  };

  for (const [index, record] of selected.entries()) {
    const snapshot = loadSnapshot(record.snapshotId, snapshotCache);
    if (!snapshot) {
      failures.push({ id: record.id, stage: "snapshot", reason: "snapshot-missing" });
      continue;
    }
    const targetNode = snapshot.nodeById.get(record.target.id);
    if (!targetNode) {
      failures.push({ id: record.id, stage: "snapshot", reason: "target-missing" });
      continue;
    }

    const pickResult = pickExistingNode(snapshot, targetNode);
    const fewShotExamples =
      FEWSHOT_COUNT > 0
        ? retrieveFewShot(
            fewShotLibrary,
            buildQueryFromSnapshot(
              snapshot,
              targetNode,
              pickResult.ancestors,
              pickResult.siblings,
            ),
            FEWSHOT_COUNT,
          )
        : undefined;
    const prompt = buildHelpPrompt({
      snapshot,
      pickResult,
      ruleSettings: settingsFor(record),
      includeFullTree: FULL_TREE,
      fewShotExamples,
    });
    const imageUrl = INCLUDE_IMAGE
      ? readImageDataUrl(record.snapshotId)
      : undefined;
    const messages = buildAiGenerateMessages({
      mode: "single",
      prompt,
      imageUrl,
      compactPrompt: !FULL_TREE,
    });
    const promptChars = messages.reduce(
      (sum, message) => sum + aiMessageTextContent(message.content).length,
      0,
    );
    const bodyChars = JSON.stringify({ messages }).length;
    promptStats.push({
      id: record.id,
      promptChars,
      bodyChars,
      estimatedTokens: Math.ceil(promptChars / 4),
    });
    const evidenceRecord = createEvidenceRecord({
      record,
      snapshot,
      targetNode,
      prompt,
      messages,
      imageUrl,
      fewShotExamples,
    });
    evidenceRecords.push(evidenceRecord);

    if (PROMPT_ONLY) {
      evidenceRecord.request.status = "skipped";
      evidenceRecord.request.error = "GKD_LLM_PROMPT_ONLY=1";
      continue;
    }
    if (!API_KEY) {
      if (index === 0) {
        console.warn(
          "[bench:llm] GKD_LLM_API_KEY 未设置，只生成 prompt 预算报告；不发起模型请求。",
        );
      }
      evidenceRecord.request.status = "skipped";
      evidenceRecord.request.error = "GKD_LLM_API_KEY 未设置";
      continue;
    }

    liveAttempts += 1;
    let result: AiRequestResult;
    try {
      result = await requestAiCandidatesDetailed({ config, messages });
      responseCount += 1;
      parseSuccess += 1;
      addUsage(tokens, result.usage, promptChars, result.content.length);
      evidenceRecord.request = {
        status: "parsed",
        elapsedMs: result.elapsedMs,
        rawContent: result.content,
        error: null,
        usage: result.usage,
        responseChars: result.content.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = classifyError(message);
      const failureEvidence = classifyRequestError(message);
      requestErrors.set(kind, (requestErrors.get(kind) ?? 0) + 1);
      if (error instanceof AiCandidateParseError) {
        responseCount += 1;
        addUsage(
          tokens,
          error.usage,
          error.promptChars,
          error.content.length,
        );
        evidenceRecord.request = {
          status: "parse_error",
          elapsedMs: error.elapsedMs,
          rawContent: error.content,
          error: summarizeError(message),
          usage: error.usage,
          responseChars: error.content.length,
        };
      } else {
        evidenceRecord.request = {
          status: "request_error",
          elapsedMs: null,
          rawContent: "",
          error: summarizeError(message),
          usage: null,
          responseChars: null,
        };
      }
      evidenceRecord.failure = failureEvidence;
      if (failures.length < 50) {
        failures.push({
          id: record.id,
          stage: "request",
          kind,
          error: summarizeError(message),
          failureCategory: failureEvidence.category,
          failureLabel: failureEvidence.label,
          failureConfidence: failureEvidence.confidence,
          selectors: failureEvidence.selectors,
          rawContentChars: evidenceRecord.request.rawContent.length,
        });
      }
      continue;
    }

    const candidates = result.candidates;
    candidateCount += candidates.length;
    const verifications = verifyAiCandidates(snapshot, candidates, targetNode);
    generated.set(record.id, { record, candidates });

    const top1 = verifications[0] ?? null;
    const top1Exact =
      !!candidates[0] &&
      candidateHitsExactly(candidates[0], snapshot, targetNode.id);
    const top3Exact = candidates
      .slice(0, 3)
      .some((candidate) =>
        candidateHitsExactly(candidate, snapshot, targetNode.id),
      );
    const anyExact = candidates.some((candidate) =>
      candidateHitsExactly(candidate, snapshot, targetNode.id),
    );
    const officialHitIds = officialSelectorHitIds(record.selector, snapshot);
    const standardTop1Exact =
      !!candidates[0] &&
      candidateHitsStandard(candidates[0], snapshot, officialHitIds);
    const standardTop3Exact = candidates
      .slice(0, 3)
      .some((candidate) =>
        candidateHitsStandard(candidate, snapshot, officialHitIds),
      );
    const standardAnyExact = candidates.some((candidate) =>
      candidateHitsStandard(candidate, snapshot, officialHitIds),
    );
    if (top1?.status === "pass") localValidationPass += 1;
    if (top1?.allRulesPass) allRulesPass += 1;
    if (verifications.some((item) => item.status === "pass")) anyValidationPass += 1;
    if (top1Exact) semanticTop1 += 1;
    if (top3Exact) semanticTop3 += 1;
    if (anyExact) semanticAny += 1;
    if (standardTop1Exact) standardTop1Count += 1;
    if (standardTop3Exact) standardTop3Count += 1;
    if (standardAnyExact) standardAnyCount += 1;

    evidenceRecord.candidates = candidates.map((candidate, candidateIndex) => {
      const verification = verifications[candidateIndex]!;
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
    evidenceRecord.semantic = {
      top1Exact,
      top3Exact,
      anyExact,
      top1VisualPass: top1?.status === "pass",
    };
    evidenceRecord.standard = {
      top1Exact: standardTop1Exact,
      top3Exact: standardTop3Exact,
      anyExact: standardAnyExact,
      officialHitIds,
    };
    // 语义判分只看 Top-1 是否唯一命中目标；Activity 范围不符只记在
    // candidate.verification 里，不能把已经点对目标的样本算成语义失败。
    evidenceRecord.failure = top1Exact
      ? null
      : evidenceRecord.candidates[0]?.failure ?? null;

    if (
      candidates[0] &&
      !top1Exact &&
      failures.length < 50
    ) {
      failures.push({
        id: record.id,
        stage: "verify",
        targetId: targetNode.id,
        top1Status: top1.status,
        top1MatchedNodeIds: top1.matchedNodeIds,
        top1FailureCodes: top1.failureCodes,
        top1Diagnostics: top1.diagnostics.slice(0, 3),
        candidateCount: candidates.length,
        failureCategory: evidenceRecord.failure?.category ?? "unclassified",
        failureLabel: evidenceRecord.failure?.label ?? "待人工归类",
        failureConfidence: evidenceRecord.failure?.confidence ?? "low",
        selectors: evidenceRecord.candidates[0]?.selectors ?? [],
      });
    }

    if (liveAttempts % 10 === 0) {
      console.log(`[bench:llm] ${liveAttempts}/${selected.length}`);
    }
  }

  const crossVersion = evaluateCrossVersion(
    generated,
    allPairs,
    snapshotCache,
  );
  const elapsedSeconds = round1((Date.now() - started) / 1000);
  const promptSummary = summarizePromptStats(promptStats);
  const sampleFailureCategories = countFailureCategories(
    evidenceRecords.map((record) => record.failure),
  );
  const candidateFailureCategories = countFailureCategories(
    evidenceRecords.flatMap((record) =>
      record.candidates.map((candidate) => candidate.failure),
    ),
  );
  const summary = {
    requestedSamples: selected.length,
    promptSamples: promptStats.length,
    evidenceSamples: evidenceRecords.length,
    failedSamples: evidenceRecords.filter((record) => record.failure !== null).length,
    liveAttempts,
    responses: responseCount,
    parsed: parseSuccess,
    candidateCount,
    jsonParseSuccessRate: pct(parseSuccess, liveAttempts),
    localValidationPassRate: pct(localValidationPass, parseSuccess),
    localValidationPassRateAllAttempts: pct(localValidationPass, liveAttempts),
    allRulesPassRate: pct(allRulesPass, parseSuccess),
    anyCandidateValidationPassRate: pct(anyValidationPass, parseSuccess),
    semanticTop1: pct(semanticTop1, parseSuccess),
    semanticTop3: pct(semanticTop3, parseSuccess),
    semanticAny: pct(semanticAny, parseSuccess),
    semanticTop1AllAttempts: pct(semanticTop1, liveAttempts),
    standardTop1: pct(standardTop1Count, parseSuccess),
    standardTop3: pct(standardTop3Count, parseSuccess),
    standardAny: pct(standardAnyCount, parseSuccess),
    standardTop1AllAttempts: pct(standardTop1Count, liveAttempts),
    sampleFailureCategories,
    candidateFailureCategories,
    crossVersion,
    requestErrors: Object.fromEntries([...requestErrors].sort()),
    tokens: {
      ...tokens,
      promptTokensEstimated: tokens.usageResponses === 0,
    },
    elapsedSeconds,
    averageRequestSeconds:
      responseCount > 0 ? round1(elapsedSeconds / responseCount) : null,
  };

  const status = PROMPT_ONLY
    ? "prompt-only"
    : API_KEY
      ? "ok"
      : "not-run";
  const report = {
    generatedAt: new Date().toISOString(),
    status,
    reason:
      status === "prompt-only"
        ? "GKD_LLM_PROMPT_ONLY=1：只构建 prompt，不调用模型。"
        : status === "not-run"
          ? "未设置 GKD_LLM_API_KEY，未调用模型。"
          : null,
    dataset: {
      root: DATASET_DIR,
      split: "test",
      sampleMode: SAMPLE_MODE,
      eligibleSamples: samplePool.length,
      limit: LIMIT,
      includeImage: INCLUDE_IMAGE,
      fullTree: FULL_TREE,
      fewShotCount: FEWSHOT_COUNT,
    },
    model: {
      baseURLHost: hostOf(config.baseURL),
      model: config.model,
      temperature: config.temperature,
      timeoutMs: config.timeoutMs,
    },
    prompt: promptSummary,
    summary,
    failures,
    evidence: {
      json: "llm-evidence.json",
      jsonl: "llm-evidence.jsonl",
      manualBatch: "llm-manual-batch.md",
      manualAnswerKey: "llm-manual-answer-key.md",
    },
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, "llm-report.json");
  const markdownPath = path.join(REPORT_DIR, "llm-report.md");
  const evidenceJsonPath = path.join(REPORT_DIR, "llm-evidence.json");
  const evidenceJsonlPath = path.join(REPORT_DIR, "llm-evidence.jsonl");
  const manualBatchPath = path.join(REPORT_DIR, "llm-manual-batch.md");
  const manualAnswerKeyPath = path.join(
    REPORT_DIR,
    "llm-manual-answer-key.md",
  );
  fs.writeFileSync(
    evidenceJsonPath,
    JSON.stringify(evidenceRecords, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    evidenceJsonlPath,
    evidenceRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf-8",
  );
  fs.writeFileSync(
    manualBatchPath,
    renderManualBatch(evidenceRecords),
    "utf-8",
  );
  fs.writeFileSync(
    manualAnswerKeyPath,
    renderManualAnswerKey(evidenceRecords),
    "utf-8",
  );
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(markdownPath, renderMarkdown(report), "utf-8");
  console.log("[bench:llm] summary", JSON.stringify({ status, ...summary }, null, 2));
  console.log(`[bench:llm] wrote ${jsonPath}`);
  console.log(`[bench:llm] wrote ${markdownPath}`);
  console.log(`[bench:llm] wrote ${evidenceJsonPath}`);
  console.log(`[bench:llm] wrote ${evidenceJsonlPath}`);
  console.log(`[bench:llm] wrote ${manualBatchPath}`);
  console.log(`[bench:llm] wrote ${manualAnswerKeyPath}`);
});

function readLimit(): number {
  const raw = process.env.GKD_LLM_LIMIT ?? process.env.BENCH_LIMIT;
  if (raw === undefined || raw === "") return 30;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 30;
}

function readSampleMode(): "paired" | "test" {
  const raw = process.env.GKD_LLM_SAMPLE_MODE;
  if (raw === "paired" || raw === "test") return raw;
  return LIMIT === 0 ? "test" : "paired";
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function createEvidenceRecord({
  record,
  snapshot,
  targetNode,
  prompt,
  messages,
  imageUrl,
  fewShotExamples,
}: {
  record: CleanRecord;
  snapshot: ParsedGkdSnapshot;
  targetNode: NormalizedSnapshotNode;
  prompt: string;
  messages: ReturnType<typeof buildAiGenerateMessages>;
  imageUrl?: string;
  fewShotExamples?: FewShotHit[];
}): EvidenceRecord {
  const messageTexts = messages.map((message) => ({
    role: message.role,
    content: aiMessageTextContent(message.content),
  }));
  const system = messageTexts
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const user = messageTexts
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n");
  const compactChars = system.length + user.length;
  return {
    id: record.id,
    snapshotId: record.snapshotId,
    appId: snapshot.appId,
    appName: record.appName || snapshot.appInfo?.name || "-",
    activityId: snapshot.activityId,
    officialSelector: record.selector,
    target: {
      id: targetNode.id,
      name: targetNode.attr.name,
      vid: targetNode.attr.vid,
      text: targetNode.attr.text,
      desc: targetNode.attr.desc,
      clickable: targetNode.attr.clickable,
      bounds: [
        targetNode.attr.left,
        targetNode.attr.top,
        targetNode.attr.right,
        targetNode.attr.bottom,
      ],
    },
    targetVisualIds: uniqueSorted(
      [...buildVisualTargetIds({ snapshot, pickedNode: targetNode })],
    ),
    snapshotNodeCount: snapshot.nodes.length,
    screenshotPath: path.join(
      SNAPSHOT_DIR,
      record.snapshotId,
      `${record.snapshotId}.png`,
    ),
    fewShot: {
      count: fewShotExamples?.length ?? 0,
      ids: fewShotExamples?.map((hit) => hit.record.id) ?? [],
      chars: fewShotExamples
        ? formatFewShotExamples(fewShotExamples).join("\n").length
        : 0,
    },
    prompt: {
      system,
      user,
      full: prompt,
      fullChars: prompt.length,
      compactChars,
      fullTree: FULL_TREE,
      imageChars: imageUrl?.length ?? 0,
      treeTruncated: /已省略\s+\d+\s+行节点树摘要/.test(user),
      charTruncated: /已按内置 AI 请求限制省略/.test(user),
      imageAttached: messages.some((message) => Array.isArray(message.content)),
    },
    request: {
      status: "skipped",
      elapsedMs: null,
      rawContent: "",
      error: null,
      usage: null,
      responseChars: null,
    },
    candidates: [],
    semantic: {
      top1Exact: false,
      top3Exact: false,
      anyExact: false,
      top1VisualPass: false,
    },
    standard: {
      top1Exact: false,
      top3Exact: false,
      anyExact: false,
      officialHitIds: [],
    },
    failure: null,
  };
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

function readJsonl(file: string): CleanRecord[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CleanRecord);
}

function readFewShotLibrary(): FewShotRecord[] {
  const file = path.join(CLEAN_DIR, "fewshot_library.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as FewShotRecord);
}

function loadSnapshot(
  snapshotId: string,
  cache: Map<string, ParsedGkdSnapshot | null>,
): ParsedGkdSnapshot | null {
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
}

function readImageDataUrl(snapshotId: string): string | undefined {
  const file = path.join(SNAPSHOT_DIR, snapshotId, `${snapshotId}.png`);
  if (!fs.existsSync(file)) return undefined;
  return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
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
    if (new Set(list.map((record) => record.snapshotId)).size < 2) continue;
    for (const from of list) {
      for (const to of list) {
        if (from.snapshotId !== to.snapshotId) {
          pairs.push({ appId: from.appId, from, to });
        }
      }
    }
  }
  return pairs;
}

function evaluateCrossVersion(
  generated: Map<string, GeneratedSample>,
  pairs: Pair[],
  snapshotCache: Map<string, ParsedGkdSnapshot | null>,
): {
  pairs: number;
  top1Stable: number;
  top3Stable: number;
  anyCandidateStable: number;
  top1StableRate: number;
  top3StableRate: number;
  anyCandidateStableRate: number;
  details: CrossVersionDetail[];
} {
  let evaluated = 0;
  let top1Stable = 0;
  let top3Stable = 0;
  let anyCandidateStable = 0;
  const details: CrossVersionDetail[] = [];

  for (const pair of pairs) {
    const sample = generated.get(pair.from.id);
    if (!sample) continue;
    const snapshot = loadSnapshot(pair.to.snapshotId, snapshotCache);
    if (!snapshot) continue;
    const targetNode = snapshot.nodeById.get(pair.to.target.id);
    if (!targetNode) continue;
    const candidates = sample.candidates;
    evaluated += 1;
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
    const top1PairStable = hitsExactly(top1HitNodeIds, targetNode.id);
    const top3PairStable = hitsExactly(top3HitNodeIds, targetNode.id);
    const anyPairStable = hitsExactly(anyHitNodeIds, targetNode.id);
    if (top1PairStable) top1Stable += 1;
    if (top3PairStable) top3Stable += 1;
    if (anyPairStable) anyCandidateStable += 1;
    details.push({
      fromId: pair.from.id,
      toId: pair.to.id,
      fromSnapshotId: pair.from.snapshotId,
      toSnapshotId: pair.to.snapshotId,
      targetId: targetNode.id,
      top1Stable: top1PairStable,
      top3Stable: top3PairStable,
      anyStable: anyPairStable,
      top1HitNodeIds,
      top3HitNodeIds,
      anyHitNodeIds,
    });
  }

  return {
    pairs: evaluated,
    top1Stable,
    top3Stable,
    anyCandidateStable,
    top1StableRate: pct(top1Stable, evaluated),
    top3StableRate: pct(top3Stable, evaluated),
    anyCandidateStableRate: pct(anyCandidateStable, evaluated),
    details,
  };
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

function candidateHitsExactly(
  candidate: AiRuleCandidate,
  snapshot: ParsedGkdSnapshot,
  targetId: number,
): boolean {
  return hitsExactly(candidateHitIds(candidate, snapshot), targetId);
}

function officialSelectorHitIds(
  selector: string,
  snapshot: ParsedGkdSnapshot,
): number[] {
  return uniqueSorted(
    splitSelectorBranches(selector).flatMap(
      (branch) => matchGkdSelectorString(snapshot, branch).clickIds,
    ),
  );
}

function candidateHitsStandard(
  candidate: AiRuleCandidate,
  snapshot: ParsedGkdSnapshot,
  officialHitIds: number[],
): boolean {
  const hitIds = candidateHitIds(candidate, snapshot);
  return hitIds.length === 1 && officialHitIds.includes(hitIds[0]!);
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

function hitsExactly(nodeIds: number[], targetId: number): boolean {
  return nodeIds.length === 1 && nodeIds[0] === targetId;
}

function addUsage(
  totals: TokenTotals,
  usage: AiTokenUsage | null,
  promptChars: number,
  responseChars: number,
): void {
  if (usage) {
    totals.usageResponses += 1;
    totals.promptTokens += usage.promptTokens ?? Math.ceil(promptChars / 4);
    totals.completionTokens +=
      usage.completionTokens ?? Math.ceil(responseChars / 4);
    totals.totalTokens +=
      usage.totalTokens ??
      (usage.promptTokens ?? Math.ceil(promptChars / 4)) +
        (usage.completionTokens ?? Math.ceil(responseChars / 4));
    return;
  }
  totals.estimatedResponses += 1;
  const promptTokens = Math.ceil(promptChars / 4);
  const completionTokens = Math.ceil(responseChars / 4);
  totals.promptTokens += promptTokens;
  totals.completionTokens += completionTokens;
  totals.totalTokens += promptTokens + completionTokens;
}

function summarizePromptStats(stats: PromptStat[]): {
  samples: number;
  promptChars: { avg: number; p50: number; p95: number; max: number };
  bodyChars: { avg: number; p50: number; p95: number; max: number };
  estimatedTokens: { avg: number; p50: number; p95: number; max: number };
} {
  const promptChars = stats.map((item) => item.promptChars);
  const bodyChars = stats.map((item) => item.bodyChars);
  const estimatedTokens = stats.map((item) => item.estimatedTokens);
  return {
    samples: stats.length,
    promptChars: distribution(promptChars),
    bodyChars: distribution(bodyChars),
    estimatedTokens: distribution(estimatedTokens),
  };
}

function distribution(values: number[]): {
  avg: number;
  p50: number;
  p95: number;
  max: number;
} {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

function classifyError(message: string): string {
  if (message.includes("不是有效 JSON5")) return "parse";
  if (/HTTP\s+(401|403)|API Key|鉴权|unauthorized/i.test(message)) return "auth";
  if (/HTTP\s+\d{3}/.test(message)) return "http";
  if (/timeout|network|fetch|ECONN|ENOTFOUND|ETIMEDOUT|abort/i.test(message)) {
    return "network";
  }
  return "unknown";
}

function summarizeError(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 500)}…` : compact;
}

function pct(value: number, total: number): number {
  return total > 0 ? round1((value / total) * 100) : 0;
}

function round1(value: number): number {
  return Number(value.toFixed(1));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function failureCategoryRows(
  sampleCounts: Record<string, number>,
  candidateCounts: Record<string, number>,
): string[] {
  const labels = [
    "选择器语法错",
    "属性名/值错",
    "文字不匹配",
    "结构条件错",
    "选错节点",
    "格式解析失败",
    "待人工归类",
  ];
  const rows = labels
    .filter((label) => sampleCounts[label] || candidateCounts[label])
    .map(
      (label) =>
        `| ${label} | ${sampleCounts[label] ?? 0} | ${candidateCounts[label] ?? 0} |`,
    );
  return rows.length > 0 ? rows : ["| 暂无失败 | 0 | 0 |"];
}

function selectManualCases(records: EvidenceRecord[]): EvidenceRecord[] {
  const failures = records.filter((record) => record.failure !== null);
  const rest = records.filter((record) => record.failure === null);
  return [...failures, ...rest].slice(0, Math.min(9, records.length));
}

function renderManualBatch(records: EvidenceRecord[]): string {
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

function renderManualAnswerKey(records: EvidenceRecord[]): string {
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

function renderMarkdown(report: {
  generatedAt: string;
  status: string;
  reason: string | null;
  dataset: {
    root: string;
    split: string;
    sampleMode: string;
    eligibleSamples: number;
    limit: number;
    includeImage: boolean;
    fullTree: boolean;
  };
  model: { baseURLHost: string; model: string; temperature: number; timeoutMs: number };
  prompt: ReturnType<typeof summarizePromptStats>;
  summary: {
    requestedSamples: number;
    promptSamples: number;
    evidenceSamples: number;
    failedSamples: number;
    liveAttempts: number;
    parsed: number;
    jsonParseSuccessRate: number;
    localValidationPassRate: number;
    allRulesPassRate: number;
    semanticTop1: number;
    semanticTop3: number;
    semanticAny: number;
    sampleFailureCategories: Record<string, number>;
    candidateFailureCategories: Record<string, number>;
    crossVersion: ReturnType<typeof evaluateCrossVersion>;
    tokens: TokenTotals & { promptTokensEstimated: boolean };
    elapsedSeconds: number;
  };
  failures: unknown[];
  evidence: {
    json: string;
    jsonl: string;
    manualBatch: string;
    manualAnswerKey: string;
  };
}): string {
  const lines = [
    "# GKD LLM 规则生成基线",
    "",
    `生成时间：${report.generatedAt}`,
    `状态：${report.status}`,
    ...(report.reason ? [`说明：${report.reason}`] : []),
    "",
    "## 配置",
    "",
    `- 数据集：${report.dataset.root} / ${report.dataset.split}.jsonl`,
    `- 采样：${report.dataset.sampleMode}（可选 ${report.dataset.eligibleSamples} 条）`,
    `- 样本上限：${report.dataset.limit || "全量"}`,
    `- 全树：${report.dataset.fullTree ? "是" : "否"}`,
    `- 截图：${report.dataset.includeImage ? "是" : "否"}`,
    `- 模型：${report.model.model}`,
    `- 服务：${report.model.baseURLHost}`,
    `- temperature：${report.model.temperature}`,
    "",
    "## Prompt 预算",
    "",
    "| 指标 | 平均 | P50 | P95 | 最大 |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| prompt 字符 | ${report.prompt.promptChars.avg} | ${report.prompt.promptChars.p50} | ${report.prompt.promptChars.p95} | ${report.prompt.promptChars.max} |`,
    `| 请求体字符 | ${report.prompt.bodyChars.avg} | ${report.prompt.bodyChars.p50} | ${report.prompt.bodyChars.p95} | ${report.prompt.bodyChars.max} |`,
    `| 估算输入 token（字符/4） | ${report.prompt.estimatedTokens.avg} | ${report.prompt.estimatedTokens.p50} | ${report.prompt.estimatedTokens.p95} | ${report.prompt.estimatedTokens.max} |`,
    "",
    "## 单快照指标",
    "",
    `- JSON 解析成功率：${report.summary.jsonParseSuccessRate}%（${report.summary.parsed}/${report.summary.liveAttempts}）`,
    `- 本地验证通过率：${report.summary.localValidationPassRate}%（分母为成功解析数）`,
    `- 全部规则同时通过率：${report.summary.allRulesPassRate}%`,
    `- 语义 Top-1：${report.summary.semanticTop1}%`,
    `- 语义 Top-3：${report.summary.semanticTop3}%`,
    `- 任一候选语义命中：${report.summary.semanticAny}%`,
    `- 官方答案效果 Top-1：${report.summary.standardTop1}%`,
    `- 官方答案效果 Top-3：${report.summary.standardTop3}%`,
    `- 任一候选达到官方答案效果：${report.summary.standardAny}%`,
    "",
    "## 失败分类",
    "",
    `- 有失败证据的样本：${report.summary.failedSamples}/${report.summary.evidenceSamples}`,
    "",
    "| 类别 | Top-1 样本数 | 候选数 |",
    "| --- | ---: | ---: |",
    ...failureCategoryRows(
      report.summary.sampleFailureCategories,
      report.summary.candidateFailureCategories,
    ),
    "",
    "## 跨版本",
    "",
    `- 已评估快照对：${report.summary.crossVersion.pairs}`,
    `- Top-1 稳定：${report.summary.crossVersion.top1StableRate}%`,
    `- Top-3 稳定：${report.summary.crossVersion.top3StableRate}%`,
    `- 任一候选稳定：${report.summary.crossVersion.anyCandidateStableRate}%`,
    "",
    "## Token 与耗时",
    "",
    `- prompt tokens：${report.summary.tokens.promptTokens}${report.summary.tokens.promptTokensEstimated ? "（字符/4 估算）" : ""}`,
    `- completion tokens：${report.summary.tokens.completionTokens}${report.summary.tokens.promptTokensEstimated ? "（字符/4 估算）" : ""}`,
    `- total tokens：${report.summary.tokens.totalTokens}`,
    `- 总耗时：${report.summary.elapsedSeconds} 秒`,
    "",
    "## 失败样本",
    "",
    `报告内保留 ${report.failures.length} 条失败摘要；逐样本材料、模型原文、selector 和命中节点见：`,
    "",
    `- \`${report.evidence.json}\``,
    `- \`${report.evidence.jsonl}\``,
    "",
    "## 网页版取证材料",
    "",
    `- 直接复制给 Gemini 的题目：\`${report.evidence.manualBatch}\``,
    `- 对照答案，不要和题目一起粘贴：\`${report.evidence.manualAnswerKey}\``,
    "",
    "## 复现",
    "",
    "运行目录：仓库根目录。Shell：PowerShell。",
    "",
    "```powershell",
    "$env:GKD_LLM_BASE_URL='https://api.openai.com/v1'",
    "$env:GKD_LLM_MODEL='gpt-4.1-mini'",
    "$env:GKD_LLM_API_KEY='<仅在本机进程设置>'",
    "$env:GKD_LLM_LIMIT=30",
    "npm run bench:llm",
    "```",
    "",
    "只做 prompt 预算、不调用模型：",
    "",
    "```powershell",
    "$env:GKD_LLM_PROMPT_ONLY=1; npm run bench:llm",
    "```",
    "",
  ];
  return lines.join("\n");
}
