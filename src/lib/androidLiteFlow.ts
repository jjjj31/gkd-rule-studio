/** 安卓版多步流程的辅助工具：
 * 判断打开模式（单选/多选/单步/流程）、从快照数组创建流程步骤、在流程画布中切换快照时重分配步骤。
 * 仅被 AndroidLiteApp 使用。
 */
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { FlowRuleStep } from "../types/flowDraft";
import type { SelectorCandidate } from "../types/ruleDraft";
import {
  createAppRuleDraft,
  selectFallbackCandidates,
  stringifyRuleDraft,
} from "./ruleDraft";

export type AndroidSnapshotOpenMode =
  | {
      mode: "none";
      ids: [];
    }
  | {
      mode: "single";
      ids: [number];
    }
  | {
      mode: "flow";
      ids: number[];
    };

export interface SnapshotListItem {
  id: number;
}

/** 判断选择快照的打开模式：none（没选）/single（单步）/flow（多步流程）。 */
export function resolveAndroidSnapshotOpenMode(
  selectedIds: Set<number>,
): AndroidSnapshotOpenMode {
  const ids = [...selectedIds];
  if (ids.length === 0) return { mode: "none", ids: [] };
  if (ids.length === 1) return { mode: "single", ids: [ids[0]!] };
  return { mode: "flow", ids };
}

export function resolveAndroidFlowCanvasSnapshots<TSnapshot extends SnapshotListItem>({
  selectedSnapshots,
  availableSnapshots,
  steps,
}: {
  selectedSnapshots: TSnapshot[];
  availableSnapshots: TSnapshot[];
  steps: FlowRuleStep[];
}): TSnapshot[] | ParsedGkdSnapshot[] {
  if (selectedSnapshots.length > 0) return selectedSnapshots;
  if (availableSnapshots.length > 0) return availableSnapshots;

  const seen = new Set<number>();
  return steps
    .map((step) => step.snapshot)
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

/** 从已加载的 ParsedGkdSnapshot 数组创建 FlowRuleStep（安卓版多步）。每个步骤初始无选点。 */
export function createAndroidFlowSteps(
  snapshots: ParsedGkdSnapshot[],
): FlowRuleStep[] {
  return snapshots.map((snapshot, index) => ({
    id: createAndroidFlowStepId(snapshot, index),
    title: "",
    note: "",
    delayNote: "步骤间延迟只作为 prompt 上下文，不保证强流程顺序。",
    snapshot,
    pickResult: null,
    candidates: [],
    selectedCandidate: null,
  }));
}

export function reassignAndroidFlowStepSnapshot(
  step: FlowRuleStep,
  snapshot: ParsedGkdSnapshot,
): FlowRuleStep {
  if (step.snapshot.id === snapshot.id) return step;

  return {
    ...step,
    snapshot,
    pickResult: null,
    candidates: [],
    selectedCandidate: null,
  };
}

export function shouldShowSnapshotOpeningState(
  source: "snapshot-list" | "flow-canvas",
): boolean {
  return source === "snapshot-list";
}

export function createAndroidSingleRulePreview(
  snapshot: ParsedGkdSnapshot | null,
  candidate: SelectorCandidate | null,
  candidates: SelectorCandidate[],
): string {
  if (!snapshot || !candidate) return "";
  const draft = createAppRuleDraft(
    snapshot,
    candidate,
    selectFallbackCandidates(candidate, candidates),
  );
  return stringifyRuleDraft(draft);
}

function createAndroidFlowStepId(
  snapshot: ParsedGkdSnapshot,
  index: number,
): string {
  return `android-flow-${snapshot.id}-${index + 1}`;
}
