import {
  Check,
  ChevronDown,
  Loader2,
  Plus,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useState } from "react";
import {
  createAiProfile,
  deleteAiProfile,
  getActiveAiProfile,
  maskApiKey,
  normalizeAiConfig,
  setActiveAiProfile,
  testAiConnection,
  upsertAiProfile,
  type AiModelConfig,
  type AiModelProfileStore,
} from "../lib/aiModel";
import { CollapsiblePanel } from "./CollapsiblePanel";

interface AiConfigPanelProps {
  config: AiModelConfig;
  profileStore: AiModelProfileStore;
  onConfigChange: (config: AiModelConfig) => void;
  onProfileStoreChange: (store: AiModelProfileStore) => void;
}

export function AiConfigPanel({
  config,
  profileStore,
  onConfigChange,
  onProfileStoreChange,
}: AiConfigPanelProps) {
  const [formExpanded, setFormExpanded] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [profileNameDraft, setProfileNameDraft] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "success" | "error">(
    "idle",
  );
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);

  const activeProfile = getActiveAiProfile(profileStore);

  function patchConfig(partial: Partial<AiModelConfig>): void {
    const next = normalizeAiConfig({ ...config, ...partial });
    onConfigChange(next);
    if (activeProfile) {
      const updated = upsertAiProfile(profileStore, {
        ...activeProfile,
        config: next,
      });
      onProfileStoreChange(updated);
    }
  }

  function handleSwitchProfile(profileId: string): void {
    const nextStore = setActiveAiProfile(profileStore, profileId);
    onProfileStoreChange(nextStore);
    const profile = nextStore.profiles.find((p) => p.id === profileId);
    if (profile) onConfigChange(profile.config);
    setTestStatus("idle");
    setTestMessage(null);
  }

  function handleCreateProfile(): void {
    const profile = createAiProfile(config, "新配置");
    const nextStore = upsertAiProfile(profileStore, profile);
    onProfileStoreChange(nextStore);
    handleSwitchProfile(profile.id);
    setEditingName(true);
    setProfileNameDraft("新配置");
  }

  function handleDeleteProfile(profileId: string): void {
    if (profileStore.profiles.length <= 1) return;
    const nextStore = deleteAiProfile(profileStore, profileId);
    onProfileStoreChange(nextStore);
    const active = getActiveAiProfile(nextStore);
    if (active) onConfigChange(active.config);
    setTestStatus("idle");
    setTestMessage(null);
  }

  function handleSaveProfileName(): void {
    if (!activeProfile) return;
    const trimmed = profileNameDraft.trim();
    if (!trimmed) {
      setEditingName(false);
      return;
    }
    const updated = upsertAiProfile(profileStore, {
      ...activeProfile,
      name: trimmed,
    });
    onProfileStoreChange(updated);
    setEditingName(false);
  }

  async function handleTestConnection(): Promise<void> {
    setTestStatus("testing");
    setTestMessage(null);
    try {
      const result = await testAiConnection(config);
      setTestStatus("success");
      setTestMessage(result);
    } catch (cause) {
      setTestStatus("error");
      setTestMessage(cause instanceof Error ? cause.message : "连接测试失败");
    }
  }

  return (
    <CollapsiblePanel
      actions={
        <div className="preview-actions">
          <button
            className="copy-button"
            disabled={testStatus === "testing"}
            type="button"
            onClick={() => void handleTestConnection()}
          >
            {testStatus === "testing" ? (
              <Loader2 className="spin" size={15} />
            ) : testStatus === "success" ? (
              <Wifi size={15} />
            ) : (
              <WifiOff size={15} />
            )}
            <span>
              {testStatus === "testing"
                ? "测试中"
                : testStatus === "success"
                  ? "连接正常"
                  : "测试连接"}
            </span>
          </button>
          <button
            className="copy-button"
            type="button"
            onClick={handleCreateProfile}
          >
            <Plus size={15} />
            <span>新建配置</span>
          </button>
        </div>
      }
      className="ai-config-panel"
      title="AI 模型配置"
    >
      {/* Profile list */}
      <div className="settings-compact">
        <label>
          <span>配置方案</span>
          <div className="preset-row">
            <select
              value={profileStore.activeId}
              onChange={(event) => handleSwitchProfile(event.target.value)}
            >
              {profileStore.profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            {profileStore.profiles.length > 1 && (
              <button
                aria-label="删除当前配置"
                className="icon-button"
                type="button"
                onClick={() => handleDeleteProfile(profileStore.activeId)}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <small>
            切换配置方案会同时切换所有模型参数。
          </small>
        </label>
      </div>

      {/* Active profile summary */}
      {activeProfile && (
        <div className="test-zone-summary">
          <span>
            <small>配置名</small>
            {editingName ? (
              <div className="input-row">
                <input
                  autoFocus
                  value={profileNameDraft}
                  onChange={(event) => setProfileNameDraft(event.target.value)}
                  onBlur={handleSaveProfileName}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleSaveProfileName();
                    if (event.key === "Escape") setEditingName(false);
                  }}
                />
                <button
                  aria-label="确认"
                  className="icon-button"
                  type="button"
                  onClick={handleSaveProfileName}
                >
                  <Check size={14} />
                </button>
                <button
                  aria-label="取消"
                  className="icon-button"
                  type="button"
                  onClick={() => setEditingName(false)}
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <strong
                className="text-link-button"
                role="button"
                tabIndex={0}
                onClick={() => {
                  setProfileNameDraft(activeProfile.name);
                  setEditingName(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    setProfileNameDraft(activeProfile.name);
                    setEditingName(true);
                  }
                }}
              >
                {activeProfile.name}
              </strong>
            )}
          </span>
          <span>
            <small>模型</small>
            <strong>{config.model || "-"}</strong>
          </span>
          <span>
            <small>API Key</small>
            <strong>{maskApiKey(config.apiKey) || "未设置"}</strong>
          </span>
          <span>
            <small>多模态</small>
            <strong className={`status-badge ${config.supportsMultimodal ? "success" : "muted"}`}>
              {config.supportsMultimodal ? "支持" : "关闭"}
            </strong>
          </span>
        </div>
      )}

      {/* Test result */}
      {testMessage && (
        <p className={`test-zone-message ${testStatus === "error" ? "danger" : ""}`}>
          {testMessage}
        </p>
      )}

      {/* Expand/collapse toggle for config form */}
      <button
        className="wide-button"
        type="button"
        onClick={() => setFormExpanded((current) => !current)}
      >
        <ChevronDown
          className="panel-collapse-icon"
          size={15}
          style={{
            transform: formExpanded ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s ease",
          }}
        />
        <span>{formExpanded ? "收起详细配置" : "展开详细配置"}</span>
      </button>

      {/* Config form (collapsible) */}
      {formExpanded && (
        <div className="settings-compact">
          <label>
            <span>Base URL</span>
            <input
              placeholder="https://api.openai.com/v1"
              value={config.baseURL}
              onChange={(event) => patchConfig({ baseURL: event.target.value })}
            />
            <small>OpenAI 兼容接口地址，不需要结尾的 /chat/completions。</small>
          </label>

          <label>
            <span>API Key</span>
            <div className="input-row">
              <input
                placeholder="sk-..."
                type={showApiKey ? "text" : "password"}
                value={config.apiKey}
                onChange={(event) => patchConfig({ apiKey: event.target.value })}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((current) => !current)}
              >
                {showApiKey ? "隐藏" : "显示"}
              </button>
            </div>
            <small>
              当前：{maskApiKey(config.apiKey) || "未设置"}
            </small>
          </label>

          <label>
            <span>模型名称</span>
            <input
              placeholder="gpt-4.1-mini"
              value={config.model}
              onChange={(event) => patchConfig({ model: event.target.value })}
            />
            <small>支持 OpenAI、DeepSeek、通义千问等兼容接口的模型名。</small>
          </label>

          <label>
            <span>Temperature</span>
            <div className="input-row">
              <input
                max={2}
                min={0}
                step={0.1}
                type="number"
                value={config.temperature}
                onChange={(event) =>
                  patchConfig({ temperature: Number(event.target.value) })
                }
              />
              <button type="button" onClick={() => patchConfig({ temperature: 0 })}>
                0
              </button>
              <button type="button" onClick={() => patchConfig({ temperature: 0.2 })}>
                0.2
              </button>
              <button type="button" onClick={() => patchConfig({ temperature: 1 })}>
                1
              </button>
            </div>
            <small>越低越稳定，规则生成推荐 0 ~ 0.3。</small>
          </label>

          <label>
            <span>超时 (ms)</span>
            <div className="input-row">
              <input
                min={5000}
                step={1000}
                type="number"
                value={config.timeoutMs}
                onChange={(event) =>
                  patchConfig({ timeoutMs: Number(event.target.value) })
                }
              />
              <button
                type="button"
                onClick={() => patchConfig({ timeoutMs: 60000 })}
              >
                60s
              </button>
              <button
                type="button"
                onClick={() => patchConfig({ timeoutMs: 120000 })}
              >
                120s
              </button>
              <button
                type="button"
                onClick={() => patchConfig({ timeoutMs: 300000 })}
              >
                300s
              </button>
            </div>
            <small>模型请求超时时间，范围 5000 ~ 300000ms。</small>
          </label>

          <label className="checkbox-label">
            <input
              checked={config.supportsMultimodal}
              type="checkbox"
              onChange={(event) =>
                patchConfig({ supportsMultimodal: event.target.checked })
              }
            />
            <span>支持多模态（Vision）</span>
            <small>
              开启后会附带截图辅助 AI 生成规则，需模型支持 image_url 输入。
            </small>
          </label>
        </div>
      )}

      <p className="preview-note">
        配置保存在浏览器本地存储中，切换配置方案可快速在不同模型间切换。
      </p>
    </CollapsiblePanel>
  );
}
