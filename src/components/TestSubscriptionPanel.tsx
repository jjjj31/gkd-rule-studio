import { Play, Plus, Trash2, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { createDeviceApiClient } from "../lib/deviceApi";
import {
  addAppDraftToTestSubscription,
  createEmptyTestSubscription,
  exportRawSubscription,
  importJson5ToTestSubscription,
  markImportedAndClearBuffer,
  summarizeTestSubscription,
  type AppIdentity,
  type TestSubscriptionDraft,
} from "../lib/testSubscription";
import type { AppRuleDraft } from "../types/ruleDraft";

interface TestSubscriptionPanelProps {
  draft: TestSubscriptionDraft;
  currentApp?: AppIdentity | null;
  onChange: (draft: TestSubscriptionDraft) => void;
}

export function TestSubscriptionPanel({
  draft,
  currentApp,
  onChange,
}: TestSubscriptionPanelProps) {
  const [aiJson5, setAiJson5] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const summary = useMemo(() => summarizeTestSubscription(draft), [draft]);
  const activeSummary = draft.lastImportedSummary;

  function importAiRule(): void {
    try {
      const next = importJson5ToTestSubscription(
        draft,
        aiJson5,
        currentApp ?? undefined,
      );
      onChange(next);
      setAiJson5("");
      setMessage("AI 返回规则已加入测试区。");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "导入 AI 规则失败");
    }
  }

  async function importToGkd(): Promise<void> {
    if (summary.ruleCount === 0) {
      setMessage("测试区没有规则。");
      return;
    }

    const origin = localStorage.getItem("gkd-rule-builder-device-url") ?? "";
    if (!origin.trim()) {
      setMessage("请先在首页连接 GKD HTTP 服务。");
      return;
    }

    setImporting(true);
    try {
      const client = await createDeviceApiClient(origin);
      await client.updateSubscription(exportRawSubscription(draft));
      onChange(markImportedAndClearBuffer(draft));
      setMessage(`已导入到 GKD 内存订阅：${summary.ruleCount} 条规则，测试区缓冲已清空。`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "导入到 GKD 失败");
    } finally {
      setImporting(false);
    }
  }

  return (
    <CollapsiblePanel
      actions={
        <div className="preview-actions">
          <button
            className="copy-button"
            disabled={summary.ruleCount === 0 || importing}
            type="button"
            onClick={() => void importToGkd()}
          >
            {importing ? <Upload size={15} /> : <Play size={15} />}
            <span>{importing ? "导入中" : "导入到 GKD 测试"}</span>
          </button>
          <button
            className="copy-button"
            disabled={summary.ruleCount === 0}
            type="button"
            onClick={() => {
              onChange(createEmptyTestSubscription());
              setMessage("测试区已清空。");
            }}
          >
            <Trash2 size={15} />
            <span>清空</span>
          </button>
        </div>
      }
      className="test-subscription-panel"
      title="测试区"
    >
      <p className="preview-note">
        测试区会作为完整内存订阅导入 GKD；每次导入都会覆盖 GKD 当前内存订阅，不会修改正式订阅。
      </p>
      {activeSummary && (
        <div className="test-zone-active-status">
          当前 GKD 内存订阅正在测试 {activeSummary.appCount} 个应用 /{" "}
          {activeSummary.groupCount} 个规则组 / {activeSummary.ruleCount} 条规则
        </div>
      )}
      <div className="test-zone-summary">
        <span>
          <small>应用</small>
          <strong>{summary.appCount}</strong>
        </span>
        <span>
          <small>规则组</small>
          <strong>{summary.groupCount}</strong>
        </span>
        <span>
          <small>规则</small>
          <strong>{summary.ruleCount}</strong>
        </span>
        <span>
          <small>状态</small>
          <strong>{draft.dirty ? "未导入" : draft.lastImportedAt ? "已导入" : "空"}</strong>
        </span>
      </div>
      {message && <p className="test-zone-message">{message}</p>}
      <textarea
        className="test-zone-textarea"
        placeholder="粘贴 AI 返回的 JSON5：完整订阅、应用规则或单个 group"
        value={aiJson5}
        onChange={(event) => setAiJson5(event.target.value)}
      />
      <button
        className="wide-button"
        disabled={!aiJson5.trim()}
        type="button"
        onClick={importAiRule}
      >
        <Plus size={15} />
        导入 AI 返回规则到测试区
      </button>
      {summary.ruleCount > 0 ? (
        <div className="test-zone-list">
          {draft.apps.map((app) =>
            app.groups.map((group) =>
              group.rules.map((rule) => (
                <div key={`${app.id}-${group.key}-${rule.key}`} className="test-zone-item">
                  <strong>
                    {app.name} / {group.name} / {rule.name ?? `规则 ${rule.key}`}
                  </strong>
                  {rule.activityIds && (
                    <span>activityIds: {formatActivityIds(rule.activityIds)}</span>
                  )}
                  <code>{rule.matches.join(" && ")}</code>
                </div>
              )),
            ),
          )}
        </div>
      ) : (
        <p className="muted">还没有测试规则。可从候选 selector 或 JSON5 草稿加入。</p>
      )}
    </CollapsiblePanel>
  );
}

export function addAppDraftToTestZone(
  draft: TestSubscriptionDraft,
  appDraft: AppRuleDraft,
): TestSubscriptionDraft {
  return addAppDraftToTestSubscription(draft, appDraft);
}

function formatActivityIds(value: string | string[]): string {
  return Array.isArray(value) ? value.join(", ") : value;
}
