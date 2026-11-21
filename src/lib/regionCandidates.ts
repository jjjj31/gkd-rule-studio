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
import {
  generateSelectorCandidates,
  isHighCollisionGenericResource,
  isObfuscatedResourceId,
} from "./selectorStrategies";
import { validateSelectorPlan } from "./selectorMatcher";
import {
  buildVisualTargetIds,
  isClickWithinVisualTarget,
} from "./visualTarget";

/** 同框候选点击目标偏离用户所选控件时的排序降权分。 */
const SAME_REGION_OFF_TARGET_PENALTY = 30;

/** 达到该基础分的候选不视为“弱兜底”，可以优先按命中目标排序。 */
const STRONG_TARGET_BASE_SCORE = 70;

/**
 * 跨版本稳定性分层。数值来自 2,230 对“同一应用同一控件、不同快照”的实测
 * （`bench/cross-version.bench.ts`）：stableResourceSemantic 约 98%，
 * exactId/exactVid/typePlusExactAttr/textSkipGuarded 约 69%–77%，
 * 其余写法（文字上下文、多命中收窄、匿名结构）约 0%–59%。
 * 只分三档，是因为中间几种写法在两半数据上波动很大，细排名不可靠。
 * 同一档内保持原有分数顺序，不影响单张快照的命中判断。
 */
