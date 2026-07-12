/** 桌面版测试订阅面板：显示已加入测试的规则集合、导入状态、历史记录。安卓版同功能集成在测试管理全屏页。 */
import { Play, Plus, Trash2, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { createDeviceApiClient } from "../lib/deviceApi";
import {
  isDebugTarget,
  targetPackageLabel,
  type GkdTargetPackage,
} from "../lib/gkdTarget";
import {
  addAppDraftToTestSubscription,
  clearImportedRules,
  createEmptyTestSubscription,
  exportRawSubscription,
  importJson5ToTestSubscription,
  markTestSubscriptionImported,
  markImportedAndClearBuffer,
  removeImportedRule,
  summarizeTestSubscription,
  type AppIdentity,
  type TestSubscriptionDraft,
} from "../lib/testSubscription";
import type { AppRuleDraft } from "../types/ruleDraft";

interface TestSubscriptionPanelProps {
  draft: TestSubscriptionDraft;
  currentApp?: AppIdentity | null;
  targetPackage: GkdTargetPackage;
  onChange: (draft: TestSubscriptionDraft) => void;
}

export function TestSubscriptionPanel({
  draft,
  currentApp,
  targetPackage,
  onChange,
}: TestSubscriptionPanelProps) {
  const [aiJson5, setAiJson5] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [savingLocal, setSavingLocal] = useState(false);
  const summary = useMemo(() => summarizeTestSubscription(draft), [draft]);
  const activeSummary = draft.lastImportedSummary;
  const importedRules = draft.importedRules ?? [];

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
      onChange(markTestSubscriptionImported(draft));
      setMessage(
        `已导入到 ${targetPackageLabel(
          targetPackage,
        )} 内存订阅：${summary.ruleCount} 条规则。测试区缓冲已保留。`,
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "导入到 GKD 失败");
    } finally {
      setImporting(false);
    }
  }

  async function saveToLocalRulesBeta(): Promise<void> {
    if (!isDebugTarget(targetPackage)) {
      setMessage("正式版 GKD 不支持本地规则 Beta API，请切换到 Debug/Beta 目标。");
      return;
    }

    if (summary.ruleCount === 0) {
      setMessage("测试区没有规则。");
      return;
    }

    const origin = localStorage.getItem("gkd-rule-builder-device-url") ?? "";
    if (!origin.trim()) {
      setMessage("请先在首页连接 GKD HTTP 服务。");
      return;
    }

    setSavingLocal(true);
    try {
      const client = await createDeviceApiClient(origin);
      const results = [];
      for (const app of draft.apps) {
        results.push(await client.appendLocalRules(app));
      }
      onChange(markImportedAndClearBuffer(draft));
      const addedRules = results.reduce((sum, item) => sum + item.addedRules, 0);
      const skipped = results.reduce((sum, item) => sum + item.skippedDuplicates, 0);
      setMessage(
        `已保存到 GKD 本地规则 Beta：新增 ${addedRules} 条，跳过重复 ${skipped} 条，测试区缓冲已清空。`,
      );
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? `${cause.message}。当前 GKD 可能还不支持本地规则 Beta API。`
          : "保存到 GKD 本地规则失败",
      );
    } finally {
      setSavingLocal(false);
    }
  }

  return (
    <CollapsiblePanel
      actions={
        <div className="preview-actions">
          <button
            className="copy-button"
            disabled={summary.ruleCount === 0 || importing || savingLocal}
            type="button"
            onClick={() => void importToGkd()}
          >
            {importing ? <Upload size={15} /> : <Play size={15} />}
            <span>{importing ? "导入中" : "导入到 GKD 测试"}</span>
          </button>
          <button
            className="copy-button"
            disabled={
              summary.ruleCount === 0 ||
              importing ||
              savingLocal ||
              !isDebugTarget(targetPackage)
            }
            type="button"
            onClick={() => void saveToLocalRulesBeta()}
          >
            <Upload size={15} />
            <span>
              {savingLocal
                ? "保存中"
                : isDebugTarget(targetPackage)
                  ? "保存到本地 Beta"
                  : "仅 Debug 可保存"}
            </span>
          </button>
          <button
            className="copy-button"
            disabled={summary.ruleCount === 0 || importing || savingLocal}
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
        当前目标：{targetPackageLabel(targetPackage)}。测试导入只覆盖内存订阅；本地保存只支持 Debug/Beta。
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
      {importedRules.length > 0 && (
        <section className="test-zone-imported">
          <div className="test-zone-section-title">
            <strong>已导入区</strong>
            <button
              className="text-link-button"
              type="button"
              onClick={() => {
                onChange(clearImportedRules(draft));
                setMessage("已导入区记录已清空。");
              }}
            >
              清空记录
            </button>
          </div>
          <div className="test-zone-list compact">
            {importedRules.map((rule) => (
              <div key={rule.id} className="test-zone-item">
                <div className="test-zone-item-head">
                  <strong>
                    {rule.appName} / {rule.groupName} / {rule.ruleName}
                  </strong>
                  <button
                    className="text-link-button danger"
                    type="button"
                    onClick={() => {
                      onChange(removeImportedRule(draft, rule.id));
                      setMessage("已移除一条导入记录。");
                    }}
                  >
                    删除
                  </button>
                </div>
                {rule.activityIds && (
                  <span>activityIds: {formatActivityIds(rule.activityIds)}</span>
                )}
                <span>导入时间: {formatImportedAt(rule.importedAt)}</span>
                <code>{rule.matches.join(" && ")}</code>
              </div>
            ))}
          </div>
        </section>
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

function formatImportedAt(value: number): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
