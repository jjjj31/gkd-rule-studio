import {
  ClipboardCopy,
  Info,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import {
  buildCustomScenarioPrompt,
  loadCustomScenarios,
  parseCustomScenario,
  resolveCustomScenarioSettings,
  saveCustomScenarios,
  type CustomScenario,
} from "../lib/customScenario";
import { CollapsiblePanel } from "./CollapsiblePanel";
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { RuleSettings } from "../types/ruleDraft";

interface CustomScenarioPanelProps {
  snapshot: ParsedGkdSnapshot | null;
  onApplySettings: (settings: RuleSettings) => void;
}

const SETTINGS_KEYS: Array<{ key: keyof RuleSettings; label: string }> = [
  { key: "groupName", label: "group" },
  { key: "activityIds", label: "activity" },
  { key: "matchTime", label: "matchTime" },
  { key: "actionMaximum", label: "max" },
  { key: "actionCd", label: "cd" },
  { key: "resetMatch", label: "reset" },
];

function formatSettingValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function ActivityIdsModeIndicator({
  mode,
  snapshot,
}: {
  mode: CustomScenario["activityIdsMode"];
  snapshot: ParsedGkdSnapshot | null;
}) {
  if (!mode || mode === "literal") return null;

  const label =
    mode === "current"
      ? `当前: ${snapshot?.activityId ?? "(未加载)"}`
      : "不限制";

  return (
    <span className="scenario-activity-mode">
      {mode === "current" ? "当前Activity" : "留空"}: {label}
    </span>
  );
}

export function CustomScenarioPanel({
  snapshot,
  onApplySettings,
}: CustomScenarioPanelProps) {
  const [scenarios, setScenarios] = useState<CustomScenario[]>(
    () => loadCustomScenarios(),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [importName, setImportName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const selectedScenario = scenarios.find((s) => s.id === selectedId) ?? null;

  const resolvedSettings = selectedScenario
    ? resolveCustomScenarioSettings(selectedScenario, snapshot)
    : null;

  const handleApply = useCallback(
    (scenario: CustomScenario) => {
      const resolved = resolveCustomScenarioSettings(scenario, snapshot);
      onApplySettings(resolved);
      setMessage(`已应用场景: ${scenario.name}`);
      window.setTimeout(() => setMessage(null), 2000);
    },
    [snapshot, onApplySettings],
  );

  const handleDelete = useCallback(
    (scenarioId: string) => {
      const next = scenarios.filter((s) => s.id !== scenarioId);
      setScenarios(next);
      saveCustomScenarios(next);
      if (selectedId === scenarioId) {
        setSelectedId(null);
      }
      setMessage("已删除场景");
      window.setTimeout(() => setMessage(null), 2000);
    },
    [scenarios, selectedId],
  );

  const handleImport = useCallback(() => {
    try {
      const scenario = parseCustomScenario(
        importText,
        snapshot,
        importName.trim(),
      );
      const next = [scenario, ...scenarios].slice(0, 20);
      setScenarios(next);
      saveCustomScenarios(next);
      setSelectedId(scenario.id);
      setImportText("");
      setImportName("");
      setShowImport(false);
      setMessage(`已导入场景: ${scenario.name}`);
      window.setTimeout(() => setMessage(null), 2000);
    } catch (cause) {
      setMessage(
        cause instanceof Error ? cause.message : "导入自定义场景失败",
      );
    }
  }, [importText, importName, snapshot, scenarios]);

  const handleCopyPrompt = useCallback(async () => {
    await navigator.clipboard.writeText(buildCustomScenarioPrompt(snapshot));
    setPromptCopied(true);
    window.setTimeout(() => setPromptCopied(false), 1300);
  }, [snapshot]);

  return (
    <CollapsiblePanel
      subtitle="管理 AI 生成的运行参数场景，快速切换不同策略"
      title="自定义场景"
      defaultCollapsed
    >
      <div className="custom-scenario-panel">
        {/* Scenario list */}
        {scenarios.length > 0 ? (
          <ul className="scenario-list">
            {scenarios.map((scenario) => (
              <li
                key={scenario.id}
                className={
                  selectedId === scenario.id
                    ? "scenario-item scenario-item-selected"
                    : "scenario-item"
                }
              >
                <button
                  className="scenario-item-main"
                  type="button"
                  onClick={() =>
                    setSelectedId(selectedId === scenario.id ? null : scenario.id)
                  }
                >
                  <span className="scenario-item-name">{scenario.name}</span>
                  <span className="scenario-item-desc">
                    {scenario.description}
                  </span>
                </button>
                <div className="scenario-item-actions">
                  <button
                    aria-label="应用此场景"
                    title="应用此场景"
                    type="button"
                    onClick={() => handleApply(scenario)}
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    aria-label="删除此场景"
                    title="删除此场景"
                    type="button"
                    onClick={() => handleDelete(scenario.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="scenario-empty">
            还没有保存的场景，使用下方按钮导入或生成。
          </p>
        )}

        {/* Selected scenario detail */}
        {selectedScenario && (
          <div className="scenario-detail">
            <div className="scenario-detail-header">
              <Info size={14} />
              <span>{selectedScenario.name}</span>
              <ActivityIdsModeIndicator
                mode={selectedScenario.activityIdsMode}
                snapshot={snapshot}
              />
            </div>
            <p className="scenario-detail-text">
              {selectedScenario.detail}
            </p>
            {resolvedSettings && (
              <div className="settings-summary-chips">
                {SETTINGS_KEYS.map(({ key, label }) => (
                  <span key={key}>
                    {label}: {formatSettingValue(resolvedSettings[key])}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="scenario-actions">
          <button type="button" onClick={handleCopyPrompt}>
            <Sparkles size={14} />
            {promptCopied ? "已复制 prompt" : "AI 生成 prompt"}
          </button>
          <button
            type="button"
            onClick={() => setShowImport((v) => !v)}
          >
            <ClipboardCopy size={14} />
            {showImport ? "收起导入" : "导入场景"}
          </button>
        </div>

        {/* Import section */}
        {showImport && (
          <div className="scenario-import-box">
            <input
              placeholder="场景名称（可留空使用 AI 返回的 name）"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
            />
            <textarea
              placeholder="粘贴 AI 返回的 JSON5 场景代码块"
              rows={5}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <button
              disabled={!importText.trim()}
              type="button"
              onClick={handleImport}
            >
              <Plus size={14} />
              导入为场景
            </button>
          </div>
        )}

        {/* Status message */}
        {message && (
          <small className="custom-scenario-message">{message}</small>
        )}
      </div>
    </CollapsiblePanel>
  );
}
