import { AlertTriangle, CheckCircle2, CircleAlert } from "lucide-react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { getCandidateGuidance } from "../lib/candidateGuidance";
import type { SelectorCandidate } from "../types/ruleDraft";

interface CandidateListProps {
  candidates: SelectorCandidate[];
  selectedId: string | null;
  importedSelectorKeys?: Set<string>;
  onSelect: (candidate: SelectorCandidate) => void;
  onAddToTestZone?: (candidate: SelectorCandidate) => void;
}

export function CandidateList({
  candidates,
  selectedId,
  importedSelectorKeys,
  onSelect,
  onAddToTestZone,
}: CandidateListProps) {
  return (
    <CollapsiblePanel className="candidates-panel" title="候选 selector">
      {candidates.length === 0 ? (
        <p className="muted">暂无候选</p>
      ) : (
        <div className="candidate-list">
          {candidates.map((candidate, index) => {
            const guidance = getCandidateGuidance(candidate, index);
            const imported = importedSelectorKeys?.has(
              candidate.rule.matches.join("\n"),
            );

            return (
              <button
                key={candidate.id}
                className={`candidate-item ${
                  candidate.id === selectedId ? "candidate-active" : ""
                }`}
                type="button"
                onClick={() => onSelect(candidate)}
              >
                <span className={`candidate-guidance ${guidance.tone}`}>
                  <strong>{guidance.label}</strong>
                  <span>{guidance.reason}</span>
                </span>
                {imported && <span className="candidate-imported-badge">导入过</span>}
                <span className="candidate-heading">
                  <RiskIcon level={candidate.risk.level} />
                  <span>{humanStrategyTitle(candidate.strategyName)}</span>
                  <strong>{candidate.risk.finalScore}</strong>
                </span>
                {onAddToTestZone && (
                  <span className="candidate-inline-actions">
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(event) => {
                        event.stopPropagation();
                        onAddToTestZone(candidate);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        onAddToTestZone(candidate);
                      }}
                    >
                      添加到测试区
                    </span>
                  </span>
                )}
                {sameRegionLabel(candidate) && (
                  <span className="candidate-desc same-region-desc">
                    {sameRegionLabel(candidate)}
                  </span>
                )}
                <span className="candidate-desc">
                  {humanStrategyDesc(candidate.strategyName, candidate.validation.hitCount)}
                </span>
                <span className="candidate-desc">
                  {humanActionPlan(candidate)}
                </span>
                <span className="candidate-stability-grid">
                  <span>
                    <small>命中</small>
                    <strong>{candidate.validation.hitCount}</strong>
                  </span>
                  <span>
                    <small>加分</small>
                    <strong>{candidate.risk.cappedPositiveScore}</strong>
                  </span>
                  <span>
                    <small>扣分</small>
                    <strong>{candidate.risk.penaltyScore}</strong>
                  </span>
                </span>
                <span className="candidate-risk-list">
                  {candidate.risk.items
                    .filter((item) => item.label !== "基础策略")
                    .slice(0, 5)
                    .map((item) => (
                      <em
                        key={`${candidate.id}-${item.label}-${item.reason}`}
                        className={item.value >= 0 ? "risk-plus" : "risk-minus"}
                      >
                        {item.reason}
                      </em>
                    ))}
                  {candidate.riskNotes.slice(0, 3).map((note) => (
                    <em key={`${candidate.id}-${note}`} className="risk-minus">
                      {note}
                    </em>
                  ))}
                </span>
                <code>{candidate.rule.matches.join(" && ")}</code>
                <span className="candidate-meta">{candidate.debugReasons[0]}</span>
              </button>
            );
          })}
        </div>
      )}
    </CollapsiblePanel>
  );
}

function sameRegionLabel(candidate: SelectorCandidate): string | null {
  const reason = candidate.debugReasons.find((item) => item.startsWith("同框节点 #"));
  return reason ? `同框候选：${reason.replace("同框节点 ", "")}` : null;
}

function humanActionPlan(candidate: SelectorCandidate): string {
  const parts = [
    candidate.actionPlan.action ? `动作 ${candidate.actionPlan.action}` : "",
    candidate.actionPlan.actionDelay
      ? `延迟 ${candidate.actionPlan.actionDelay}ms`
      : "",
    candidate.actionPlan.actionMaximum
      ? `最多 ${candidate.actionPlan.actionMaximum} 次`
      : "",
    candidate.actionPlan.matchRoot ? "matchRoot" : "",
  ].filter(Boolean);

  return parts.length ? `执行策略：${parts.join(" / ")}` : "执行策略：使用默认点击";
}

function RiskIcon({ level }: { level: SelectorCandidate["risk"]["level"] }) {
  if (level === "low") return <CheckCircle2 size={17} />;
  if (level === "medium") return <CircleAlert size={17} />;
  return <AlertTriangle size={17} />;
}

function humanStrategyTitle(strategyName: SelectorCandidate["strategyName"]): string {
  const titles: Record<SelectorCandidate["strategyName"], string> = {
    stableResourceSemantic: "推荐：稳定资源 + 跳过语义",
    exactVid: "推荐：用控件 vid 定位",
    exactId: "推荐：用完整 id 定位",
    exactDesc: "用无障碍描述定位",
    typePlusExactAttr: "用控件类型收窄",
    exactTextWithContext: "用上下文保护短文本",
    textSkipGuarded: "开屏跳过按钮",
    clickParentDirectChildText: "点击可点父节点",
    clickParentByChildIdVid: "用子控件定位父点击",
    simpleSiblingCancelVsCTA: "用旁边按钮确认位置",
    simpleContextRelation: "用同层提示确认位置",
    adContainerSkipFallback: "广告容器内跳过兜底",
    clickableAncestorFallback: "可点击父区域兜底",
    visibleNodeFallback: "可见节点兜底",
  };
  return titles[strategyName];
}

function humanStrategyDesc(
  strategyName: SelectorCandidate["strategyName"],
  hitCount: number,
): string {
  const hitText = hitCount === 1 ? "当前快照唯一命中" : `当前快照命中 ${hitCount} 个`;
  const suffix: Record<SelectorCandidate["strategyName"], string> = {
    stableResourceSemantic: "最优先，避开倒计时文本",
    exactVid: "最优先，通常最稳",
    exactId: "适合原生控件",
    exactDesc: "适合关闭图标或无文字按钮",
    typePlusExactAttr: "比裸文本更稳",
    exactTextWithContext: "适合取消、暂不、关闭这类短词",
    textSkipGuarded: "限制尺寸、长度和可见性",
    clickParentDirectChildText: "文字不可点时使用",
    clickParentByChildIdVid: "图标在子层、热区在父层时使用",
    simpleSiblingCancelVsCTA: "避免点到升级、允许等正向按钮",
    simpleContextRelation: "适合简单弹窗结构",
    adContainerSkipFallback: "适合作为 WebView 广告兜底",
    clickableAncestorFallback: "目标无稳定属性时的低分兜底",
    visibleNodeFallback: "避免候选为空，需人工复核",
  };
  return `${hitText}，${suffix[strategyName]}`;
}
