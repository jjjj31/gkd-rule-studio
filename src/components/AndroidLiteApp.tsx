/**
 * 安卓版主壳（4300+ 行），包含首页和工作区的所有逻辑和 UI。
 * 首页：连接手机 → 勾选快照 → 进入工作区
 * 工作区：截图画布 + 底部 5 个标签页（场景/候选/Prompt/步骤/AI）+ 弹出层（测试管理/session 管理/调试报告）
 * 所有状态为 ~60 个 useState，面板为文件内函数组件。
 * @see ScreenshotCanvas 放大镜交互
 * @see deviceApi HTTP 通信
 */
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Plug,
  RefreshCw,
  ScrollText,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
} from "react";
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
  reassignAndroidFlowStepSnapshot,
  resolveAndroidFlowCanvasSnapshots,
  resolveAndroidSnapshotOpenMode,
  shouldShowSnapshotOpeningState,
} from "../lib/androidLiteFlow";
import { getCandidateGuidance } from "../lib/candidateGuidance";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  debugLog,
  exportDebugReport,
  clearDebugLog,
  flushToAdbHelper,
} from "../lib/debugLog";
import {
  createDeviceApiClient,
  extractDeviceOrigins,
  type DeviceApiClient,
} from "../lib/deviceApi";
import {
  DEBUG_GKD_PACKAGE,
  OFFICIAL_GKD_PACKAGE,
  isDebugTarget,
  matchesTargetPackage,
  readStoredTargetPackage,
  storeTargetPackage,
  targetPackageLabel,
  type GkdTargetPackage,
} from "../lib/gkdTarget";
import {
  buildFlowHelpPrompt,
  createFlowAppRuleDraft,
  stringifyFlowRuleDraft,
} from "../lib/flowDraft";
import { buildHelpPrompt } from "../lib/helpPrompt";
import {
  buildAiBatchFeedbackMessages,
  buildExternalFeedbackPrompt,
  buildAiGenerateMessages,
  aiMessageTextContent,
  aiMessagesHaveImage,
  deleteAiProfile,
  getActiveAiProfile,
  loadAiProfileStore,
  loadAiConfig,
  maskApiKey,
  normalizeAiConfig,
  parseAiCandidates,
  requestAiCandidates,
  saveAiProfileStore,
  setActiveAiProfile,
  shouldRetryTextOnlyAfterMultimodalError,
  stripAiMessageImages,
  testAiConnection,
  upsertAiProfile,
  withAiGenerationTimeout,
  type AiCandidateFeedback,
  type AiChatMessage,
  type AiConnectionStatus,
  type AiFeedbackResult,
  type AiModelConfig,
  type AiModelProfile,
  type AiModelProfileStore,
  type AiRuleCandidate,
  saveConnectionStatus,
  loadConnectionStatus,
  categorizeAiError,
} from "../lib/aiModel";
import { pickNodeAtPoint } from "../lib/nodePicker";
import { generateRegionSelectorCandidates } from "../lib/regionCandidates";
import { normalizeSnapshot } from "../lib/snapshotNormalize";
import { buildSnapshotExport, saveExportedFile } from "../lib/snapshotExport";
import {
  loadSnapshotNames,
  persistSnapshotNames,
  snapshotOptionLabel,
  type SnapshotNameMap,
} from "../lib/snapshotNames";
import { validateAiCandidateAgainstSnapshot } from "../lib/selectorMatcher";
import {
  createAppRuleDraft,
  selectFallbackCandidates,
  stringifyRuleDraft,
} from "../lib/ruleDraft";
import {
  addAppDraftToTestSubscription,
  createEmptyTestSubscription,
  exportRawSubscription,
  markImportedAndClearBuffer,
  summarizeTestSubscription,
  wasSelectorImported,
  type TestSubscriptionDraft,
} from "../lib/testSubscription";
import {
  addAiSession,
  aiCandidateSourceKey,
  buildActiveTestSubscription,
  createEmptyInlineRuleTestingState,
  deleteAiSession,
  deleteInlineTestItem,
  filterAiSessionsByMode,
  findInlineTestItem,
  markInlineTestItemResult,
  prunePersistentInlineRuleTestingState,
  removeInlineTestItem,
  setAiSessionCandidates,
  startAiCandidateTest,
  startOfflineCandidateTest,
  type InlineAiSession,
  type InlineRuleTestItem,
  type InlineRuleTestingState,
  type InlineTestStatus,
} from "../lib/inlineRuleTesting";
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
type AndroidWorkspaceTab = "scene" | "candidates" | "prompt" | "steps" | "ai";
type AiOperation = "test" | "generate" | "feedback" | null;
const INLINE_TESTING_STORAGE_KEY = "gkd-rule-studio-inline-testing";
const SNAPSHOT_MEMORY_STORAGE_KEY = "gkd-rule-studio-snapshot-memory";

interface SnapshotWorkspaceMemory {
  point: NodePoint | null;
  selectedCandidateId: string | null;
}

const MAIN_TRANSIENT_MS = 2500;

