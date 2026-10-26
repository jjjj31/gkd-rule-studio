import type {
  AiCandidateFeedback,
} from "../lib/aiModel";
import {
  classifyAuthoringFeedback,
  formatAuthoringFeedbackEvidence,
  LABELS,
  toLegacyFeedbackResult,
  type AuthoringFeedbackCategory,
} from "../lib/authoringFeedback";

export type FailureFeedbackChoice = AuthoringFeedbackCategory;

export interface FailureFeedbackDraft {
  result: FailureFeedbackChoice;
  note: string;
  snapshotId?: number | string;
  appId?: string;
  staticValidation?: "unsatisfied" | "partial" | "satisfied" | "unknown";
  diagnostics?: string[];
  knownLimitations?: string[];
}

export interface FailureFeedbackPanelProps {
  feedback: FailureFeedbackDraft;
  onFeedbackChange?: (feedback: FailureFeedbackDraft) => void;
  onCopyPrompt?: (() => void) | null;
  onSendFeedback?: (() => void) | null;
  copyState?: "idle" | "copied" | "failed";
  sendState?: "idle" | "sending" | "failed";
}

const CHOICES: Array<{ value: FailureFeedbackChoice; label: string }> =
  Object.entries(LABELS).map(([value, label]) => ({
    value: value as FailureFeedbackChoice,
    label,
  }));

export function failureFeedbackDescription(feedback: FailureFeedbackDraft) {
  return classifyAuthoringFeedback(feedback);
}

export function failureFeedbackResultValue(
  value: string,
): FailureFeedbackChoice {
  return CHOICES.some((choice) => choice.value === value)
    ? value as FailureFeedbackChoice
    : "other";
}

export function toCandidateFeedback(
  candidate: AiCandidateFeedback["candidate"],
  draft: FailureFeedbackDraft,
): AiCandidateFeedback {
  return {
    candidate,
    result: toLegacyFeedbackResult(draft.result),
    category: draft.result,
    note: draft.note,
    snapshotId: draft.snapshotId,
    appId: draft.appId,
    staticValidation: draft.staticValidation,
    diagnostics: draft.diagnostics,
    knownLimitations: draft.knownLimitations,
  };
}

export function FailureFeedbackPanel({
  feedback,
  onFeedbackChange,
  onCopyPrompt,
  onSendFeedback,
  copyState = "idle",
  sendState = "idle",
}: FailureFeedbackPanelProps) {
  const description = failureFeedbackDescription(feedback);
  const disabled = !onFeedbackChange;
  const change = (patch: Partial<FailureFeedbackDraft>) => {
    onFeedbackChange?.({ ...feedback, ...patch });
  };

  return (
    <section className="rule-authoring-panel" aria-label="失败反馈">
      <strong>失败反馈</strong>
      <label>
        用户观察
        <select
          value={feedback.result}
          disabled={disabled}
          onChange={(event) => change({
            result: failureFeedbackResultValue(event.target.value),
          })}
        >
          {CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <p>{description.repairHint}</p>
      <small>
        依据：{formatAuthoringFeedbackEvidence(description.evidence)}
      </small>
      <label>
        补充说明
        <textarea
          value={feedback.note}
          disabled={disabled}
          onChange={(event) => change({ note: event.target.value })}
        />
      </label>
      {feedback.snapshotId !== undefined && (
        <small>快照：{feedback.snapshotId}</small>
      )}
      {feedback.appId && <small>应用：{feedback.appId}</small>}
      {feedback.knownLimitations?.length ? (
        <details>
          <summary>已知限制</summary>
          <ul>{feedback.knownLimitations.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
      ) : null}
      <div className="rule-authoring-actions">
        <button type="button" disabled={!onCopyPrompt} onClick={onCopyPrompt ?? undefined}>
          {copyState === "copied" ? "已复制 prompt" : copyState === "failed" ? "复制失败，重试" : "复制反馈 prompt"}
        </button>
        <button type="button" disabled={!onSendFeedback || sendState === "sending"} onClick={onSendFeedback ?? undefined}>
          {sendState === "sending" ? "发送中" : sendState === "failed" ? "发送失败，重试" : "发送给 AI"}
        </button>
      </div>
      <small>快照验证和用户反馈不等同于设备测试有效。</small>
    </section>
  );
}
