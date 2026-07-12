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
  note?: string;
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
  candidateIds: string[];
  candidates: AiRuleCandidate[];
  feedbackHistory: Array<{
    at: number;
    note: string;
  }>;
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
    createdAt: findItem(state, id)?.createdAt ?? now,
    updatedAt: now,
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

  const sourceKey = aiCandidateSourceKey(aiSessionId, candidate.id);
  const id = inlineItemId(
    "ai-candidate",
    session.mode,
    session.snapshotId,
    session.controlKey,
    sourceKey,
  );
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
    createdAt: findItem(state, id)?.createdAt ?? now,
    updatedAt: now,
    aiSessionId,
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

/** 移除测试项（从 items 中彻底删除）。 */
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
): InlineRuleTestingState {
  return {
    ...state,
    aiSessions: state.aiSessions.map((session) =>
      session.id === aiSessionId
        ? {
            ...session,
            candidates,
            updatedAt: now,
          }
        : session,
    ),
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
): string {
  return `${aiSessionId}:${candidateId}`;
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
