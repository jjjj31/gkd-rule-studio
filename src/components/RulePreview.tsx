/** 桌面版规则预览：显示选中候选的 JSON5 格式。 */
import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { SelectorCandidate } from "../types/ruleDraft";
import {
  createAppRuleDraft,
  selectFallbackCandidates,
  stringifyRuleDraft,
} from "../lib/ruleDraft";
import { CollapsiblePanel } from "./CollapsiblePanel";

interface RulePreviewProps {
  snapshot: ParsedGkdSnapshot | null;
  candidate: SelectorCandidate | null;
  candidates?: SelectorCandidate[];
  onAddToTestZone?: (draft: ReturnType<typeof createAppRuleDraft>) => void;
}

export function RulePreview({
  snapshot,
  candidate,
  candidates = [],
  onAddToTestZone,
}: RulePreviewProps) {
  const [copied, setCopied] = useState(false);
  const fallbackCandidates = candidate
    ? selectFallbackCandidates(candidate, candidates)
    : [];
  const draft =
    snapshot && candidate
      ? createAppRuleDraft(snapshot, candidate, fallbackCandidates)
      : null;
  const preview = draft ? stringifyRuleDraft(draft) : "";
  const draftPrimarySelector = formatMatches(
    draft?.groups[0]?.rules[0]?.matches ?? [],
  );
  const selectedSelector = candidate?.rule.matches.join(" && ") ?? "";
  const promotedDraft =
    Boolean(draftPrimarySelector) &&
    Boolean(selectedSelector) &&
    draftPrimarySelector !== selectedSelector;
  const actualFallbackCount = Math.max(
    0,
    (draft?.groups[0]?.rules.length ?? 0) - 1,
  );

  async function copyPreview(): Promise<void> {
    if (!preview) return;
    await navigator.clipboard.writeText(preview);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  }

  function exportPreview(): void {
    if (!preview || !snapshot) return;

    const blob = new Blob([preview], {
      type: "application/json5;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const fileStem = snapshot.appId.replace(/[^\w.-]+/g, "_") || "gkd-rule";

    link.href = url;
    link.download = `${fileStem}.json5`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <CollapsiblePanel
      actions={
        candidate && (
          <div className="preview-actions">
            <button className="copy-button" type="button" onClick={copyPreview}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
            <button className="copy-button" type="button" onClick={exportPreview}>
              <Download size={15} />
              <span>导出</span>
            </button>
            {draft && onAddToTestZone && (
              <button
                className="copy-button"
                type="button"
                onClick={() => onAddToTestZone(draft)}
              >
                <Check size={15} />
                <span>加入测试区</span>
              </button>
            )}
          </div>
        )
      }
      className="preview-panel"
      title="JSON5 草稿"
    >
      {candidate ? (
        <>
          <p className="preview-note">
            {promotedDraft
              ? "草稿已提升为更可靠的 WebView 动作规则。"
              : candidate.risk.level === "low"
              ? "这个候选可以作为首选草稿。"
              : "这个候选需要人工确认后再写入订阅。"}
          </p>
          <p className="score-note">
            评分 = min(100, 基础分和加分 {candidate.risk.positiveScore})
            {candidate.risk.penaltyScore < 0
              ? ` ${candidate.risk.penaltyScore}`
              : ""}{" "}
            = {candidate.risk.finalScore}
            {candidate.actionPlan.rankAdjustment !== 0
              ? `；执行策略排序 ${candidate.actionPlan.rankAdjustment > 0 ? "+" : ""}${candidate.actionPlan.rankAdjustment}`
              : ""}
            {actualFallbackCount > 0
              ? `；已加入 ${actualFallbackCount} 条 fallback`
              : ""}
          </p>
          <p className="score-note">
            执行策略：{formatActionPlan(candidate)}
          </p>
          <div className="risk-list">
            {candidate.risk.items
              .filter((item) => item.label !== "基础策略")
              .map((item) => (
              <span
                key={`${item.label}-${item.reason}`}
                className={item.value >= 0 ? "risk-plus" : "risk-minus"}
                title={`${item.label} ${item.value > 0 ? `+${item.value}` : item.value}`}
              >
                {item.reason}
              </span>
            ))}
            {candidate.riskNotes.map((note) => (
              <span key={note} className="risk-minus">
                {note}
              </span>
            ))}
          </div>
          <div className="risk-list">
            {candidate.debugAdvice.map((advice) => (
              <span key={advice} className="risk-plus">
                {advice}
              </span>
            ))}
          </div>
          <pre className="code-preview">
            <code>{preview}</code>
          </pre>
        </>
      ) : (
        <p className="muted">选择候选后显示</p>
      )}
    </CollapsiblePanel>
  );
}

function formatMatches(matches: string[]): string {
  return matches.join(" && ");
}

function formatActionPlan(candidate: SelectorCandidate): string {
  const plan = candidate.actionPlan;
  const parts = [
    plan.activityIds ? `activityIds=${plan.activityIds}` : "",
    plan.action ? `action=${plan.action}` : "",
    plan.actionDelay ? `actionDelay=${plan.actionDelay}` : "",
    plan.actionMaximum ? `actionMaximum=${plan.actionMaximum}` : "",
    plan.actionCd ? `actionCd=${plan.actionCd}` : "",
    plan.forcedTime ? `forcedTime=${plan.forcedTime}` : "",
    plan.matchRoot ? "matchRoot=true" : "",
    plan.resetMatch ? `resetMatch=${plan.resetMatch}` : "",
  ].filter(Boolean);

  return parts.length ? parts.join("，") : "默认点击";
}
