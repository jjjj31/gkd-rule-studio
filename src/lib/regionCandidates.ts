/**
 * 候选生成总入口。
 * 输入：快照 + 选点结果 + 规则设置 → 输出：一组排序后的 SelectorCandidate[]。
 * 内部先对 pickedNode 跑 14 种策略，再找"同框区域"的其他节点也各跑一遍策略，
 * 最后去重并按分数从高到低排列。
 * @see selectorStrategies 14 种策略的具体实现
 */
import type {
  NodePickResult,
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { RuleSettings, SelectorCandidate } from "../types/ruleDraft";
import { pickExistingNode } from "./nodePicker";
import { candidateDedupeKey } from "./candidateIdentity";
import { generateSelectorCandidates } from "./selectorStrategies";

/** 主入口：生成、去重、排序所有候选，供前端 CandidateList / CandidateSummary 渲染。 */
export function generateRegionSelectorCandidates({
  snapshot,
  ruleSettings,
  pickResult,
}: {
  snapshot: ParsedGkdSnapshot;
  ruleSettings: RuleSettings;
  pickResult: NodePickResult;
}): SelectorCandidate[] {
  const primary = generateForPick(snapshot, ruleSettings, pickResult);
  const sameRegionNodes = findSameRegionNodes(snapshot, pickResult.pickedNode);
  const sameRegionCandidates = sameRegionNodes.flatMap((node) => {
    const nodePick = pickExistingNode(snapshot, node);
    return generateForPick(snapshot, ruleSettings, nodePick).map((candidate) =>
      markSameRegionCandidate(candidate, node),
    );
  });

  return sortCandidates(dedupeCandidates([...primary, ...sameRegionCandidates]));
}

function generateForPick(
  snapshot: ParsedGkdSnapshot,
  ruleSettings: RuleSettings,
  pickResult: NodePickResult,
): SelectorCandidate[] {
  return generateSelectorCandidates({
    snapshot,
    ruleSettings,
    pickedNode: pickResult.pickedNode,
    ancestors: pickResult.ancestors,
    siblings: pickResult.siblings,
    clickableAncestor: pickResult.clickableAncestor,
    nearbyTextNodes: pickResult.nearbyTextNodes,
  });
}

function findSameRegionNodes(
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode,
): NormalizedSnapshotNode[] {
  const visualRegion = findCompactVisualRegion(snapshot, pickedNode);

  return snapshot.nodes
    .filter((node) => node.id !== pickedNode.id)
    .filter((node) => node.attr.visibleToUser)
    .filter((node) => hasUsefulSelectorSignal(node))
    .filter((node) => sameBounds(node, pickedNode) || isInsideVisualRegion(node, visualRegion))
    .sort((a, b) => {
      if (b.attr.clickable !== a.attr.clickable) {
        return Number(b.attr.clickable) - Number(a.attr.clickable);
      }
      if (hasStableSignal(b) !== hasStableSignal(a)) {
        return Number(hasStableSignal(b)) - Number(hasStableSignal(a));
      }
      return b.attr.depth - a.attr.depth;
    })
    .slice(0, 12);
}

function markSameRegionCandidate(
  candidate: SelectorCandidate,
  node: NormalizedSnapshotNode,
): SelectorCandidate {
  return {
    ...candidate,
    id: `same-region-${node.id}-${candidate.id}`,
    title: `同框节点 #${node.id} · ${candidate.title}`,
    debugReasons: [
      `同框节点 #${node.id} ${node.attr.name}`,
      ...candidate.debugReasons,
    ],
  };
}

function dedupeCandidates(candidates: SelectorCandidate[]): SelectorCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidateDedupeKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortCandidates(candidates: SelectorCandidate[]): SelectorCandidate[] {
  return [...candidates].sort((a, b) => {
    const bScore = effectiveScore(b);
    const aScore = effectiveScore(a);
    if (bScore !== aScore) return bScore - aScore;
    if (b.risk.finalScore !== a.risk.finalScore) {
      return b.risk.finalScore - a.risk.finalScore;
    }
    return b.baseScore - a.baseScore;
  });
}

function effectiveScore(candidate: SelectorCandidate): number {
  return Math.max(
    0,
    Math.min(140, candidate.risk.finalScore + candidate.actionPlan.rankAdjustment),
  );
}

function sameBounds(
  a: NormalizedSnapshotNode,
  b: NormalizedSnapshotNode,
): boolean {
  return (
    a.attr.left === b.attr.left &&
    a.attr.top === b.attr.top &&
    a.attr.right === b.attr.right &&
    a.attr.bottom === b.attr.bottom
  );
}

function findCompactVisualRegion(
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode,
): NormalizedSnapshotNode {
  const screenArea = snapshot.screenWidth * snapshot.screenHeight;
  const maxRegionArea = Math.max(nodeArea(pickedNode) * 16, 180000);
  let current: NormalizedSnapshotNode | undefined = pickedNode;
  let best = pickedNode;

  while (current && current.pid >= 0) {
    const parent = snapshot.nodeById.get(current.pid);
    if (!parent) break;

    const area = nodeArea(parent);
    if (area <= maxRegionArea && area / screenArea <= 0.18) {
      best = parent;
      current = parent;
      continue;
    }

    break;
  }

  return best;
}

function isInsideVisualRegion(
  node: NormalizedSnapshotNode,
  region: NormalizedSnapshotNode,
): boolean {
  if (node.id === region.id) return false;
  return (
    node.attr.left >= region.attr.left &&
    node.attr.top >= region.attr.top &&
    node.attr.right <= region.attr.right &&
    node.attr.bottom <= region.attr.bottom
  );
}

function hasUsefulSelectorSignal(node: NormalizedSnapshotNode): boolean {
  return (
    hasStableSignal(node) ||
    Boolean(node.attr.text || node.attr.desc || node.attr.clickable)
  );
}

function hasStableSignal(node: NormalizedSnapshotNode): boolean {
  return Boolean(node.attr.id || node.attr.vid);
}

function nodeArea(node: NormalizedSnapshotNode): number {
  return Math.max(0, node.attr.width) * Math.max(0, node.attr.height);
}
