/**
 * 内联测试状态机。维护两条数据流：
 * 1. inlineTestItems[] — 每条候选的测试状态，持久化到 localStorage
 * 2. aiSessions[] — AI 会话及候选，持久化到 localStorage
 * buildActiveTestSubscription 整合后发给 deviceApi 同步到 GKD。
 * @see testSubscription.ts 导入/导出 payload
 */
import type { AppRuleDraft } from "../types/ruleDraft";
import type { AiMode, AiRuleCandidate } from "./aiModel";
import {
  addAppDraftToTestSubscription,
  createEmptyTestSubscription,
  type TestSubscriptionDraft,
} from "./testSubscription";

export type InlineTestSource = "offline-selector" | "ai-candidate" | "flow";
export type InlineTestStatus =
  | "idle"
  | "testing"
  | "tested"
  | "ended"
  | "valid"
  | "invalid"
  | "mistouch"
  | "other";

export interface InlineRuleTestItem {
  id: string;
  source: InlineTestSource;
  mode: AiMode;
  snapshotId?: number | string;
  controlKey?: string;
  sourceKey: string;
  title: string;
  summary: string;
  appName?: string;
  nodeId?: number | string;
  selectorIndex?: number | string;
  thumbnailUrl?: string;
  app: AppRuleDraft;
  status: InlineTestStatus;
  canImport: boolean;
  createdAt: number;
  updatedAt: number;
  aiSessionId?: string;
  /** AI 候选所属的生成轮次（第 1 轮、第 2 轮…），用于区分同一 session 内跨轮次候选。 */
  generation?: number;
  /** 已导入到 GKD 本地规则的时间戳；非空时避免非幂等重复导入。 */
  importedAt?: number;
  note?: string;
}

export interface InlineAiFeedbackHistoryItem {
  candidateId: string;
  title: string;
  result: string;
  note: string;
  selectors?: string[];
}

export interface InlineAiFeedbackHistoryEntry {
  at: number;
  note: string;
  generation?: number;
  items?: InlineAiFeedbackHistoryItem[];
}

export interface InlineAiSession {
  id: string;
  mode: AiMode;
  /** 会话来源：内置 AI 生成，还是外部粘贴。旧数据缺省视为 builtin。 */
  source?: "builtin" | "external";
  snapshotId?: number | string;
  controlKey?: string;
  title: string;
  originalPrompt: string;
  contextSummary: string;
  appName?: string;
  nodeId?: number | string;
  selectorIndex?: number | string;
  thumbnailUrl?: string;
  /** 候选生成轮次。每次 setAiSessionCandidates 时 +1，用于区分同名 ID 的不同轮次候选。 */
  generation: number;
  candidateIds: string[];
  candidates: AiRuleCandidate[];
  feedbackHistory: InlineAiFeedbackHistoryEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface InlineRuleTestingState {
  version: 1;
  items: InlineRuleTestItem[];
  aiSessions: InlineAiSession[];
  updatedAt?: number;
}

export interface StartOfflineCandidateInput {
  mode: AiMode;
  snapshotId?: number | string;
  controlKey?: string;
  sourceKey: string;
  title: string;
  summary: string;
  appName?: string;
  nodeId?: number | string;
  selectorIndex?: number | string;
  thumbnailUrl?: string;
  app: AppRuleDraft;
}

export interface AddAiSessionInput {
  mode: AiMode;
  source?: "builtin" | "external";
  snapshotId?: number | string;
  controlKey?: string;
  title: string;
  originalPrompt: string;
  contextSummary: string;
  appName?: string;
  nodeId?: number | string;
  thumbnailUrl?: string;
}

/** 初始空状态，版本 1，空 items 和 sessions。 */
export function createEmptyInlineRuleTestingState(): InlineRuleTestingState {
  return {
    version: 1,
    items: [],
    aiSessions: [],
  };
}

/** 把算法候选加入测试集合（脱机 selector）。自动去重（相同 sourceKey 覆盖）。 */
export function startOfflineCandidateTest(
  state: InlineRuleTestingState,
  input: StartOfflineCandidateInput,
  now = Date.now(),
): InlineRuleTestingState {
  const id = inlineItemId(
    "offline-selector",
    input.mode,
    input.snapshotId,
    input.controlKey,
    input.sourceKey,
  );
  const existing = findItem(state, id);
  const item: InlineRuleTestItem = {
    id,
    source: "offline-selector",
    mode: input.mode,
    snapshotId: input.snapshotId,
    controlKey: input.controlKey,
    sourceKey: input.sourceKey,
    title: input.title,
    summary: input.summary,
    appName: input.appName,
    nodeId: input.nodeId,
    selectorIndex: input.selectorIndex,
    thumbnailUrl: input.thumbnailUrl,
    app: input.app,
    status: "testing",
    canImport: false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.importedAt !== undefined ? { importedAt: existing.importedAt } : {}),
  };

