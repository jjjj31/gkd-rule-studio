/**
 * 应用入口。URL 带 ?mode=android 或 #android 走 AndroidLiteApp，否则走 DesktopApp。
 * DesktopApp 是三个栏的经典布局（左截图、中节点树+候选、右设置+规则预览）；
 * AndroidLiteApp 是单个标签页切换布局（底部五个 tab）。
 * @see AndroidLiteApp 安卓版主组件（当前主线）
 */
import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Home,
  ListChecks,
  Settings,
  TerminalSquare,
  X,
} from "lucide-react";
import { AiCandidatesPanel } from "./components/AiCandidatesPanel";
import { AiConfigPanel } from "./components/AiConfigPanel";
import { AndroidLiteApp } from "./components/AndroidLiteApp";
import { CandidateList } from "./components/CandidateList";
import { CollapsiblePanel } from "./components/CollapsiblePanel";
import { CustomScenarioPanel } from "./components/CustomScenarioPanel";
import { FlowPanel } from "./components/FlowPanel";
import { HelpPromptPanel } from "./components/HelpPromptPanel";
import { HomePage } from "./components/HomePage";
import { InlineTestingPanel } from "./components/InlineTestingPanel";
import { NodeTreePanel } from "./components/NodeTreePanel";
import { RulePreview } from "./components/RulePreview";
import { RuleSettingsPanel } from "./components/RuleSettingsPanel";
import { ScreenshotCanvas } from "./components/ScreenshotCanvas";
import { SnapshotLoader } from "./components/SnapshotLoader";
import { SubscriptionRepoPanel } from "./components/SubscriptionRepoPanel";
import { TestSubscriptionPanel } from "./components/TestSubscriptionPanel";
import { DEFAULT_RULE_SETTINGS } from "./data/ruleSettings";
import {
  loadAiConfig,
  loadAiProfileStore,
  saveAiProfileStore,
  getActiveAiProfile,
  type AiModelConfig,
  type AiModelProfileStore,
} from "./lib/aiModel";
import { buildFlowHelpPrompt } from "./lib/flowDraft";
import { buildHelpPrompt } from "./lib/helpPrompt";
import {
  createEmptyInlineRuleTestingState,
  prunePersistentInlineRuleTestingState,
  type InlineAiSession,
  type InlineRuleTestItem,
  type InlineRuleTestingState,
} from "./lib/inlineRuleTesting";
import { pickExistingNode, pickNodeAtPoint } from "./lib/nodePicker";
import { getAdjacentFlowSnapshotId } from "./lib/flowSteps";
import { generateRegionSelectorCandidates } from "./lib/regionCandidates";
import { createAppRuleDraft, selectFallbackCandidates } from "./lib/ruleDraft";
import {
  DEBUG_GKD_PACKAGE,
  OFFICIAL_GKD_PACKAGE,
  readStoredTargetPackage,
  storeTargetPackage,
  type GkdTargetPackage,
} from "./lib/gkdTarget";
import { loadSnapshotZip } from "./lib/snapshotZip";
import {
  addAppDraftToTestSubscription,
  createEmptyTestSubscription,
  type TestSubscriptionDraft,
} from "./lib/testSubscription";
import type {
  NodePickResult,
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "./types/gkdSnapshot";
import type { FlowRuleStep } from "./types/flowDraft";
import type { RuleSettings, SelectorCandidate } from "./types/ruleDraft";

export default function App() {
  const androidLiteMode =
    new URLSearchParams(window.location.search).get("mode") === "android" ||
    window.location.hash === "#android";

  return androidLiteMode ? <AndroidLiteApp /> : <DesktopApp />;
}

function DesktopApp() {
  const [view, setView] = useState<"home" | "workspace">("home");
  const [snapshot, setSnapshot] = useState<ParsedGkdSnapshot | null>(null);
  const [pickResult, setPickResult] = useState<NodePickResult | null>(null);
  const [candidates, setCandidates] = useState<SelectorCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showTestLog, setShowTestLog] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"single" | "flow">("single");
  const [flowName, setFlowName] = useState("多步骤规则");
  const [flowDesc, setFlowDesc] = useState("");
  const [flowSnapshots, setFlowSnapshots] = useState<ParsedGkdSnapshot[]>([]);
  const [flowSteps, setFlowSteps] = useState<FlowRuleStep[]>([]);
  const [activeFlowStepId, setActiveFlowStepId] = useState<string | null>(null);
  const [ruleSettings, setRuleSettings] = useState<RuleSettings>(
    DEFAULT_RULE_SETTINGS,
  );
  const [targetPackage, setTargetPackage] = useState<GkdTargetPackage>(
    readStoredTargetPackage,
  );
  const [testSubscription, setTestSubscription] = useState<TestSubscriptionDraft>(
    createEmptyTestSubscription,
  );
  const [aiConfig, setAiConfig] = useState<AiModelConfig>(loadAiConfig);
  const [aiProfileStore, setAiProfileStore] = useState<AiModelProfileStore>(
    loadAiProfileStore,
  );
  const [inlineTesting, setInlineTesting] = useState<InlineRuleTestingState>(
    loadInlineTestingState,
  );
  const [aiPanelOpen, setAiPanelOpen] = useState(false);

  const selectedCandidate = useMemo(() => {
    return candidates.find((candidate) => candidate.id === selectedId) ?? null;
  }, [candidates, selectedId]);
  const importedSelectorKeys = useMemo(
    () => new Set(testSubscription.importedSelectors),
    [testSubscription.importedSelectors],
  );
  const activeFlowStepIndex = flowSteps.findIndex(
    (step) => step.id === activeFlowStepId,
  );
  const activeFlowSnapshotIndex = snapshot
    ? flowSnapshots.findIndex((item) => item.id === snapshot.id)
    : -1;
  const previousFlowSnapshotId = getAdjacentFlowSnapshotId(
    flowSnapshots,
    snapshot?.id ?? null,
    -1,
  );
  const nextFlowSnapshotId = getAdjacentFlowSnapshotId(
    flowSnapshots,
    snapshot?.id ?? null,
    1,
  );
  const singleAiPrompt = useMemo(() => {
    return buildHelpPrompt({
      snapshot,
      pickResult,
      ruleSettings,
    });
  }, [snapshot, pickResult, ruleSettings]);
  const flowAiPrompt = useMemo(() => {
    return buildFlowHelpPrompt({ flowName, flowDesc, steps: flowSteps });
  }, [flowName, flowDesc, flowSteps]);
  const activeAiPrompt = workspaceMode === "flow" ? flowAiPrompt : singleAiPrompt;

  function handleAiConfigChange(nextConfig: AiModelConfig): void {
    setAiConfig(nextConfig);
  }

  function handleAiProfileStoreChange(nextStore: AiModelProfileStore): void {
    setAiProfileStore(nextStore);
    saveAiProfileStore(nextStore);
    const active = getActiveAiProfile(nextStore);
    if (active) setAiConfig(active.config);
  }

  useEffect(() => {
    saveInlineTestingState(inlineTesting);
  }, [inlineTesting]);

  async function handleFileSelected(file: File): Promise<void> {
    setLoading(true);
    setError(null);
    setPickResult(null);
    setCandidates([]);
    setSelectedId(null);

    try {
      const nextSnapshot = await loadSnapshotZip(file);
      openSnapshot(nextSnapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "快照读取失败");
    } finally {
      setLoading(false);
    }
  }

  function openSnapshot(nextSnapshot: ParsedGkdSnapshot): void {
    const previousSnapshot = snapshot;
    setSnapshot((previous) => {
      if (
        previous &&
        !isSnapshotInFlow(previous, flowSteps) &&
        !isSnapshotInPool(previous, flowSnapshots)
      ) {
        URL.revokeObjectURL(previous.screenshotUrl);
      }
      return nextSnapshot;
    });
    setRuleSettings((current) =>
      reconcileRuleSettingsForSnapshot(current, previousSnapshot, nextSnapshot),
    );
    setPickResult(null);
    setCandidates([]);
    setSelectedId(null);
    setActiveFlowStepId(null);
    setError(null);
    setView("workspace");
  }

  function openSnapshotsAsFlow(nextSnapshots: ParsedGkdSnapshot[]): void {
    const firstSnapshot = nextSnapshots[0];
    if (!firstSnapshot) return;

    setSnapshot(firstSnapshot);
    setRuleSettings((current) =>
      reconcileRuleSettingsForSnapshot(current, snapshot, firstSnapshot),
    );
    const nextSteps = nextSnapshots.map((item, index): FlowRuleStep => {
      return {
        id: createFlowStepId(),
        title: `步骤 ${index + 1}`,
        note: "",
        delayNote: "",
        snapshot: item,
        pickResult: null,
        candidates: [],
        selectedCandidate: null,
      };
    });
    setFlowSnapshots(nextSnapshots);
    setFlowSteps(nextSteps);
    setActiveFlowStepId(nextSteps[0]?.id ?? null);
    setFlowName(
      firstSnapshot.appInfo?.name
        ? `${firstSnapshot.appInfo.name}多步骤规则`
        : "多步骤规则",
    );
    setFlowDesc("");
    setPickResult(null);
    setCandidates([]);
    setSelectedId(null);
    setError(null);
    setWorkspaceMode("flow");
    setView("workspace");
  }

  useEffect(() => {
    function getZipFile(event: DragEvent): File | null {
      const files = Array.from(event.dataTransfer?.files ?? []);
      return files.find((file) => file.name.toLowerCase().endsWith(".zip")) ?? null;
    }

    function handleDragOver(event: DragEvent): void {
      event.preventDefault();
      setDragActive(true);
    }

    function handleDragLeave(event: DragEvent): void {
      if (event.target === document.body || event.target === document.documentElement) {
        setDragActive(false);
      }
    }

    function handleDrop(event: DragEvent): void {
      event.preventDefault();
      setDragActive(false);
      const file = getZipFile(event);
      if (!file) {
        setError("没有发现可导入的 zip 快照");
        return;
      }
      void handleFileSelected(file);
    }

    document.body.addEventListener("dragover", handleDragOver);
    document.body.addEventListener("dragleave", handleDragLeave);
    document.body.addEventListener("drop", handleDrop);

    return () => {
      document.body.removeEventListener("dragover", handleDragOver);
      document.body.removeEventListener("dragleave", handleDragLeave);
      document.body.removeEventListener("drop", handleDrop);
    };
  }, [flowSteps, snapshot]);

  function handlePointSelected(point: { x: number; y: number }): void {
    if (!snapshot) return;
    const nextPick = pickNodeAtPoint(snapshot, point);
    setPickResult(nextPick);

    if (!nextPick) {
      setError("点击位置没有可见节点");
      setCandidates([]);
      setSelectedId(null);
      syncActiveFlowStep({
        pickResult: null,
        candidates: [],
        selectedCandidate: null,
      });
      return;
    }

    setError(null);
    const nextCandidates = updateCandidates(nextPick, ruleSettings);
    syncActiveFlowStep({
      snapshot,
      pickResult: nextPick,
      candidates: nextCandidates,
      selectedCandidate: nextCandidates[0] ?? null,
    });
  }

  function handleTreeNodeSelected(node: NormalizedSnapshotNode): void {
    if (!snapshot) return;
    const nextPick = pickExistingNode(snapshot, node);
    setPickResult(nextPick);
    setError(null);
    const nextCandidates = updateCandidates(nextPick, ruleSettings);
    syncActiveFlowStep({
      snapshot,
      pickResult: nextPick,
      candidates: nextCandidates,
      selectedCandidate: nextCandidates[0] ?? null,
    });
  }

  function handleRuleSettingsChange(nextRuleSettings: RuleSettings): void {
    setRuleSettings(nextRuleSettings);
    if (pickResult) {
      const nextCandidates = updateCandidates(pickResult, nextRuleSettings);
      syncActiveFlowStep({
        candidates: nextCandidates,
        selectedCandidate: nextCandidates[0] ?? null,
      });
    }
  }

  function updateCandidates(
    nextPick: NodePickResult,
    nextRuleSettings: RuleSettings,
  ): SelectorCandidate[] {
    if (!snapshot) return [];
    const nextCandidates = generateRegionSelectorCandidates({
      snapshot,
      ruleSettings: nextRuleSettings,
      pickResult: nextPick,
    });
    setCandidates(nextCandidates);
    setSelectedId(nextCandidates[0]?.id ?? null);
    return nextCandidates;
  }

  function handleCandidateSelect(candidate: SelectorCandidate): void {
    setSelectedId(candidate.id);
    syncActiveFlowStep({
      candidates,
      selectedCandidate: candidate,
    });
  }

  function addCandidateToTestZone(candidate: SelectorCandidate): void {
    if (!snapshot) {
      setError("请先打开快照");
      return;
    }
    const draft = createAppRuleDraft(
      snapshot,
      candidate,
      selectFallbackCandidates(candidate, candidates),
    );
    setTestSubscription((current) => addAppDraftToTestSubscription(current, draft));
    setError(null);
  }

  function addCurrentSnapshotToFlow(): void {
    if (!snapshot) {
      setError("请先打开一个快照");
      return;
    }

    const nextStep: FlowRuleStep = {
      id: createFlowStepId(),
      title: `步骤 ${flowSteps.length + 1}`,
      note: "",
      delayNote: "步骤间延迟只作为 prompt 上下文，不保证强流程顺序。",
      snapshot,
      pickResult,
      candidates,
      selectedCandidate,
    };

    setFlowSteps((current) => [...current, nextStep]);
    setFlowSnapshots((current) => appendUniqueSnapshot(current, snapshot));
    setActiveFlowStepId(nextStep.id);
    setWorkspaceMode("flow");
  }

  function selectFlowStep(stepId: string): void {
    const step = flowSteps.find((item) => item.id === stepId);
    if (!step) return;

    setActiveFlowStepId(stepId);
    setSnapshot(step.snapshot);
    setPickResult(step.pickResult);
    setCandidates(step.candidates);
    setSelectedId(step.selectedCandidate?.id ?? null);
    setError(null);
    setView("workspace");
  }

  function selectAdjacentFlowSnapshot(direction: -1 | 1): void {
    const nextSnapshotId = getAdjacentFlowSnapshotId(
      flowSnapshots,
      snapshot?.id ?? null,
      direction,
    );
    const nextSnapshot = flowSnapshots.find((item) => item.id === nextSnapshotId);
    if (!nextSnapshot) return;

    setSnapshot(nextSnapshot);
    setPickResult(null);
    setCandidates([]);
    setSelectedId(null);
    setError(null);
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
      setActiveFlowStepId(null);
    }
  }

  function reorderFlowSteps(activeId: string, overId: string): void {
    if (activeId === overId) return;
    setFlowSteps((current) => {
      const sourceIndex = current.findIndex((step) => step.id === activeId);
      const targetIndex = current.findIndex((step) => step.id === overId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [sourceStep] = next.splice(sourceIndex, 1);
      if (!sourceStep) return current;
      next.splice(targetIndex, 0, sourceStep);
      return next;
    });
  }

  function syncActiveFlowStep(patch: Partial<FlowRuleStep>): void {
    if (workspaceMode !== "flow" || !activeFlowStepId) return;
    updateFlowStep(activeFlowStepId, patch);
  }

  return (
    <main className="app-shell">
      {error && <div className="error-banner">{error}</div>}
      {dragActive && <div className="drop-overlay">松开导入快照 zip</div>}

      <div hidden={view !== "home"}>
        <HomePage
          loadingFile={loading}
          onError={setError}
          onFileSelected={(file) => void handleFileSelected(file)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenSnapshot={openSnapshot}
          onOpenSnapshotsAsFlow={openSnapshotsAsFlow}
          targetPackage={targetPackage}
          onTargetPackageChange={setTargetPackage}
        />
      </div>

      {view === "workspace" && (
        <>
          <WorkspaceHeader
            aiPanelOpen={aiPanelOpen}
            flowStepCount={flowSteps.length}
            loading={loading}
            pickResult={pickResult}
            selectedCandidate={selectedCandidate}
            snapshot={snapshot}
            targetPackage={targetPackage}
            workspaceMode={workspaceMode}
            onAiPanelToggle={() => setAiPanelOpen((current) => !current)}
            onBackHome={() => setView("home")}
            onFileSelected={(file) => void handleFileSelected(file)}
            onModeChange={setWorkspaceMode}
            onOpenSettings={() => setSettingsOpen(true)}
            onTargetPackageChange={setTargetPackage}
            onToggleTestLog={() => setShowTestLog((current) => !current)}
          />
          <div className="console-grid">
            <section className="console-column left-column">
              <CollapsiblePanel
                actions={
                  <div className="viewer-actions">
                    {workspaceMode === "flow" && flowSnapshots.length > 0 && (
                      <>
                        <span className="status-badge muted">
                          步骤 {activeFlowStepIndex >= 0 ? activeFlowStepIndex + 1 : "-"} /{" "}
                          {flowSteps.length}
                        </span>
                        <button
                          aria-label="上一张快照"
                          className="icon-button"
                          disabled={!previousFlowSnapshotId}
                          type="button"
                          onClick={() => selectAdjacentFlowSnapshot(-1)}
                        >
                          <ChevronLeft size={15} />
                        </button>
                        <span className="status-badge neutral">
                          快照 {activeFlowSnapshotIndex >= 0 ? activeFlowSnapshotIndex + 1 : 0} /{" "}
                          {flowSnapshots.length}
                        </span>
                        <button
                          aria-label="下一张快照"
                          className="icon-button"
                          disabled={!nextFlowSnapshotId}
                          type="button"
                          onClick={() => selectAdjacentFlowSnapshot(1)}
                        >
                          <ChevronRight size={15} />
                        </button>
                      </>
                    )}
                    {snapshot && (
                      <span className="status-badge neutral">
                        {snapshot.screenWidth} x {snapshot.screenHeight}
                      </span>
                    )}
                  </div>
                }
                className="viewer-panel"
                subtitle="点击目标控件，或从中栏节点树选择"
                title="快照画布"
              >
                {snapshot ? (
                  <ScreenshotCanvas
                    pickResult={pickResult}
                    selectedCandidate={selectedCandidate}
                    snapshot={snapshot}
                    onPointSelected={handlePointSelected}
                  />
                ) : (
                  <div className="empty-state">等待快照</div>
                )}
              </CollapsiblePanel>
            </section>

            <section className="console-column center-column">
              <NodeTreePanel
                pickedNodeId={pickResult?.pickedNode.id ?? null}
                selectedCandidate={selectedCandidate}
                snapshot={snapshot}
                onNodeSelected={handleTreeNodeSelected}
              />
              <CandidateList
                candidates={candidates}
                importedSelectorKeys={importedSelectorKeys}
                selectedId={selectedId}
                onAddToTestZone={addCandidateToTestZone}
                onSelect={handleCandidateSelect}
              />
            </section>

            <section className="console-column right-column">
              <RuleSettingsPanel
                snapshot={snapshot}
                value={ruleSettings}
                onChange={handleRuleSettingsChange}
              />
              <CustomScenarioPanel
                snapshot={snapshot}
                onApplySettings={handleRuleSettingsChange}
              />
              {workspaceMode === "flow" ? (
                <FlowPanel
                  activeStepId={activeFlowStepId}
                  canAddCurrent={Boolean(snapshot)}
                  flowDesc={flowDesc}
                  flowName={flowName}
                  steps={flowSteps}
                  onAddCurrentStep={addCurrentSnapshotToFlow}
                  onFlowDescChange={setFlowDesc}
                  onFlowNameChange={setFlowName}
                  onRemoveStep={removeFlowStep}
                  onReorderSteps={reorderFlowSteps}
                  onSelectStep={selectFlowStep}
                  onUpdateStep={updateFlowStep}
                />
              ) : (
                <>
                  <RulePreview
                    candidate={selectedCandidate}
                    candidates={candidates}
                    snapshot={snapshot}
                    onAddToTestZone={(draft) =>
                      setTestSubscription((current) =>
                        addAppDraftToTestSubscription(current, draft),
                      )
                    }
                  />
                  <TestSubscriptionPanel
                    currentApp={
                      snapshot
                        ? {
                            id: snapshot.appId,
                            name: snapshot.appInfo?.name ?? snapshot.appId,
                          }
                        : null
                    }
                    draft={testSubscription}
                    targetPackage={targetPackage}
                    onChange={setTestSubscription}
                  />
                  <HelpPromptPanel
                    pickResult={pickResult}
                    ruleSettings={ruleSettings}
                    snapshot={snapshot}
                  />
                </>
              )}
              {aiPanelOpen && (
                <>
                  <AiCandidatesPanel
                    mode={workspaceMode}
                    config={aiConfig}
                    prompt={activeAiPrompt}
                    snapshot={snapshot}
                    inlineTesting={inlineTesting}
                    onInlineTestingChange={setInlineTesting}
                    onTestSubscriptionChange={setTestSubscription}
                  />
                  <InlineTestingPanel
                    state={inlineTesting}
                    mode={workspaceMode}
                    onStateChange={setInlineTesting}
                    onTestSubscriptionChange={setTestSubscription}
                  />
                </>
              )}
            </section>
          </div>
        </>
      )}

      <SettingsDrawer
        aiConfig={aiConfig}
        aiProfileStore={aiProfileStore}
        candidate={selectedCandidate}
        candidates={candidates}
        open={settingsOpen}
        snapshot={snapshot}
        onAiConfigChange={handleAiConfigChange}
        onAiProfileStoreChange={handleAiProfileStoreChange}
        onClose={() => setSettingsOpen(false)}
      />

      {showTestLog && (
        <TestLogDrawer
          error={error}
          pickResult={pickResult}
          selectedCandidate={selectedCandidate}
          snapshot={snapshot}
          onClose={() => setShowTestLog(false)}
        />
      )}
    </main>
  );
}

function reconcileRuleSettingsForSnapshot(
  current: RuleSettings,
  previousSnapshot: ParsedGkdSnapshot | null,
  nextSnapshot: ParsedGkdSnapshot,
): RuleSettings {
  const currentActivityIds = current.activityIds.trim();
  if (!currentActivityIds || currentActivityIds === nextSnapshot.activityId) {
    return current;
  }

  if (previousSnapshot && currentActivityIds === previousSnapshot.activityId) {
    return {
      ...current,
      activityIds: nextSnapshot.activityId,
    };
  }

  return current;
}

function isSnapshotInFlow(
  snapshot: ParsedGkdSnapshot,
  steps: FlowRuleStep[],
): boolean {
  return steps.some((step) => step.snapshot.screenshotUrl === snapshot.screenshotUrl);
}

function isSnapshotInPool(
  snapshot: ParsedGkdSnapshot,
  snapshots: ParsedGkdSnapshot[],
): boolean {
  return snapshots.some((item) => item.screenshotUrl === snapshot.screenshotUrl);
}

function appendUniqueSnapshot(
  snapshots: ParsedGkdSnapshot[],
  snapshot: ParsedGkdSnapshot,
): ParsedGkdSnapshot[] {
  if (snapshots.some((item) => item.id === snapshot.id)) {
    return snapshots;
  }
  return [...snapshots, snapshot];
}

const INLINE_TESTING_STORAGE_KEY = "gkd-rule-studio-inline-testing";

function loadInlineTestingState(): InlineRuleTestingState {
  const raw = localStorage.getItem(INLINE_TESTING_STORAGE_KEY);
  if (!raw) return createEmptyInlineRuleTestingState();
  try {
    const parsed = JSON.parse(raw) as Partial<InlineRuleTestingState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
      return createEmptyInlineRuleTestingState();
    }
    return prunePersistentInlineRuleTestingState({
      version: 1,
      items: parsed.items as InlineRuleTestItem[],
      aiSessions: Array.isArray(parsed.aiSessions)
        ? (parsed.aiSessions as InlineAiSession[]).map((session) => ({
            ...session,
            source:
              session.source === undefined && session.title?.startsWith("外部 AI /")
                ? ("external" as const)
                : session.source,
            generation: session.generation ?? 0,
          }))
        : [],
      updatedAt: parsed.updatedAt,
    });
  } catch {
    return createEmptyInlineRuleTestingState();
  }
}