const STRATEGY_STABILITY_TIER: Record<string, number> = {
  stableResourceSemantic: 1,
  exactId: 2,
  exactVid: 2,
  typePlusExactAttr: 2,
  textSkipGuarded: 2,
  clickParentByChildIdVid: 2,
};

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
  const visualTargetIds = buildVisualTargetIds({
    snapshot,
    pickedNode: pickResult.pickedNode,
    clickableAncestor: pickResult.clickableAncestor,
  });
  const primary = generateForPick(snapshot, ruleSettings, pickResult);
  const sameRegionNodes = findSameRegionNodes(snapshot, pickResult.pickedNode);
  const clickIdsCache = new WeakMap<SelectorCandidate, number[]>();
  const sameRegionCandidates = sameRegionNodes.flatMap((node) => {
    const nodePick = pickExistingNode(snapshot, node);
    return generateForPick(snapshot, ruleSettings, nodePick).map((candidate) =>
      markSameRegionCandidate(
        snapshot,
        candidate,
        node,
        pickResult,
        visualTargetIds,
        clickIdsCache,
      ),
    );
  });

  return sortCandidates(
    snapshot,
    dedupeCandidates([...primary, ...sameRegionCandidates]),
    visualTargetIds,
    pickResult.pickedNode.id,
    !hasTargetSignal(pickResult.pickedNode),
    clickIdsCache,
  );
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
  snapshot: ParsedGkdSnapshot,
  candidate: SelectorCandidate,
  node: NormalizedSnapshotNode,
  primaryPick: NodePickResult,
  visualTargetIds: Set<number>,
  clickIdsCache: WeakMap<SelectorCandidate, number[]>,
): SelectorCandidate {
  // 用户点的是图标，同框的文字标签候选会命中另一个节点。点击目标偏离用户选择时降权，
  // 让"图标 + 文字锚点"这类正确规则排到前面。
  const clickedIds = selectorClickIds(snapshot, candidate, clickIdsCache);
  const offTarget =
    clickedIds.length > 0 &&
    !isClickWithinVisualTarget(clickedIds, visualTargetIds);
  return {
    ...candidate,
    id: `same-region-${node.id}-${candidate.id}`,
    title: `同框节点 #${node.id} · ${candidate.title}`,
    rankPenalty: offTarget
      ? Math.max(candidate.rankPenalty ?? 0, SAME_REGION_OFF_TARGET_PENALTY)
      : candidate.rankPenalty ?? 0,
    debugReasons: [
      `同框节点 #${node.id} ${node.attr.name}`,
      ...(offTarget
        ? [
            `点击目标 #${clickedIds.join(",")} 与用户所选 #${primaryPick.pickedNode.id} 的视觉摞不同，排序降权`,
          ]
        : []),
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

function sortCandidates(
  snapshot: ParsedGkdSnapshot,
  candidates: SelectorCandidate[],
  visualTargetIds: Set<number>,
  pickedNodeId: number,
  pickedIsWeak: boolean,
  clickIdsCache: WeakMap<SelectorCandidate, number[]>,
): SelectorCandidate[] {
  return [...candidates].sort((a, b) => {
    const bRank = visualTargetRank(
      snapshot,
      b,
      visualTargetIds,
      pickedNodeId,
      pickedIsWeak,
      clickIdsCache,
    );
    const aRank = visualTargetRank(
      snapshot,
      a,
      visualTargetIds,
      pickedNodeId,
      pickedIsWeak,
      clickIdsCache,
    );
    if (aRank !== bRank) return aRank - bRank;
    const bTier = candidateStabilityTier(b);
    const aTier = candidateStabilityTier(a);
    if (aTier !== bTier) return aTier - bTier;
    const bScore = effectiveScore(b);
    const aScore = effectiveScore(a);
    if (bScore !== aScore) return bScore - aScore;
    if (b.risk.finalScore !== a.risk.finalScore) {
      return b.risk.finalScore - a.risk.finalScore;
    }
    return b.baseScore - a.baseScore;
  });
}

function candidateStabilityTier(candidate: SelectorCandidate): number {
  const baseTier = STRATEGY_STABILITY_TIER[candidate.strategyName] ?? 3;
  if (
    candidate.strategyName === "exactId" ||
    candidate.strategyName === "exactVid"
  ) {
    const conditions =
      candidate.plan.kind === "simple" ? candidate.plan.selector.conditions : [];
    const resCond = conditions.find(
      (c) => c.attr === "id" || c.attr === "vid",
    );
    const hasTextGuard = conditions.some(
      (c) => c.attr === "text" || c.attr === "desc",
    );
    const resVal = typeof resCond?.value === "string" ? resCond.value : "";
    // 混淆资源名（如 dzp、rvc、obfuscated、arg、pdd）换版本极易失效，降档让位给稳定文本
    if (isObfuscatedResourceId(resVal)) {
      return 4;
    }
    // 系统/跨包通用标题资源名（如 miui:id/alertTitle、tvTitle）且未加文本守卫时，低于具体文案
    if (
      !hasTextGuard &&
      (resVal.startsWith("android:id/") ||
        resVal.startsWith("miui:id/") ||
        isHighCollisionGenericResource(resVal))
    ) {
      return 3;
    }
  }
  return baseTier;
}

/**
 * 硬排序分组：先保证候选点的是用户所选控件所在的视觉摞，再比分数。
 * 扣分只能影响组内顺序，不能再让"点偏了但基础分很高"的候选翻到前面。
 */
function visualTargetRank(
  snapshot: ParsedGkdSnapshot,
  candidate: SelectorCandidate,
  visualTargetIds: Set<number>,
  pickedNodeId: number,
  pickedIsWeak: boolean,
  clickIdsCache: WeakMap<SelectorCandidate, number[]>,
): number {
  const clickedIds = selectorClickIds(snapshot, candidate, clickIdsCache);
  if (clickedIds.length === 0) return 9;

  const unique = clickedIds.length === 1;
  const exact = unique && clickedIds[0] === pickedNodeId;
  const insideCount = clickedIds.filter((id) => visualTargetIds.has(id)).length;
  const inside = insideCount === clickedIds.length;
  // 兜底策略（可见节点/父区域兜底）分数很低；没有稳定依据时，不让它
  // 仅凭“点的是所选节点”压过同摞里带 vid/text 的可靠候选。
  const strong = candidate.baseScore >= STRONG_TARGET_BASE_SCORE;
  const pickedNode = snapshot.nodeById.get(pickedNodeId);
  const pickedClickable = Boolean(pickedNode?.attr.clickable);
  const hasSafeClickableInVisualTarget =
    !pickedClickable &&
    Array.from(visualTargetIds).some((id) => {
      const node = snapshot.nodeById.get(id);
      return Boolean(node && isSafeClickableVisualTarget(snapshot, node));
    });

  if (hasSafeClickableInVisualTarget && inside && strong && unique) {
    const clickedNode = snapshot.nodeById.get(clickedIds[0]!);
    if (clickedNode && isSafeClickableVisualTarget(snapshot, clickedNode)) {
      return 0;
    }
    if (exact) return 1;
  }

  if (exact && strong && !pickedIsWeak) return 0;
  if (inside && strong) return unique ? 1 : 2;
  if (exact) return 3;
  if (inside) return unique ? 4 : 5;
  if (insideCount > 0) return 6;
  return unique ? 7 : 8;
}

function isSafeClickableVisualTarget(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): boolean {
  if (!node.attr.clickable || !node.attr.visibleToUser) return false;
  const screenArea = Math.max(1, snapshot.screenWidth * snapshot.screenHeight);
  if (nodeArea(node) / screenArea > 0.15) return false;
  const res = `${node.attr.id ?? ""} ${node.attr.vid ?? ""}`.toLowerCase();
  if (
    res.includes("shade") ||
    res.includes("mask") ||
    res.includes("hotarea") ||
    res.includes("hot_area") ||
    res.includes("click_area") ||
    res.includes("clickarea") ||
    res.includes("click_group")
  ) {
    return false;
  }
  return /(skip|close|cancel)/.test(res);
}

/**
 * 排序只看“选择器本身点到哪些节点”，不带 activityIds 等规则范围。
 * 规则范围只影响这条规则什么时候生效，不该影响候选之间的优劣比较；否则
 * activityIds 与快照不一致时命中集合为空，排序会退化成纯按分数排。
 */
function selectorClickIds(
  snapshot: ParsedGkdSnapshot,
  candidate: SelectorCandidate,
  cache: WeakMap<SelectorCandidate, number[]>,
): number[] {
  const cached = cache.get(candidate);
  if (cached) return cached;
  const ids = validateSelectorPlan(snapshot, candidate.plan).clickNodes.map(
    (node) => node.id,
  );
  cache.set(candidate, ids);
  return ids;
}

/** 用户选中的节点是否有可用于定位的文字/资源/可点属性。 */
function hasTargetSignal(node: NormalizedSnapshotNode): boolean {
  return Boolean(
    node.attr.text ||
      node.attr.desc ||
      node.attr.id ||
      node.attr.vid ||
      node.attr.clickable,
  );
}

function effectiveScore(candidate: SelectorCandidate): number {
  return Math.max(
    0,
    Math.min(
      140,
      candidate.risk.finalScore +
        candidate.actionPlan.rankAdjustment -
        (candidate.rankPenalty ?? 0),
    ),
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