  return upsertInlineTestItem(state, item, now);
}

/** 把 AI candidate 加入测试集合。走 startAiCandidateTest source key。 */
export function startAiCandidateTest(
  state: InlineRuleTestingState,
  aiSessionId: string,
  candidate: AiRuleCandidate,
  now = Date.now(),
): InlineRuleTestingState {
  const session = state.aiSessions.find((item) => item.id === aiSessionId);
  if (!session) return state;

  const sourceKey = aiCandidateSourceKey(aiSessionId, candidate.id, session.generation);
  const id = inlineItemId(
    "ai-candidate",
    session.mode,
    session.snapshotId,
    session.controlKey,
    sourceKey,
  );
  const existing = findItem(state, id);
  const item: InlineRuleTestItem = {
    id,
    source: "ai-candidate",
    mode: session.mode,
    snapshotId: session.snapshotId,
    controlKey: session.controlKey,
    sourceKey,
    title: candidate.title,
    summary: candidate.summary,
    appName: session.appName,
    nodeId: session.nodeId,
    selectorIndex: candidate.id,
    thumbnailUrl: session.thumbnailUrl,
    app: candidate.app,
    status: "testing",
    canImport: false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    aiSessionId,
    generation: session.generation,
    ...(existing?.importedAt !== undefined ? { importedAt: existing.importedAt } : {}),
  };

  const next = upsertInlineTestItem(state, item, now);
  return {
    ...next,
    aiSessions: next.aiSessions.map((current) =>
      current.id === aiSessionId
        ? {
            ...current,
            candidateIds: unique([...current.candidateIds, id]),
            candidates: upsertAiCandidate(current.candidates, candidate),
            updatedAt: now,
          }
        : current,
    ),
  };
}

/** 结束单条正在进行的测试（将状态置为 tested 并允许导入，从活跃内存订阅移除）。 */
export function removeInlineTestItem(
  state: InlineRuleTestingState,
  itemId: string,
  now = Date.now(),
): InlineRuleTestingState {
  return markInlineTestItemResult(state, itemId, "tested", now);
}

export function deleteInlineTestItem(
  state: InlineRuleTestingState,
  itemId: string,
  now = Date.now(),
): InlineRuleTestingState {
  return {
    ...state,
    items: state.items.filter((item) => item.id !== itemId),
    updatedAt: now,
  };
}

export function markInlineTestItemResult(
  state: InlineRuleTestingState,
  itemId: string,
  status: Exclude<InlineTestStatus, "idle" | "testing">,
  now = Date.now(),
  note?: string,
): InlineRuleTestingState {
  return {
    ...state,
    items: state.items.map((item) =>
      item.id === itemId
        ? {
            ...item,
            status,
            canImport: status === "valid" || status === "tested",
            updatedAt: now,
            note,
          }
        : item,
    ),
    updatedAt: now,
  };
}

