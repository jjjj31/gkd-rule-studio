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

export function resolveAndroidSnapshotOpenMode(
  selectedIds: Set<number>,
): AndroidSnapshotOpenMode {
  const ids = [...selectedIds];
  if (ids.length === 0) return { mode: "none", ids: [] };
  if (ids.length === 1) return { mode: "single", ids: [ids[0]!] };
  return { mode: "flow", ids };
}

export function createAndroidFlowSteps(
  snapshots: ParsedGkdSnapshot[],
): FlowRuleStep[] {
  return snapshots.map((snapshot, index) => ({
    id: createAndroidFlowStepId(snapshot, index),
    title: `步骤 ${index + 1}`,
    note: "",
    delayNote: "步骤间延迟只作为 prompt 上下文，不保证强流程顺序。",
    snapshot,
    pickResult: null,
    candidates: [],
    selectedCandidate: null,
  }));
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
