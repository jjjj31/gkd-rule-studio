import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { AppRuleDraft, SelectorValidation } from "../types/ruleDraft";
import { describeRulePreview } from "../lib/authoringPreview";
import "./RuleAuthoring.css";

export function RulePreviewPanel({ app, snapshot, validation }: {
  app: AppRuleDraft;
  snapshot: ParsedGkdSnapshot;
  validation: SelectorValidation;
}) {
  const preview = describeRulePreview(app, snapshot, validation);
  return <section className="rule-authoring-panel" aria-label="规则验证">
    <strong>{preview.status}</strong>
    <small>{preview.snapshotLabel}</small>
    <small>{preview.targetLabel}</small>
    {preview.summaries.map((summary, index) => <p key={index}>{summary}</p>)}
    {preview.diagnostics.map((reason) => <small key={reason}>{reason}</small>)}
    <small>快照验证不代表设备测试有效；发送测试后需在目标应用确认结果。</small>
    {preview.unknowns.length > 0 && <details>
      <summary>运行条件待确认</summary>
      <ul>{preview.unknowns.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    </details>}
    <details><summary>已有本地规则检查</summary>
      <small>当前支持的 GKD 接口未提供本地规则读取，无法检查已有覆盖；可继续测试、复制或导入。</small>
    </details>
  </section>;
}