/** 把当前数据（快照+选点+候选）创建一个新 AI session 并加入状态。 */
export function addAiSession(
  state: InlineRuleTestingState,
  input: AddAiSessionInput,
  now = Date.now(),
): InlineRuleTestingState {
  const session: InlineAiSession = {
    id: `ai-session-${now}-${Math.random().toString(36).slice(2, 8)}`,
    mode: input.mode,
    source: input.source ?? "builtin",
    snapshotId: input.snapshotId,
    controlKey: input.controlKey,
    title: input.title,
    originalPrompt: input.originalPrompt,
    contextSummary: input.contextSummary,
    appName: input.appName,
    nodeId: input.nodeId,
    thumbnailUrl: input.thumbnailUrl,
    generation: 0,
    candidateIds: [],
    candidates: [],
    feedbackHistory: [],
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...state,
    aiSessions: [session, ...state.aiSessions],
    updatedAt: now,
  };
}

export function setAiSessionCandidates(
  state: InlineRuleTestingState,
  aiSessionId: string,
  candidates: AiRuleCandidate[],
  now = Date.now(),
  feedbackEntry?: InlineAiFeedbackHistoryEntry,
): InlineRuleTestingState {
  const targetSession = state.aiSessions.find((session) => session.id === aiSessionId);
  if (!targetSession) return state;

  const nextGeneration = targetSession.generation + 1;
  // 当会话进入新一轮候选（generation > 1）时，自动结束上一轮仍在 testing 的旧候选，
  // 避免第一轮仍在 GKD 内存订阅里运行并与第二轮候选混在一起。
  const items =
    targetSession.generation > 0
      ? state.items.map((item) =>
          item.aiSessionId === aiSessionId && item.status === "testing"
            ? {
                ...item,
                status: "ended" as const,
                canImport: false,
                updatedAt: now,
              }
            : item,
        )
      : state.items;

  return {
    ...state,
    items,
    aiSessions: state.aiSessions.map((session) =>
      session.id === aiSessionId
        ? {
            ...session,
            candidates,
            generation: nextGeneration,
            feedbackHistory: feedbackEntry
              ? [...session.feedbackHistory, feedbackEntry]
              : session.feedbackHistory,
            updatedAt: now,
          }
        : session,
    ),
    updatedAt: now,
  };
}

export function appendAiSessionFeedback(
  state: InlineRuleTestingState,
  aiSessionId: string,
  entry: InlineAiFeedbackHistoryEntry,
  now = Date.now(),
): InlineRuleTestingState {
  return {
    ...state,
    aiSessions: state.aiSessions.map((session) =>
      session.id === aiSessionId
        ? {
            ...session,
            feedbackHistory: [...session.feedbackHistory, entry],
            updatedAt: now,
          }
        : session,
    ),
    updatedAt: now,
  };
}

export function restartInlineTestItem(
  state: InlineRuleTestingState,
  itemId: string,
  now = Date.now(),
): InlineRuleTestingState {
  const existing = findItem(state, itemId);
  if (!existing) return state;
  const restarted: InlineRuleTestItem = {
    ...existing,
    status: "testing",
    canImport: false,
    updatedAt: now,
  };
  return upsertInlineTestItem(state, restarted, now);
}

export function markInlineTestItemImported(
  state: InlineRuleTestingState,
  itemId: string,
  now = Date.now(),
): InlineRuleTestingState {
  if (!state.items.some((item) => item.id === itemId)) return state;
  return {
    ...state,
    items: state.items.map((item) =>
      item.id === itemId
        ? {
            ...item,
            importedAt: now,
            updatedAt: now,
          }
        : item,
    ),
    updatedAt: now,
  };
}

export function endAllInlineTests(
  state: InlineRuleTestingState,
  now = Date.now(),
): InlineRuleTestingState {
  if (!state.items.some((item) => item.status === "testing")) return state;
  return {
    ...state,
    items: state.items.map((item) =>
      item.status === "testing"
        ? {
            ...item,
            status: "tested" as const,
            canImport: true,
            updatedAt: now,
          }
        : item,
    ),
    updatedAt: now,
  };
}

