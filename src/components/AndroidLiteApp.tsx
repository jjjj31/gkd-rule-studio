import {
  ArrowLeft,
  Camera,
  Check,
  ClipboardCopy,
  Copy,
  ListChecks,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_RULE_SETTINGS, RULE_SETTINGS_PRESETS } from "../data/ruleSettings";
import {
  buildCustomScenarioPrompt,
  loadCustomScenarios,
  parseCustomScenario,
  resolveCustomScenarioSettings,
  saveCustomScenarios,
  type CustomScenario,
} from "../lib/customScenario";
import {
  createAndroidFlowSteps,
  createAndroidSingleRulePreview,
  resolveAndroidSnapshotOpenMode,
} from "../lib/androidLiteFlow";
import { getCandidateGuidance } from "../lib/candidateGuidance";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  createDeviceApiClient,
  extractDeviceOrigins,
  formatServerTitle,
  formatSnapshotOption,
  type DeviceApiClient,
} from "../lib/deviceApi";
import {
  buildFlowHelpPrompt,
  createFlowAppRuleDraft,
  stringifyFlowRuleDraft,
} from "../lib/flowDraft";
import { buildHelpPrompt } from "../lib/helpPrompt";
import { pickNodeAtPoint } from "../lib/nodePicker";
import { generateRegionSelectorCandidates } from "../lib/regionCandidates";
import { createAppRuleDraft, selectFallbackCandidates } from "../lib/ruleDraft";
import {
  addAppDraftToTestSubscription,
  createEmptyTestSubscription,
  exportRawSubscription,
  importJson5ToTestSubscription,
  markImportedAndClearBuffer,
  summarizeTestSubscription,
  type TestSubscriptionDraft,
} from "../lib/testSubscription";
import { nodeLabel } from "../types/gkdSnapshot";
import type {
  DeviceSnapshotSummary,
  NodePickResult,
  NodePoint,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { FlowRuleStep } from "../types/flowDraft";
import type { RuleSettings, SelectorCandidate } from "../types/ruleDraft";
import { ScreenshotCanvas } from "./ScreenshotCanvas";

const CUSTOM_SCENARIO_OPTION_ID = "__custom_scenario__";
type AndroidWorkspaceTab = "scene" | "candidates" | "rule" | "test";

export function AndroidLiteApp() {
  const [deviceUrl, setDeviceUrl] = useState(
    () => localStorage.getItem("gkd-rule-builder-device-url") ?? "",
  );
  const [client, setClient] = useState<DeviceApiClient | null>(null);
  const [view, setView] = useState<"home" | "workspace">("home");
  const [snapshots, setSnapshots] = useState<DeviceSnapshotSummary[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState("");
  const [selectedSnapshotIds, setSelectedSnapshotIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [snapshot, setSnapshot] = useState<ParsedGkdSnapshot | null>(null);
  const [pickResult, setPickResult] = useState<NodePickResult | null>(null);
  const [ruleSettings, setRuleSettings] = useState<RuleSettings>(
    DEFAULT_RULE_SETTINGS,
  );
  const [scenarioId, setScenarioId] = useState("splash");
  const [customScenarios, setCustomScenarios] = useState<CustomScenario[]>(
    () => loadCustomScenarios(),
  );
  const [customScenarioName, setCustomScenarioName] = useState("");
  const [customScenarioText, setCustomScenarioText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [openingFlow, setOpeningFlow] = useState(false);
  const [copied, setCopied] = useState<
    "scene" | "rule" | "draft" | "flowDraft" | "flowPrompt" | null
  >(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<AndroidWorkspaceTab>("scene");
  const [workspaceMode, setWorkspaceMode] = useState<"single" | "flow">("single");
  const [flowName, setFlowName] = useState("多步骤规则");
  const [flowDesc, setFlowDesc] = useState("");
  const [flowSteps, setFlowSteps] = useState<FlowRuleStep[]>([]);
  const [activeFlowStepId, setActiveFlowStepId] = useState<string | null>(null);
  const [testSubscription, setTestSubscription] = useState<TestSubscriptionDraft>(
    createEmptyTestSubscription,
  );
  const pushedWorkspaceHistoryRef = useRef(false);
  const candidates = useMemo(() => {
    if (!snapshot || !pickResult) return [];
    return generateRegionSelectorCandidates({
      snapshot,
      ruleSettings,
      pickResult,
    });
  }, [snapshot, pickResult, ruleSettings]);
  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) ??
    candidates[0] ??
    null;
  const activeScenario =
    RULE_SETTINGS_PRESETS.find((item) => item.id === scenarioId) ??
    customScenarios.find((item) => item.id === scenarioId);
  const customScenarioEditorOpen = scenarioId === CUSTOM_SCENARIO_OPTION_ID;
  const singleRulePreview = useMemo(() => {
    return createAndroidSingleRulePreview(snapshot, selectedCandidate, candidates);
  }, [snapshot, selectedCandidate, candidates]);
  const flowDraft = useMemo(() => {
    return createFlowAppRuleDraft({ flowName, flowDesc, steps: flowSteps });
  }, [flowName, flowDesc, flowSteps]);
  const flowPreview = flowDraft ? stringifyFlowRuleDraft(flowDraft) : "";
  const flowPrompt = useMemo(() => {
    return buildFlowHelpPrompt({ flowName, flowDesc, steps: flowSteps });
  }, [flowName, flowDesc, flowSteps]);
  const activeFlowStep =
    flowSteps.find((step) => step.id === activeFlowStepId) ?? null;

  useEffect(() => {
    function handlePopState(): void {
      if (!pushedWorkspaceHistoryRef.current) return;
      pushedWorkspaceHistoryRef.current = false;
      setView("home");
      setMessage(null);
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (view !== "workspace" || pushedWorkspaceHistoryRef.current) return;

    window.history.pushState(
      {
        ...(typeof window.history.state === "object" && window.history.state
          ? window.history.state
          : {}),
        gkdRuleBuilderView: "workspace",
      },
      "",
      window.location.href,
    );
    pushedWorkspaceHistoryRef.current = true;
  }, [view]);

  async function connect(): Promise<void> {
    setLoading(true);
    setMessage(null);
    try {
      const origin = resolveConnectOrigin(deviceUrl);
      const nextClient = await createDeviceApiClient(origin);
      const nextSnapshots = await nextClient.getSnapshots();
      setClient(nextClient);
      setSnapshots(nextSnapshots);
      setSelectedSnapshotId(nextSnapshots[0]?.id ? String(nextSnapshots[0].id) : "");
      setSelectedSnapshotIds(new Set());
      setDeviceUrl(nextClient.origin);
      localStorage.setItem("gkd-rule-builder-device-url", nextClient.origin);
      setMessage(`连接成功：${formatServerTitle(nextClient.serverInfo)}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "连接设备失败");
    } finally {
      setLoading(false);
    }
  }

  async function refreshSnapshots(): Promise<void> {
    if (!client) {
      await connect();
      return;
    }

    setLoading(true);
    setMessage(null);
    try {
      const nextSnapshots = await client.getSnapshots();
      setSnapshots(nextSnapshots);
      setSelectedSnapshotId((current) => {
        if (nextSnapshots.some((item) => String(item.id) === current)) return current;
        return nextSnapshots[0]?.id ? String(nextSnapshots[0].id) : "";
      });
      setSelectedSnapshotIds((current) => {
        const availableIds = new Set(nextSnapshots.map((item) => item.id));
        return new Set([...current].filter((id) => availableIds.has(id)));
      });
      setMessage(`刷新成功：${nextSnapshots.length} 条快照`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "刷新快照失败");
    } finally {
      setLoading(false);
    }
  }

  async function captureSnapshot(): Promise<void> {
    if (!client) return;

    setLoading(true);
    setMessage(null);
    try {
      const rawSnapshot = await client.captureSnapshot();
      const nextSnapshots = await client.getSnapshots();
      setSnapshots(nextSnapshots);
      setSelectedSnapshotId(String(rawSnapshot.id));
      await loadDeviceSnapshot(rawSnapshot.id, client);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "捕获快照失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadDeviceSnapshot(
    id: number | string = selectedSnapshotId,
    targetClient = client,
  ): Promise<void> {
    if (!targetClient || !id) return;

    const numericId = Number(id);
    setOpeningId(numericId);
    setMessage(null);
    try {
      const nextSnapshot = await targetClient.loadSnapshot(numericId);
      openSnapshot(nextSnapshot);
      setSelectedSnapshotId(String(numericId));
      setMessage(`已加载快照：${nextSnapshot.appInfo?.name ?? nextSnapshot.appId}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "加载快照失败");
    } finally {
      setOpeningId(null);
    }
  }

  function openSnapshot(nextSnapshot: ParsedGkdSnapshot): void {
    const previousSnapshot = snapshot;
    setSnapshot((previous) => {
      if (previous) URL.revokeObjectURL(previous.screenshotUrl);
      return nextSnapshot;
    });
    setPickResult(null);
    setSelectedCandidateId(null);
    setWorkspaceMode("single");
    setView("workspace");
    setActiveTab("scene");
    setRuleSettings((current) => {
      const nextPreset = RULE_SETTINGS_PRESETS.find((item) => item.id === scenarioId);
      if (nextPreset) return nextPreset.build(nextSnapshot);
      const customScenario = customScenarios.find((item) => item.id === scenarioId);
      if (customScenario) {
        return resolveCustomScenarioSettings(customScenario, nextSnapshot);
      }
      return reconcileActivity(current, previousSnapshot, nextSnapshot);
    });
  }

  function handlePointSelected(point: NodePoint): void {
    if (!snapshot) return;
    const nextPick = pickNodeAtPoint(snapshot, point);
    setPickResult(nextPick);
    setSelectedCandidateId(null);
    if (!nextPick) {
      setMessage("点击位置没有可见节点");
      syncActiveFlowStep({
        pickResult: null,
        candidates: [],
        selectedCandidate: null,
      });
      return;
    }

    const nextCandidates = buildCandidates(snapshot, ruleSettings, nextPick);
    const nextSelectedCandidate = nextCandidates[0] ?? null;
    setSelectedCandidateId(nextSelectedCandidate?.id ?? null);
    setActiveTab("candidates");
    setMessage(null);
    syncActiveFlowStep({
      snapshot,
      pickResult: nextPick,
      candidates: nextCandidates,
      selectedCandidate: nextSelectedCandidate,
    });
  }

  function selectScenario(nextScenarioId: string): void {
    setScenarioId(nextScenarioId);
    if (nextScenarioId === CUSTOM_SCENARIO_OPTION_ID) return;

    const preset = RULE_SETTINGS_PRESETS.find((item) => item.id === nextScenarioId);
    const custom = customScenarios.find((item) => item.id === nextScenarioId);
    const nextSettings =
      preset?.build(snapshot) ??
      (custom ? resolveCustomScenarioSettings(custom, snapshot) : undefined);
    if (nextSettings) setRuleSettings(nextSettings);
    if (nextSettings && snapshot && pickResult) {
      const nextCandidates = buildCandidates(snapshot, nextSettings, pickResult);
      const nextSelectedCandidate = nextCandidates[0] ?? null;
      setSelectedCandidateId(nextSelectedCandidate?.id ?? null);
      syncActiveFlowStep({
        candidates: nextCandidates,
        selectedCandidate: nextSelectedCandidate,
      });
    }
  }

  async function copyScenePrompt(): Promise<void> {
    await copyTextToClipboard(buildCustomScenarioPrompt(snapshot));
    markCopied("scene");
  }

  async function copyRulePrompt(): Promise<void> {
    const prompt = buildHelpPrompt({
      snapshot,
      pickResult,
      candidates,
      selectedCandidate,
      ruleSettings,
    });
    await copyTextToClipboard(prompt);
    markCopied("rule");
  }

  async function copySingleRuleDraft(): Promise<void> {
    if (!singleRulePreview) return;
    await copyTextToClipboard(singleRulePreview);
    markCopied("draft");
  }

  async function copyFlowDraft(): Promise<void> {
    if (!flowPreview) return;
    await copyTextToClipboard(flowPreview);
    markCopied("flowDraft");
  }

  async function copyFlowPrompt(): Promise<void> {
    if (flowSteps.length === 0) return;
    await copyTextToClipboard(flowPrompt);
    markCopied("flowPrompt");
  }

  async function openSelectedSnapshots(): Promise<void> {
    if (!client) return;

    const openMode = resolveAndroidSnapshotOpenMode(selectedSnapshotIds);
    if (openMode.mode === "none") return;
    if (openMode.mode === "single") {
      await loadDeviceSnapshot(openMode.ids[0], client);
      return;
    }

    await openSelectedSnapshotsAsFlow(openMode.ids);
  }

  async function openSelectedSnapshotsAsFlow(ids: number[]): Promise<void> {
    if (!client || ids.length === 0) return;

    setOpeningFlow(true);
    setMessage(null);
    try {
      const orderedIds = snapshots
        .filter((item) => ids.includes(item.id))
        .map((item) => item.id);
      const loadedSnapshots: ParsedGkdSnapshot[] = [];
      for (const id of orderedIds) {
        loadedSnapshots.push(await client.loadSnapshot(id));
      }
      const steps = createAndroidFlowSteps(loadedSnapshots);
      const firstSnapshot = loadedSnapshots[0];
      if (!firstSnapshot) return;

      setFlowSteps(steps);
      setActiveFlowStepId(steps[0]?.id ?? null);
      setFlowName(
        firstSnapshot.appInfo?.name
          ? `${firstSnapshot.appInfo.name}多步骤规则`
          : "多步骤规则",
      );
      setFlowDesc("");
      setSnapshot(firstSnapshot);
      setPickResult(null);
      setSelectedCandidateId(null);
      setSelectedSnapshotId(String(firstSnapshot.id));
      setWorkspaceMode("flow");
      setView("workspace");
      setActiveTab("scene");
      setMessage(`已创建流程：${steps.length} 个步骤`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "创建流程失败");
    } finally {
      setOpeningFlow(false);
    }
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
      setScenarioId(scenario.id);
      setRuleSettings(resolveCustomScenarioSettings(scenario, snapshot));
      setCustomScenarioName("");
      setCustomScenarioText("");
      setMessage(`已导入场景：${scenario.name}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "导入自定义场景失败");
    }
  }

  function addCurrentSnapshotToFlow(): void {
    if (!snapshot) {
      setMessage("请先打开一个快照");
      return;
    }

    const selected = selectedCandidate ?? candidates[0] ?? null;
    const nextStep: FlowRuleStep = {
      id: `android-flow-${snapshot.id}-${flowSteps.length + 1}`,
      title: `步骤 ${flowSteps.length + 1}`,
      note: "",
      delayNote: "步骤间延迟只作为 prompt 上下文，不保证强流程顺序。",
      snapshot,
      pickResult,
      candidates,
      selectedCandidate: selected,
    };

    setFlowSteps((current) => [...current, nextStep]);
    setActiveFlowStepId(nextStep.id);
    setWorkspaceMode("flow");
  }

  function selectFlowStep(stepId: string): void {
    const step = flowSteps.find((item) => item.id === stepId);
    if (!step) return;

    setActiveFlowStepId(step.id);
    setSnapshot(step.snapshot);
    setPickResult(step.pickResult);
    setSelectedCandidateId(step.selectedCandidate?.id ?? null);
    setSelectedSnapshotId(String(step.snapshot.id));
    setMessage(null);
  }

  function updateFlowStep(
    stepId: string,
    patch: Partial<FlowRuleStep>,
  ): void {
    setFlowSteps((current) =>
      current.map((step) =>
        step.id === stepId
          ? {
              ...step,
              ...patch,
            }
          : step,
      ),
    );
  }

  function removeFlowStep(stepId: string): void {
    setFlowSteps((current) => current.filter((step) => step.id !== stepId));
    if (activeFlowStepId === stepId) {
      const nextStep = flowSteps.find((step) => step.id !== stepId) ?? null;
      if (nextStep) {
        selectFlowStep(nextStep.id);
      } else {
        setActiveFlowStepId(null);
      }
    }
  }

  function syncActiveFlowStep(patch: Partial<FlowRuleStep>): void {
    if (workspaceMode !== "flow" || !activeFlowStepId) return;
    updateFlowStep(activeFlowStepId, patch);
  }

  function toggleSnapshotSelection(id: number): void {
    setSelectedSnapshotIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleCandidateSelect(candidate: SelectorCandidate): void {
    setSelectedCandidateId(candidate.id);
    syncActiveFlowStep({
      candidates,
      selectedCandidate: candidate,
    });
  }

  function addCandidateToTestZone(candidate: SelectorCandidate): void {
    if (!snapshot) {
      setMessage("请先打开一个快照");
      return;
    }

    const draft = createAppRuleDraft(
      snapshot,
      candidate,
      selectFallbackCandidates(candidate, candidates),
    );
    setTestSubscription((current) => addAppDraftToTestSubscription(current, draft));
    setActiveTab("test");
    setMessage("已加入测试区");
  }

  async function importTestZoneToGkd(): Promise<void> {
    if (!client) {
      setMessage("请先连接 GKD HTTP 服务");
      return;
    }

    const summary = summarizeTestSubscription(testSubscription);
    if (summary.ruleCount === 0) {
      setMessage("测试区没有规则");
      return;
    }

    setLoading(true);
    setMessage(null);
    try {
      await client.updateSubscription(exportRawSubscription(testSubscription));
      setTestSubscription((current) => markImportedAndClearBuffer(current));
      setMessage(`已导入到 GKD 内存订阅：${summary.ruleCount} 条规则，测试区缓冲已清空`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "导入到 GKD 失败");
    } finally {
      setLoading(false);
    }
  }

  function importAiRuleToTestZone(source: string): void {
    try {
      setTestSubscription((current) =>
        importJson5ToTestSubscription(
          current,
          source,
          snapshot
            ? {
                id: snapshot.appId,
                name: snapshot.appInfo?.name ?? snapshot.appId,
              }
            : undefined,
        ),
      );
      setMessage("AI 返回规则已加入测试区");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "导入 AI 规则失败");
    }
  }

  function markCopied(
    kind: "scene" | "rule" | "draft" | "flowDraft" | "flowPrompt",
  ) {
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1300);
  }

  function backHome(): void {
    if (pushedWorkspaceHistoryRef.current) {
      window.history.back();
      return;
    }

    setView("home");
    setMessage(null);
  }

  return (
    <main className="android-shell">
      <header className="android-header">
        <div className="android-title-row">
          {view === "workspace" && (
            <button
              aria-label="返回首页"
              className="android-back-button"
              type="button"
              onClick={backHome}
            >
              <ArrowLeft size={16} />
              <span>首页</span>
            </button>
          )}
          <div>
          <h1>GKD Rule Studio</h1>
            <p>{view === "home" ? "首页" : "工作区"}</p>
          </div>
        </div>
        <div className="android-header-actions">
          <span className={client ? "status-badge success" : "status-badge muted"}>
            {client ? "已连接" : "未连接"}
          </span>
          <span className="status-badge neutral">
            {workspaceMode === "flow" ? "流程" : "单步"}
          </span>
        </div>
      </header>

      {message && <div className="android-message">{message}</div>}

      {view === "home" && (
        <section className="android-home">
          <div className="android-home-hero">
            <div className="android-home-icon">G</div>
            <div>
              <h2>从手机快照开始生成规则</h2>
              <p>连接 GKD HTTP 服务，选择一张快照做单步规则，或多选快照做流程规则。</p>
            </div>
          </div>
          <div className="android-card android-connect-card">
            <div className="android-section-title">
              <h2>HTTP 服务</h2>
              <span>填 GKD 显示的地址。手机本机访问通常用 127.0.0.1:8888。</span>
            </div>
            <div className="android-device-form">
              <input
                className="android-input"
                placeholder="例如 127.0.0.1:8888 或 192.168.1.23:8888"
                value={deviceUrl}
                onChange={(event) => setDeviceUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void connect();
                }}
              />
              <button
                className="android-button android-button-primary"
                disabled={loading}
                type="button"
                onClick={() => void connect()}
              >
                <Smartphone size={16} />
                {client ? "重连" : "连接"}
              </button>
            </div>
            {client && (
              <div className="android-device-status">
                {formatServerTitle(client.serverInfo)}
              </div>
            )}
          </div>
          {client ? (
            <AndroidSnapshotChooser
              loading={loading}
              openingId={openingId}
              openingFlow={openingFlow}
              selectedIds={selectedSnapshotIds}
              snapshots={snapshots}
              onCapture={() => void captureSnapshot()}
              onOpenSelected={() => void openSelectedSnapshots()}
              onRefresh={() => void refreshSnapshots()}
              onToggle={toggleSnapshotSelection}
            />
          ) : (
            <div className="android-empty android-home-empty">
              连接成功后会在这里显示手机保存的快照。
            </div>
          )}
        </section>
      )}

      {view === "workspace" && (
      <>
      <section className="android-workspace-stage">
        <div className="android-workspace-meta">
          <div>
            <strong>{snapshot?.appInfo?.name ?? snapshot?.appId ?? "未加载快照"}</strong>
            <span>{snapshot ? shortActivity(snapshot.activityId) : "等待快照"}</span>
          </div>
          <span className="status-badge neutral">
            {workspaceMode === "flow"
              ? `${flowSteps.length} 步流程`
              : "单步规则"}
          </span>
        </div>
        {snapshot ? (
          <>
            {testSubscription.lastImportedSummary && (
              <div className="test-zone-active-status android-test-status">
                当前正在测试 {testSubscription.lastImportedSummary.appCount} 个应用 /{" "}
                {testSubscription.lastImportedSummary.groupCount} 个规则组 /{" "}
                {testSubscription.lastImportedSummary.ruleCount} 条规则
              </div>
            )}
            <ScreenshotCanvas
              interactionMode="dragMagnifier"
              pickResult={pickResult}
              selectedCandidate={selectedCandidate}
              snapshot={snapshot}
              onPointSelected={handlePointSelected}
            />
            <div className="android-canvas-hint">
              <span>按住拖动放大镜，松手选中十字中心</span>
              {selectedCandidate && (
                <strong>Score {selectedCandidate.risk.finalScore}</strong>
              )}
            </div>
            <TargetSummary pickResult={pickResult} selectedCandidate={selectedCandidate} />
          </>
        ) : (
          <div className="android-empty">先连接手机 HTTP 服务并打开一个快照</div>
        )}
      </section>

      {workspaceMode === "flow" && (
        <AndroidFlowStepRail
          activeStepId={activeFlowStepId}
          steps={flowSteps}
          onAddCurrentStep={addCurrentSnapshotToFlow}
          onSelectStep={selectFlowStep}
        />
      )}

      <AndroidWorkspaceTabs activeTab={activeTab} onChange={setActiveTab} />

      <section className="android-card android-tab-panel">
        {activeTab === "scene" && (
          <AndroidScenePanel
            activeScenarioDescription={
              customScenarioEditorOpen
                ? "创建一个新场景，导入后会出现在场景列表里。"
                : activeScenario?.description ?? "选择一个运行场景"
            }
            copied={copied}
            customScenarioEditorOpen={customScenarioEditorOpen}
            customScenarioName={customScenarioName}
            customScenarioText={customScenarioText}
            customScenarios={customScenarios}
            ruleSettings={ruleSettings}
            scenarioId={scenarioId}
            onCopyScenePrompt={() => void copyScenePrompt()}
            onCustomScenarioNameChange={setCustomScenarioName}
            onCustomScenarioTextChange={setCustomScenarioText}
            onImportCustomScenario={importCustomScenario}
            onScenarioChange={selectScenario}
          />
        )}
        {activeTab === "candidates" && (
          <div className="android-tab-content">
            <div className="android-section-title">
              <h2>候选 selector</h2>
              <span>优先选高分、低风险、命中数合理的候选。</span>
            </div>
            <CandidateSummary
              candidates={candidates}
              importedSelectorKeys={new Set(testSubscription.importedSelectors)}
              selectedId={selectedCandidate?.id ?? null}
              onAddToTestZone={addCandidateToTestZone}
              onSelect={handleCandidateSelect}
            />
          </div>
        )}
        {activeTab === "rule" && (
          <AndroidRulePanel
            activeFlowStep={activeFlowStep}
            activeFlowStepId={activeFlowStepId}
            copied={copied}
            flowDesc={flowDesc}
            flowName={flowName}
            flowPreview={flowPreview}
            flowSteps={flowSteps}
            singleRulePreview={singleRulePreview}
            snapshot={snapshot}
            pickResult={pickResult}
            workspaceMode={workspaceMode}
            onAddCurrentStep={addCurrentSnapshotToFlow}
            onCopyFlowDraft={() => void copyFlowDraft()}
            onCopyFlowPrompt={() => void copyFlowPrompt()}
            onCopyRuleDraft={() => void copySingleRuleDraft()}
            onCopyRulePrompt={() => void copyRulePrompt()}
            onFlowDescChange={setFlowDesc}
            onFlowNameChange={setFlowName}
            onRemoveStep={removeFlowStep}
            onSelectStep={selectFlowStep}
            onUpdateStep={updateFlowStep}
          />
        )}
        {activeTab === "test" && (
          <AndroidTestZonePanel
            draft={testSubscription}
            loading={loading}
            onClear={() => {
              setTestSubscription(createEmptyTestSubscription());
              setMessage("测试区已清空");
            }}
            onImportAiRule={importAiRuleToTestZone}
            onImportToGkd={() => void importTestZoneToGkd()}
          />
        )}
      </section>
      </>
      )}
    </main>
  );
}

function buildCandidates(
  snapshot: ParsedGkdSnapshot,
  ruleSettings: RuleSettings,
  pickResult: NodePickResult,
): SelectorCandidate[] {
  return generateRegionSelectorCandidates({
    snapshot,
    ruleSettings,
    pickResult,
  });
}

function AndroidWorkspaceTabs({
  activeTab,
  onChange,
}: {
  activeTab: AndroidWorkspaceTab;
  onChange: (tab: AndroidWorkspaceTab) => void;
}) {
  const tabs = [
    { id: "scene" as const, label: "场景" },
    { id: "candidates" as const, label: "候选" },
    { id: "rule" as const, label: "规则" },
    { id: "test" as const, label: "测试区" },
  ];

  return (
    <nav className="android-workspace-tabs" aria-label="工作区标签">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={activeTab === tab.id ? "android-tab-active" : ""}
          type="button"
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

function AndroidFlowStepRail({
  steps,
  activeStepId,
  onSelectStep,
  onAddCurrentStep,
}: {
  steps: FlowRuleStep[];
  activeStepId: string | null;
  onSelectStep: (stepId: string) => void;
  onAddCurrentStep: () => void;
}) {
  return (
    <section className="android-flow-rail" aria-label="流程步骤">
      <div className="android-flow-rail-scroll">
        {steps.map((step, index) => (
          <button
            key={step.id}
            className={[
              "android-flow-chip",
              step.id === activeStepId ? "android-flow-chip-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            onClick={() => onSelectStep(step.id)}
          >
            <strong>{index + 1}</strong>
            <span>{step.title || `步骤 ${index + 1}`}</span>
            {step.selectedCandidate && (
              <em>{step.selectedCandidate.risk.finalScore}</em>
            )}
          </button>
        ))}
        <button
          className="android-flow-chip android-flow-chip-add"
          type="button"
          onClick={onAddCurrentStep}
        >
          <Plus size={15} />
          <span>添加</span>
        </button>
      </div>
    </section>
  );
}

function AndroidScenePanel({
  scenarioId,
  customScenarios,
  customScenarioEditorOpen,
  activeScenarioDescription,
  ruleSettings,
  copied,
  customScenarioName,
  customScenarioText,
  onScenarioChange,
  onCopyScenePrompt,
  onCustomScenarioNameChange,
  onCustomScenarioTextChange,
  onImportCustomScenario,
}: {
  scenarioId: string;
  customScenarios: CustomScenario[];
  customScenarioEditorOpen: boolean;
  activeScenarioDescription: string;
  ruleSettings: RuleSettings;
  copied: "scene" | "rule" | "draft" | "flowDraft" | "flowPrompt" | null;
  customScenarioName: string;
  customScenarioText: string;
  onScenarioChange: (scenarioId: string) => void;
  onCopyScenePrompt: () => void;
  onCustomScenarioNameChange: (value: string) => void;
  onCustomScenarioTextChange: (value: string) => void;
  onImportCustomScenario: () => void;
}) {
  return (
    <div className="android-tab-content">
      <div className="android-section-title">
        <h2>运行场景</h2>
        <span>{activeScenarioDescription}</span>
      </div>
      <select
        className="android-select"
        value={scenarioId}
        onChange={(event) => onScenarioChange(event.target.value)}
      >
        {RULE_SETTINGS_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
        {customScenarios.length > 0 && (
          <optgroup label="自定义场景">
            {customScenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value={CUSTOM_SCENARIO_OPTION_ID}>添加自定义场景...</option>
      </select>
      <RuntimeSummary settings={ruleSettings} />
      {customScenarioEditorOpen && (
        <div className="android-custom-scenario-box">
          <div className="android-section-title">
            <h2>自定义场景</h2>
            <span>复制 prompt 给 AI，粘贴 JSON5 回来后会加入场景列表。</span>
          </div>
          <button
            className="android-button"
            type="button"
            onClick={onCopyScenePrompt}
          >
            {copied === "scene" ? <Check size={16} /> : <ClipboardCopy size={16} />}
            {copied === "scene" ? "已复制场景 prompt" : "复制场景 prompt"}
          </button>
          <input
            className="android-input"
            placeholder="场景名称，可留空使用 AI 返回的 name"
            value={customScenarioName}
            onChange={(event) => onCustomScenarioNameChange(event.target.value)}
          />
          <textarea
            className="android-textarea"
            placeholder="粘贴 AI 返回的 JSON5 场景代码块"
            rows={6}
            value={customScenarioText}
            onChange={(event) => onCustomScenarioTextChange(event.target.value)}
          />
          <button
            className="android-button android-button-primary"
            disabled={!customScenarioText.trim()}
            type="button"
            onClick={onImportCustomScenario}
          >
            <Plus size={16} />
            导入为场景
          </button>
        </div>
      )}
    </div>
  );
}

function AndroidRulePanel({
  workspaceMode,
  singleRulePreview,
  snapshot,
  pickResult,
  copied,
  flowSteps,
  activeFlowStep,
  activeFlowStepId,
  flowName,
  flowDesc,
  flowPreview,
  onCopyRuleDraft,
  onCopyRulePrompt,
  onAddCurrentStep,
  onFlowNameChange,
  onFlowDescChange,
  onSelectStep,
  onUpdateStep,
  onRemoveStep,
  onCopyFlowDraft,
  onCopyFlowPrompt,
}: {
  workspaceMode: "single" | "flow";
  singleRulePreview: string;
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
  copied: "scene" | "rule" | "draft" | "flowDraft" | "flowPrompt" | null;
  flowSteps: FlowRuleStep[];
  activeFlowStep: FlowRuleStep | null;
  activeFlowStepId: string | null;
  flowName: string;
  flowDesc: string;
  flowPreview: string;
  onCopyRuleDraft: () => void;
  onCopyRulePrompt: () => void;
  onAddCurrentStep: () => void;
  onFlowNameChange: (value: string) => void;
  onFlowDescChange: (value: string) => void;
  onSelectStep: (stepId: string) => void;
  onUpdateStep: (stepId: string, patch: Partial<FlowRuleStep>) => void;
  onRemoveStep: (stepId: string) => void;
  onCopyFlowDraft: () => void;
  onCopyFlowPrompt: () => void;
}) {
  if (workspaceMode === "flow") {
    return (
      <AndroidFlowEditor
        activeStep={activeFlowStep}
        activeStepId={activeFlowStepId}
        copied={copied}
        flowDesc={flowDesc}
        flowName={flowName}
        flowPreview={flowPreview}
        steps={flowSteps}
        onAddCurrentStep={onAddCurrentStep}
        onCopyFlowDraft={onCopyFlowDraft}
        onCopyFlowPrompt={onCopyFlowPrompt}
        onFlowDescChange={onFlowDescChange}
        onFlowNameChange={onFlowNameChange}
        onRemoveStep={onRemoveStep}
        onSelectStep={onSelectStep}
        onUpdateStep={onUpdateStep}
      />
    );
  }

  return (
    <div className="android-tab-content">
      <div className="android-section-title">
        <h2>规则输出</h2>
        <span>先复制本地 JSON5；复杂场景再复制求助 prompt 给 AI 微调。</span>
      </div>
      <div className="android-action-row">
        <button
          className="android-button"
          disabled={!singleRulePreview}
          type="button"
          onClick={onCopyRuleDraft}
        >
          {copied === "draft" ? <Check size={16} /> : <Copy size={16} />}
          {copied === "draft" ? "已复制规则" : "复制规则 JSON5"}
        </button>
        <button
          className="android-button android-button-primary"
          disabled={!snapshot || !pickResult}
          type="button"
          onClick={onCopyRulePrompt}
        >
          {copied === "rule" ? <Check size={16} /> : <ClipboardCopy size={16} />}
          {copied === "rule" ? "已复制 prompt" : "复制求助 prompt"}
        </button>
      </div>
      {singleRulePreview ? (
        <pre className="android-code-preview">
          <code>{singleRulePreview}</code>
        </pre>
      ) : (
        <p className="android-muted">选择控件和候选 selector 后会生成规则 JSON5。</p>
      )}
    </div>
  );
}

function AndroidTestZonePanel({
  draft,
  loading,
  onImportAiRule,
  onImportToGkd,
  onClear,
}: {
  draft: TestSubscriptionDraft;
  loading: boolean;
  onImportAiRule: (source: string) => void;
  onImportToGkd: () => void;
  onClear: () => void;
}) {
  const [aiJson5, setAiJson5] = useState("");
  const summary = summarizeTestSubscription(draft);

  return (
    <div className="android-tab-content">
      <div className="android-section-title">
        <h2>测试区</h2>
        <span>作为完整内存订阅导入 GKD；每次导入会覆盖当前内存订阅。</span>
      </div>
      {draft.lastImportedSummary && (
        <div className="test-zone-active-status">
          当前正在测试 {draft.lastImportedSummary.appCount} 个应用 /{" "}
          {draft.lastImportedSummary.groupCount} 个规则组 /{" "}
          {draft.lastImportedSummary.ruleCount} 条规则
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
      <div className="android-action-row">
        <button
          className="android-button android-button-primary"
          disabled={loading || summary.ruleCount === 0}
          type="button"
          onClick={onImportToGkd}
        >
          <Upload size={16} />
          {loading ? "导入中" : "导入到 GKD 测试"}
        </button>
        <button
          className="android-button"
          disabled={summary.ruleCount === 0}
          type="button"
          onClick={onClear}
        >
          <Trash2 size={16} />
          清空测试区
        </button>
      </div>
      <textarea
        className="android-textarea"
        placeholder="粘贴 AI 返回的 JSON5：完整订阅、应用规则或单个 group"
        rows={6}
        value={aiJson5}
        onChange={(event) => setAiJson5(event.target.value)}
      />
      <button
        className="android-button"
        disabled={!aiJson5.trim()}
        type="button"
        onClick={() => {
          onImportAiRule(aiJson5);
          setAiJson5("");
        }}
      >
        <Plus size={16} />
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
                  <code>{rule.matches.join(" && ")}</code>
                </div>
              )),
            ),
          )}
        </div>
      ) : (
        <p className="android-muted">还没有测试规则。可从候选 selector 或 AI JSON5 加入。</p>
      )}
    </div>
  );
}

function AndroidSnapshotChooser({
  snapshots,
  selectedIds,
  loading,
  openingId,
  openingFlow,
  onToggle,
  onRefresh,
  onCapture,
  onOpenSelected,
}: {
  snapshots: DeviceSnapshotSummary[];
  selectedIds: Set<number>;
  loading: boolean;
  openingId: number | null;
  openingFlow: boolean;
  onToggle: (id: number) => void;
  onRefresh: () => void;
  onCapture: () => void;
  onOpenSelected: () => void;
}) {
  const openMode = resolveAndroidSnapshotOpenMode(selectedIds);
  const isOpening = openingId !== null || openingFlow;

  return (
    <div className="android-snapshot-chooser">
      <div className="android-section-title">
        <h2>选择快照</h2>
        <span>
          选一张进入单步工作区；选多张会按列表顺序直接进入流程工作区。
        </span>
      </div>
      {snapshots.length > 0 ? (
        <div className="android-snapshot-check-list">
          {snapshots.map((item) => (
            <label key={item.id} className="android-snapshot-check-row">
              <input
                checked={selectedIds.has(item.id)}
                disabled={isOpening}
                type="checkbox"
                onChange={() => onToggle(item.id)}
              />
              <span>{formatSnapshotOption(item)}</span>
            </label>
          ))}
        </div>
      ) : (
        <div className="android-empty">手机上没有快照，可以先捕获当前界面。</div>
      )}
      <div className="android-action-row">
        <button
          className="android-button"
          disabled={loading}
          type="button"
          onClick={onRefresh}
        >
          <RefreshCw size={16} />
          刷新快照
        </button>
        <button
          className="android-button"
          disabled={loading || isOpening}
          type="button"
          onClick={onCapture}
        >
          <Camera size={16} />
          捕获当前界面
        </button>
      </div>
      <button
        className="android-button android-button-primary"
        disabled={openMode.mode === "none" || isOpening}
        type="button"
        onClick={onOpenSelected}
      >
        <ListChecks size={16} />
        {isOpening
          ? "打开中"
          : openMode.mode === "flow"
            ? `进入流程工作区 (${selectedIds.size})`
            : "进入工作区"}
      </button>
    </div>
  );
}

function AndroidFlowEditor({
  steps,
  activeStep,
  activeStepId,
  flowName,
  flowDesc,
  flowPreview,
  copied,
  onFlowNameChange,
  onFlowDescChange,
  onSelectStep,
  onUpdateStep,
  onRemoveStep,
  onAddCurrentStep,
  onCopyFlowDraft,
  onCopyFlowPrompt,
}: {
  steps: FlowRuleStep[];
  activeStep: FlowRuleStep | null;
  activeStepId: string | null;
  flowName: string;
  flowDesc: string;
  flowPreview: string;
  copied: "scene" | "rule" | "draft" | "flowDraft" | "flowPrompt" | null;
  onFlowNameChange: (value: string) => void;
  onFlowDescChange: (value: string) => void;
  onSelectStep: (stepId: string) => void;
  onUpdateStep: (stepId: string, patch: Partial<FlowRuleStep>) => void;
  onRemoveStep: (stepId: string) => void;
  onAddCurrentStep: () => void;
  onCopyFlowDraft: () => void;
  onCopyFlowPrompt: () => void;
}) {
  return (
    <div className="android-flow-card">
      <div className="android-section-title">
        <h2>流程步骤</h2>
        <span>先选步骤，再在对应快照画布里选控件；每步会保存自己的候选 selector。</span>
      </div>
      <div className="android-flow-form">
        <input
          className="android-input"
          placeholder="规则组名称"
          value={flowName}
          onChange={(event) => onFlowNameChange(event.target.value)}
        />
        <input
          className="android-input"
          placeholder="流程备注，例如：点进去再返回"
          value={flowDesc}
          onChange={(event) => onFlowDescChange(event.target.value)}
        />
      </div>
      <div className="android-flow-step-list">
        {steps.map((step, index) => (
          <button
            key={step.id}
            className={[
              "android-flow-step",
              step.id === activeStepId ? "android-flow-step-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            onClick={() => onSelectStep(step.id)}
          >
            <span>
              <strong>{index + 1}</strong>
              {step.title || "未命名步骤"}
              <em>
                {step.selectedCandidate
                  ? `score ${step.selectedCandidate.risk.finalScore}`
                  : "待选"}
              </em>
            </span>
            <small>{step.snapshot.activityId}</small>
            <code>
              {step.selectedCandidate?.rule.matches.join(" && ") ??
                "未选择 selector"}
            </code>
          </button>
        ))}
      </div>
      <button
        className="android-button"
        type="button"
        onClick={onAddCurrentStep}
      >
        <Plus size={16} />
        加入当前快照为步骤
      </button>
      {activeStep && (
        <div className="android-flow-editor">
          <div className="android-flow-editor-title">
            <span className="status-badge neutral">
              正在编辑：{activeStep.title || "未命名步骤"}
            </span>
            <button
              className="android-button"
              type="button"
              onClick={() => onRemoveStep(activeStep.id)}
            >
              <Trash2 size={15} />
              删除
            </button>
          </div>
          <input
            className="android-input"
            placeholder="步骤名称，例如：点击红包"
            value={activeStep.title}
            onChange={(event) =>
              onUpdateStep(activeStep.id, { title: event.target.value })
            }
          />
          <textarea
            className="android-textarea"
            placeholder="备注：这一步要做什么"
            rows={4}
            value={activeStep.note}
            onChange={(event) =>
              onUpdateStep(activeStep.id, { note: event.target.value })
            }
          />
          <textarea
            className="android-textarea"
            placeholder="备注：点击后多久出现下一步、需要等待什么条件"
            rows={4}
            value={activeStep.delayNote}
            onChange={(event) =>
              onUpdateStep(activeStep.id, { delayNote: event.target.value })
            }
          />
        </div>
      )}
      <div className="android-action-row">
        <button
          className="android-button"
          disabled={!flowPreview}
          type="button"
          onClick={onCopyFlowDraft}
        >
          {copied === "flowDraft" ? <Check size={16} /> : <Copy size={16} />}
          {copied === "flowDraft" ? "已复制规则" : "复制流程规则"}
        </button>
        <button
          className="android-button android-button-primary"
          disabled={steps.length === 0}
          type="button"
          onClick={onCopyFlowPrompt}
        >
          {copied === "flowPrompt" ? (
            <Check size={16} />
          ) : (
            <ClipboardCopy size={16} />
          )}
          {copied === "flowPrompt" ? "已复制 prompt" : "复制流程求助 prompt"}
        </button>
      </div>
      {flowPreview ? (
        <pre className="android-code-preview">
          <code>{flowPreview}</code>
        </pre>
      ) : (
        <p className="android-muted">至少有一个步骤选中候选 selector 后才会生成流程规则。</p>
      )}
    </div>
  );
}

function CandidateSummary({
  candidates,
  selectedId,
  importedSelectorKeys,
  onSelect,
  onAddToTestZone,
}: {
  candidates: SelectorCandidate[];
  selectedId: string | null;
  importedSelectorKeys: Set<string>;
  onSelect: (candidate: SelectorCandidate) => void;
  onAddToTestZone: (candidate: SelectorCandidate) => void;
}) {
  if (candidates.length === 0) {
    return <p className="android-muted">选择控件后会生成候选 selector。</p>;
  }

  return (
    <div className="android-candidate-list">
      {candidates.slice(0, 6).map((candidate, index) => {
        const guidance = getCandidateGuidance(candidate, index);
        const imported = importedSelectorKeys.has(candidate.rule.matches.join("\n"));

        return (
          <button
            key={candidate.id}
            className={`android-candidate-item ${
              candidate.id === selectedId ? "android-candidate-active" : ""
            }`}
            type="button"
            onClick={() => onSelect(candidate)}
          >
            <span className={`candidate-guidance ${guidance.tone}`}>
              <strong>{guidance.label}</strong>
              <span>{guidance.reason}</span>
            </span>
            {imported && <span className="candidate-imported-badge">导入过</span>}
            <span className="android-candidate-heading">
              <span className={`status-badge ${candidate.risk.level}`}>
                {riskLabel(candidate.risk.level)}
              </span>
              <span>{humanStrategyTitle(candidate.strategyName)}</span>
              <strong>{candidate.risk.finalScore}</strong>
            </span>
            {sameRegionLabel(candidate) && <span>{sameRegionLabel(candidate)}</span>}
            <span>{humanStrategyDesc(candidate)}</span>
            <small>{formatScoreNote(candidate)}</small>
            <code>{candidate.rule.matches.join(" && ")}</code>
            <small>{formatCandidateAction(candidate)}</small>
            <span
              role="button"
              tabIndex={0}
              className="android-candidate-add"
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
            <CandidateRiskNotes candidate={candidate} />
          </button>
        );
      })}
    </div>
  );
}

function sameRegionLabel(candidate: SelectorCandidate): string | null {
  const reason = candidate.debugReasons.find((item) => item.startsWith("同框节点 #"));
  return reason ? `同框候选：${reason.replace("同框节点 ", "")}` : null;
}

function CandidateRiskNotes({ candidate }: { candidate: SelectorCandidate }) {
  const notes = [
    ...candidate.risk.items
      .filter((item) => item.label !== "基础策略")
      .slice(0, 3)
      .map((item) => item.reason),
    ...candidate.riskNotes.slice(0, 2),
  ];

  if (notes.length === 0) return null;

  return (
    <span className="android-candidate-risk-list">
      {notes.map((note) => (
        <em key={note}>{note}</em>
      ))}
    </span>
  );
}

function riskLabel(level: SelectorCandidate["risk"]["level"]): string {
  if (level === "low") return "低风险";
  if (level === "medium") return "中风险";
  return "高风险";
}

function humanStrategyTitle(strategyName: SelectorCandidate["strategyName"]): string {
  const titles: Record<SelectorCandidate["strategyName"], string> = {
    stableResourceSemantic: "稳定资源 + 跳过语义",
    exactVid: "控件 vid 定位",
    exactId: "完整 id 定位",
    exactDesc: "无障碍描述定位",
    typePlusExactAttr: "控件类型收窄",
    exactTextWithContext: "上下文保护短文本",
    textSkipGuarded: "开屏跳过按钮",
    clickParentDirectChildText: "点击可点父节点",
    clickParentByChildIdVid: "子控件定位父点击",
    simpleSiblingCancelVsCTA: "旁边按钮确认位置",
    simpleContextRelation: "同层提示确认位置",
    adContainerSkipFallback: "广告容器内跳过兜底",
    clickableAncestorFallback: "可点击父区域兜底",
    visibleNodeFallback: "可见节点兜底",
  };
  return titles[strategyName];
}

function humanStrategyDesc(candidate: SelectorCandidate): string {
  const hitText =
    candidate.validation.hitCount === 1
      ? "当前快照唯一命中"
      : `当前快照命中 ${candidate.validation.hitCount} 个`;
  const suffix: Record<SelectorCandidate["strategyName"], string> = {
    stableResourceSemantic: "优先避开倒计时文本",
    exactVid: "通常比文本更稳定",
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
  return `${hitText}，${suffix[candidate.strategyName]}`;
}

function formatScoreNote(candidate: SelectorCandidate): string {
  const penalty =
    candidate.risk.penaltyScore < 0 ? ` ${candidate.risk.penaltyScore}` : "";
  const rank =
    candidate.actionPlan.rankAdjustment !== 0
      ? `；执行策略排序 ${
          candidate.actionPlan.rankAdjustment > 0 ? "+" : ""
        }${candidate.actionPlan.rankAdjustment}`
      : "";

  return `评分 = min(100, 基础分和加分 ${candidate.risk.positiveScore})${penalty} = ${candidate.risk.finalScore}${rank}`;
}

function formatCandidateAction(candidate: SelectorCandidate): string {
  const plan = candidate.actionPlan;
  const parts = [
    plan.action ? `action=${plan.action}` : "",
    plan.actionDelay ? `delay=${plan.actionDelay}` : "",
    plan.actionMaximum ? `max=${plan.actionMaximum}` : "",
    plan.actionCd ? `cd=${plan.actionCd}` : "",
    plan.forcedTime ? `forced=${plan.forcedTime}` : "",
    plan.matchRoot ? "matchRoot" : "",
  ].filter(Boolean);

  return parts.length ? parts.join(" / ") : "默认点击";
}

function TargetSummary({
  pickResult,
  selectedCandidate,
}: {
  pickResult: NodePickResult | null;
  selectedCandidate: SelectorCandidate | null;
}) {
  if (!pickResult) {
    return <p className="android-muted">点击截图上的关闭、跳过或目标按钮。</p>;
  }

  return (
    <div className="android-target-summary">
      <strong>#{pickResult.pickedNode.id} {nodeLabel(pickResult.pickedNode)}</strong>
      <span>{pickResult.pickedNode.attr.name}</span>
      {selectedCandidate && (
        <code>{selectedCandidate.rule.matches.join(" && ")}</code>
      )}
    </div>
  );
}

function RuntimeSummary({ settings }: { settings: RuleSettings }) {
  return (
    <div className="android-runtime-grid">
      <span>group: {settings.groupName || "-"}</span>
      <span>activity: {settings.activityIds || "留空"}</span>
      <span>matchTime: {settings.matchTime ?? "留空"}</span>
      <span>max: {settings.actionMaximum ?? "留空"}</span>
      <span>cd: {settings.actionCd ?? "留空"}</span>
      <span>reset: {settings.resetMatch || "留空"}</span>
    </div>
  );
}

function reconcileActivity(
  current: RuleSettings,
  previousSnapshot: ParsedGkdSnapshot | null,
  nextSnapshot: ParsedGkdSnapshot,
): RuleSettings {
  if (!previousSnapshot) return current;
  if (current.activityIds.trim() !== previousSnapshot.activityId) return current;
  return {
    ...current,
    activityIds: nextSnapshot.activityId,
  };
}

function shortActivity(activityId: string): string {
  return activityId.split(".").slice(-2).join(".");
}

function resolveConnectOrigin(input: string): string {
  const origins = extractDeviceOrigins(input);
  return origins[0] ?? input;
}
