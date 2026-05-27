import {
  Check,
  ClipboardCopy,
  Copy,
  Plus,
  Trash2,
} from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import {
  buildFlowHelpPrompt,
  createFlowAppRuleDraft,
  stringifyFlowRuleDraft,
} from "../lib/flowDraft";
import type { FlowRuleStep } from "../types/flowDraft";
import { CollapsiblePanel } from "./CollapsiblePanel";

interface FlowPanelProps {
  activeStepId: string | null;
  canAddCurrent: boolean;
  flowDesc: string;
  flowName: string;
  steps: FlowRuleStep[];
  onAddCurrentStep: () => void;
  onFlowDescChange: (value: string) => void;
  onFlowNameChange: (value: string) => void;
  onRemoveStep: (stepId: string) => void;
  onSelectStep: (stepId: string) => void;
  onUpdateStep: (stepId: string, patch: Partial<FlowRuleStep>) => void;
}

export function FlowPanel({
  activeStepId,
  canAddCurrent,
  flowDesc,
  flowName,
  steps,
  onAddCurrentStep,
  onFlowDescChange,
  onFlowNameChange,
  onRemoveStep,
  onSelectStep,
  onUpdateStep,
}: FlowPanelProps) {
  const [copied, setCopied] = useState<"draft" | "prompt" | null>(null);
  const draft = useMemo(
    () => createFlowAppRuleDraft({ flowName, flowDesc, steps }),
    [flowName, flowDesc, steps],
  );
  const preview = draft ? stringifyFlowRuleDraft(draft) : "";
  const prompt = useMemo(
    () => buildFlowHelpPrompt({ flowName, flowDesc, steps }),
    [flowName, flowDesc, steps],
  );
  const activeStep = steps.find((step) => step.id === activeStepId) ?? null;

  async function copyText(kind: "draft" | "prompt", value: string): Promise<void> {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1300);
  }

  return (
    <>
      <CollapsiblePanel
        actions={
          <button
            className="copy-button primary-button"
            disabled={!canAddCurrent}
            type="button"
            onClick={onAddCurrentStep}
          >
            <Plus size={15} />
            <span>加入步骤</span>
          </button>
        }
        className="flow-panel"
        title="流程步骤"
      >
        <div className="flow-form">
          <label>
            <span>规则组名称</span>
            <input
              value={flowName}
              onChange={(event) => onFlowNameChange(event.target.value)}
            />
          </label>
          <label>
            <span>规则描述</span>
            <input
              placeholder="例如：自动处理连续弹窗、领取红包后返回"
              value={flowDesc}
              onChange={(event) => onFlowDescChange(event.target.value)}
            />
          </label>
          {steps.length === 0 ? (
            <p className="muted">
              从首页多选快照创建流程，或把当前快照加入步骤后继续补充。
            </p>
          ) : (
            <div className="flow-step-list">
              {steps.map((step, index) => (
                <button
                  key={step.id}
                  className={[
                    "flow-step-item",
                    step.id === activeStepId ? "flow-step-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  type="button"
                  onClick={() => onSelectStep(step.id)}
                >
                  <span className="flow-step-heading">
                    <strong>{index + 1}</strong>
                    <span>{step.title || "未命名步骤"}</span>
                    {step.selectedCandidate ? (
                      <em>{step.selectedCandidate.risk.finalScore}</em>
                    ) : (
                      <em>待选</em>
                    )}
                  </span>
                  <span className="flow-step-meta">
                    {step.snapshot.activityId}
                  </span>
                  <code>
                    {step.selectedCandidate?.rule.matches.join(" && ") ??
                      "未选择 selector"}
                  </code>
                </button>
              ))}
            </div>
          )}

          {activeStep && (
            <div className="flow-step-editor">
              <div className="flow-step-toolbar">
                <span className="status-badge neutral">
                  正在编辑：{activeStep.title || "未命名步骤"}
                </span>
                <button
                  className="copy-button"
                  type="button"
                  onClick={() => onRemoveStep(activeStep.id)}
                >
                  <Trash2 size={14} />
                  <span>删除</span>
                </button>
              </div>
              <label>
                <span>步骤名称（生成 rule.name）</span>
                <input
                  placeholder="例如：点击别人发的红包"
                  value={activeStep.title}
                  onChange={(event) =>
                    onUpdateStep(activeStep.id, { title: event.target.value })
                  }
                />
              </label>
              <label>
                <span>备注：这一步要做什么</span>
                <textarea
                  value={activeStep.note}
                  onChange={(event) =>
                    onUpdateStep(activeStep.id, { note: event.target.value })
                  }
                />
              </label>
              <label>
                <span>依赖步骤（生成 preKeys）</span>
                <input
                  placeholder="留空=自动依赖前面所有步骤；也可填 1,2"
                  value={formatPreKeys(activeStep.preKeys)}
                  onChange={(event) =>
                    onUpdateStep(activeStep.id, {
                      preKeys: parsePreKeys(event.target.value),
                    })
                  }
                />
                <small>
                  第 2 步默认依赖第 1 步；第 3 步默认依赖第 1、2 步。只有需要跳过某些步骤时才手动填写。
                </small>
              </label>
              <label>
                <span>备注：点击后/下一步出现条件</span>
                <textarea
                  value={activeStep.delayNote}
                  onChange={(event) =>
                    onUpdateStep(activeStep.id, { delayNote: event.target.value })
                  }
                />
              </label>
            </div>
          )}
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        actions={
          <div className="preview-actions">
            <button
              className="copy-button"
              disabled={!preview}
              type="button"
              onClick={() => void copyText("draft", preview)}
            >
              {copied === "draft" ? <Check size={15} /> : <Copy size={15} />}
              <span>{copied === "draft" ? "已复制" : "复制规则"}</span>
            </button>
            <button
              className="copy-button"
              disabled={steps.length === 0}
              type="button"
              onClick={() => void copyText("prompt", prompt)}
            >
              {copied === "prompt" ? (
                <Check size={15} />
              ) : (
                <ClipboardCopy size={15} />
              )}
              <span>{copied === "prompt" ? "已复制" : "复制求助 prompt"}</span>
            </button>
          </div>
        }
        className="preview-panel"
        title="多步骤规则"
      >
        <p className="preview-note">
          可直接复制本地 JSON5，也可以复制求助 prompt，让 AI 根据多快照、步骤备注和候选 selector 生成完整规则。
        </p>
        {draft ? (
          <Fragment>
            <p className="score-note">
              已生成 {draft.groups.length} 个 group，{countRules(draft)} 条 rule。
            </p>
            <pre className="code-preview">
              <code>{preview}</code>
            </pre>
          </Fragment>
        ) : (
          <p className="muted">至少需要一个已选择 selector 的步骤。</p>
        )}
      </CollapsiblePanel>
    </>
  );
}

function countRules(
  draft: NonNullable<ReturnType<typeof createFlowAppRuleDraft>>,
): number {
  return draft.groups.reduce((sum, group) => sum + group.rules.length, 0);
}

function formatPreKeys(preKeys: number[] | undefined): string {
  return preKeys?.join(", ") ?? "";
}

function parsePreKeys(value: string): number[] | undefined {
  const keys = value
    .split(/[\s,，]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  return keys.length > 0 ? Array.from(new Set(keys)) : undefined;
}