function saveInlineTestingState(state: InlineRuleTestingState): void {
  localStorage.setItem(
    INLINE_TESTING_STORAGE_KEY,
    JSON.stringify(prunePersistentInlineRuleTestingState(state)),
  );
}

function createFlowStepId(): string {
  return crypto.randomUUID?.() ?? `flow-${Date.now()}-${Math.random()}`;
}

function WorkspaceHeader({
  snapshot,
  pickResult,
  selectedCandidate,
  targetPackage,
  workspaceMode,
  flowStepCount,
  loading,
  aiPanelOpen,
  onAiPanelToggle,
  onBackHome,
  onModeChange,
  onOpenSettings,
  onTargetPackageChange,
  onToggleTestLog,
  onFileSelected,
}: {
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
  selectedCandidate: SelectorCandidate | null;
  targetPackage: GkdTargetPackage;
  workspaceMode: "single" | "flow";
  flowStepCount: number;
  loading: boolean;
  aiPanelOpen: boolean;
  onAiPanelToggle: () => void;
  onBackHome: () => void;
  onModeChange: (mode: "single" | "flow") => void;
  onOpenSettings: () => void;
  onTargetPackageChange: (packageId: GkdTargetPackage) => void;
  onToggleTestLog: () => void;
  onFileSelected: (file: File) => void;
}) {
  const appTitle = snapshot?.appInfo?.name ?? snapshot?.appId ?? "等待快照";
  const contextLine = snapshot
    ? `${snapshot.appId} / ${snapshot.activityId}`
    : "从首页连接手机、导入快照或选择流程步骤";

  return (
    <header className="app-header workspace-header">
      <div className="workspace-nav">
        <button
          aria-label="回到首页"
          className="icon-button"
          type="button"
          onClick={onBackHome}
        >
          <Home size={16} />
        </button>
        <div className="brand-block">
          <div className="brand-mark">G</div>
          <div>
            <h1>规则工作台</h1>
            <p>{appTitle}</p>
          </div>
        </div>
      </div>
      <div className="top-status">
        <span className={snapshot ? "status-badge success" : "status-badge muted"}>
          {snapshot ? "快照已载入" : "未载入快照"}
        </span>
        <span className={pickResult ? "status-badge success" : "status-badge muted"}>
          {pickResult ? `目标 #${pickResult.pickedNode.id}` : "未选目标"}
        </span>
        <span
          className={
            selectedCandidate
              ? `status-badge ${selectedCandidate.risk.level}`
              : "status-badge muted"
          }
        >
          {selectedCandidate ? `评分 ${selectedCandidate.risk.finalScore}` : "无候选"}
        </span>
        <span className="status-badge neutral">
          <ListChecks size={13} />
          {workspaceMode === "flow" ? `${flowStepCount} 步` : "单步"}
        </span>
      </div>
      <div className="top-actions">
        <TargetVersionSwitch
          targetPackage={targetPackage}
          onChange={(packageId) => {
            storeTargetPackage(packageId);
            onTargetPackageChange(packageId);
          }}
        />
        <div className="mode-switch" aria-label="工作区模式">
          <button
            className={workspaceMode === "single" ? "mode-switch-active" : ""}
            type="button"
            onClick={() => onModeChange("single")}
          >
            单步
          </button>
          <button
            className={workspaceMode === "flow" ? "mode-switch-active" : ""}
            type="button"
            onClick={() => onModeChange("flow")}
          >
            流程
          </button>
        </div>
        <button className="header-button" type="button" onClick={onToggleTestLog}>
          <TerminalSquare size={16} />
          <span>测试日志</span>
        </button>
        <button
          className={`header-button ${aiPanelOpen ? "header-button-active" : ""}`}
          type="button"
          onClick={onAiPanelToggle}
        >
          <Bot size={16} />
          <span>AI</span>
        </button>
        <button className="header-button" type="button" onClick={onOpenSettings}>
          <Settings size={16} />
          <span>设置</span>
        </button>
        <SnapshotLoader loading={loading} onFileSelected={onFileSelected} />
      </div>
      <div className="workspace-context-line" title={contextLine}>
        {contextLine}
      </div>
    </header>
  );
}

