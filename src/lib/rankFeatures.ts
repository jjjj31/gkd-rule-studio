/**
 * 排序模型特征。训练（bench/extract-rank-features.bench.ts）和运行时
 * （rankCandidates）共用本文件，保证特征顺序与含义一致。
 */
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type {
  SelectorCandidate,
  SelectorPlan,
  SimpleSelector,
} from "../types/ruleDraft";
import { buildVisualTargetIds } from "./visualTarget";
import { validateSelectorPlan } from "./selectorMatcher";

export const RANK_FEATURE_NAMES = [
  "baseScore",
  "riskScore",
  "rankAdjustment",
  "rankPenalty",
  "hitCount",
  "uniqueHit",
  "clickedPicked",
  "clickedClickableAncestor",
  "clickedVisualStack",
  "offTarget",
  "noClick",
  "planSimple",
  "planParentChild",
  "planSibling",
  "planContextSibling",
  "planMatchesChain",
  "planAncestorDescendant",
  "conditionCount",
  "hasText",
  "hasDesc",
  "hasId",
  "hasVid",
  "hasClickable",
  "hasWidth",
  "hasHeight",
  "hasChildCount",
  "hasIndex",
  "hasDepth",
  "hasVisible",
  "matchCount",
  "matchLength",
  "orCount",
  "atCount",
  "targetClickable",
  "targetChildCount",
  "targetDepth",
  "targetAreaRatio",
  "targetHasText",
  "targetHasDesc",
  "targetHasId",
  "targetHasVid",
  "strategyStructural",
  "strategyNarrowing",
  "strategyVisibleFallback",
  "strategyAncestorFallback",
  "strategyExactStable",
  "structuralCondition",
  "conditionsPerMatch",
] as const;

export type RankFeatureName = (typeof RANK_FEATURE_NAMES)[number];

export interface RankContext {
  snapshot: ParsedGkdSnapshot;
  pickedNode: NormalizedSnapshotNode;
  clickableAncestor: NormalizedSnapshotNode | null;
  visualTargetIds: Set<number>;
  screenArea: number;
}

export function createRankContext({
  snapshot,
  pickedNode,
  clickableAncestor,
}: {
  snapshot: ParsedGkdSnapshot;
  pickedNode: NormalizedSnapshotNode;
  clickableAncestor: NormalizedSnapshotNode | null;
}): RankContext {
  return {
    snapshot,
    pickedNode,
    clickableAncestor,
    visualTargetIds: buildVisualTargetIds({
      snapshot,
      pickedNode,
      clickableAncestor,
    }),
    screenArea: Math.max(1, snapshot.screenWidth * snapshot.screenHeight),
  };
}

