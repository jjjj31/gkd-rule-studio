import type { AiFeedbackResult } from "./aiModel";

export type AuthoringFeedbackCategory =
  | "not-triggered"
  | "triggered-no-close"
  | "mistouch"
  | "node-unavailable"
  | "static-unsatisfied"
  | "scope-or-timing-pending"
  | "other";

export type AuthoringFeedbackEvidence =
  | "user-observation"
  | "static-validation"
  | "unknown";

export interface AuthoringFeedbackInput {
  result: AuthoringFeedbackCategory | AiFeedbackResult | string;
  category?: AuthoringFeedbackCategory;
  note?: string;
  staticValidation?: "unsatisfied" | "partial" | "satisfied" | "unknown";
  diagnostics?: string[];
  limitations?: string[];
  knownLimitations?: string[];
  snapshotId?: number | string;
  appId?: string;
}

export interface AuthoringFeedbackDescription {
  category: AuthoringFeedbackCategory;
  legacyResult: Exclude<AiFeedbackResult, "success"> | "other";
  label: string;
  evidence: AuthoringFeedbackEvidence;
  confidence: "observed" | "unknown";
  reasons: string[];
  repairHint: string;
  note: string;
  snapshotId?: number | string;
  appId?: string;
  knownLimitations: string[];
}

const CATEGORIES = new Set<AuthoringFeedbackCategory>([
  "not-triggered",
  "triggered-no-close",
  "mistouch",
  "node-unavailable",
  "static-unsatisfied",
  "scope-or-timing-pending",
  "other",
]);

export const LABELS: Record<AuthoringFeedbackCategory, string> = {
  "not-triggered": "未触发（用户观察）",
  "triggered-no-close": "触发但未关闭（用户观察）",
  mistouch: "误触（用户观察）",
  "node-unavailable": "节点不可用",
  "static-unsatisfied": "静态条件不满足",
  "scope-or-timing-pending": "范围或时机待核对",
  other: "其他问题",
};

const REPAIR_HINTS: Record<AuthoringFeedbackCategory, string> = {
  "not-triggered": "重新测试并确认快照与当前页面一致。",
  "triggered-no-close": "检查动作和目标是否属于关闭控件。",
  mistouch: "缩窄 selector 并避开广告或跳转入口。",
  "node-unavailable": "重新抓取快照，并改用稳定的上下文。",
  "static-unsatisfied": "检查页面和 App 版本条件是否适用。",
  "scope-or-timing-pending": "核对 Activity、匹配窗口和冷却状态。",
  other: "补充症状、页面变化和是否误触。",
};

const LEGACY_RESULTS = new Set<AuthoringFeedbackCategory>([
  "not-triggered",
  "triggered-no-close",
  "mistouch",
  "other",
]);

export function normalizeAuthoringFeedbackResult(
  value: string,
): AuthoringFeedbackCategory {
  return CATEGORIES.has(value as AuthoringFeedbackCategory)
    ? (value as AuthoringFeedbackCategory)
    : "other";
}

export function toLegacyFeedbackResult(
  result: AuthoringFeedbackCategory,
): Exclude<AiFeedbackResult, "success"> {
  return LEGACY_RESULTS.has(result)
    ? result as Exclude<AiFeedbackResult, "success">
    : "other";
}

export function classifyAuthoringFeedback(
  input: AuthoringFeedbackInput,
): AuthoringFeedbackDescription {
  const category = normalizeAuthoringFeedbackResult(input.category ?? input.result);
  const knownLimitations = unique([
    ...(input.knownLimitations ?? []),
    ...(input.limitations ?? []),
  ]);
  const reasons = unique([...(input.diagnostics ?? []), ...knownLimitations]);
  let evidence: AuthoringFeedbackEvidence = "user-observation";
  let confidence: "observed" | "unknown" = "observed";

  if (category === "static-unsatisfied" && input.staticValidation === "unsatisfied") {
    evidence = "static-validation";
  } else if (category === "static-unsatisfied" || category === "scope-or-timing-pending") {
    evidence = "unknown";
    confidence = "unknown";
  } else if (category === "not-triggered") {
    confidence = "unknown";
  }

  return {
    category,
    legacyResult: toLegacyFeedbackResult(category),
    label: LABELS[category],
    evidence,
    confidence,
    reasons,
    repairHint: REPAIR_HINTS[category],
    note: input.note?.trim() ?? "",
    snapshotId: input.snapshotId,
    appId: input.appId,
    knownLimitations,
  };
}

export function formatAuthoringFeedbackEvidence(
  evidence: AuthoringFeedbackEvidence,
): "用户反馈" | "快照验证" | "待核对" {
  return evidence === "user-observation"
    ? "用户反馈"
    : evidence === "static-validation"
      ? "快照验证"
      : "待核对";
}

export function formatAuthoringFeedbackPrompt(feedback: {
  description: AuthoringFeedbackDescription;
  staticValidation?: "unsatisfied" | "partial" | "satisfied" | "unknown";
}): string {
  const data = {
    result: feedback.description.category,
    label: feedback.description.label,
    evidence: feedback.description.evidence,
    confidence: feedback.description.confidence,
    userNote: feedback.description.note || null,
    snapshotId: feedback.description.snapshotId ?? null,
    appId: feedback.description.appId ?? null,
    staticValidation: feedback.staticValidation ?? null,
    reasons: feedback.description.reasons,
    knownLimitations: feedback.description.knownLimitations,
    repairHint: feedback.description.repairHint,
  };
  return [
    "testing feedback (structured):",
    JSON.stringify(data, null, 2),
    "user 备注只代表用户观察，不是已确认的根因。",
    "证据规则：user-observation 和「用户观察」只记录用户看到的现象；静态验证结果单独列出。没有设备运行日志时不要断言根因。",
    "AI revision contract: 不要因为规则内容不同就宣布修正版有效；修正版必须重新验证和测试。",
  ].join("\n");
}

function unique(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}