function TargetVersionSwitch({
  targetPackage,
  onChange,
}: {
  targetPackage: GkdTargetPackage;
  onChange: (packageId: GkdTargetPackage) => void;
}) {
  return (
    <div className="mode-switch target-version-switch" aria-label="GKD 目标版本">
      <button
        className={targetPackage === DEBUG_GKD_PACKAGE ? "mode-switch-active" : ""}
        type="button"
        onClick={() => onChange(DEBUG_GKD_PACKAGE)}
      >
        Debug/Beta
      </button>
      <button
        className={targetPackage === OFFICIAL_GKD_PACKAGE ? "mode-switch-active" : ""}
        type="button"
        onClick={() => onChange(OFFICIAL_GKD_PACKAGE)}
      >
        正式版
      </button>
    </div>
  );
}

function SettingsDrawer({
  open,
  snapshot,
  candidate,
  candidates,
  aiConfig,
  aiProfileStore,
  onClose,
  onAiConfigChange,
  onAiProfileStoreChange,
}: {
  open: boolean;
  snapshot: ParsedGkdSnapshot | null;
  candidate: SelectorCandidate | null;
  candidates: SelectorCandidate[];
  aiConfig: AiModelConfig;
  aiProfileStore: AiModelProfileStore;
  onClose: () => void;
  onAiConfigChange: (config: AiModelConfig) => void;
  onAiProfileStoreChange: (store: AiModelProfileStore) => void;
}) {
  return (
    <>
      <button
        aria-label="关闭设置"
        className={`settings-backdrop ${open ? "settings-backdrop-open" : ""}`}
        type="button"
        onClick={onClose}
      />
      <aside
        aria-hidden={!open}
        className={`settings-drawer ${open ? "settings-drawer-open" : ""}`}
      >
        <div className="settings-drawer-header">
          <div>
            <h2>设置</h2>
            <p>订阅仓库连接、AI 模型配置、历史导入记录和撤回操作。</p>
          </div>
          <button
            aria-label="关闭设置"
            className="icon-button"
            type="button"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <AiConfigPanel
          config={aiConfig}
          profileStore={aiProfileStore}
          onConfigChange={onAiConfigChange}
          onProfileStoreChange={onAiProfileStoreChange}
        />
        <SubscriptionRepoPanel
          candidate={candidate}
          candidates={candidates}
          snapshot={snapshot}
        />
      </aside>
    </>
  );
}