/** 返回与 RANK_FEATURE_NAMES 一一对应的数值特征。 */
export function extractRankFeatures(
  candidate: SelectorCandidate,
  context: RankContext,
): number[] {
  // 只用选择器本身判断是否点中目标，不带 activityIds/matchTime 等规则范围。
  // 训练标签与基准的 semantic 指标因此保持一致。
  const selectorValidation = validateSelectorPlan(context.snapshot, candidate.plan);
  const clickedIds = selectorValidation.clickNodes.map((node) => node.id);
  const unique = clickedIds.length === 1;
  const clickedPicked = unique && clickedIds[0] === context.pickedNode.id;
  const clickedAncestor = Boolean(
    context.clickableAncestor &&
      clickedIds.includes(context.clickableAncestor.id),
  );
  const insideStack =
    clickedIds.length > 0 &&
    clickedIds.every((id) => context.visualTargetIds.has(id));
  const offTarget = clickedIds.length > 0 && !insideStack && !clickedAncestor;

  const selectors = collectSimpleSelectors(candidate.plan);
  const conditions = selectors.flatMap((selector) => selector.conditions);
  const attrs = new Set(conditions.map((condition) => condition.attr));
  const matches = candidate.rule.matches;
  const matchText = matches.join(" ");
  const target = context.pickedNode;
  const targetArea =
    Math.max(0, target.attr.width) * Math.max(0, target.attr.height);

  const featureMap: Record<RankFeatureName, number> = {
    baseScore: candidate.baseScore / 100,
    riskScore: candidate.risk.finalScore / 100,
    rankAdjustment: candidate.actionPlan.rankAdjustment / 100,
    rankPenalty: (candidate.rankPenalty ?? 0) / 100,
    hitCount: Math.min(selectorValidation.hitCount, 5) / 5,
    uniqueHit: unique ? 1 : 0,
    clickedPicked: clickedPicked ? 1 : 0,
    clickedClickableAncestor: clickedAncestor ? 1 : 0,
    clickedVisualStack: insideStack ? 1 : 0,
    offTarget: offTarget ? 1 : 0,
    noClick: clickedIds.length === 0 ? 1 : 0,
    planSimple: candidate.plan.kind === "simple" ? 1 : 0,
    planParentChild: candidate.plan.kind === "parentChild" ? 1 : 0,
    planSibling: candidate.plan.kind === "sibling" ? 1 : 0,
    planContextSibling: candidate.plan.kind === "contextSibling" ? 1 : 0,
    planMatchesChain: candidate.plan.kind === "matchesChain" ? 1 : 0,
    planAncestorDescendant:
      candidate.plan.kind === "ancestorDescendant" ? 1 : 0,
    conditionCount: Math.min(conditions.length, 10) / 10,
    hasText: attrs.has("text") ? 1 : 0,
    hasDesc: attrs.has("desc") ? 1 : 0,
    hasId: attrs.has("id") ? 1 : 0,
    hasVid: attrs.has("vid") ? 1 : 0,
    hasClickable: attrs.has("clickable") ? 1 : 0,
    hasWidth: attrs.has("width") ? 1 : 0,
    hasHeight: attrs.has("height") ? 1 : 0,
    hasChildCount: attrs.has("childCount") ? 1 : 0,
    hasIndex: attrs.has("index") ? 1 : 0,
    hasDepth: attrs.has("depth") ? 1 : 0,
    hasVisible: attrs.has("visibleToUser") ? 1 : 0,
    matchCount: Math.min(matches.length, 3) / 3,
    matchLength: Math.min(matchText.length, 200) / 200,
    orCount: Math.min((matchText.match(/\|\|/g) ?? []).length, 4) / 4,
    atCount: Math.min((matchText.match(/@/g) ?? []).length, 2) / 2,
    targetClickable: target.attr.clickable ? 1 : 0,
    targetChildCount: Math.min(target.attr.childCount, 5) / 5,
    targetDepth: Math.min(target.attr.depth, 30) / 30,
    targetAreaRatio: Math.min(targetArea / context.screenArea, 1),
    targetHasText: target.attr.text ? 1 : 0,
    targetHasDesc: target.attr.desc ? 1 : 0,
    targetHasId: target.attr.id ? 1 : 0,
    targetHasVid: target.attr.vid ? 1 : 0,
    strategyStructural:
      candidate.strategyName === "structuralTargetFallback" ? 1 : 0,
    strategyNarrowing:
      candidate.strategyName === "ambiguousTargetNarrowing" ? 1 : 0,
    strategyVisibleFallback:
      candidate.strategyName === "visibleNodeFallback" ? 1 : 0,
    strategyAncestorFallback:
      candidate.strategyName === "clickableAncestorFallback" ? 1 : 0,
    strategyExactStable:
      candidate.strategyName === "exactVid" ||
      candidate.strategyName === "exactId"
        ? 1
        : 0,
    structuralCondition:
      attrs.has("childCount") ||
      attrs.has("width") ||
      attrs.has("height") ||
      attrs.has("index") ||
      attrs.has("depth")
        ? 1
        : 0,
    conditionsPerMatch:
      Math.min(conditions.length / Math.max(1, matches.length), 10) / 10,
  };

  return RANK_FEATURE_NAMES.map((name) => featureMap[name]);
}

function collectSimpleSelectors(plan: SelectorPlan): SimpleSelector[] {
  switch (plan.kind) {
    case "simple":
      return [plan.selector];
    case "parentChild":
      return [plan.parent, plan.child];
    case "sibling":
      return [plan.target, plan.neighbor];
    case "contextSibling":
      return [plan.context, plan.target];
    case "matchesChain":
      return [plan.context, plan.target];
    case "ancestorDescendant":
      return [plan.ancestor, plan.descendant];
  }
}