export function AndroidLiteApp() {
  const [deviceUrl, setDeviceUrl] = useState(
    () => localStorage.getItem("gkd-rule-builder-device-url") ?? "",
  );
  const [targetPackage, setTargetPackage] = useState<GkdTargetPackage>(
    readStoredTargetPackage,
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
  const [exportingSnapshotId, setExportingSnapshotId] = useState<number | null>(null);
  const [snapshotNames, setSnapshotNames] = useState<SnapshotNameMap>(loadSnapshotNames);
  const [renamingSnapshotId, setRenamingSnapshotId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [openingFlow] = useState(false);
  const [copied, setCopied] = useState<
    "scene" | "rule" | "draft" | "flowDraft" | "flowPrompt" | null
  >(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [selectedAiCandidateId, setSelectedAiCandidateId] = useState<
    string | null
  >(null);
  const [activeTab, setActiveTab] = useState<AndroidWorkspaceTab>("scene");
  const [workspaceMode, setWorkspaceMode] = useState<"single" | "flow">("single");
  const [flowName, setFlowName] = useState("多步骤规则");
  const [flowDesc, setFlowDesc] = useState("");
  const [flowSteps, setFlowSteps] = useState<FlowRuleStep[]>([]);
  const [activeFlowStepId, setActiveFlowStepId] = useState<string | null>(null);
  const [testSubscription, setTestSubscription] = useState<TestSubscriptionDraft>(
    createEmptyTestSubscription,
  );
  const [inlineTesting, setInlineTesting] = useState<InlineRuleTestingState>(
    loadInlineTestingState,
  );
  const inlineTestingRef = useRef(inlineTesting);
  const [snapshotMemory, setSnapshotMemory] = useState<
    Record<string, SnapshotWorkspaceMemory>
  >(loadSnapshotWorkspaceMemory);
  const [aiProfileStore, setAiProfileStore] =
    useState<AiModelProfileStore>(loadAiProfileStore);
  const [aiConfig, setAiConfig] = useState<AiModelConfig>(loadAiConfig);
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [aiConnectionStatus, setAiConnectionStatus] =
    useState<AiConnectionStatus>(loadConnectionStatus);
  const [aiCandidates, setAiCandidates] = useState<AiRuleCandidate[]>([]);
  const [activeAiSessionId, setActiveAiSessionId] = useState<string | null>(
    () => loadInlineTestingState().aiSessions[0]?.id ?? null,
  );
  const [aiPendingCount, setAiPendingCount] = useState(0);
  const [aiOperation, setAiOperation] = useState<AiOperation>(null);
  const [aiRequestStartedAt, setAiRequestStartedAt] = useState<number | null>(null);
  const [aiElapsedSeconds, setAiElapsedSeconds] = useState(0);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [externalAiMessage, setExternalAiMessage] = useState<string | null>(null);
  const [aiPasteText, setAiPasteText] = useState("");
  const [aiGeneratedMode, setAiGeneratedMode] = useState<"single" | "flow" | null>(
    null,
  );
  const [externalAiCandidates, setExternalAiCandidates] = useState<
    AiRuleCandidate[]
  >([]);
  const [externalAiMode, setExternalAiMode] = useState<"single" | "flow" | null>(
    null,
  );
  const [externalAiSessionId, setExternalAiSessionId] = useState<string | null>(
    null,
  );
  const [aiDebugLogs, setAiDebugLogs] = useState<string[]>([]);
  const [aiSessionManagerOpen, setAiSessionManagerOpen] = useState(false);
  const [logPageOpen, setLogPageOpen] = useState(false);
  const [testPageOpen, setTestPageOpen] = useState(false);
  const [flowPreparing, setFlowPreparing] = useState(false);
  const pushedWorkspaceHistoryRef = useRef(false);
  const aiMessageTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const mainMessageTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const externalAiMessageTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const prolongedMainRef = useRef(false);
  const syncQueueRef = useRef<{
    running: boolean;
    pendingState: InlineRuleTestingState | null;
    pendingMessage: string;
  }>({ running: false, pendingState: null, pendingMessage: "" });
  const activeFlowStep =
    flowSteps.find((step) => step.id === activeFlowStepId) ?? null;
  const effectiveRuleSettings =
    workspaceMode === "flow"
      ? activeFlowStep?.ruleSettings ?? ruleSettings
      : ruleSettings;

  const candidates = useMemo(() => {
    if (!snapshot || !pickResult) return [];
    return generateRegionSelectorCandidates({
      snapshot,
      ruleSettings: effectiveRuleSettings,
      pickResult,
    });
  }, [snapshot, pickResult, effectiveRuleSettings]);
  const selectedCandidate = useMemo(() => {
    // 当 AI 候选被选中时，不要让普通候选回退到 candidates[0]，
    // 否则画布会同时显示普通候选的命中框而不是 AI 候选的。
    if (selectedCandidateId === null && selectedAiCandidateId !== null) {
      return null;
    }
    return (
      candidates.find((candidate) => candidate.id === selectedCandidateId) ??
      candidates[0] ??
      null
    );
  }, [candidates, selectedCandidateId, selectedAiCandidateId]);
  const selectedAiCandidate = selectedAiCandidateId
    ? (aiCandidates.find((c) => c.id === selectedAiCandidateId) ??
      externalAiCandidates.find((c) => c.id === selectedAiCandidateId) ??
      null)
    : null;
  const aiValidation = useMemo(() => {
    if (!selectedAiCandidate || !snapshot) return null;
    return validateAiCandidateAgainstSnapshot(selectedAiCandidate, snapshot);
  }, [selectedAiCandidate, snapshot]);
  const customScenarioEditorOpen = scenarioId === CUSTOM_SCENARIO_OPTION_ID;
  const flowDraft = useMemo(() => {
    return createFlowAppRuleDraft({ flowName, flowDesc, steps: flowSteps });
  }, [flowName, flowDesc, flowSteps]);
  const flowPreview = flowDraft ? stringifyFlowRuleDraft(flowDraft) : "";
  const flowPrompt = useMemo(() => {
    return buildFlowHelpPrompt({ flowName, flowDesc, steps: flowSteps });
  }, [flowName, flowDesc, flowSteps]);
  const singleAiPrompt = useMemo(() => {
    return buildHelpPrompt({
      snapshot,
      pickResult,
      ruleSettings,
    });
  }, [snapshot, pickResult, ruleSettings]);
  const selectedSnapshotList = useMemo(
    () => snapshots.filter((item) => selectedSnapshotIds.has(item.id)),
    [snapshots, selectedSnapshotIds],
  );
  const flowCanvasSnapshots = useMemo(
    () =>
      resolveAndroidFlowCanvasSnapshots({
        selectedSnapshots: selectedSnapshotList,
        availableSnapshots: snapshots,
        steps: flowSteps,
      }),
    [flowSteps, selectedSnapshotList, snapshots],
  );
  const activeSelectedSnapshotIndex = snapshot
    ? selectedSnapshotList.findIndex((item) => item.id === snapshot.id)
    : -1;
  const activeFlowSnapshotIndex = snapshot
    ? flowCanvasSnapshots.findIndex((item) => item.id === snapshot.id)
    : -1;
  const activeAiProfile = getActiveAiProfile(aiProfileStore);
  const aiLoading = aiPendingCount > 0;
  const currentAiSessionSnapshotId =
    workspaceMode === "flow" ? activeFlowStep?.snapshot.id : snapshot?.id;
  const currentAiSessionControlKey =
    workspaceMode === "flow"
      ? flowSteps.length > 0
        ? `flow:${flowSteps.map((step) => step.snapshot.id).join(",")}`
        : ""
      : controlKeyForPick(snapshot, pickResult);
  const visibleAiSessions = filterAiSessionsByMode(inlineTesting, workspaceMode).filter(
    (session) => session.source !== "external",
  );
  const externalAiSession =
    externalAiSessionId
      ? inlineTesting.aiSessions.find((session) => session.id === externalAiSessionId) ??
        null
      : null;
  const activeAiSession =
    visibleAiSessions.find(
      (session) =>
        session.id === activeAiSessionId &&
        sessionMatchesCurrentAiContext(
          session,
          currentAiSessionSnapshotId,
          currentAiSessionControlKey,
        ),
    ) ??
    visibleAiSessions.find((session) =>
      sessionMatchesCurrentAiContext(
        session,
        currentAiSessionSnapshotId,
        currentAiSessionControlKey,
      ),
    ) ??
    null;
  const activeAiSessionHasTestingItem = activeAiSession
    ? inlineTesting.items.some(
        (item) =>
          item.aiSessionId === activeAiSession.id && item.status === "testing",
      )
    : false;
  const canGenerateAiRules =
    !activeAiSession ||
    (activeAiSession.candidates.length === 0 && !activeAiSessionHasTestingItem);

  useEffect(() => {
    function handlePopState(): void {
      if (!pushedWorkspaceHistoryRef.current) return;
      pushedWorkspaceHistoryRef.current = false;
      setView("home");
      setMessage(null);
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      clearAllTransientMessages();
    };
  }, []);

  useEffect(() => {
    const recoverPointerEvents = () => {
      if (document.body.style.pointerEvents === "none") {
        document.body.style.pointerEvents = "";
      }
      if (document.documentElement.style.pointerEvents === "none") {
        document.documentElement.style.pointerEvents = "";
      }
    };

    recoverPointerEvents();
    const timer = window.setInterval(recoverPointerEvents, 1200);
    window.addEventListener("pointerup", recoverPointerEvents);
    window.addEventListener("touchend", recoverPointerEvents);
    window.addEventListener("touchcancel", recoverPointerEvents);
    window.addEventListener("blur", recoverPointerEvents);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerup", recoverPointerEvents);
      window.removeEventListener("touchend", recoverPointerEvents);
      window.removeEventListener("touchcancel", recoverPointerEvents);
      window.removeEventListener("blur", recoverPointerEvents);
    };
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

  useEffect(() => {
    window.GkdAndroidBridge?.setBackVisible?.(view === "workspace");
    window.__GkdAndroidBack = () => backHome();
    return () => {
      window.__GkdAndroidBack = undefined;
      window.GkdAndroidBridge?.setBackVisible?.(false);
    };
  }, [view]);

  useEffect(() => {
    inlineTestingRef.current = inlineTesting;
    saveInlineTestingState(inlineTesting);
  }, [inlineTesting]);

  useEffect(() => {
    saveSnapshotWorkspaceMemory(snapshotMemory);
  }, [snapshotMemory]);

  useEffect(() => {
    if (!activeAiSession) {
      setAiCandidates([]);
      setAiGeneratedMode(null);
      return;
    }
    setAiCandidates(activeAiSession.candidates ?? []);
    setAiGeneratedMode(activeAiSession.mode);
  }, [activeAiSession?.id]);

  useEffect(() => {
    if (workspaceMode !== "flow" && activeTab === "steps") {
      setActiveTab("prompt");
    }
  }, [workspaceMode, activeTab]);

  useEffect(() => {
    if (!aiLoading || !aiRequestStartedAt) {
      setAiElapsedSeconds(0);
      return;
    }

    const updateElapsed = () =>
      setAiElapsedSeconds(Math.max(0, Math.floor((Date.now() - aiRequestStartedAt) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [aiLoading, aiRequestStartedAt]);

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
      if (matchesTargetPackage(nextClient.serverInfo.gkdAppInfo?.id, targetPackage)) {
        showMainTransient("连接成功");
      } else {
        setMessage(
          `已连接，但当前目标是 ${targetPackageLabel(
            targetPackage,
          )}，HTTP 服务来自 ${nextClient.serverInfo.gkdAppInfo?.id ?? "未知包名"}`,
        );
      }
      debugLog("network", "connect:ok", nextClient.origin, {
        serverInfo: nextClient.serverInfo,
        snapshotCount: nextSnapshots.length,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "连接设备失败";
      debugLog("error", "connect:fail", msg);
      setMessage(msg);
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
      showMainTransient(`刷新成功：${nextSnapshots.length} 条快照`);
      debugLog("snapshot", "refresh:ok", `${nextSnapshots.length} snapshots`, {
        snapshotCount: nextSnapshots.length,
        selectedSnapshotId: selectedSnapshotId,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "刷新快照失败";
      debugLog("error", "refresh:fail", msg);
      setMessage(msg);
    } finally {
      setLoading(false);
    }
  }

  /** 首页导出：拉取快照数据 + 截图，保存为 Markdown 文档和 PNG 两个文件。 */
  async function exportSnapshotFromHome(item: DeviceSnapshotSummary): Promise<void> {
    if (!client || exportingSnapshotId !== null) return;

    setExportingSnapshotId(item.id);
    setMessage(null);
    try {
      const [raw, screenshot] = await Promise.all([
        client.getSnapshot(item.id),
        client.getScreenshot(item.id),
      ]);
      const parsed = normalizeSnapshot(raw, "", `设备快照 ${item.id}`);
      const files = buildSnapshotExport(
        parsed,
        new Date(),
        snapshotNames[String(item.id)],
      );
      await saveExportedFile(
        files.screenshotName,
        new Blob([screenshot], { type: "image/png" }),
      );
      await saveExportedFile(
        files.markdownName,
        new Blob([files.markdownContent], { type: "text/markdown" }),
      );
      showMainTransient(`已导出：${files.markdownName} + 截图`);
      debugLog("snapshot", "export:ok", `id=${item.id}`, {
        id: item.id,
        appId: parsed.appId,
        nodeCount: parsed.nodes.length,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "导出快照失败";
      debugLog("error", "export:fail", msg, { id: item.id });
      setMessage(msg);
    } finally {
      setExportingSnapshotId(null);
    }
  }

  async function loadDeviceSnapshot(
    id: number | string = selectedSnapshotId,
    targetClient = client,
  ): Promise<void> {
    if (!targetClient || !id) return;

    const numericId = Number(id);
    if (shouldShowSnapshotOpeningState("flow-canvas")) {
      setOpeningId(numericId);
    }
    setMessage(null);
    try {
      const nextSnapshot = await targetClient.loadSnapshot(numericId);
      openSnapshot(nextSnapshot);
      setSelectedSnapshotId(String(numericId));
      setMessage(null);
      debugLog("snapshot", "load:ok", `id=${numericId} appId=${nextSnapshot.appId}`, {
        id: numericId,
        appId: nextSnapshot.appId,
        activityId: nextSnapshot.activityId,
        nodeCount: nextSnapshot.nodes.length,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "加载快照失败";
      debugLog("error", "load:fail", msg, { id });
      setMessage(msg);
    } finally {
      setOpeningId(null);
    }
  }

  function openSnapshot(nextSnapshot: ParsedGkdSnapshot): void {
    const previousSnapshot = snapshot;
    if (previousSnapshot) {
      setSnapshotMemory((current) => ({
        ...current,
        [String(previousSnapshot.id)]: {
          point: pickResult?.point ?? null,
          selectedCandidateId,
        },
      }));
    }
    const remembered = snapshotMemory[String(nextSnapshot.id)] ?? null;
    const rememberedPick = remembered?.point
      ? pickNodeAtPoint(nextSnapshot, remembered.point)
      : null;
    setSnapshot((previous) => {
      if (previous) URL.revokeObjectURL(previous.screenshotUrl);
      return nextSnapshot;
    });
    setPickResult(rememberedPick);
    setSelectedCandidateId(remembered?.selectedCandidateId ?? null);
    // 切到新快照时清掉上一张快照残留的 AI 候选 / 选区，避免旧 AI 提示还停在新画布上。
    clearAiCandidateState();
    clearAllTransientMessages();
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
    if (!nextPick) {
      setSelectedCandidateId(null);
      setSelectedAiCandidateId(null);
      setSnapshotMemory((current) => ({
        ...current,
        [String(snapshot.id)]: {
          point,
          selectedCandidateId: null,
        },
      }));
      setMessage("点击位置没有可见节点");
      debugLog("pick", "tap:miss", `point=(${point.x},${point.y}) snapshot=${snapshot.id}`, {
        point,
        snapshotId: snapshot.id,
      });
      syncActiveFlowStep({
        pickResult: null,
        candidates: [],
        selectedCandidate: null,
      });
      return;
    }
    debugLog("pick", "tap:hit", `node=#${nextPick.pickedNode.id} ${nodeLabel(nextPick.pickedNode)}`, {
      point,
      nodeId: nextPick.pickedNode.id,
      nodeLabel: nodeLabel(nextPick.pickedNode),
      ancestors: nextPick.ancestors.map((n) => ({ id: n.id, label: nodeLabel(n) })),
      clickableAncestor: nextPick.clickableAncestor?.id,
    });
    const nextCandidates = buildCandidates(snapshot, effectiveRuleSettings, nextPick);
    // 保留用户之前手动选的卡：在同一组候选中按 matches 匹配，不过度覆盖用户的意图
    const previousSelected = candidates.find(
      (c) => c.id === selectedCandidateId,
    );
    const previousMatchesKey =
      previousSelected?.rule.matches.join(" && ") ?? null;
    let nextSelectedCandidate = nextCandidates[0] ?? null;
    if (previousMatchesKey) {
      const kept = nextCandidates.find(
        (c) => c.rule.matches.join(" && ") === previousMatchesKey,
      );
      if (kept) nextSelectedCandidate = kept;
    }
    setSelectedCandidateId(nextSelectedCandidate?.id ?? null);
    setSnapshotMemory((current) => ({
      ...current,
      [String(snapshot.id)]: {
        point,
        selectedCandidateId: nextSelectedCandidate?.id ?? null,
      },
    }));
    setActiveTab("candidates");
    debugLog("candidate", "generated", `${nextCandidates.length} candidates`, {
      count: nextCandidates.length,
      top: nextCandidates.slice(0, 3).map((c) => ({
        strategy: c.strategyName,
        score: c.risk.finalScore,
        matches: c.rule.matches.join(" && "),
      })),
    });
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
    if (!nextSettings) return;

    if (workspaceMode === "flow" && activeFlowStep) {
      // flow 模式：场景参数写入当前激活步骤，候选重算后写回 step
      const { nextCandidates, nextSelected } = applyScenarioToCandidates({
        nextSettings,
        snapshot: activeFlowStep.snapshot,
        pickResult: activeFlowStep.pickResult,
        previousCandidates: activeFlowStep.candidates,
        previousSelectedId: activeFlowStep.selectedCandidate?.id ?? null,
      });
      updateFlowStep(activeFlowStep.id, {
        ruleSettings: nextSettings,
        scenarioId: nextScenarioId,
        candidates: nextCandidates,
        selectedCandidate: nextSelected,
      });
      // 如果当前画布就是该步骤的快照，同步本地候选状态
      if (snapshot?.id === activeFlowStep.snapshot.id) {
        setSelectedCandidateId(nextSelected?.id ?? null);
      }
    } else {
      // single 模式：写全局 ruleSettings + 本地候选
      setRuleSettings(nextSettings);
      if (snapshot && pickResult) {
        const { nextSelected } = applyScenarioToCandidates({
          nextSettings,
          snapshot,
          pickResult,
          previousCandidates: candidates,
          previousSelectedId: selectedCandidateId,
        });
        setSelectedCandidateId(nextSelected?.id ?? null);
        // 不调 syncActiveFlowStep（single 模式无需同步到步骤）
      }
    }
  }

  /** flow 模式：在步骤编辑器中切换场景 → 更新该步骤的 ruleSettings 并重算候选。 */
  function handleStepScenarioChange(
    stepId: string,
    nextScenarioId: string,
  ): void {
    const step = flowSteps.find((s) => s.id === stepId);
    if (!step) return;

    const preset = RULE_SETTINGS_PRESETS.find(
      (item) => item.id === nextScenarioId,
    );
    const custom = customScenarios.find(
      (item) => item.id === nextScenarioId,
    );
    const nextSettings =
      preset?.build(step.snapshot) ??
      (custom
        ? resolveCustomScenarioSettings(custom, step.snapshot)
        : undefined);
    if (!nextSettings) return;

    const { nextCandidates, nextSelected } = applyScenarioToCandidates({
      nextSettings,
      snapshot: step.snapshot,
      pickResult: step.pickResult,
      previousCandidates: step.candidates,
      previousSelectedId: step.selectedCandidate?.id ?? null,
    });
    updateFlowStep(stepId, {
      ruleSettings: nextSettings,
      scenarioId: nextScenarioId,
      candidates: nextCandidates,
      selectedCandidate: nextSelected,
    });
    // 如果当前画布就是该步骤的快照，同步本地候选状态
    if (snapshot?.id === step.snapshot.id) {
      setSelectedCandidateId(nextSelected?.id ?? null);
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
      ruleSettings,
    });
    await copyTextToClipboard(prompt);
    markCopied("rule");
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
    await loadDeviceSnapshot(openMode.ids[0], client);
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
      showMainTransient(`已导入场景：${scenario.name}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "导入自定义场景失败");
    }
  }

  function addCurrentSnapshotToFlow(): void {
    if (!snapshot) {
      setMessage("请先打开一个快照");
      return;
    }

    // 新建步骤默认继承最后一步的场景（同屏多动作时省事）
    const lastStep = flowSteps.length > 0 ? flowSteps[flowSteps.length - 1] : null;
    const inheritedRuleSettings = lastStep?.ruleSettings ?? ruleSettings;
    const inheritedScenarioId = lastStep?.scenarioId ?? scenarioId;

    const nextStep: FlowRuleStep = {
      id: `android-flow-${snapshot.id}-${Date.now()}`,
      title: "",
      note: "",
      delayNote: "",
      ruleSettings: inheritedRuleSettings,
      scenarioId: inheritedScenarioId,
      snapshot,
      pickResult: null,
      candidates: [],
      selectedCandidate: null,
    };

    setFlowSteps((current) => [...current, nextStep]);
    setActiveFlowStepId(nextStep.id);
    setPickResult(null);
    setSelectedCandidateId(null);
    setWorkspaceMode("flow");
    setActiveTab("scene");
    showMainTransient("已添加新步骤，请在当前快照上选择目标控件");
  }

  function selectFlowStep(stepId: string): void {
    const step = flowSteps.find((item) => item.id === stepId);
    if (!step) return;

    setActiveFlowStepId(step.id);
    setSnapshot(step.snapshot);
    setSelectedSnapshotId(String(step.snapshot.id));
    setPickResult(step.pickResult);
    setSelectedCandidateId(step.selectedCandidate?.id ?? null);
    clearAiCandidateState();
    setMessage(null);
  }

  async function selectAdjacentFlowSnapshot(direction: -1 | 1): Promise<void> {
    if (!client || flowCanvasSnapshots.length <= 1) return;
    const currentIndex = activeFlowSnapshotIndex >= 0 ? activeFlowSnapshotIndex : 0;
    const next = flowCanvasSnapshots[currentIndex + direction];
    if (!next) return;
    await loadFlowCanvasSnapshot(next.id, client);
  }

  async function selectAdjacentSingleSnapshot(direction: -1 | 1): Promise<void> {
    if (!client || selectedSnapshotList.length <= 1) return;
    const currentIndex = activeSelectedSnapshotIndex >= 0 ? activeSelectedSnapshotIndex : 0;
    const next = selectedSnapshotList[currentIndex + direction];
    if (!next) return;
    await loadDeviceSnapshot(next.id, client);
  }

  function clearAiCandidateState(): void {
    setSelectedAiCandidateId(null);
    setAiCandidates([]);
    setAiGeneratedMode(null);
    setActiveAiSessionId(null);
    setExternalAiCandidates([]);
    setExternalAiMode(null);
    setExternalAiSessionId(null);
  }

  async function loadFlowCanvasSnapshot(
    id: number | string,
    targetClient = client,
  ): Promise<void> {
    if (!targetClient || !id) return;

    const numericId = Number(id);
    if (shouldShowSnapshotOpeningState("flow-canvas")) {
      setOpeningId(numericId);
    }
    setMessage(null);
    try {
      const nextSnapshot =
        snapshot?.id === numericId ? snapshot : await targetClient.loadSnapshot(numericId);
      const activeStep =
        flowSteps.find((step) => step.id === activeFlowStepId) ?? null;
      const stepIsOnNextSnapshot = activeStep?.snapshot.id === nextSnapshot.id;
      setSnapshot(nextSnapshot);
      if (activeStep && !stepIsOnNextSnapshot) {
        // 当前步骤绑定的是另一张快照 → 直接改绑，清空旧选点和候选
        setFlowSteps((current) =>
          current.map((step) =>
            step.id === activeStep.id
              ? reassignAndroidFlowStepSnapshot(step, nextSnapshot)
              : step,
          ),
        );
        setPickResult(null);
        setSelectedCandidateId(null);
        clearAiCandidateState();
        showMainTransient(`已切到快照 #${nextSnapshot.id}，请选择目标控件`);
      } else if (stepIsOnNextSnapshot) {
        // 当前步骤本来就绑定这张快照 → 恢复步骤上的选点
        setPickResult(activeStep?.pickResult ?? null);
        setSelectedCandidateId(
          activeStep?.selectedCandidate?.id ?? null,
        );
      } else {
        // 没有激活步骤 → 清空
        setPickResult(null);
        setSelectedCandidateId(null);
      }
      setSelectedSnapshotId(String(numericId));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "切换快照失败");
    } finally {
      if (shouldShowSnapshotOpeningState("flow-canvas")) {
        setOpeningId(null);
      }
    }
  }

  async function switchToFlowMode(): Promise<void> {
    if (!client || flowPreparing) return;
    const ids =
      selectedSnapshotIds.size > 0
        ? snapshots.filter((item) => selectedSnapshotIds.has(item.id)).map((item) => item.id)
        : snapshot
          ? [snapshot.id]
          : [];
    const flowStepIds = flowSteps.map((step) => step.snapshot.id);
    const canReuseFlow =
      flowSteps.length > 0 &&
      ids.length === flowStepIds.length &&
      ids.every((id, index) => id === flowStepIds[index]);

    if (canReuseFlow) {
      setWorkspaceMode("flow");
      return;
    }

    setFlowPreparing(true);
    setMessage(null);
    try {
      const loadedSnapshots: ParsedGkdSnapshot[] = [];
      for (const id of ids) {
        if (snapshot?.id === id) {
          loadedSnapshots.push(snapshot);
        } else {
          loadedSnapshots.push(await client.loadSnapshot(id));
        }
      }
      const steps = createAndroidFlowSteps(loadedSnapshots);
      const firstStep = steps[0] ?? null;
      if (!firstStep) {
        setMessage("请先打开快照");
        return;
      }
      setFlowSteps(steps);
      setActiveFlowStepId(firstStep.id);
      setFlowName(
        firstStep.snapshot.appInfo?.name
          ? `${firstStep.snapshot.appInfo.name}多步骤规则`
          : "多步骤规则",
      );
      setFlowDesc("");
      setSnapshot(firstStep.snapshot);
      setPickResult(firstStep.pickResult);
      setSelectedCandidateId(firstStep.selectedCandidate?.id ?? null);
      setSelectedSnapshotId(String(firstStep.snapshot.id));
      setWorkspaceMode("flow");
      setMessage(null);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "创建流程失败");
    } finally {
      setFlowPreparing(false);
    }
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

  function reorderFlowStep(sourceStepId: string, targetStepId: string): void {
    if (sourceStepId === targetStepId) return;

    setFlowSteps((current) => {
      const sourceIndex = current.findIndex((step) => step.id === sourceStepId);
      const targetIndex = current.findIndex((step) => step.id === targetStepId);
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

  function startRenameSnapshot(item: DeviceSnapshotSummary): void {
    setRenamingSnapshotId(item.id);
    setRenameDraft(snapshotNames[String(item.id)] ?? "");
  }

  function commitRenameSnapshot(id: number): void {
    const nextName = renameDraft.trim();
    setSnapshotNames((current) => {
      const next = { ...current };
      if (nextName) {
        next[String(id)] = nextName;
      } else {
        delete next[String(id)];
      }
      persistSnapshotNames(next);
      return next;
    });
    setRenamingSnapshotId(null);
    setRenameDraft("");
    showMainTransient(nextName ? `已命名为「${nextName}」` : "已恢复默认名称");
  }

  function cancelRenameSnapshot(): void {
    setRenamingSnapshotId(null);
    setRenameDraft("");
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
    setSelectedAiCandidateId(null);
    if (snapshot) {
      setSnapshotMemory((current) => ({
        ...current,
        [String(snapshot.id)]: {
          point: pickResult?.point ?? current[String(snapshot.id)]?.point ?? null,
          selectedCandidateId: candidate.id,
        },
      }));
    }
    syncActiveFlowStep({
      candidates,
      selectedCandidate: candidate,
    });
  }

  function handleAiCandidateSelect(candidateId: string): void {
    setSelectedAiCandidateId(candidateId);
    setSelectedCandidateId(null);
  }

  function commitInlineTestingState(nextState: InlineRuleTestingState): void {
    inlineTestingRef.current = nextState;
    setInlineTesting(nextState);
    saveInlineTestingState(nextState);
  }

  async function startCandidateInlineTest(candidate: SelectorCandidate): Promise<void> {
    if (!snapshot) {
      setMessage("请先打开一个快照");
      return;
    }

    const draft = createAppRuleDraft(
      snapshot,
      candidate,
      selectFallbackCandidates(candidate, candidates),
    );
    const nextState = startOfflineCandidateTest(inlineTestingRef.current, {
      mode: workspaceMode,
      snapshotId: snapshot.id,
      controlKey: controlKeyForPick(snapshot, pickResult),
      sourceKey: candidate.rule.matches.join("\n"),
      title: humanStrategyTitle(candidate.strategyName),
      summary: candidate.title,
      appName: formatSnapshotAppName(snapshot),
      nodeId: pickResult?.pickedNode.id,
      selectorIndex: selectorDisplayIndex(candidates, candidate),
      thumbnailUrl: await createSnapshotThumbnail(snapshot),
      app: draft,
    });
    commitInlineTestingState(nextState);
    debugLog("candidate", "test:add", `${candidate.strategyName} score=${candidate.risk.finalScore}`, {
      strategy: candidate.strategyName,
      score: candidate.risk.finalScore,
      risk: candidate.risk.level,
      matches: candidate.rule.matches,
      sourceKey: candidate.rule.matches.join("\n"),
    });
    void syncInlineTestsToGkd(nextState, "已加入当前测试集合并同步到 GKD 测试");
  }

  async function startFlowInlineTest(): Promise<void> {
    if (!flowDraft) {
      setMessage("流程里还没有可测试的 selector");
      return;
    }

    const nextState = startOfflineCandidateTest(inlineTestingRef.current, {
      mode: "flow",
      snapshotId: activeFlowStep?.snapshot.id ?? snapshot?.id,
      controlKey: `flow:${flowSteps.map((step) => step.snapshot.id).join(",")}`,
      sourceKey: flowDraft.groups
        .flatMap((group) => group.rules.flatMap((rule) => rule.matches))
        .join("\n"),
      title: flowName,
      summary: `${flowSteps.length} 步流程`,
      appName: formatSnapshotAppName(activeFlowStep?.snapshot ?? snapshot),
      nodeId: activeFlowStep?.pickResult?.pickedNode.id,
      thumbnailUrl: activeFlowStep?.snapshot
        ? await createSnapshotThumbnail(activeFlowStep.snapshot)
        : snapshot
          ? await createSnapshotThumbnail(snapshot)
          : undefined,
      app: flowDraft,
    });
    commitInlineTestingState(nextState);
    void syncInlineTestsToGkd(nextState, "已将流程加入当前测试集合并同步到 GKD 测试");
  }

  async function syncInlineTestsToGkd(
    state = inlineTestingRef.current,
    successMessage = "当前测试集合已同步到 GKD 测试",
  ): Promise<void> {
    syncQueueRef.current.pendingState = state;
    syncQueueRef.current.pendingMessage = successMessage;

    if (syncQueueRef.current.running) return;
    syncQueueRef.current.running = true;

    try {
      while (syncQueueRef.current.pendingState) {
        const nextState = syncQueueRef.current.pendingState;
        const nextMessage = syncQueueRef.current.pendingMessage;
        syncQueueRef.current.pendingState = null;
        await runSyncToGkd(nextState, nextMessage);
      }
    } finally {
      syncQueueRef.current.running = false;
    }
  }

  async function runSyncToGkd(
    state: InlineRuleTestingState,
    successMessage: string,
  ): Promise<void> {
    if (!client) {
      setMessage("请先连接 GKD HTTP 服务");
      return;
    }

    const draft = buildActiveTestSubscription(state);
    const summary = summarizeTestSubscription(draft);

    if (summary.ruleCount === 0) {
      // Still send empty subscription to clear GKD's in-memory rules.
    }

    setLoading(true);
    setMessage(null);
    try {
      await client.updateSubscription(exportRawSubscription(draft));
      showMainTransient(
        `${successMessage}：${summary.ruleCount} 条规则`,
      );
      debugLog("sync", "gkd:ok", `${summary.ruleCount} rules`, {
        ruleCount: summary.ruleCount,
        appCount: summary.appCount,
        groupCount: summary.groupCount,
      });
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : "导入到 GKD 失败";
      debugLog("error", "gkd:fail", msg);
      setMessage(msg);
    } finally {
      setLoading(false);
    }
  }

  function endInlineTest(itemId: string): void {
    const nextState = removeInlineTestItem(inlineTestingRef.current, itemId);
    commitInlineTestingState(nextState);
    void syncInlineTestsToGkd(nextState, "已结束这条测试并同步 GKD");
  }

  function deleteInlineTestRecord(itemId: string): void {
    const nextState = deleteInlineTestItem(inlineTestingRef.current, itemId);
    commitInlineTestingState(nextState);
    void syncInlineTestsToGkd(nextState, "已删除测试记录并同步 GKD");
  }

  function markInlineTestResult(
    itemId: string,
    status: Exclude<InlineTestStatus, "idle" | "testing">,
    note?: string,
  ): void {
    const nextState = markInlineTestItemResult(
      inlineTestingRef.current,
      itemId,
      status,
      Date.now(),
      note,
    );
    commitInlineTestingState(nextState);
    void syncInlineTestsToGkd(nextState, "已记录测试结果并同步 GKD");
  }

  async function importInlineItem(item: InlineRuleTestItem): Promise<void> {
    if (!item.canImport) {
      setMessage("请先把这条规则标记为有效");
      return;
    }
    await saveInlineItemToLocalRulesBeta(item);
  }

  async function saveInlineItemToLocalRulesBeta(item: InlineRuleTestItem): Promise<void> {
    if (!isDebugTarget(targetPackage)) {
      await copyTextToClipboard(stringifyRuleDraft(item.app));
      setMessage("正式版 GKD 不支持本地规则 API，已复制规则片段");
      return;
    }

    if (!client) {
      setMessage("请先连接 GKD HTTP 服务");
      return;
    }

    if (!item.canImport) {
      setMessage("请先把这条规则标记为有效，再导入");
      return;
    }

    setLoading(true);
    setMessage(null);
    try {
      const result = await client.appendLocalRules(item.app);
      setTestSubscription((current) =>
        markImportedAndClearBuffer(addAppDraftToTestSubscription(current, item.app)),
      );
      showMainTransient(
        `已保存到 GKD 本地规则 Beta：新增 ${result.addedRules} 条，跳过重复 ${result.skippedDuplicates} 条`,
      );
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "保存到 GKD 本地规则失败";
      setMessage(`${detail}。当前 GKD 可能还不支持本地规则 Beta API`);
    } finally {
      setLoading(false);
    }
  }

  function clearCurrentAiConfigLocal(profile: AiModelProfile): void {
    const nextProfile: AiModelProfile = {
      ...profile,
      config: {
        baseURL: "",
        apiKey: "",
        model: "",
        temperature: profile.config.temperature,
        timeoutMs: profile.config.timeoutMs,
        supportsMultimodal: profile.config.supportsMultimodal,
      },
    };
    const nextStore = upsertAiProfile(aiProfileStore, nextProfile);
    const active = getActiveAiProfile(nextStore);
    setAiProfileStore(nextStore);
    if (active) setAiConfig(active.config);
    saveAiProfileStore(nextStore);
    showAiTransient("当前模型配置已清空");
  }

  function saveAiProfileLocal(profile: AiModelProfile): void {
    const nextStore = upsertAiProfile(aiProfileStore, profile);
    const active = getActiveAiProfile(nextStore);
    setAiProfileStore(nextStore);
    if (active) setAiConfig(active.config);
    saveAiProfileStore(nextStore);
    showAiTransient(`模型配置已保存：${active?.name ?? profile.name}`);
  }

  function selectAiProfileLocal(profileId: string): void {
    const nextStore = setActiveAiProfile(aiProfileStore, profileId);
    const active = getActiveAiProfile(nextStore);
    setAiProfileStore(nextStore);
    if (active) setAiConfig(active.config);
    saveAiProfileStore(nextStore);
    setAiMessage(null);
  }

  function deleteAiProfileLocal(profileId: string): void {
    const nextStore = deleteAiProfile(aiProfileStore, profileId);
    const active = getActiveAiProfile(nextStore);
    setAiProfileStore(nextStore);
    if (active) setAiConfig(active.config);
    saveAiProfileStore(nextStore);
    showAiTransient("模型配置已删除");
  }

  async function testAiConfigLocal(): Promise<void> {
    startAiOperation("test");
    setAiMessage(null);
    setAiConnectionStatus({ status: "testing" });
    try {
      appendAiDebugLog("test:start");
      const result = await testAiConnection(aiConfig, appendAiDebugLog);
      showAiTransient(result);
      appendAiDebugLog(`test:done ${result}`);
      saveConnectionStatus({ status: "connected", lastTested: Date.now() });
      setAiConnectionStatus({ status: "connected", lastTested: Date.now() });
    } catch (cause) {
      const errMsg = formatAiError(cause, aiConfig.apiKey);
      setAiMessage(errMsg);
      appendAiDebugLog(`test:error ${errMsg}`);
      const diagnosis = categorizeAiError(cause);
      const failedStatus: AiConnectionStatus = {
        status: "failed",
        error: diagnosis.message,
        category: diagnosis.category,
        lastTested: Date.now(),
      };
      saveConnectionStatus(failedStatus);
      setAiConnectionStatus(failedStatus);
    } finally {
      finishAiOperation();
    }
  }

  async function generateAiRules(): Promise<void> {
    const mode = workspaceMode;
    if (mode === "single" && (!snapshot || !pickResult)) {
      setAiMessage("请先在截图上选择目标控件");
      return;
    }
    if (mode === "flow" && flowSteps.length === 0) {
      setAiMessage("流程里还没有步骤");
      return;
    }
    if (!canGenerateAiRules) {
      setAiMessage("当前 session 已有候选或正在测试，请先开启新 session");
      setActiveTab("ai");
      return;
    }

    startAiOperation("generate");
    setAiMessage(null);
    debugLog("ai", "generate:start", `mode=${mode}`, {
      mode,
      snapshotId: mode === "flow" ? activeFlowStep?.snapshot.id : snapshot?.id,
      multimodal: aiConfig.supportsMultimodal,
      model: aiConfig.model,
    });
    try {
      appendAiDebugLog(`generate:start mode=${mode}`);
      const originalPrompt = mode === "flow" ? flowPrompt : singleAiPrompt;
      const imageUrl = aiConfig.supportsMultimodal
        ? await createSessionThumbnailForMode(mode).catch(() => undefined)
        : undefined;
      const messages = buildAiGenerateMessages({
        mode,
        prompt: originalPrompt,
        imageUrl,
      });
      appendAiDebugLog(
        `generate:messages count=${messages.length} chars=${messages.reduce(
          (sum, item) => sum + aiMessageTextContent(item.content).length,
          0,
        )} multimodal=${Boolean(imageUrl)}`,
      );
      const requestConfig = withAiGenerationTimeout(aiConfig);
      appendAiDebugLog(
        `generate:timeout savedMs=${aiConfig.timeoutMs} effectiveMs=${requestConfig.timeoutMs}`,
      );
      const nextCandidates = await requestAiCandidatesWithTextFallback({
        config: requestConfig,
        messages,
        phase: "generate",
        onDebugLog: appendAiDebugLog,
      });
      const sessionInput = {
        mode,
        snapshotId: mode === "flow" ? activeFlowStep?.snapshot.id : snapshot?.id,
        controlKey:
          mode === "flow"
            ? `flow:${flowSteps.map((step) => step.snapshot.id).join(",")}`
            : controlKeyForPick(snapshot, pickResult),
        title:
          mode === "flow"
            ? `${flowName || "流程规则"}`
            : nodeLabel(pickResult!.pickedNode),
        originalPrompt,
        contextSummary:
          mode === "flow"
            ? `${flowSteps.length} 个步骤`
            : `${nodeLabel(pickResult!.pickedNode)} / ${snapshot?.activityId ?? ""}`,
        appName: formatSnapshotAppName(mode === "flow" ? activeFlowStep?.snapshot ?? snapshot : snapshot),
        nodeId: mode === "flow" ? activeFlowStep?.pickResult?.pickedNode.id : pickResult?.pickedNode.id,
        thumbnailUrl: imageUrl ?? (await createSessionThumbnailForMode(mode).catch(() => undefined)),
      } satisfies Parameters<typeof addAiSession>[1];
      const reusableSession =
        activeAiSession &&
        activeAiSession.mode === sessionInput.mode &&
        activeAiSession.snapshotId === sessionInput.snapshotId &&
        activeAiSession.controlKey === sessionInput.controlKey &&
        activeAiSession.candidates.length === 0
          ? activeAiSession
          : null;
      const withSession = reusableSession
        ? inlineTestingRef.current
        : addAiSession(inlineTestingRef.current, sessionInput);
      const sessionId = reusableSession?.id ?? withSession.aiSessions[0]?.id ?? null;
      const withCandidates = sessionId
        ? setAiSessionCandidates(withSession, sessionId, nextCandidates)
        : withSession;
      commitInlineTestingState(withCandidates);
      setActiveAiSessionId(sessionId);
      setAiCandidates(nextCandidates);
      setAiGeneratedMode(mode);
      showAiTransient(`AI 返回 ${nextCandidates.length} 个候选`);
      appendAiDebugLog(`generate:done candidates=${nextCandidates.length}`);
      debugLog("ai", "generate:ok", `${nextCandidates.length} candidates`, {
        mode,
        candidateCount: nextCandidates.length,
        sessionId,
      });
      setActiveTab("ai");
    } catch (cause) {
      const errMsg = formatAiError(cause, aiConfig.apiKey);
      setAiMessage(errMsg);
      appendAiDebugLog(`generate:error ${errMsg}`);
      debugLog("error", "ai:generate:fail", errMsg, { mode });
    } finally {
      finishAiOperation();
    }
  }

  async function createNewAiSession(): Promise<void> {
    const input = createCurrentAiSessionInput(
      true,
      await createSessionThumbnailForMode(workspaceMode).catch(() => undefined),
    );
    if (!input) return;

    const nextState = addAiSession(inlineTestingRef.current, input);
    const sessionId = nextState.aiSessions[0]?.id ?? null;
    commitInlineTestingState(nextState);
    setActiveAiSessionId(sessionId);
    setAiCandidates([]);
    setAiGeneratedMode(input.mode);
    setActiveTab("ai");
    showAiTransient("已开启新的 AI session");
  }

  async function selectAiSession(sessionId: string): Promise<void> {
    const session = inlineTestingRef.current.aiSessions.find((item) => item.id === sessionId);
    if (!session) return;

    setActiveAiSessionId(session.id);
    setAiCandidates(session.candidates);
    setAiGeneratedMode(session.mode);
    setWorkspaceMode(session.mode);
    if (session.mode === "single" && session.snapshotId && client) {
      await loadSnapshotForAiSession(session, client);
    } else if (session.mode === "flow" && session.snapshotId && client) {
      await loadFlowCanvasSnapshot(session.snapshotId, client);
    }
    setActiveTab("ai");
  }

  function removeAiSession(sessionId: string): void {
    const nextState = deleteAiSession(inlineTestingRef.current, sessionId);
    commitInlineTestingState(nextState);
    if (activeAiSessionId === sessionId) {
      const nextSession =
        filterAiSessionsByMode(nextState, workspaceMode).filter(
          (session) => session.source !== "external",
        )[0] ?? null;
      setActiveAiSessionId(nextSession?.id ?? null);
      setAiCandidates(nextSession?.candidates ?? []);
      setAiGeneratedMode(nextSession?.mode ?? null);
    }
    showAiTransient("已删除 AI session");
  }

  function formatCurrentAiSessionTitle(): string {
    if (workspaceMode === "flow") {
      const stepCount = flowSteps.length;
      const snapshotIds = flowSteps.map((step) => step.snapshot.id).join(",");
      return `${flowName || "流程规则"} / ${stepCount} 步 / 快照 ${snapshotIds || "-"}`;
    }
    if (!snapshot || !pickResult) return "单步规则";
    return [
      `快照 ${snapshot.id}`,
      shortActivity(snapshot.activityId),
      nodeLabel(pickResult.pickedNode),
    ].join(" / ");
  }

  function formatCurrentAiSessionContext(): string {
    if (workspaceMode === "flow") {
      return flowSteps
        .map((step, index) => `步骤 ${index + 1}: 快照 ${step.snapshot.id} ${shortActivity(step.snapshot.activityId)}`)
        .join(" | ");
    }
    if (!snapshot || !pickResult) return "";
    const node = pickResult.pickedNode;
    const parts = [
      snapshot.sourceName || `快照 ${snapshot.id}`,
      snapshot.activityId ?? "未知页面",
      `#${node.id} ${nodeLabel(node)}`,
    ];
    return parts.join(" / ");
  }

  async function createSessionThumbnailForMode(
    mode: "single" | "flow",
  ): Promise<string | undefined> {
    const sourceSnapshot = mode === "flow" ? activeFlowStep?.snapshot ?? snapshot : snapshot;
    return sourceSnapshot ? createSnapshotThumbnail(sourceSnapshot) : undefined;
  }

  async function loadSnapshotForAiSession(
    session: InlineAiSession,
    targetClient: DeviceApiClient,
  ): Promise<void> {
    if (!session.snapshotId) return;

    const numericId = Number(session.snapshotId);
    setOpeningId(numericId);
    setMessage(null);
    try {
      const nextSnapshot =
        snapshot?.id === numericId ? snapshot : await targetClient.loadSnapshot(numericId);
      openSnapshot(nextSnapshot);
      const point = pointFromControlKey(session.controlKey);
      const nextPick = point ? pickNodeAtPoint(nextSnapshot, point) : null;
      setWorkspaceMode("single");
      setSelectedSnapshotId(String(numericId));
      setPickResult(nextPick);
      setSelectedCandidateId(null);
      if (!nextPick) {
        setMessage("已跳转到 session 快照，请重新选择目标控件");
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "加载 session 快照失败");
    } finally {
      setOpeningId(null);
    }
  }

  async function importPastedAiResult(): Promise<void> {
    const text = aiPasteText.trim();
    if (!text) {
      setExternalAiMessage("请先粘贴 AI 返回内容");
      return;
    }

    const input = createCurrentAiSessionInput(
      false,
      await createSessionThumbnailForMode(workspaceMode).catch(() => undefined),
    );
    if (!input) return;

    try {
      const nextCandidates = parseAiCandidates(text);
      if (nextCandidates.length === 0) {
        setExternalAiMessage("没有提取到可用规则");
        return;
      }

      const reusableExternalSession =
        externalAiSessionId
          ? inlineTestingRef.current.aiSessions.find(
              (session) =>
                session.id === externalAiSessionId &&
                session.mode === input.mode &&
                session.snapshotId === input.snapshotId &&
                session.controlKey === input.controlKey,
            ) ?? null
          : null;
      const withSession = reusableExternalSession
        ? inlineTestingRef.current
        : addAiSession(inlineTestingRef.current, {
            ...input,
            source: "external",
            title: `外部 AI / ${input.title}`,
          });
      const sessionId = reusableExternalSession?.id ?? withSession.aiSessions[0]?.id ?? null;
      const nextState = sessionId
        ? setAiSessionCandidates(withSession, sessionId, nextCandidates)
        : withSession;
      commitInlineTestingState(nextState);
      setExternalAiSessionId(sessionId);
      setExternalAiCandidates(nextCandidates);
      setExternalAiMode(input.mode);
      setAiPasteText("");
      showExternalAiTransient(`已提取 ${nextCandidates.length} 个外部 AI 规则候选`);
    } catch (cause) {
      setExternalAiMessage(cause instanceof Error ? cause.message : "解析 AI 返回内容失败");
    }
  }

  function addExternalAiCandidateToTestZone(candidate: AiRuleCandidate): void {
    if (!externalAiSessionId) {
      setExternalAiMessage("请先提取外部 AI 规则");
      return;
    }
    const nextState = startAiCandidateTest(
      inlineTestingRef.current,
      externalAiSessionId,
      candidate,
    );
    commitInlineTestingState(nextState);
    void syncInlineTestsToGkd(nextState, `${candidate.title} 已加入当前测试集合`);
  }

  function createCurrentAiSessionInput(
    focusAiTabOnError = true,
    thumbnailUrl?: string,
  ): Parameters<typeof addAiSession>[1] | null {
    const mode = workspaceMode;
    if (mode === "single" && (!snapshot || !pickResult)) {
      setAiMessage("请先在截图上选择目标控件");
      if (focusAiTabOnError) setActiveTab("ai");
      return null;
    }
    if (mode === "flow" && flowSteps.length === 0) {
      setAiMessage("流程里还没有步骤");
      if (focusAiTabOnError) setActiveTab("ai");
      return null;
    }

    const originalPrompt = mode === "flow" ? flowPrompt : singleAiPrompt;
    return {
      mode,
      snapshotId: mode === "flow" ? activeFlowStep?.snapshot.id : snapshot?.id,
      controlKey:
        mode === "flow"
          ? `flow:${flowSteps.map((step) => step.snapshot.id).join(",")}`
          : controlKeyForPick(snapshot, pickResult),
      title: formatCurrentAiSessionTitle(),
      originalPrompt,
      contextSummary: formatCurrentAiSessionContext(),
      appName: formatSnapshotAppName(mode === "flow" ? activeFlowStep?.snapshot ?? snapshot : snapshot),
      nodeId: mode === "flow" ? activeFlowStep?.pickResult?.pickedNode.id : pickResult?.pickedNode.id,
      thumbnailUrl,
    };
  }

  function addAiCandidateToTestZone(candidate: AiRuleCandidate): void {
    if (!activeAiSession) {
      setAiMessage("请先生成一个 AI 会话");
      return;
    }
    const nextState = startAiCandidateTest(
      inlineTestingRef.current,
      activeAiSession.id,
      candidate,
    );
    commitInlineTestingState(nextState);
    void syncInlineTestsToGkd(nextState, `${candidate.title} 已加入当前测试集合`);
  }

  async function copyAiFeedbackPrompt(
    feedbacks: AiCandidateFeedback[],
    modeOverride?: "single" | "flow" | null,
  ): Promise<void> {
    if (feedbacks.length === 0) {
      setExternalAiMessage("请先填写至少一条测试反馈");
      return;
    }
    const mode = modeOverride ?? aiGeneratedMode ?? workspaceMode;
    setExternalAiMessage(null);
    try {
      await copyTextToClipboard(buildExternalFeedbackPrompt(feedbacks, mode === "flow"));
      showExternalAiTransient("已复制测试反馈 prompt，可粘贴给外部 AI 修正规则");
      appendAiDebugLog(`feedback:copied mode=${mode} count=${feedbacks.length}`);
    } catch (cause) {
      setExternalAiMessage(cause instanceof Error ? cause.message : "复制测试反馈失败");
      appendAiDebugLog(`feedback:error ${cause instanceof Error ? cause.message : "copy failed"}`);
    }
  }

  async function sendAiFeedback(feedbacks: AiCandidateFeedback[]): Promise<void> {
    if (feedbacks.length === 0) {
      setAiMessage("请先填写至少一条测试反馈");
      return;
    }
    const mode = aiGeneratedMode ?? workspaceMode;
    const session = activeAiSession;
    startAiOperation("feedback");
    setAiMessage(null);
    try {
      const messages = buildAiBatchFeedbackMessages({
        mode,
        originalPrompt: session?.originalPrompt ?? (mode === "flow" ? flowPrompt : singleAiPrompt),
        feedbacks,
      });
      appendAiDebugLog(`feedback:start mode=${mode} count=${feedbacks.length}`);
      const nextCandidates = await requestAiCandidatesWithTextFallback({
        config: withAiGenerationTimeout(aiConfig),
        messages,
        phase: "feedback",
        onDebugLog: appendAiDebugLog,
      });
      if (session) {
        const nextState = setAiSessionCandidates(
          inlineTestingRef.current,
          session.id,
          nextCandidates,
        );
        commitInlineTestingState(nextState);
      }
      setAiCandidates(nextCandidates);
      setAiGeneratedMode(mode);
      setActiveTab("ai");
      showAiTransient(`反馈已返回 ${nextCandidates.length} 个候选`);
      appendAiDebugLog(`feedback:done candidates=${nextCandidates.length}`);
    } catch (cause) {
      setAiMessage(formatAiError(cause, aiConfig.apiKey));
      appendAiDebugLog(`feedback:error ${formatAiError(cause, aiConfig.apiKey)}`);
    } finally {
      finishAiOperation();
    }
  }

  function startAiOperation(operation: Exclude<AiOperation, null>): void {
    setAiOperation(operation);
    setAiRequestStartedAt(Date.now());
    setAiElapsedSeconds(0);
    setAiPendingCount((current) => current + 1);
  }

  async function requestAiCandidatesWithTextFallback({
    config,
    messages,
    phase,
    onDebugLog,
  }: {
    config: AiModelConfig;
    messages: AiChatMessage[];
    phase: "generate" | "feedback";
    onDebugLog: (line: string) => void;
  }): Promise<AiRuleCandidate[]> {
    try {
      return await requestAiCandidates({ config, messages, onDebugLog });
    } catch (cause) {
      if (!aiMessagesHaveImage(messages) || !shouldRetryTextOnlyAfterMultimodalError(cause)) {
        throw cause;
      }
      const textOnlyMessages = stripAiMessageImages(messages);
      onDebugLog(
        `${phase}:multimodal:fallback text-only reason=${formatAiError(cause, aiConfig.apiKey)}`,
      );
      return requestAiCandidates({
        config,
        messages: textOnlyMessages,
        onDebugLog,
      });
    }
  }

  function finishAiOperation(): void {
    setAiPendingCount((current) => {
      const next = Math.max(0, current - 1);
      if (next === 0) {
        setAiOperation(null);
        setAiRequestStartedAt(null);
      }
      return next;
    });
  }

  function appendAiDebugLog(line: string): void {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setAiDebugLogs((current) => [...current.slice(-79), `[${time}] ${line}`]);
  }

  function clearTransientAiMessage(): void {
    if (aiMessageTimerRef.current === null) return;
    window.clearTimeout(aiMessageTimerRef.current);
    aiMessageTimerRef.current = null;
  }

  function clearTransientMainMessage(): void {
    if (mainMessageTimerRef.current === null) return;
    window.clearTimeout(mainMessageTimerRef.current);
    mainMessageTimerRef.current = null;
  }

  function clearTransientExternalAiMessage(): void {
    if (externalAiMessageTimerRef.current === null) return;
    window.clearTimeout(externalAiMessageTimerRef.current);
    externalAiMessageTimerRef.current = null;
  }

  function clearAllTransientMessages(): void {
    clearTransientAiMessage();
    clearTransientMainMessage();
    clearTransientExternalAiMessage();
  }

  function showMainTransient(text: string): void {
    clearTransientMainMessage();
    prolongedMainRef.current = false;
    setMessage(text);
    mainMessageTimerRef.current = window.setTimeout(() => {
      mainMessageTimerRef.current = null;
      setMessage(null);
    }, MAIN_TRANSIENT_MS);
  }

  function prolongMainMessage(): void {
    if (mainMessageTimerRef.current === null) return;
    if (prolongedMainRef.current) return;
    prolongedMainRef.current = true;
    window.clearTimeout(mainMessageTimerRef.current);
    mainMessageTimerRef.current = window.setTimeout(() => {
      mainMessageTimerRef.current = null;
      setMessage(null);
    }, MAIN_TRANSIENT_MS);
  }

  function showAiTransient(text: string): void {
    clearTransientAiMessage();
    setAiMessage(text);
    aiMessageTimerRef.current = window.setTimeout(() => {
      aiMessageTimerRef.current = null;
      setAiMessage(null);
    }, MAIN_TRANSIENT_MS);
  }

  function showExternalAiTransient(text: string): void {
    clearTransientExternalAiMessage();
    setExternalAiMessage(text);
    externalAiMessageTimerRef.current = window.setTimeout(() => {
      externalAiMessageTimerRef.current = null;
      setExternalAiMessage(null);
    }, MAIN_TRANSIENT_MS);
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
    <main
      className={[
        "android-shell",
        view === "workspace" ? "android-workspace-shell" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="android-header">
        <div className="android-title-row">
          {view === "home" && (
            <div className="android-brand-mark" aria-label="GKD Rule Studio">
              <span>G</span>
            </div>
          )}
        </div>
        {view === "home" && (
          <div className="android-header-actions">
            <TargetVersionSwitch
              targetPackage={targetPackage}
              onChange={(packageId) => {
                storeTargetPackage(packageId);
                setTargetPackage(packageId);
                setClient(null);
                setSnapshots([]);
                setSelectedSnapshotIds(new Set());
                showMainTransient(`已切换目标：${targetPackageLabel(packageId)}`);
              }}
            />
            <button
              aria-label="模型配置"
              className={[
                "android-icon-button",
                activeAiProfile?.config.apiKey ? "android-ai-ready" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              type="button"
              onClick={() => setAiConfigOpen(true)}
            >
              <Plug size={16} />
            </button>
            <button
              aria-label="日志"
              className="android-icon-button"
              type="button"
              onClick={() => {
                setLogPageOpen(true);
                void flushToAdbHelper();
              }}
            >
              <ScrollText size={16} />
            </button>
            <span
              className={`ai-status-dot ai-status-${aiConnectionStatus.status}`}
              title={
                aiConnectionStatus.status === "connected"
                  ? "模型连接正常"
                  : aiConnectionStatus.status === "failed"
                    ? `${aiConnectionStatus.category}：${aiConnectionStatus.error}`
                    : aiConnectionStatus.status === "testing"
                      ? "测试连接中..."
                      : "模型未测试连接"
              }
            />
            <span className={client ? "status-badge success" : "status-badge muted"}>
              {client ? "已连接" : "未连接"}
            </span>
          </div>
        )}
      </header>

      {message && (
        <button
          type="button"
          aria-label="延长显示这条提示"
          className="android-message"
          onClick={prolongMainMessage}
        >
          {message}
        </button>
      )}
      {view === "home" && (
        <section className="android-home">
          <div className="android-card android-connect-card">
            <div className="android-section-title">
              <h2>HTTP 服务</h2>
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
          </div>
          {client ? (
            <AndroidSnapshotChooser
              loading={loading}
              openingId={openingId}
              openingFlow={openingFlow}
              exportingId={exportingSnapshotId}
              names={snapshotNames}
              renameDraft={renameDraft}
              renamingId={renamingSnapshotId}
              selectedIds={selectedSnapshotIds}
              snapshots={snapshots}
              onCancelRename={cancelRenameSnapshot}
              onCommitRename={commitRenameSnapshot}
              onExport={(item) => void exportSnapshotFromHome(item)}
              onOpenSelected={() => void openSelectedSnapshots()}
              onRefresh={() => void refreshSnapshots()}
              onRenameDraftChange={setRenameDraft}
              onStartRename={startRenameSnapshot}
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
          <div className="android-workspace-title">
            <strong>{snapshot?.appInfo?.name ?? snapshot?.appId ?? "未加载快照"}</strong>
          </div>
          <button
            aria-label="当前测试"
            className="android-icon-button"
            type="button"
            onClick={() => setTestPageOpen(true)}
          >
            <ListChecks size={16} />
          </button>
          <div className="mode-switch android-workspace-mode-switch">
            <button
              className={workspaceMode === "single" ? "mode-switch-active" : ""}
              type="button"
              onClick={() => setWorkspaceMode("single")}
            >
              单步
            </button>
            <button
              className={workspaceMode === "flow" ? "mode-switch-active" : ""}
              disabled={flowPreparing}
              type="button"
              onClick={() => void switchToFlowMode()}
            >
              {flowPreparing ? "载入" : "多步"}
            </button>
          </div>
        </div>
        {snapshot ? (
          <>
            {workspaceMode === "flow" && (
              <>
                <AndroidFlowCanvasNav
                  activeSnapshotIndex={activeFlowSnapshotIndex}
                  snapshotCount={flowCanvasSnapshots.length}
                  onPrevious={() => void selectAdjacentFlowSnapshot(-1)}
                  onNext={() => void selectAdjacentFlowSnapshot(1)}
                />
              </>
            )}
            {workspaceMode === "single" && selectedSnapshotList.length > 1 && (
              <AndroidFlowCanvasNav
                activeSnapshotIndex={activeSelectedSnapshotIndex}
                snapshotCount={selectedSnapshotList.length}
                onPrevious={() => void selectAdjacentSingleSnapshot(-1)}
                onNext={() => void selectAdjacentSingleSnapshot(1)}
              />
            )}
            <ScreenshotCanvas
              interactionMode="dragMagnifier"
              pickResult={pickResult}
              selectedCandidate={selectedCandidate}
              aiValidation={aiValidation}
              snapshot={snapshot}
              onPointSelected={handlePointSelected}
            />
            <TargetSummary pickResult={pickResult} selectedCandidate={selectedCandidate} />
            {workspaceMode === "flow" && (
              <AndroidFlowStepRail
                activeStepId={activeFlowStepId}
                steps={flowSteps}
                onAddCurrentStep={addCurrentSnapshotToFlow}
                onReorderStep={reorderFlowStep}
                onSelectStep={selectFlowStep}
              />
            )}
          </>
        ) : (
          <div className="android-empty">先连接手机 HTTP 服务并打开一个快照</div>
        )}
      </section>

      <AndroidWorkspaceTabs
        activeTab={activeTab}
        flowMode={workspaceMode === "flow"}
        onChange={setActiveTab}
      />

      <section className="android-card android-tab-panel">
        {activeTab === "scene" && (
          <AndroidScenePanel
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
            </div>
            <CandidateSummary
              candidates={candidates}
              importedSelectorKeys={new Set(testSubscription.importedSelectors)}
              inlineTesting={inlineTesting}
              mode={workspaceMode}
              snapshot={snapshot}
              snapshotId={snapshot?.id}
              controlKey={controlKeyForPick(snapshot, pickResult)}
              targetPackage={targetPackage}
              selectedId={selectedCandidate?.id ?? null}
              onEndTest={endInlineTest}
              onImport={(item) => void importInlineItem(item)}
              onMarkTest={markInlineTestResult}
              onSelect={handleCandidateSelect}
              onStartTest={(candidate) => void startCandidateInlineTest(candidate)}
            />
          </div>
        )}
        {activeTab === "prompt" && (
          <AndroidPromptPanel
            aiPasteText={aiPasteText}
            copied={copied}
            externalAiCandidates={externalAiCandidates}
            externalAiMode={externalAiMode}
            externalAiSession={externalAiSession}
            inlineTesting={inlineTesting}
            loading={aiLoading}
            message={externalAiMessage}
            snapshot={snapshot}
            pickResult={pickResult}
            selectedAiCandidateId={selectedAiCandidateId}
            targetPackage={targetPackage}
            testSubscription={testSubscription}
            workspaceMode={workspaceMode}
            onAddExternalCandidate={addExternalAiCandidateToTestZone}
            onCopyExternalFeedback={(feedbacks) =>
              void copyAiFeedbackPrompt(feedbacks, externalAiMode)
            }
            onCopyFlowPrompt={() => void copyFlowPrompt()}
            onCopyRulePrompt={() => void copyRulePrompt()}
            onEndCandidateTest={endInlineTest}
            onImportCandidate={(item) => void importInlineItem(item)}
            onImportPastedAiResult={importPastedAiResult}
            onMarkCandidate={markInlineTestResult}
            onPasteAiTextChange={setAiPasteText}
            onSelectAiCandidate={handleAiCandidateSelect}
          />
        )}
        {activeTab === "steps" && workspaceMode === "flow" && (
          <AndroidFlowEditor
            activeStep={activeFlowStep}
            activeStepId={activeFlowStepId}
            copied={copied}
            customScenarios={customScenarios}
            flowDesc={flowDesc}
            flowName={flowName}
            flowPreview={flowPreview}
            steps={flowSteps}
            onAddFlowToTestZone={() => void startFlowInlineTest()}
            onCopyFlowDraft={() => void copyFlowDraft()}
            onFlowDescChange={setFlowDesc}
            onFlowNameChange={setFlowName}
            onRemoveStep={removeFlowStep}
            onSelectStep={selectFlowStep}
            onStepScenarioChange={handleStepScenarioChange}
            onUpdateStep={updateFlowStep}
          />
        )}
        {activeTab === "ai" && (
            <AndroidAiPanel
              candidates={aiCandidates}
            config={aiConfig}
            generatedMode={aiGeneratedMode}
            elapsedSeconds={aiElapsedSeconds}
            canGenerate={canGenerateAiRules}
            inlineTesting={inlineTesting}
            loading={aiLoading}
            message={aiMessage}
            operation={aiOperation}
            selectedAiCandidateId={selectedAiCandidateId}
            session={activeAiSession}
            snapshot={snapshot}
            targetPackage={targetPackage}
            testSubscription={testSubscription}
            workspaceMode={workspaceMode}
            onAddCandidate={addAiCandidateToTestZone}
            onGenerate={() => void generateAiRules()}
            onNewSession={createNewAiSession}
            onOpenSessions={() => setAiSessionManagerOpen(true)}
            onImportCandidate={(item) => void importInlineItem(item)}
            onMarkCandidate={markInlineTestResult}
            onEndCandidateTest={endInlineTest}
            onSelectAiCandidate={handleAiCandidateSelect}
            onSendFeedback={(feedbacks) => void sendAiFeedback(feedbacks)}
          />
        )}
      </section>
      </>
      )}
      {view === "home" && aiConfigOpen && (
        <AndroidAiConfigDialog
          activeProfileId={aiProfileStore.activeId}
          loading={aiLoading}
          message={aiMessage}
          profiles={aiProfileStore.profiles}
          onChangeDraft={(config) => {
            setAiConfig(config);
            setAiMessage(null);
          }}
          onClearCurrent={clearCurrentAiConfigLocal}
          onClose={() => setAiConfigOpen(false)}
          onDeleteProfile={deleteAiProfileLocal}
          onSaveProfile={saveAiProfileLocal}
          onSelectProfile={selectAiProfileLocal}
          onTestConfig={() => void testAiConfigLocal()}
        />
      )}
      {view === "workspace" && aiSessionManagerOpen && (
        <AndroidAiSessionManagerPage
          activeSessionId={activeAiSession?.id ?? null}
          sessions={visibleAiSessions}
          onClose={() => setAiSessionManagerOpen(false)}
          onNewSession={() => {
            createNewAiSession();
            setAiSessionManagerOpen(false);
          }}
          onSelectSession={(sessionId) => {
            setAiSessionManagerOpen(false);
            void selectAiSession(sessionId);
          }}
          onDeleteSession={removeAiSession}
        />
      )}
      {logPageOpen && (
        <AndroidLogPage
          debugReportText={exportDebugReport()}
          aiRequestLogs={aiDebugLogs}
          onClose={() => setLogPageOpen(false)}
          onCopyDebugReport={async () => {
            await copyTextToClipboard(exportDebugReport());
            showMainTransient("调试报告已复制到剪贴板");
          }}
          onClearDebugReport={() => {
            clearDebugLog();
            showMainTransient("调试日志已清除");
          }}
          onCopyAiLogs={async () => {
            await copyTextToClipboard(aiDebugLogs.join("\n"));
            showMainTransient("AI 请求日志已复制到剪贴板");
          }}
          onClearAiLogs={() => {
            setAiDebugLogs([]);
            showMainTransient("AI 请求日志已清空");
          }}
        />
      )}
      {testPageOpen && (
        <AndroidTestPage
          items={inlineTesting.items}
          loading={loading}
          targetPackage={targetPackage}
          onClose={() => setTestPageOpen(false)}
          onDelete={deleteInlineTestRecord}
          onEnd={endInlineTest}
          onImport={(item) => void importInlineItem(item)}
        />
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

/**
 * 选场景后重算候选，同时保留用户之前手选的卡片（按 matches 匹配）。
 * 单步模式和 flow 模式的每步编辑器都可复用。
 */
function applyScenarioToCandidates(args: {
  nextSettings: RuleSettings;
  snapshot: ParsedGkdSnapshot;
  pickResult: NodePickResult | null;
  previousCandidates: SelectorCandidate[];
  previousSelectedId: string | null;
}): {
  nextCandidates: SelectorCandidate[];
  nextSelected: SelectorCandidate | null;
} {
  if (!args.pickResult) {
    return { nextCandidates: [], nextSelected: null };
  }
  const nextCandidates = buildCandidates(
    args.snapshot,
    args.nextSettings,
    args.pickResult,
  );
  const previousSelected = args.previousCandidates.find(
    (c) => c.id === args.previousSelectedId,
  );
  const previousMatchesKey =
    previousSelected?.rule.matches.join(" && ") ?? null;
  let nextSelected: SelectorCandidate | null = nextCandidates[0] ?? null;
  if (previousMatchesKey) {
    const kept = nextCandidates.find(
      (c) => c.rule.matches.join(" && ") === previousMatchesKey,
    );
    if (kept) nextSelected = kept;
  }
  return { nextCandidates, nextSelected };
}

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

function loadSnapshotWorkspaceMemory(): Record<string, SnapshotWorkspaceMemory> {
  const raw = localStorage.getItem(SNAPSHOT_MEMORY_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, SnapshotWorkspaceMemory>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveSnapshotWorkspaceMemory(
  memory: Record<string, SnapshotWorkspaceMemory>,
): void {
  localStorage.setItem(SNAPSHOT_MEMORY_STORAGE_KEY, JSON.stringify(memory));
}

async function createSnapshotThumbnail(
  snapshot: ParsedGkdSnapshot,
): Promise<string | undefined> {
  if (typeof document === "undefined") return undefined;

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const maxWidth = 180;
        const maxHeight = 320;
        const ratio = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
        const width = Math.max(1, Math.round(image.naturalWidth * ratio));
        const height = Math.max(1, Math.round(image.naturalHeight * ratio));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(undefined);
          return;
        }
        context.drawImage(image, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.72));
      } catch {
        resolve(undefined);
      }
    };
    image.onerror = () => resolve(undefined);
    image.src = snapshot.screenshotUrl;
  });
}

function collectAiCandidateSelectors(candidate: AiRuleCandidate): string[] {
  return candidate.app.groups.flatMap((group) =>
    group.rules.flatMap((rule) => rule.matches),
  );
}

function formatSnapshotAppName(snapshot: ParsedGkdSnapshot | null | undefined): string {
  return snapshot?.appInfo?.name || snapshot?.appId || "未知应用";
}

function formatCompactContext({
  appName,
  nodeId,
}: {
  appName?: string;
  nodeId?: number | string;
}): { appName: string; nodeLabel: string } {
  return {
    appName: appName?.trim() || "未知应用",
    nodeLabel: nodeId === undefined || nodeId === "" ? "节点 -" : `节点 #${nodeId}`,
  };
}

function selectorDisplayIndex(
  candidates: SelectorCandidate[],
  candidate: SelectorCandidate,
): number {
  const index = candidates.findIndex((item) => item.id === candidate.id);
  return index >= 0 ? index + 1 : 1;
}

function controlKeyForPick(
  snapshot: ParsedGkdSnapshot | null,
  pickResult: NodePickResult | null,
): string {
  if (!snapshot || !pickResult) return "unknown-control";
  const node = pickResult.pickedNode;
  return [
    snapshot.id,
    node.id,
    node.attr.id ?? "",
    node.attr.vid ?? "",
    `${node.attr.left},${node.attr.top},${node.attr.right},${node.attr.bottom}`,
  ].join("|");
}

function sessionMatchesCurrentAiContext(
  session: InlineAiSession,
  snapshotId: number | string | undefined,
  controlKey: string,
): boolean {
  if (!snapshotId || !controlKey) return false;
  return (
    String(session.snapshotId ?? "") === String(snapshotId) &&
    session.controlKey === controlKey
  );
}

function pointFromControlKey(controlKey: string | undefined): NodePoint | null {
  if (!controlKey) return null;
  const bounds = controlKey.split("|")[4];
  if (!bounds) return null;
  const [left, top, right, bottom] = bounds.split(",").map(Number);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  return {
    x: Math.round((left! + right!) / 2),
    y: Math.round((top! + bottom!) / 2),
  };
}

function isAiCandidateImported(
  draft: TestSubscriptionDraft,
  candidate: AiRuleCandidate,
): boolean {
  const rules = candidate.app.groups.flatMap((group) => group.rules);
  return rules.length > 0 && rules.some((rule) => wasSelectorImported(draft, rule.matches));
}

function formatAiError(cause: unknown, apiKey: string): string {
  const message = cause instanceof Error ? cause.message : "模型请求失败";
  const key = apiKey.trim();
  const cleaned = key ? message.replaceAll(key, maskApiKey(key)) : message;
  const diagnosis = categorizeAiError(cause);
  if (diagnosis.category !== "unknown") {
    return `${cleaned}\n${diagnosis.hint}`;
  }
  return cleaned;
}

function AndroidLogPage({
  debugReportText,
  aiRequestLogs,
  onClose,
  onCopyDebugReport,
  onClearDebugReport,
  onCopyAiLogs,
  onClearAiLogs,
}: {
  debugReportText: string;
  aiRequestLogs: string[];
  onClose: () => void;
  onCopyDebugReport: () => void;
  onClearDebugReport: () => void;
  onCopyAiLogs: () => void;
  onClearAiLogs: () => void;
}) {
  const debugLineCount = debugReportText ? debugReportText.split("\n").length : 0;
  const aiLineCount = aiRequestLogs.length;
  const aiLogText = aiRequestLogs.join("\n");

  return (
    <section className="android-manager-page" aria-label="日志">
      <div className="android-manager-head">
        <div>
          <h2>日志</h2>
          <span>所有日志和报告</span>
        </div>
        <button className="android-icon-button" type="button" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="android-manager-body">
        <div className="android-log-section">
          <div className="android-section-title">
            <h2>全局调试报告</h2>
            <span>{debugLineCount > 0 ? `${debugLineCount} 行` : "无数据"}</span>
          </div>
          <p className="android-log-desc">
            记录所有分类的调试日志：网络 / 快照 / 选点 / 候选 / AI / GKD 同步 / 错误。最长保留 500 条，主要给排查问题用。
          </p>
          <div className="android-manager-actions">
            <button
              className="android-button android-button-primary"
              disabled={!debugReportText}
              type="button"
              onClick={onCopyDebugReport}
            >
              <ClipboardCopy size={14} />
              复制报告
            </button>
            <button
              className="android-button android-button-danger"
              type="button"
              onClick={onClearDebugReport}
            >
              清除日志
            </button>
          </div>
          {debugReportText ? (
            <pre className="debug-report-view">
              <code>{debugReportText}</code>
            </pre>
          ) : (
            <p className="android-muted">
              还没有调试日志记录。连接设备、选择快照或生成规则后会产生记录。
            </p>
          )}
        </div>

        <div className="android-log-section">
          <div className="android-section-title">
            <h2>AI 请求日志</h2>
            <span>{aiLineCount > 0 ? `${aiLineCount} 条` : "无数据"}</span>
          </div>
          <p className="android-log-desc">
            只记录 AI 请求 / 响应详情：消息条数、token 估算、多模态回退、超时、错误码。最多 80 条，给排查 AI 调用用。
          </p>
          <div className="android-manager-actions">
            <button
              className="android-button android-button-primary"
              disabled={aiLineCount === 0}
              type="button"
              onClick={onCopyAiLogs}
            >
              <ClipboardCopy size={14} />
              复制
            </button>
            <button
              className="android-button android-button-danger"
              type="button"
              onClick={onClearAiLogs}
            >
              清空
            </button>
          </div>
          {aiLineCount > 0 ? (
            <pre className="debug-report-view">
              <code>{aiLogText}</code>
            </pre>
          ) : (
            <p className="android-muted">
              还没有 AI 请求日志。在工作区配好 AI 模型后，生成 AI 规则会产生记录。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function AndroidTestPage({
  items,
  loading,
  targetPackage,
  onClose,
  onDelete,
  onEnd,
  onImport,
}: {
  items: InlineRuleTestItem[];
  loading: boolean;
  targetPackage: GkdTargetPackage;
  onClose: () => void;
  onDelete: (itemId: string) => void;
  onEnd: (itemId: string) => void;
  onImport: (item: InlineRuleTestItem) => void;
}) {
  const activeItems = items.filter((item) => item.status === "testing");
  const validCount = items.filter((item) => item.status === "valid").length;
  const finishedCount = items.length - activeItems.length;

  return (
    <section className="android-manager-page" aria-label="当前测试">
      <div className="android-manager-head">
        <div>
          <h2>当前测试</h2>
          <span>
            正在测试 {activeItems.length} 条 / 已测试 {finishedCount} 条 / 可导入 {validCount} 条
          </span>
        </div>
        <button className="android-icon-button" type="button" onClick={onClose}>
          ×
        </button>
      </div>
      {items.length > 0 ? (
        <div className="inline-test-list manager">
          {items.map((item) => {
            const context = formatCompactContext(item);
            return (
              <div key={item.id} className="inline-test-item manager">
                <span className="android-session-row-thumb">
                  {item.thumbnailUrl ? (
                    <img alt="" src={item.thumbnailUrl} />
                  ) : (
                    <ListChecks size={17} />
                  )}
                </span>
                <span className="inline-test-main">
                  <strong>{context.appName}</strong>
                  <small>
                    {context.nodeLabel}
                    {item.selectorIndex !== undefined
                      ? ` / 候选 #${item.selectorIndex}`
                      : ""}
                  </small>
                </span>
                <span className={`inline-test-status status-${item.status}`}>
                  {inlineStatusLabel(item.status)}
                </span>
                <div className="inline-test-actions">
                  {item.status === "testing" ? (
                    <button type="button" onClick={() => onEnd(item.id)}>
                      结束测试
                    </button>
                  ) : (
                    <button
                      disabled={!item.canImport || loading}
                      type="button"
                      onClick={() => onImport(item)}
                    >
                      {isDebugTarget(targetPackage) ? "导入" : "复制"}
                    </button>
                  )}
                  <button
                    className="danger"
                    type="button"
                    onClick={() => onDelete(item.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="android-muted">还没有正在测试或测试过的规则。</p>
      )}
    </section>
  );
}

function AndroidWorkspaceTabs({
  activeTab,
  flowMode,
  onChange,
}: {
  activeTab: AndroidWorkspaceTab;
  flowMode: boolean;
  onChange: (tab: AndroidWorkspaceTab) => void;
}) {
  const tabs: Array<{ id: AndroidWorkspaceTab; label: string }> = [
    { id: "scene" as const, label: "场景" },
    { id: "candidates" as const, label: "候选" },
    { id: "prompt" as const, label: "Prompt" },
    ...(flowMode ? [{ id: "steps" as const, label: "步骤" }] : []),
    { id: "ai" as const, label: "AI" },
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

function TargetVersionSwitch({
  targetPackage,
  onChange,
}: {
  targetPackage: GkdTargetPackage;
  onChange: (packageId: GkdTargetPackage) => void;
}) {
  return (
    <div className="mode-switch android-target-switch" aria-label="GKD 目标版本">
      <button
        className={targetPackage === DEBUG_GKD_PACKAGE ? "mode-switch-active" : ""}
        type="button"
        onClick={() => onChange(DEBUG_GKD_PACKAGE)}
      >
        Beta
      </button>
      <button
        className={targetPackage === OFFICIAL_GKD_PACKAGE ? "mode-switch-active" : ""}
        type="button"
        onClick={() => onChange(OFFICIAL_GKD_PACKAGE)}
      >
        正式
      </button>
    </div>
  );
}

function AndroidFlowStepRail({
  steps,
  activeStepId,
  onSelectStep,
  onAddCurrentStep,
  onReorderStep,
}: {
  steps: FlowRuleStep[];
  activeStepId: string | null;
  onSelectStep: (stepId: string) => void;
  onAddCurrentStep: () => void;
  onReorderStep: (sourceStepId: string, targetStepId: string) => void;
}) {
  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 650,
        tolerance: 14,
      },
    }),
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
  );
  const stepIds = steps.map((step) => step.id);
  const draggingStepIndex = steps.findIndex((step) => step.id === draggingStepId);
  const draggingStep =
    draggingStepIndex >= 0 ? steps[draggingStepIndex] ?? null : null;

  function handleDragStart(event: DragStartEvent): void {
    setDraggingStepId(String(event.active.id));
  }

  function handleDragOver(event: DragOverEvent): void {
    const sourceStepId = String(event.active.id);
    const targetStepId = event.over?.id ? String(event.over.id) : null;
    if (!targetStepId || sourceStepId === targetStepId) return;
    onReorderStep(sourceStepId, targetStepId);
  }

  function handleDragEnd(event: DragEndEvent): void {
    void event;
    setDraggingStepId(null);
  }

  function releaseDragState(): void {
    setDraggingStepId(null);
  }

  useEffect(() => {
    if (!draggingStepId) return;

    const release = () => releaseDragState();
    const releaseTimer = window.setTimeout(release, 8000);
    window.addEventListener("pointerup", release);
    window.addEventListener("touchend", release);
    window.addEventListener("touchcancel", release);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.clearTimeout(releaseTimer);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", release);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [draggingStepId]);

  useEffect(() => {
    if (draggingStepId && !steps.some((step) => step.id === draggingStepId)) {
      setDraggingStepId(null);
    }
  }, [draggingStepId, steps]);

  return (
    <section className="android-flow-rail" aria-label="流程步骤">
      <DndContext
        collisionDetection={closestCenter}
        modifiers={[restrictDragToHorizontalAxis]}
        sensors={sensors}
        onDragCancel={releaseDragState}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragStart={handleDragStart}
      >
        <SortableContext items={stepIds} strategy={horizontalListSortingStrategy}>
          <div className="android-flow-rail-body">
            <div className="android-flow-rail-scroll">
              {steps.map((step, index) => (
                <AndroidSortableFlowChip
                  key={step.id}
                  dragging={step.id === draggingStepId}
                  index={index}
                  selected={step.id === activeStepId}
                  step={step}
                  onSelect={onSelectStep}
                />
              ))}
            </div>
            <button
              aria-label="添加当前快照为步骤"
              className="android-flow-chip android-flow-chip-add"
              type="button"
              onClick={onAddCurrentStep}
            >
              <Plus size={16} />
            </button>
          </div>
        </SortableContext>
        <DragOverlay
          className="android-drag-overlay"
          dropAnimation={null}
          modifiers={[restrictDragToHorizontalAxis]}
        >
          {draggingStep ? (
            <FlowStepChipContent
              className="android-flow-chip android-flow-chip-dragging"
              index={draggingStepIndex}
              step={draggingStep}
            />
          ) : null}
        </DragOverlay>
      </DndContext>
    </section>
  );
}

function AndroidSortableFlowChip({
  step,
  index,
  selected,
  dragging,
  onSelect,
}: {
  step: FlowRuleStep;
  index: number;
  selected: boolean;
  dragging: boolean;
  onSelect: (stepId: string) => void;
}) {
    const {
      attributes,
      listeners,
      setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: step.id,
    transition: {
      duration: 170,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <FlowStepChipContent
      ref={setNodeRef}
      className={[
        "android-flow-chip",
        selected ? "android-flow-chip-active" : "",
        isDragging || dragging ? "android-flow-chip-source-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      index={index}
      dragAttributes={attributes}
      dragListeners={listeners}
      step={step}
      style={style}
      onClick={() => onSelect(step.id)}
    />
  );
}

const FlowStepChipContent = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    step: FlowRuleStep;
    index: number;
    dragAttributes?: DraggableAttributes;
    dragListeners?: DraggableSyntheticListeners;
  }
>(function FlowStepChipContent(
  { step, index, className, dragAttributes, dragListeners, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={className}
      type="button"
      {...dragAttributes}
      {...dragListeners}
      {...props}
    >
      <strong className="android-flow-chip-handle">
        {index + 1}
      </strong>
      <span>{flowStepDisplayTitle(step, index)}</span>
      {step.preKeys && step.preKeys.length > 0 && (
        <span className="status-badge neutral">{step.preKeys.length}前</span>
      )}
      {step.selectedCandidate ? (
        <>
          <span className="status-badge success">已选</span>
          <em>{step.selectedCandidate.risk.finalScore}</em>
        </>
      ) : (
        <span className="status-badge muted">待选</span>
      )}
    </button>
  );
});

const restrictDragToHorizontalAxis: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

function AndroidFlowCanvasNav({
  activeSnapshotIndex,
  snapshotCount,
  onPrevious,
  onNext,
}: {
  activeSnapshotIndex: number;
  snapshotCount: number;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const index = activeSnapshotIndex >= 0 ? activeSnapshotIndex : 0;

  return (
    <div className="android-flow-canvas-nav" aria-label="流程快照切换">
      <button
        aria-label="上一张快照"
        disabled={snapshotCount <= 1 || activeSnapshotIndex <= 0}
        type="button"
        onClick={onPrevious}
      >
        <ChevronLeft size={18} />
      </button>
      <span>
        {snapshotCount > 0 ? `${index + 1}/${snapshotCount}` : "0/0"}
      </span>
      <button
        aria-label="下一张快照"
        disabled={
          snapshotCount <= 1 ||
          activeSnapshotIndex < 0 ||
          activeSnapshotIndex >= snapshotCount - 1
        }
        type="button"
        onClick={onNext}
      >
        <ChevronRight size={18} />
      </button>
    </div>
  );
}

function flowStepDisplayTitle(step: FlowRuleStep, index: number): string {
  return step.title.trim() || `步骤 ${index + 1}`;
}

function FlowProgress({ steps }: { steps: FlowRuleStep[] }) {
  if (steps.length === 0) return null;
  const doneCount = steps.filter((step) => step.selectedCandidate).length;
  const missing = steps
    .map((step, index) => (step.selectedCandidate ? null : index + 1))
    .filter((index): index is number => index !== null);
  return (
    <div className="android-flow-progress">
      <span>
        完成 {doneCount} / {steps.length} 步
      </span>
      {missing.length > 0 && (
        <span className="android-flow-progress-missing">
          未选候选:步骤 {missing.join("、")} 将被跳过
        </span>
      )}
    </div>
  );
}

function FlowStepPreKeysEditor({
  steps,
  activeStep,
  activeStepIndex,
  onUpdateStep,
}: {
  steps: FlowRuleStep[];
  activeStep: FlowRuleStep;
  activeStepIndex: number;
  onUpdateStep: (stepId: string, patch: Partial<FlowRuleStep>) => void;
}) {
  const currentPreKeys = activeStep.preKeys ?? null;
  return (
    <div className="android-flow-editor-prekeys">
      <div className="android-flow-editor-prekeys-label">
        <strong>前置步骤(默认依赖前面所有步)</strong>
        <span>勾选哪些步触发后本步才会跑。不勾 = 默认线性全串。</span>
      </div>
      <div className="android-flow-editor-prekeys-list">
        {steps.slice(0, activeStepIndex).map((other, idx) => {
          const otherKey = idx + 1;
          const checked = currentPreKeys?.includes(otherKey) ?? false;
          return (
            <label key={other.id} className="android-flow-editor-prekeys-row">
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  const existing = activeStep.preKeys
                    ? [...activeStep.preKeys]
                    : steps
                        .slice(0, activeStepIndex)
                        .map((_, previousIndex) => previousIndex + 1);
                  const next = event.target.checked
                    ? Array.from(new Set([...existing, otherKey])).sort(
                        (a, b) => a - b,
                      )
                    : existing.filter((key) => key !== otherKey);
                  onUpdateStep(activeStep.id, { preKeys: next });
                }}
              />
              <span>
                {otherKey}. {flowStepDisplayTitle(other, idx)}
              </span>
            </label>
          );
        })}
      </div>
      <button
        className="android-button"
        type="button"
        onClick={() => onUpdateStep(activeStep.id, { preKeys: undefined })}
      >
        恢复默认(线性全串)
      </button>
    </div>
  );
}

function AndroidScenePanel({
  scenarioId,
  customScenarios,
  customScenarioEditorOpen,
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

function AndroidAiSessionManagerPage({
  sessions,
  activeSessionId,
  onClose,
  onNewSession,
  onSelectSession,
  onDeleteSession,
}: {
  sessions: InlineAiSession[];
  activeSessionId: string | null;
  onClose: () => void;
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
}) {
  return (
    <section className="android-manager-page" aria-label="AI session 管理">
      <div className="android-manager-head">
        <div>
          <h2>AI Sessions</h2>
        </div>
        <button className="android-icon-button" type="button" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="android-session-page-body">
        <button
          className="android-session-create"
          type="button"
          onClick={onNewSession}
        >
          <Plus size={18} />
          <span>
            <strong>新 session</strong>
            <small>使用当前快照和控件重新开始</small>
          </span>
        </button>
        {sessions.length > 0 ? (
          <div className="android-session-list-page">
            {sessions.map((item) => {
              const context = formatCompactContext(item);
              return (
              <div
                key={item.id}
                className={[
                  "android-session-row-page",
                  item.id === activeSessionId ? "android-session-row-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <button
                  className="android-session-row-open"
                  type="button"
                  onClick={() => onSelectSession(item.id)}
                >
                  <span className="android-session-row-thumb">
                    {item.thumbnailUrl ? (
                      <img alt="" src={item.thumbnailUrl} />
                    ) : (
                      <Bot size={17} />
                    )}
                  </span>
                  <span className="android-session-row-main">
                    <strong>{context.appName}</strong>
                    <small>{context.nodeLabel}</small>
                  </span>
                </button>
                <button
                  aria-label={`删除 ${context.appName} ${context.nodeLabel}`}
                  className="android-session-delete"
                  type="button"
                  onClick={() => onDeleteSession(item.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              );
            })}
          </div>
        ) : (
          <div className="android-empty">当前模式还没有 AI session。</div>
        )}
      </div>
    </section>
  );
}

function AndroidAiPanel({
  config,
  canGenerate,
  candidates,
  workspaceMode,
  generatedMode,
  inlineTesting,
  selectedAiCandidateId,
  session,
  snapshot,
  targetPackage,
  elapsedSeconds,
  loading,
  message,
  operation,
  testSubscription,
  onGenerate,
  onNewSession,
  onOpenSessions,
  onAddCandidate,
  onEndCandidateTest,
  onMarkCandidate,
  onImportCandidate,
  onSelectAiCandidate,
  onSendFeedback,
}: {
  config: AiModelConfig;
  canGenerate: boolean;
  candidates: AiRuleCandidate[];
  workspaceMode: "single" | "flow";
  generatedMode: "single" | "flow" | null;
  inlineTesting: InlineRuleTestingState;
  selectedAiCandidateId: string | null;
  session: InlineAiSession | null;
  snapshot: ParsedGkdSnapshot | null;
  targetPackage: GkdTargetPackage;
  elapsedSeconds: number;
  loading: boolean;
  message: string | null;
  operation: AiOperation;
  testSubscription: TestSubscriptionDraft;
  onGenerate: () => void;
  onNewSession: () => void;
  onOpenSessions: () => void;
  onAddCandidate: (candidate: AiRuleCandidate) => void;
  onEndCandidateTest: (itemId: string) => void;
  onMarkCandidate: (
    itemId: string,
    status: Exclude<InlineTestStatus, "idle" | "testing">,
  ) => void;
  onImportCandidate: (item: InlineRuleTestItem) => void;
  onSelectAiCandidate: (candidateId: string) => void;
  onSendFeedback: (feedbacks: AiCandidateFeedback[]) => void;
}) {
  const hasConfig = Boolean(
    config.baseURL.trim() && config.apiKey.trim() && config.model.trim(),
  );
  const feedbackMode = (generatedMode ?? workspaceMode) === "flow" ? "flow" : "single";

  return (
    <div className="android-tab-content android-ai-panel">
      <div className="android-section-title">
        <h2>AI 规则候选</h2>
        <span>当前模型：{config.model}</span>
      </div>

      <div className="android-action-row">
        <button
          aria-label="管理 AI sessions"
          className="android-icon-button android-ai-session-trigger"
          type="button"
          onClick={onOpenSessions}
        >
          <ListChecks size={17} />
        </button>
        <button
          className="android-button"
          type="button"
          onClick={onNewSession}
        >
          <Plus size={16} />
          新 session
        </button>
        <button
          className="android-button android-button-primary"
          disabled={!hasConfig || loading || !canGenerate}
          type="button"
          onClick={onGenerate}
        >
          {loading ? <RefreshCw className="spin" size={16} /> : <Bot size={16} />}
          {loading
            ? "生成中"
            : workspaceMode === "flow"
              ? "生成流程规则"
              : canGenerate
                ? "生成 AI 规则"
                : "新 session 后生成"}
        </button>
      </div>

      {loading && (
        <div className="android-ai-busy" role="status">
          <RefreshCw className="spin" size={18} />
          <span>{formatAiOperationStatus(operation, elapsedSeconds)}</span>
        </div>
      )}
      {message && <p className="android-ai-message">{message}</p>}
      {generatedMode && generatedMode !== workspaceMode && (
        <p className="android-ai-warning">
          当前显示的是{generatedMode === "flow" ? "流程" : "单步"}模式候选，重新生成后会更新。
        </p>
      )}

      {candidates.length > 0 ? (
        <div className="android-ai-candidate-list">
          {candidates.map((candidate) => (
            <AndroidAiCandidateCard
              key={candidate.id}
              candidate={candidate}
              inlineTesting={inlineTesting}
              imported={isAiCandidateImported(testSubscription, candidate)}
              isSelected={candidate.id === selectedAiCandidateId}
              session={session}
              snapshot={snapshot}
              targetPackage={targetPackage}
              onAddCandidate={onAddCandidate}
              onEndTest={onEndCandidateTest}
              onImport={onImportCandidate}
              onMarkTest={onMarkCandidate}
              onSelect={onSelectAiCandidate}
            />
          ))}
          <AndroidAiBatchFeedbackPanel
            actionLabel="发送反馈给内置 AI"
            candidates={candidates}
            flowMode={feedbackMode === "flow"}
            loading={loading}
            onSubmit={onSendFeedback}
          />
        </div>
      ) : null}
    </div>
  );
}

function AndroidAiCandidateCard({
  candidate,
  imported,
  inlineTesting,
  isSelected,
  session,
  snapshot,
  targetPackage,
  onAddCandidate,
  onEndTest,
  onMarkTest,
  onImport,
  onSelect,
}: {
  candidate: AiRuleCandidate;
  imported: boolean;
  inlineTesting: InlineRuleTestingState;
  isSelected: boolean;
  session: InlineAiSession | null;
  snapshot: ParsedGkdSnapshot | null;
  targetPackage: GkdTargetPackage;
  onAddCandidate: (candidate: AiRuleCandidate) => void;
  onEndTest: (itemId: string) => void;
  onMarkTest: (
    itemId: string,
    status: Exclude<InlineTestStatus, "idle" | "testing">,
  ) => void;
  onImport: (item: InlineRuleTestItem) => void;
  onSelect: (candidateId: string) => void;
}) {
  const selectors = collectAiCandidateSelectors(candidate);
  const [copiedJson5, setCopiedJson5] = useState(false);
  const testItem = session
    ? findInlineTestItem(
        inlineTesting,
        "ai-candidate",
        session.mode,
        session.snapshotId,
        session.controlKey,
        aiCandidateSourceKey(session.id, candidate.id, session.generation),
      )
    : null;

  const candidateValidation = useMemo(() => {
    if (!snapshot) return null;
    return validateAiCandidateAgainstSnapshot(candidate, snapshot);
  }, [candidate, snapshot]);

  async function copyCandidateJson5(): Promise<void> {
    await copyTextToClipboard(stringifyRuleDraft(candidate.app));
    setCopiedJson5(true);
    window.setTimeout(() => setCopiedJson5(false), 1300);
  }

  const unparsed = candidateValidation?.unparsedMatches ?? [];

  return (
    <article
      className={`android-ai-candidate-card${isSelected ? " selected" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(candidate.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(candidate.id);
      }}
    >
      <div className="android-ai-candidate-head">
        <div>
          <strong>{candidate.title}</strong>
          <span>{candidate.summary || "AI 未提供验证说明"}</span>
        </div>
        {imported && <em>导入过</em>}
      </div>
      {candidate.risk && <p className="android-ai-risk">{candidate.risk}</p>}
      {unparsed.length > 0 ? (
        <p className="android-ai-warning">
          ⚠️ {unparsed.length} 条 selector 本工具无法预览，需人工验证：
          {unparsed.slice(0, 2).map((match) => (
            <code key={match}>{match}</code>
          ))}
          {unparsed.length > 2 ? " …" : null}
        </p>
      ) : null}
      <div className="android-ai-selector-list">
        {selectors.slice(0, 4).map((selector, index) => (
          <code key={`${candidate.id}-${index}`}>{selector}</code>
        ))}
      </div>
      <div className="android-action-row">
        <span className={`inline-test-status status-${testItem?.status ?? "idle"}`}>
          {inlineStatusLabel(testItem?.status ?? "idle")}
        </span>
        <button
          className="android-candidate-detail"
          type="button"
          onClick={() => void copyCandidateJson5()}
        >
          {copiedJson5 ? "已复制 JSON5" : "复制 JSON5"}
        </button>
        {renderInlineCandidateActions({
          item: testItem,
          feedbackActions: true,
          targetLabel: "测试",
          targetPackage,
          onStart: () => onAddCandidate(candidate),
          onEnd: onEndTest,
          onMark: onMarkTest,
          onImport,
        })}
      </div>
    </article>
  );
}

type AiFeedbackDraft = Record<
  string,
  {
    enabled: boolean;
    result: Exclude<AiFeedbackResult, "success">;
    note: string;
  }
>;

function AndroidAiBatchFeedbackPanel({
  actionLabel,
  candidates,
  flowMode,
  loading,
  onSubmit,
}: {
  actionLabel: string;
  candidates: AiRuleCandidate[];
  flowMode: boolean;
  loading: boolean;
  onSubmit: (feedbacks: AiCandidateFeedback[]) => void;
}) {
  const [drafts, setDrafts] = useState<AiFeedbackDraft>({});

  useEffect(() => {
    setDrafts((current) => {
      const next: AiFeedbackDraft = {};
      for (const candidate of candidates) {
        next[candidate.id] = current[candidate.id] ?? {
          enabled: false,
          result: "not-triggered",
          note: "",
        };
      }
      return next;
    });
  }, [candidates]);

  const selectedFeedbacks = candidates
    .map((candidate) => {
      const draft = drafts[candidate.id];
      if (!draft?.enabled) return null;
      return {
        candidate,
        result: flowMode ? "flow-note" : draft.result,
        note: draft.note,
      } satisfies AiCandidateFeedback;
    })
    .filter((item): item is AiCandidateFeedback => item !== null);

  return (
    <section className="android-ai-feedback-summary">
      <div className="android-section-title">
        <h2>测试反馈汇总</h2>
        <span>测完多个候选后再一次性发给模型；成功的候选通常直接导入，不需要反馈。</span>
      </div>
      <div className="android-ai-feedback-list">
        {candidates.map((candidate) => {
          const draft = drafts[candidate.id] ?? {
            enabled: false,
            result: "not-triggered",
            note: "",
          };
          return (
            <div key={candidate.id} className="android-ai-feedback-row">
              <label className="android-ai-feedback-check">
                <input
                  checked={draft.enabled}
                  type="checkbox"
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [candidate.id]: {
                        ...draft,
                        enabled: event.target.checked,
                      },
                    }))
                  }
                />
                <strong>{candidate.title}</strong>
              </label>
              {!flowMode && (
                <select
                  disabled={!draft.enabled}
                  value={draft.result}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [candidate.id]: {
                        ...draft,
                        result: event.target.value as Exclude<AiFeedbackResult, "success">,
                      },
                    }))
                  }
                >
                  <option value="not-triggered">未触发</option>
                  <option value="triggered-no-close">触发但没关闭</option>
                  <option value="mistouch">误触广告</option>
                  <option value="other">其他</option>
                </select>
              )}
              <textarea
                className="android-textarea android-ai-note"
                disabled={!draft.enabled}
                placeholder={
                  flowMode
                    ? "写流程测试结果：停在哪一步、是否误触、需要什么延迟"
                    : "补充说明，可留空"
                }
                rows={1}
                value={draft.note}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [candidate.id]: {
                      ...draft,
                      note: event.target.value,
                    },
                  }))
                }
              />
            </div>
          );
        })}
      </div>
      <button
        className="android-button"
        disabled={loading || selectedFeedbacks.length === 0}
        type="button"
        onClick={() => {
          onSubmit(selectedFeedbacks);
          setDrafts({});
        }}
      >
        {loading ? <RefreshCw className="spin" size={16} /> : <ClipboardCopy size={16} />}
        {actionLabel}
      </button>
    </section>
  );
}

function AndroidAiConfigDialog({
  profiles,
  activeProfileId,
  loading,
  message,
  onChangeDraft,
  onSaveProfile,
  onSelectProfile,
  onDeleteProfile,
  onClearCurrent,
  onTestConfig,
  onClose,
}: {
  profiles: AiModelProfile[];
  activeProfileId: string;
  loading: boolean;
  message: string | null;
  onChangeDraft: (config: AiModelConfig) => void;
  onSaveProfile: (profile: AiModelProfile) => void;
  onSelectProfile: (profileId: string) => void;
  onDeleteProfile: (profileId: string) => void;
  onClearCurrent: (profile: AiModelProfile) => void;
  onTestConfig: () => void;
  onClose: () => void;
}) {
  const NEW_PROFILE_ID_PREFIX = "ai-profile-new-";
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const [draft, setDraft] = useState<AiModelProfile>(
    activeProfile ?? {
      id: `ai-profile-${Date.now()}`,
      name: "",
      config: normalizeAiConfig({}),
    },
  );
  const [showKey, setShowKey] = useState(false);
  const draftIsNewProfile = !profiles.some((profile) => profile.id === draft.id);

  useEffect(() => {
    if (!activeProfile) return;
    setDraft(activeProfile);
  }, [activeProfile?.id]);

  function updateDraftConfig(patch: Partial<AiModelConfig>): void {
    const nextDraft = {
      ...draft,
      config: normalizeAiDraftConfig({
        ...draft.config,
        ...patch,
      }),
    };
    setDraft(nextDraft);
    onChangeDraft(nextDraft.config);
  }

  function createNewProfile(): void {
    const nextDraft: AiModelProfile = {
      id: `${NEW_PROFILE_ID_PREFIX}${Date.now()}`,
      name: "",
      config: {
        baseURL: "",
        apiKey: "",
        model: "",
        temperature: 0.2,
        timeoutMs: 120000,
        supportsMultimodal: false,
      },
    };
    setDraft(nextDraft);
    onChangeDraft(nextDraft.config);
  }

  function clearCurrentDraft(): void {
    const nextDraft: AiModelProfile = {
      ...draft,
      config: {
        baseURL: "",
        apiKey: "",
        model: "",
        temperature: draft.config.temperature,
        timeoutMs: draft.config.timeoutMs,
        supportsMultimodal: draft.config.supportsMultimodal,
      },
    };
    setDraft(nextDraft);
    onChangeDraft(nextDraft.config);
    onClearCurrent(nextDraft);
  }

  return (
    <div className="android-dialog-backdrop" role="presentation">
      <section aria-modal="true" className="android-dialog" role="dialog">
        <div className="android-dialog-head">
          <div>
            <h2>模型配置</h2>
          </div>
          <button
            aria-label="关闭"
            className="android-icon-button"
            type="button"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="android-ai-profile-list">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              className={[
                "android-ai-profile-chip",
                profile.id === draft.id ? "android-ai-profile-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              type="button"
              onClick={() => {
                setDraft(profile);
                onChangeDraft(profile.config);
                onSelectProfile(profile.id);
              }}
            >
              <strong>{profile.name}</strong>
              <span>{profile.config.model}</span>
            </button>
          ))}
          <button
            className={[
              "android-ai-profile-chip",
              draftIsNewProfile ? "android-ai-profile-active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            onClick={createNewProfile}
          >
            <strong>新配置</strong>
            <span>添加</span>
          </button>
        </div>
        {message && <p className="android-ai-message">{message}</p>}
        <div className="android-ai-config-form">
          <label>
            <span>名称</span>
            <input
              className="android-input"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            <span>Base URL</span>
            <input
              className="android-input"
              value={draft.config.baseURL}
              onChange={(event) => updateDraftConfig({ baseURL: event.target.value })}
            />
          </label>
          <label>
            <span>API Key</span>
            <div className="android-ai-key-row">
              <input
                className="android-input"
                type={showKey ? "text" : "password"}
                value={draft.config.apiKey}
                onChange={(event) => updateDraftConfig({ apiKey: event.target.value })}
              />
              <button
                aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                className="android-icon-button"
                type="button"
                onClick={() => setShowKey((current) => !current)}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>
          <div className="android-ai-config-grid">
            <label>
              <span>Model</span>
              <input
                className="android-input"
                value={draft.config.model}
                onChange={(event) => updateDraftConfig({ model: event.target.value })}
              />
            </label>
            <label>
              <span>Temperature</span>
              <input
                className="android-input"
                inputMode="decimal"
                value={String(draft.config.temperature)}
                onChange={(event) =>
                  updateDraftConfig({ temperature: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>Timeout(ms)</span>
              <input
                className="android-input"
                inputMode="numeric"
                value={String(draft.config.timeoutMs)}
                onChange={(event) =>
                  updateDraftConfig({ timeoutMs: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <label className="android-ai-toggle-row">
            <input
              checked={draft.config.supportsMultimodal}
              type="checkbox"
              onChange={(event) =>
                updateDraftConfig({ supportsMultimodal: event.target.checked })
              }
            />
            <span>支持多模态</span>
          </label>
        </div>
        <div className="android-action-row">
          <button
            className="android-button android-button-primary"
            type="button"
            onClick={() => onSaveProfile(draft)}
          >
            <KeyRound size={16} />
            保存
          </button>
          <button className="android-button" disabled={loading} type="button" onClick={onTestConfig}>
            {loading ? <RefreshCw className="spin" size={16} /> : <RefreshCw size={16} />}
            测试连接
          </button>
          <button
            className="android-button"
            disabled={profiles.length <= 1}
            type="button"
            onClick={() => onDeleteProfile(draft.id)}
          >
            <Trash2 size={16} />
            删除当前
          </button>
          <button className="android-button" type="button" onClick={clearCurrentDraft}>
            <Trash2 size={16} />
            清空当前
          </button>
        </div>
      </section>
    </div>
  );
}

function normalizeAiDraftConfig(input: Partial<AiModelConfig>): AiModelConfig {
  const normalized = normalizeAiConfig(input);
  return {
    ...normalized,
    baseURL: typeof input.baseURL === "string" ? input.baseURL : normalized.baseURL,
  };
}

function AndroidPromptPanel({
  workspaceMode,
  aiPasteText,
  externalAiCandidates,
  externalAiMode,
  externalAiSession,
  inlineTesting,
  targetPackage,
  snapshot,
  pickResult,
  copied,
  loading,
  message,
  selectedAiCandidateId,
  testSubscription,
  onAddExternalCandidate,
  onCopyRulePrompt,
  onPasteAiTextChange,
  onImportPastedAiResult,
  onCopyFlowPrompt,
  onCopyExternalFeedback,
  onEndCandidateTest,
  onMarkCandidate,
  onImportCandidate,
  onSelectAiCandidate,
}: {
  workspaceMode: "single" | "flow";
  aiPasteText: string;
  externalAiCandidates: AiRuleCandidate[];
  externalAiMode: "single" | "flow" | null;
  externalAiSession: InlineAiSession | null;
  inlineTesting: InlineRuleTestingState;
  targetPackage: GkdTargetPackage;
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
  copied: "scene" | "rule" | "draft" | "flowDraft" | "flowPrompt" | null;
  loading: boolean;
  message: string | null;
  selectedAiCandidateId: string | null;
  testSubscription: TestSubscriptionDraft;
  onAddExternalCandidate: (candidate: AiRuleCandidate) => void;
  onCopyRulePrompt: () => void;
  onPasteAiTextChange: (value: string) => void;
  onImportPastedAiResult: () => void;
  onCopyFlowPrompt: () => void;
  onCopyExternalFeedback: (feedbacks: AiCandidateFeedback[]) => void;
  onEndCandidateTest: (itemId: string) => void;
  onMarkCandidate: (
    itemId: string,
    status: Exclude<InlineTestStatus, "idle" | "testing">,
  ) => void;
  onImportCandidate: (item: InlineRuleTestItem) => void;
  onSelectAiCandidate: (candidateId: string) => void;
}) {
  const canImportPaste =
    workspaceMode === "flow" ? true : Boolean(snapshot && pickResult);
  return (
    <div className="android-tab-content">
      <div className="android-section-title">
        <h2>外部 AI Prompt</h2>
      </div>
      <div className="android-action-row">
        <button
          className="android-button android-button-primary"
          disabled={workspaceMode === "single" ? !snapshot || !pickResult : false}
          type="button"
          onClick={workspaceMode === "flow" ? onCopyFlowPrompt : onCopyRulePrompt}
        >
          {(workspaceMode === "flow" ? copied === "flowPrompt" : copied === "rule") ? (
            <Check size={16} />
          ) : (
            <ClipboardCopy size={16} />
          )}
          {(workspaceMode === "flow" ? copied === "flowPrompt" : copied === "rule")
            ? "已复制 prompt"
            : "复制求助 prompt"}
        </button>
      </div>
      {message && <p className="android-ai-message">{message}</p>}
      {externalAiCandidates.length > 0 ? (
        <div className="android-ai-candidate-list">
          {externalAiCandidates.map((candidate) => (
            <AndroidAiCandidateCard
              key={candidate.id}
              candidate={candidate}
              imported={isAiCandidateImported(testSubscription, candidate)}
              inlineTesting={inlineTesting}
              isSelected={candidate.id === selectedAiCandidateId}
              session={externalAiSession}
              snapshot={snapshot}
              targetPackage={targetPackage}
              onAddCandidate={onAddExternalCandidate}
              onEndTest={onEndCandidateTest}
              onImport={onImportCandidate}
              onMarkTest={onMarkCandidate}
              onSelect={onSelectAiCandidate}
            />
          ))}
          <AndroidAiBatchFeedbackPanel
            actionLabel="复制测试反馈 prompt"
            candidates={externalAiCandidates}
            flowMode={(externalAiMode ?? workspaceMode) === "flow"}
            loading={loading}
            onSubmit={onCopyExternalFeedback}
          />
        </div>
      ) : null}
      <div className="android-ai-paste-box">
        <textarea
          className="android-textarea"
          placeholder="粘贴 AI 返回的规则内容，会自动过滤出真正的 GKD 规则"
          rows={4}
          value={aiPasteText}
          onChange={(event) => onPasteAiTextChange(event.target.value)}
        />
        <button
          className="android-button"
          disabled={!aiPasteText.trim() || !canImportPaste}
          type="button"
          onClick={onImportPastedAiResult}
        >
          <Plus size={16} />
          提取 AI 规则
        </button>
      </div>
    </div>
  );
}

function AndroidSnapshotChooser({
  snapshots,
  selectedIds,
  loading,
  openingId,
  openingFlow,
  exportingId,
  names,
  renameDraft,
  renamingId,
  onToggle,
  onRefresh,
  onOpenSelected,
  onExport,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onRenameDraftChange,
}: {
  snapshots: DeviceSnapshotSummary[];
  selectedIds: Set<number>;
  loading: boolean;
  openingId: number | null;
  openingFlow: boolean;
  exportingId: number | null;
  names: SnapshotNameMap;
  renameDraft: string;
  renamingId: number | null;
  onToggle: (id: number) => void;
  onRefresh: () => void;
  onOpenSelected: () => void;
  onExport: (item: DeviceSnapshotSummary) => void;
  onStartRename: (item: DeviceSnapshotSummary) => void;
  onCommitRename: (id: number) => void;
  onCancelRename: () => void;
  onRenameDraftChange: (value: string) => void;
}) {
  const openMode = resolveAndroidSnapshotOpenMode(selectedIds);
  const isOpening = openingId !== null || openingFlow;

  return (
    <div className="android-snapshot-chooser">
      <div className="android-section-title">
        <h2>选择快照</h2>
      </div>
      {snapshots.length > 0 ? (
        <div className="android-snapshot-check-list">
          {snapshots.map((item) => {
            const customName = names[String(item.id)] ?? null;
            const label = snapshotOptionLabel(item, customName);
            return (
              <div key={item.id} className="android-snapshot-check-row">
                {renamingId === item.id ? (
                  <div className="android-snapshot-rename-row">
                    <input
                      autoFocus
                      className="android-input android-snapshot-rename-input"
                      placeholder="快照名称，留空恢复默认"
                      value={renameDraft}
                      onChange={(event) => onRenameDraftChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") onCommitRename(item.id);
                        if (event.key === "Escape") onCancelRename();
                      }}
                    />
                    <button
                      aria-label="保存名称"
                      className="android-icon-button android-snapshot-export-button"
                      type="button"
                      onClick={() => onCommitRename(item.id)}
                    >
                      <Check size={16} />
                    </button>
                    <button
                      aria-label="取消改名"
                      className="android-icon-button android-snapshot-export-button"
                      type="button"
                      onClick={onCancelRename}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <>
                    <label className="android-snapshot-check-toggle">
                      <input
                        checked={selectedIds.has(item.id)}
                        disabled={isOpening}
                        type="checkbox"
                        onChange={() => onToggle(item.id)}
                      />
                      <span>{label}</span>
                    </label>
                    <div className="android-snapshot-row-actions">
                      <button
                        aria-label={`重命名快照：${label}`}
                        className="android-icon-button android-snapshot-export-button"
                        disabled={isOpening || renamingId !== null}
                        title="重命名快照"
                        type="button"
                        onClick={() => onStartRename(item)}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        aria-label={`导出快照：${label}`}
                        className="android-icon-button android-snapshot-export-button"
                        disabled={isOpening || exportingId !== null || renamingId !== null}
                        title="导出为 Markdown 文档 + 截图"
                        type="button"
                        onClick={() => onExport(item)}
                      >
                        {exportingId === item.id ? (
                          <Loader2 className="spin" size={16} />
                        ) : (
                          <Download size={16} />
                        )}
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="android-empty">手机上没有快照。请先在 GKD 里保存快照，然后刷新。</div>
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
            ? `进入工作区 (${selectedIds.size})`
            : "进入工作区"}
      </button>
    </div>
  );
}

function AndroidFlowEditor({
  steps,
  activeStep,
  activeStepId,
  customScenarios,
  flowName,
  flowDesc,
  flowPreview,
  copied,
  onAddFlowToTestZone,
  onFlowNameChange,
  onFlowDescChange,
  onSelectStep,
  onUpdateStep,
  onRemoveStep,
  onCopyFlowDraft,
  onStepScenarioChange,
}: {
  steps: FlowRuleStep[];
  activeStep: FlowRuleStep | null;
  activeStepId: string | null;
  customScenarios: CustomScenario[];
  flowName: string;
  flowDesc: string;
  flowPreview: string;
  copied: "scene" | "rule" | "draft" | "flowDraft" | "flowPrompt" | null;
  onAddFlowToTestZone: () => void;
  onFlowNameChange: (value: string) => void;
  onFlowDescChange: (value: string) => void;
  onSelectStep: (stepId: string) => void;
  onUpdateStep: (stepId: string, patch: Partial<FlowRuleStep>) => void;
  onRemoveStep: (stepId: string) => void;
  onCopyFlowDraft: () => void;
  onStepScenarioChange: (stepId: string, scenarioId: string) => void;
}) {
  const activeStepIndex = steps.findIndex((step) => step.id === activeStepId);
  const activeStepTitle =
    activeStep && activeStepIndex >= 0
      ? flowStepDisplayTitle(activeStep, activeStepIndex)
      : "未选择步骤";

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
          placeholder="整体说明，例如：点进去再返回"
          value={flowDesc}
          onChange={(event) => onFlowDescChange(event.target.value)}
        />
      </div>
      <FlowProgress steps={steps} />
      <div className="android-flow-step-list">
        {steps.map((step, index) => (
          <button
            key={step.id}
            className={[
              "android-flow-step",
              step.id === activeStepId ? "android-flow-step-active" : "",
              !step.selectedCandidate
                ? "android-flow-step-missing"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            onClick={() => onSelectStep(step.id)}
          >
            <span>
              <strong>{index + 1}</strong>
              {flowStepDisplayTitle(step, index)}
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
      {activeStep && (
        <div className="android-flow-editor">
          <div className="android-flow-editor-title">
            <span className="status-badge neutral">
              正在编辑：{activeStepTitle}
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
            placeholder="步骤说明：这一步要做什么、是否需要等待"
            rows={3}
            value={activeStep.note}
            onChange={(event) =>
              onUpdateStep(activeStep.id, { note: event.target.value })
            }
          />
          <select
            className="android-select"
            value={activeStep.scenarioId}
            onChange={(event) =>
              onStepScenarioChange(activeStep.id, event.target.value)
            }
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
          </select>
          <RuntimeSummary settings={activeStep.ruleSettings} />
          {activeStepIndex > 0 && (
            <FlowStepPreKeysEditor
              steps={steps}
              activeStep={activeStep}
              activeStepIndex={activeStepIndex}
              onUpdateStep={onUpdateStep}
            />
          )}
        </div>
      )}
      <div className="android-action-row">
        <button
          className="android-button android-button-primary"
          disabled={!flowPreview}
          type="button"
          onClick={onAddFlowToTestZone}
        >
          <Plus size={16} />
          测试整个流程
        </button>
        <button
          className="android-button"
          disabled={!flowPreview}
          type="button"
          onClick={onCopyFlowDraft}
        >
          {copied === "flowDraft" ? <Check size={16} /> : <Copy size={16} />}
          {copied === "flowDraft" ? "已复制规则" : "复制流程规则"}
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
  inlineTesting,
  mode,
  snapshot,
  snapshotId,
  controlKey,
  targetPackage,
  onSelect,
  onStartTest,
  onEndTest,
  onMarkTest,
  onImport,
}: {
  candidates: SelectorCandidate[];
  selectedId: string | null;
  importedSelectorKeys: Set<string>;
  inlineTesting: InlineRuleTestingState;
  mode: "single" | "flow";
  snapshot: ParsedGkdSnapshot | null;
  snapshotId?: number | string;
  controlKey: string;
  targetPackage: GkdTargetPackage;
  onSelect: (candidate: SelectorCandidate) => void;
  onStartTest: (candidate: SelectorCandidate) => void;
  onEndTest: (itemId: string) => void;
  onMarkTest: (
    itemId: string,
    status: Exclude<InlineTestStatus, "idle" | "testing">,
  ) => void;
  onImport: (item: InlineRuleTestItem) => void;
}) {
  const [detailCandidateId, setDetailCandidateId] = useState<string | null>(null);
  const [copiedCandidateId, setCopiedCandidateId] = useState<string | null>(null);

  if (candidates.length === 0) {
    return null;
  }

  return (
    <div className="android-candidate-list">
      {candidates.slice(0, 6).map((candidate, index) => {
        const guidance = getCandidateGuidance(candidate, index);
        const displayIndex = selectorDisplayIndex(candidates, candidate);
        const imported = importedSelectorKeys.has(candidate.rule.matches.join("\n"));
        const testItem = findInlineTestItem(
          inlineTesting,
          "offline-selector",
          mode,
          snapshotId,
          controlKey,
          candidate.rule.matches.join("\n"),
        );

        const showDetails = detailCandidateId === candidate.id;
        const candidateJson5 = snapshot
          ? stringifyRuleDraft(
              createAppRuleDraft(
                snapshot,
                candidate,
                selectFallbackCandidates(candidate, candidates),
              ),
            )
          : "";

        async function copyCandidateJson5(event: MouseEvent<HTMLButtonElement>): Promise<void> {
          event.stopPropagation();
          if (!candidateJson5) return;
          await copyTextToClipboard(candidateJson5);
          setCopiedCandidateId(candidate.id);
          window.setTimeout(() => {
            setCopiedCandidateId((current) =>
              current === candidate.id ? null : current,
            );
          }, 1300);
        }

        return (
          <div
            key={candidate.id}
            className={`android-candidate-item ${
              candidate.id === selectedId ? "android-candidate-active" : ""
            }`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(candidate)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelect(candidate);
            }}
          >
            <div className="android-candidate-compact">
              <span className="android-candidate-strategy">
                {humanStrategyTitle(candidate.strategyName)}
              </span>
              <code>{candidate.rule.matches.join(" && ")}</code>
              <div className="android-candidate-actions">
                <button
                  className="android-candidate-detail"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDetailCandidateId((current) =>
                      current === candidate.id ? null : candidate.id,
                    );
                  }}
                >
                  {showDetails ? "收起详情" : "查看详情"}
                </button>
                {renderInlineCandidateActions({
                  item: testItem,
                  feedbackActions: false,
                  targetLabel: "测试",
                  targetPackage,
                  onStart: () => onStartTest(candidate),
                  onEnd: onEndTest,
                  onImport,
                  onMark: onMarkTest,
                })}
              </div>
            </div>
            {showDetails && (
              <div className="android-candidate-details">
                <span className={`candidate-guidance ${guidance.tone}`}>
                  <strong>{guidance.label}</strong>
                  <span>{guidance.reason}</span>
                </span>
                {imported && <span className="candidate-imported-badge">导入过</span>}
                <span className="android-candidate-heading">
                  <span className="candidate-index-badge">#{displayIndex}</span>
                  <span className={`status-badge ${candidate.risk.level}`}>
                    {riskLabel(candidate.risk.level)}
                  </span>
                  <span>{humanStrategyTitle(candidate.strategyName)}</span>
                  <strong>{candidate.risk.finalScore}</strong>
                </span>
                <div className="android-candidate-actions">
                  <span className={`inline-test-status status-${testItem?.status ?? "idle"}`}>
                    {inlineStatusLabel(testItem?.status ?? "idle")}
                  </span>
                  <button
                    className="android-candidate-detail"
                    disabled={!candidateJson5}
                    type="button"
                    onClick={(event) => void copyCandidateJson5(event)}
                  >
                    {copiedCandidateId === candidate.id ? "已复制 JSON5" : "复制 JSON5"}
                  </button>
                </div>
                {sameRegionLabel(candidate) && <span>{sameRegionLabel(candidate)}</span>}
                <span>{humanStrategyDesc(candidate)}</span>
                <small>{formatScoreNote(candidate)}</small>
                <small>{formatCandidateAction(candidate)}</small>
                <CandidateRiskNotes candidate={candidate} />
                {candidateJson5 && (
                  <pre className="android-candidate-json-preview">
                    <code>{candidateJson5}</code>
                  </pre>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function renderInlineCandidateActions({
  item,
  feedbackActions,
  targetLabel,
  targetPackage,
  onStart,
  onEnd,
  onMark,
  onImport,
}: {
  item: InlineRuleTestItem | null;
  feedbackActions: boolean;
  targetLabel: string;
  targetPackage: GkdTargetPackage;
  onStart: () => void;
  onEnd: (itemId: string) => void;
  onMark: (
    itemId: string,
    status: Exclude<InlineTestStatus, "idle" | "testing">,
  ) => void;
  onImport: (item: InlineRuleTestItem) => void;
}) {
  if (!item || item.status === "idle") {
    return (
      <button
        className="android-candidate-add"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onStart();
        }}
      >
        {targetLabel}
      </button>
    );
  }

  if (item.status === "testing") {
    if (!feedbackActions) {
      return (
        <button
          className="android-candidate-detail"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onEnd(item.id);
          }}
        >
          结束测试
        </button>
      );
    }
    return (
      <>
        <button
          className="android-candidate-add"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onMark(item.id, "valid");
          }}
        >
          有效
        </button>
        <button
          className="android-candidate-detail"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onMark(item.id, "invalid");
          }}
        >
          无效
        </button>
        <button
          className="android-candidate-detail"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onEnd(item.id);
          }}
        >
          结束
        </button>
      </>
    );
  }

  return (
    <>
      <button
        className="android-candidate-detail"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onStart();
        }}
      >
        重新测试
      </button>
      <button
        className="android-candidate-add"
        disabled={!item.canImport}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onImport(item);
        }}
      >
        {isDebugTarget(targetPackage) ? "导入" : "复制"}
      </button>
    </>
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

function inlineStatusLabel(status: InlineTestStatus): string {
  const labels: Record<InlineTestStatus, string> = {
    idle: "未测试",
    testing: "测试中",
    tested: "已测试",
    ended: "已结束",
    valid: "有效",
    invalid: "无效",
    mistouch: "误触",
    other: "其他",
  };
  return labels[status];
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
    negativeActionVariantUnion: "否定动作变体合并",
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
    negativeActionVariantUnion: "合并同义否定词，跨 App 复用",
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

function formatAiOperationStatus(operation: AiOperation, elapsedSeconds: number): string {
  const seconds = `${elapsedSeconds} 秒`;
  if (operation === "test") return `正在测试连接，已等待 ${seconds}`;
  if (operation === "feedback") return `正在发送测试反馈并等待模型修正，已等待 ${seconds}`;
  return `模型正在生成规则候选，已等待 ${seconds}，长 prompt 可能需要 1-2 分钟`;
}

function TargetSummary({
  pickResult,
  selectedCandidate,
}: {
  pickResult: NodePickResult | null;
  selectedCandidate: SelectorCandidate | null;
}) {
  if (!pickResult) {
    return null;
  }

  return (
    <div className="android-target-summary">
      <strong>已选 #{pickResult.pickedNode.id} {nodeLabel(pickResult.pickedNode)}</strong>
      {selectedCandidate && (
        <span>候选：{selectedCandidate.rule.matches.join(" && ")}</span>
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
    activityIds: nextSnapshot.activityId ?? "",
  };
}

/** 取 Activity 路径最后两段用于短展示；桌面/系统界面快照的 activityId 可能为 null。 */
function shortActivity(activityId: string | null | undefined): string {
  return activityId?.split(".").slice(-2).join(".") ?? "未知页面";
}

function resolveConnectOrigin(input: string): string {
  const origins = extractDeviceOrigins(input);
  return origins[0] ?? input;
}

