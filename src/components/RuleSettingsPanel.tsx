/** 桌面版规则设置面板：activityIds、matchTime、action 参数等。安卓版同功能集成在 AndroidScenePanel。 */
import { ClipboardCopy, Plus, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_RULE_SETTINGS,
  RULE_SETTINGS_PRESETS,
} from "../data/ruleSettings";
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

interface RuleSettingsPanelProps {
  snapshot: ParsedGkdSnapshot | null;
  value: RuleSettings;
  onChange: (value: RuleSettings) => void;
}

export function RuleSettingsPanel({
  snapshot,
  value,
  onChange,
}: RuleSettingsPanelProps) {
  const [presetId, setPresetId] = useState("splash");
  const [openHelpId, setOpenHelpId] = useState<string | null>(null);
  const [memoryByPreset, setMemoryByPreset] = useState<Record<string, RuleSettings>>({
    splash: DEFAULT_RULE_SETTINGS,
  });
  const [customScenarios, setCustomScenarios] = useState<CustomScenario[]>(
    () => loadCustomScenarios(),
  );
  const [customScenarioName, setCustomScenarioName] = useState("");
  const [customScenarioText, setCustomScenarioText] = useState("");
  const [customScenarioMessage, setCustomScenarioMessage] = useState<string | null>(
    null,
  );
  const [promptCopied, setPromptCopied] = useState(false);
  const [paramsEditorOpen, setParamsEditorOpen] = useState(false);
  const previousActivityRef = useRef(snapshot?.activityId ?? "");

  const activePreset = RULE_SETTINGS_PRESETS.find(
    (preset) => preset.id === presetId,
  );
  const activeCustomScenario = customScenarios.find(
    (scenario) => scenario.id === presetId,
  );
  const customMode = presetId === "";
  const activeDescription =
    activePreset?.description ?? activeCustomScenario?.description ?? "";
  const activeDetail = activePreset?.detail ?? activeCustomScenario?.detail ?? "";

  useEffect(() => {
    const previousActivity = previousActivityRef.current;
    const nextActivity = snapshot?.activityId ?? "";
    if (!nextActivity || previousActivity === nextActivity) return;

    previousActivityRef.current = nextActivity;
    if (previousActivity) {
      setMemoryByPreset((current) => {
        return Object.fromEntries(
          Object.entries(current).map(([key, settings]) => [
            key,
            settings.activityIds.trim() === previousActivity
              ? { ...settings, activityIds: nextActivity }
              : settings,
          ]),
        );
      });
    }

    if (previousActivity && value.activityIds.trim() === previousActivity) {
      onChange({ ...value, activityIds: nextActivity });
    }
  }, [snapshot?.activityId, onChange, value]);

  function patch(next: Partial<RuleSettings>): void {
    const nextValue = { ...value, ...next };
    onChange(nextValue);
    if (presetId) {
      setMemoryByPreset((current) => ({
        ...current,
        [presetId]: nextValue,
      }));
    }
  }

  function selectPreset(nextPresetId: string): void {
    setPresetId(nextPresetId);
    setOpenHelpId(null);
    if (!nextPresetId) return;

    const preset = RULE_SETTINGS_PRESETS.find((item) => item.id === nextPresetId);
    const customScenario = customScenarios.find((item) => item.id === nextPresetId);
    const nextDefault =
      preset?.build(snapshot) ??
      (customScenario
        ? resolveCustomScenarioSettings(customScenario, snapshot)
        : undefined);
    if (!nextDefault) return;

    const nextValue = memoryByPreset[nextPresetId] ?? nextDefault;
    onChange(nextValue);
    setMemoryByPreset((current) => ({
      ...current,
      [nextPresetId]: nextValue,
    }));
  }

  function resetActivePreset(): void {
    const preset = RULE_SETTINGS_PRESETS.find((item) => item.id === presetId);
    const customScenario = customScenarios.find((item) => item.id === presetId);
    const nextValue =
      preset?.build(snapshot) ??
      (customScenario
        ? resolveCustomScenarioSettings(customScenario, snapshot)
        : undefined) ??
      DEFAULT_RULE_SETTINGS;
    onChange(nextValue);
    if (presetId) {
      setMemoryByPreset((current) => ({
        ...current,
        [presetId]: nextValue,
      }));
    }
  }

  async function copyCustomScenarioPrompt(): Promise<void> {
    await navigator.clipboard.writeText(buildCustomScenarioPrompt(snapshot));
    setPromptCopied(true);
    window.setTimeout(() => setPromptCopied(false), 1300);
  }

  function importCustomScenario(): void {
    try {
      const scenario = parseCustomScenario(
        customScenarioText,
        snapshot,
        customScenarioName.trim(),
      );
      const nextScenarios = [scenario, ...customScenarios].slice(0, 20);
      setCustomScenarios(nextScenarios);
      saveCustomScenarios(nextScenarios);
      setPresetId(scenario.id);
      setOpenHelpId(null);
      setMemoryByPreset((current) => ({
        ...current,
        [scenario.id]: resolveCustomScenarioSettings(scenario, snapshot),
      }));
      onChange(resolveCustomScenarioSettings(scenario, snapshot));
      setCustomScenarioName("");
      setCustomScenarioText("");
      setCustomScenarioMessage(`已导入场景：${scenario.name}`);
    } catch (cause) {
      setCustomScenarioMessage(
        cause instanceof Error ? cause.message : "导入自定义场景失败",
      );
    }
  }

  return (
    <CollapsiblePanel subtitle="默认使用场景推荐值，必要时再编辑细节" title="运行参数">
      <div className="settings-compact">
        <label>
          <span>推荐场景</span>
          <div className="preset-row">
            <select
              value={presetId}
              onChange={(event) => selectPreset(event.target.value)}
            >
              <option value="">自定义</option>
              {RULE_SETTINGS_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.shortLabel}
                </option>
              ))}
              {customScenarios.length > 0 && (
                <optgroup label="AI 自定义">
                  {customScenarios.map((scenario) => (
                    <option key={scenario.id} value={scenario.id}>
                      {scenario.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              aria-label="查看场景说明"
              className="icon-help"
              disabled={!activePreset && !activeCustomScenario}
              type="button"
              onClick={() => {
                setOpenHelpId(openHelpId === presetId ? null : presetId);
              }}
            >
              ?
            </button>
            <button type="button" onClick={() => setParamsEditorOpen(true)}>
              <SlidersHorizontal size={14} />
              编辑
            </button>
          </div>
          {activeDescription && <small>{activeDescription}</small>}
          {activeDetail && openHelpId === presetId && (
            <div className="preset-help">{activeDetail}</div>
          )}
        </label>
        <div className="settings-summary-chips">
          <span>group: {value.groupName || "-"}</span>
          <span>activity: {value.activityIds || "留空"}</span>
          <span>matchTime: {value.matchTime ?? "留空"}</span>
          <span>max: {value.actionMaximum ?? "留空"}</span>
          <span>cd: {value.actionCd ?? "留空"}</span>
          <span>reset: {value.resetMatch || "留空"}</span>
        </div>
      </div>

      {paramsEditorOpen && (
        <div
          aria-modal="true"
          className="settings-modal-backdrop"
          role="dialog"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setParamsEditorOpen(false);
          }}
        >
          <div className="settings-modal">
            <div className="settings-modal-header">
              <div>
                <h3>编辑运行参数</h3>
                <p>调整场景推荐值、Activity、执行窗口和冷却策略。</p>
              </div>
              <button
                aria-label="关闭参数编辑"
                className="icon-button"
                type="button"
                onClick={() => setParamsEditorOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="settings-grid">
        <label>
          <span>推荐场景</span>
          <div className="preset-row">
            <select
              value={presetId}
              onChange={(event) => selectPreset(event.target.value)}
            >
              <option value="">自定义</option>
              {RULE_SETTINGS_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.shortLabel}
                </option>
              ))}
              {customScenarios.length > 0 && (
                <optgroup label="AI 自定义">
                  {customScenarios.map((scenario) => (
                    <option key={scenario.id} value={scenario.id}>
                      {scenario.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button
              aria-label="查看场景说明"
              className="icon-help"
              disabled={!activePreset && !activeCustomScenario}
              type="button"
              onClick={() => {
                setOpenHelpId(openHelpId === presetId ? null : presetId);
              }}
            >
              ?
            </button>
            <button type="button" onClick={resetActivePreset}>
              恢复默认
            </button>
          </div>
          <small>
            切换场景会恢复该场景上次填写的数据；恢复默认会重新套用推荐值。
          </small>
          {activeDescription && <small>{activeDescription}</small>}
          {activeDetail && openHelpId === presetId && (
            <div className="preset-help">{activeDetail}</div>
          )}
        </label>

        {customMode && (
          <div className="custom-scenario-box">
            <div className="custom-scenario-actions">
              <button type="button" onClick={() => void copyCustomScenarioPrompt()}>
                <ClipboardCopy size={14} />
                {promptCopied ? "已复制 prompt" : "复制场景 prompt"}
              </button>
              <button
                disabled={!customScenarioText.trim()}
                type="button"
                onClick={importCustomScenario}
              >
                <Plus size={14} />
                导入为场景
              </button>
            </div>
            <input
              placeholder="场景名称，可留空使用 AI 返回的 name"
              value={customScenarioName}
              onChange={(event) => setCustomScenarioName(event.target.value)}
            />
            <textarea
              placeholder="把 AI 返回的 JSON5 场景代码块粘贴到这里"
              rows={6}
              value={customScenarioText}
              onChange={(event) => setCustomScenarioText(event.target.value)}
            />
            {customScenarioMessage && (
              <small className="custom-scenario-message">{customScenarioMessage}</small>
            )}
          </div>
        )}

        <label>
          <span>分组名</span>
          <input
            value={value.groupName}
            onChange={(event) => {
              patch({ groupName: event.target.value });
            }}
          />
          <small>写规则用途，例如开屏广告、局部广告、更新提示、权限提示。</small>
        </label>

        <label>
          <span>activityIds</span>
          <div className="input-row">
            <input
              value={value.activityIds}
              placeholder="留空表示不限制 Activity"
              onChange={(event) => {
                patch({ activityIds: event.target.value });
              }}
            />
            <button
              disabled={!snapshot}
              type="button"
              onClick={() => {
                if (snapshot) patch({ activityIds: snapshot.activityId });
              }}
            >
              当前
            </button>
            <button
              type="button"
              onClick={() => {
                patch({ activityIds: "" });
              }}
            >
              清空
            </button>
          </div>
          <small>
            除开屏广告外通常建议填写当前 Activity；开屏广告可留空，但要配合短
            matchTime 和 actionMaximum=1。
          </small>
        </label>

        <label>
          <span>matchTime</span>
          <div className="input-row">
            <input
              min={0}
              placeholder="留空"
              type="number"
              value={value.matchTime ?? ""}
              onChange={(event) => {
                patch({ matchTime: parseOptionalNumber(event.target.value) });
              }}
            />
            <button
              type="button"
              onClick={() => {
                patch({ matchTime: 10000 });
              }}
            >
              10s
            </button>
            <button
              type="button"
              onClick={() => {
                patch({ matchTime: 30000 });
              }}
            >
              30s
            </button>
          </div>
          <small>
            只在打开应用或进入页面后一小段时间出现时填写。开屏广告常用
            30000，普通弹窗常用 10000；常驻局部广告留空。
          </small>
        </label>

        <label>
          <span>actionMaximum</span>
          <div className="input-row">
            <input
              min={1}
              placeholder="留空"
              type="number"
              value={value.actionMaximum ?? ""}
              onChange={(event) => {
                patch({ actionMaximum: parseOptionalNumber(event.target.value) });
              }}
            />
            <button
              type="button"
              onClick={() => {
                patch({ actionMaximum: 1 });
              }}
            >
              1
            </button>
          </div>
          <small>
            一次性广告、更新、权限、评分弹窗一般填 1。页面内可能反复出现的广告位不要填。
          </small>
        </label>

        <label>
          <span>actionCd</span>
          <div className="input-row">
            <input
              min={0}
              placeholder="留空"
              type="number"
              value={value.actionCd ?? ""}
              onChange={(event) => {
                patch({ actionCd: parseOptionalNumber(event.target.value) });
              }}
            />
            <button
              type="button"
              onClick={() => {
                patch({ actionCd: 3000 });
              }}
            >
              3s
            </button>
            <button
              type="button"
              onClick={() => {
                patch({ actionCd: null });
              }}
            >
              清空
            </button>
          </div>
          <small>
            两次点击之间的冷却时间。视频播放中周期弹窗、局部广告建议填
            3000，避免节点刷新导致连续点击。
          </small>
        </label>

        <label>
          <span>resetMatch</span>
          <select
            value={value.resetMatch}
            onChange={(event) => {
              patch({
                resetMatch: event.target.value as RuleSettings["resetMatch"],
              });
            }}
          >
            <option value="">留空</option>
            <option value="app">app</option>
            <option value="activity">activity</option>
            <option value="match">match</option>
          </select>
          <small>
            app 表示每次重新进入应用后可再次触发，适合开屏/一次性弹窗；
            activity 跟随页面重置；match 适合目标消失后还会再出现的周期性广告。
          </small>
        </label>
            </div>
          </div>
        </div>
      )}
    </CollapsiblePanel>
  );
}

function parseOptionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