export function clearFinishedInlineTestItems(
  state: InlineRuleTestingState,
  now = Date.now(),
): InlineRuleTestingState {
  const remaining = state.items.filter((item) => item.status === "testing");
  if (remaining.length === state.items.length) return state;
  return {
    ...state,
    items: remaining,
    updatedAt: now,
  };
}

export function filterAiSessionsByMode(
  state: InlineRuleTestingState,
  mode: AiMode,
): InlineAiSession[] {
  return state.aiSessions.filter((session) => session.mode === mode);
}

export function deleteAiSession(
  state: InlineRuleTestingState,
  aiSessionId: string,
  now = Date.now(),
): InlineRuleTestingState {
  return {
    ...state,
    aiSessions: state.aiSessions.filter((session) => session.id !== aiSessionId),
    items: state.items.filter((item) => item.aiSessionId !== aiSessionId),
    updatedAt: now,
  };
}

export function prunePersistentInlineRuleTestingState(
  state: InlineRuleTestingState,
): InlineRuleTestingState {
  const sessionIds = new Set(state.aiSessions.map((session) => session.id));
  return {
    ...state,
    items: state.items.filter((item) => {
      if (item.source === "offline-selector") return true;
      return item.source === "ai-candidate" && Boolean(item.aiSessionId && sessionIds.has(item.aiSessionId));
    }),
  };
}

/** 整合当前测试集合（items + sessions）→ 发给 GKD 的完整订阅 payload。 */
export function buildActiveTestSubscription(
  state: InlineRuleTestingState,
): TestSubscriptionDraft {
  return state.items
    .filter((item) => item.status === "testing")
    .reduce(
      (draft, item) => addAppDraftToTestSubscription(draft, item.app),
      createEmptyTestSubscription(),
    );
}

export function findInlineTestItem(
  state: InlineRuleTestingState,
  source: InlineTestSource,
  mode: AiMode,
  snapshotId: number | string | undefined,
  controlKey: string | undefined,
  sourceKey: string,
): InlineRuleTestItem | null {
  return findItem(state, inlineItemId(source, mode, snapshotId, controlKey, sourceKey));
}

export function aiCandidateSourceKey(
  aiSessionId: string,
  candidateId: string,
  generation = 0,
): string {
  return `${aiSessionId}:${candidateId}:${generation}`;
}

function upsertInlineTestItem(
  state: InlineRuleTestingState,
  item: InlineRuleTestItem,
  now: number,
): InlineRuleTestingState {
  const exists = state.items.some((current) => current.id === item.id);
  const items = state.items.map((current) => {
    if (current.id === item.id) return item;
    if (
      item.status === "testing" &&
      item.controlKey &&
      current.controlKey === item.controlKey &&
      current.status === "testing"
    ) {
      return {
        ...current,
        status: "tested" as const,
        canImport: true,
        updatedAt: now,
      };
    }
    return current;
  });
  return {
    ...state,
    items: exists ? items : [...items, item],
    updatedAt: now,
  };
}

function findItem(
  state: InlineRuleTestingState,
  itemId: string,
): InlineRuleTestItem | null {
  return state.items.find((item) => item.id === itemId) ?? null;
}

function inlineItemId(
  source: InlineTestSource,
  mode: AiMode,
  snapshotId: number | string | undefined,
  controlKey: string | undefined,
  sourceKey: string,
): string {
  return [
    source,
    mode,
    snapshotId ?? "no-snapshot",
    controlKey ?? "no-control",
    sourceKey,
  ].join("|");
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function upsertAiCandidate(
  candidates: AiRuleCandidate[],
  candidate: AiRuleCandidate,
): AiRuleCandidate[] {
  return candidates.some((item) => item.id === candidate.id)
    ? candidates.map((item) => (item.id === candidate.id ? candidate : item))
    : [...candidates, candidate];
}