function TestLogDrawer({
  snapshot,
  pickResult,
  selectedCandidate,
  error,
  onClose,
}: {
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
  selectedCandidate: SelectorCandidate | null;
  error: string | null;
  onClose: () => void;
}) {
  const logs = [
    snapshot
      ? `snapshot: ${snapshot.appId} / ${snapshot.activityId}`
      : "snapshot: waiting for input",
    pickResult
      ? `target: #${pickResult.pickedNode.id} ${pickResult.pickedNode.attr.name}`
      : "target: not selected",
    selectedCandidate
      ? `selector: ${selectedCandidate.rule.matches.join(" && ")}`
      : "selector: no candidate",
    selectedCandidate
      ? `result: hit=${selectedCandidate.validation.hitCount}, score=${selectedCandidate.risk.finalScore}, risk=${selectedCandidate.risk.level}`
      : "result: pending",
    error ? `error: ${error}` : "error: none",
  ];

  return (
    <section aria-label="测试日志" className="test-log-drawer">
      <div className="panel-title-row">
        <h2>测试日志</h2>
        <div className="panel-header-actions">
          <span className={error ? "status-badge high" : "status-badge success"}>
            {error ? "error" : "ready"}
          </span>
          <button
            aria-label="关闭测试日志"
            className="icon-button"
            type="button"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
      </div>
      <pre>
        <code>{logs.map((line) => `> ${line}`).join("\n")}</code>
      </pre>
    </section>
  );
}
