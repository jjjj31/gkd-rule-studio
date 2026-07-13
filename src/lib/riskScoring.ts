/**
 * 候选评分系统。
 * 基础分来自策略优先级，加上/减去命中数、活动匹配、坐标稳定性、文字风险、
 * 广告上下文检测、父节点风险、复杂度等维度 → 最终 finalScore + 风险等级。
 * 扣分规则数据来自 data/riskWords.ts。
 * @see actionPlan.ts 动作计划与评分并列
 */
import {
  DANGEROUS_CLICK_WORDS,
  GENERIC_ACTION_TEXT,
} from "../data/riskWords";
import { nodeArea } from "../types/gkdSnapshot";
import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type {
  RiskBreakdown,
  RiskItem,
  RuleDraft,
  SelectorPlan,
  SelectorValidation,
  SimpleSelector,
} from "../types/ruleDraft";

/** 评分入口：从基准分开始，累计各维度加减分 → RiskBreakdown。不改变候选结构，只产出打分。 */
export function scoreCandidate(input: {
  baseScore: number;
  snapshot: ParsedGkdSnapshot;
  plan: SelectorPlan;
  rule: RuleDraft;
  validation: SelectorValidation;
  allowNoActivityIds?: boolean;
  pickedNode: NormalizedSnapshotNode;
}): RiskBreakdown {
  const { baseScore, snapshot, plan, rule, validation, allowNoActivityIds, pickedNode } =
    input;
  const items: RiskItem[] = [
    {
      label: "基础策略",
      value: baseScore,
      reason: "来自 selector 策略优先级",
    },
  ];

  const target = validation.clickNodes[0] ?? null;
  addHitCountScore(items, validation.hitCount);
  addProximityScore(items, snapshot, pickedNode, validation);
  addActivityScore(items, rule.activityIds, Boolean(allowNoActivityIds));
  addBoundsScore(items, snapshot, target);
  addClickableScore(items, target);
  addTextRiskScore(items, target, plan);
  addDynamicCountdownScore(items, plan);
  addAdSdkOverlayScore(items, target);
  addAdContextScore(items, snapshot, target);
  addParentRiskScore(items, snapshot, plan, validation);
  addComplexityScore(items, plan);

  const positiveScore = items
    .filter((item) => item.value > 0)
    .reduce((sum, item) => sum + item.value, 0);
  const penaltyScore = items
    .filter((item) => item.value < 0)
    .reduce((sum, item) => sum + item.value, 0);
  const cappedPositiveScore = Math.min(100, positiveScore);
  const finalScore = Math.max(
    0,
    Math.min(100, Math.round(cappedPositiveScore + penaltyScore)),
  );

  return {
    finalScore,
    level: finalScore >= 85 ? "low" : finalScore >= 70 ? "medium" : "high",
    items,
    positiveScore,
    cappedPositiveScore,
    penaltyScore,
  };
}

function addHitCountScore(items: RiskItem[], hitCount: number): void {
  if (hitCount === 1) {
    items.push({
      label: "唯一命中",
      value: 18,
      reason: "当前快照只命中一个点击目标",
    });
    return;
  }

  if (hitCount === 0) {
    items.push({
      label: "未命中",
      value: -50,
      reason: "生成 selector 在当前快照没有点击目标",
    });
    return;
  }

  items.push({
    label: "多命中",
    value: -12 * (hitCount - 1),
    reason: `当前快照命中 ${hitCount} 个点击目标`,
  });
}

/**
 * 空间邻近性打分：让规则命中的绿框（validation.clickNodes）落在用户选点蓝框附近。
 * - 任意 clickNode 与 pickedNode 的 bbox 重叠/包含 → +6（命中靠近选点）
 * - 最近 clickNode 中心到 pickedNode 中心距离 > 0.25 屏幕对角线 → −40（命中远离选点）
 *   远处命中若 pickedNode 与最近 clickNode 共享广告祖先，降为 −10（点容器而真按钮在内部属合法）
 *
 * Why: 之前的打分只看属性唯一性（唯一命中 +18），不看命中节点位置，导致「命中屏幕另一角落的唯一按钮」
 * 压过「命中用户点选的按钮」排到第一，绿框跑到远处。
 */
function addProximityScore(
  items: RiskItem[],
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode,
  validation: SelectorValidation,
): void {
  if (validation.clickNodes.length === 0) return;

  const near = validation.clickNodes.some(
    (node) =>
      boundsOverlap(node, pickedNode) ||
      containsRect(node, pickedNode) ||
      containsRect(pickedNode, node),
  );
  if (near) {
    items.push({
      label: "命中靠近选点",
      value: 6,
      reason: "规则命中节点与用户点击区域位置重合或相邻",
    });
    return;
  }

  const diag = screenDiagonal(snapshot);
  if (diag <= 0) return;

  let bestDist = Infinity;
  let bestNode: NormalizedSnapshotNode | null = null;
  const pickedCenter = rectCenter(pickedNode);
  for (const node of validation.clickNodes) {
    const c = rectCenter(node);
    const d = Math.hypot(c.x - pickedCenter.x, c.y - pickedCenter.y) / diag;
    if (d < bestDist) {
      bestDist = d;
      bestNode = node;
    }
  }

  if (bestNode && bestDist > 0.25) {
    const sharedAd = hasAdAncestor(snapshot, pickedNode) &&
      (hasAdAncestor(snapshot, bestNode) || isAdLikeNode(bestNode));
    items.push({
      label: sharedAd ? "命中偏离选点(广告)" : "命中远离选点",
      value: sharedAd ? -10 : -40,
      reason: sharedAd
        ? "命中节点偏离选点，但与选点同属广告容器，保留为低优先候补"
        : "规则命中节点远离用户点击区域，可能在屏幕其它位置误触",
    });
  }
}

function boundsOverlap(a: NormalizedSnapshotNode, b: NormalizedSnapshotNode): boolean {
  return (
    a.attr.left < b.attr.right &&
    a.attr.right > b.attr.left &&
    a.attr.top < b.attr.bottom &&
    a.attr.bottom > b.attr.top
  );
}

function containsRect(outer: NormalizedSnapshotNode, inner: NormalizedSnapshotNode): boolean {
  return (
    outer.attr.left <= inner.attr.left &&
    outer.attr.right >= inner.attr.right &&
    outer.attr.top <= inner.attr.top &&
    outer.attr.bottom >= inner.attr.bottom
  );
}

function rectCenter(node: NormalizedSnapshotNode): { x: number; y: number } {
  return {
    x: (node.attr.left + node.attr.right) / 2,
    y: (node.attr.top + node.attr.bottom) / 2,
  };
}

function screenDiagonal(snapshot: ParsedGkdSnapshot): number {
  return Math.hypot(snapshot.screenWidth, snapshot.screenHeight);
}

function addActivityScore(
  items: RiskItem[],
  activityIds: string | string[] | undefined,
  allowNoActivityIds: boolean,
): void {
  if (Array.isArray(activityIds) ? activityIds.length > 0 : Boolean(activityIds)) {
    items.push({
      label: "activityIds",
      value: 12,
      reason: "规则被限制在当前 Activity",
    });
  } else if (allowNoActivityIds) {
    items.push({
      label: "短窗口替代",
      value: 4,
      reason: "未限制 Activity，但有短窗口/单次点击约束",
    });
  } else {
    items.push({
      label: "缺少 activityIds",
      value: -18,
      reason: "非明确开屏场景不建议裸 selector",
    });
  }
}

function addBoundsScore(
  items: RiskItem[],
  snapshot: ParsedGkdSnapshot,
  target: NormalizedSnapshotNode | null,
): void {
  if (!target) return;
  const screenArea = snapshot.screenWidth * snapshot.screenHeight;
  const ratio = screenArea > 0 ? nodeArea(target.attr) / screenArea : 1;

  if (ratio <= 0.03) {
    items.push({
      label: "小目标",
      value: 12,
      reason: "点击目标面积不超过屏幕 3%",
    });
    return;
  }

  if (ratio <= 0.08) {
    items.push({
      label: "目标尺寸",
      value: 6,
      reason: "点击目标面积不超过屏幕 8%",
    });
    return;
  }

  if (ratio > 0.35) {
    items.push({
      label: "目标过大",
      value: -35,
      reason: "点击目标面积超过屏幕 35%",
    });
    return;
  }

  if (ratio > 0.2) {
    items.push({
      label: "目标偏大",
      value: -18,
      reason: "点击目标面积超过屏幕 20%",
    });
  }
}

function addClickableScore(
  items: RiskItem[],
  target: NormalizedSnapshotNode | null,
): void {
  if (!target) return;

  if (target.attr.clickable) {
    items.push({
      label: "可点击目标",
      value: 8,
      reason: "最终点击节点本身 clickable=true",
    });
  } else {
    items.push({
      label: "不可点击目标",
      value: -8,
      reason: "最终点击节点不可点击，可能需要 @ 抬升点击目标",
    });
  }
}

function addTextRiskScore(
  items: RiskItem[],
  target: NormalizedSnapshotNode | null,
  plan: SelectorPlan,
): void {
  if (!target) return;

  const targetText = [
    target.attr.text,
    target.attr.desc,
    target.attr.id,
    target.attr.vid,
  ]
    .filter(Boolean)
    .join(" ");

  const normalizedTargetText = targetText.toLowerCase();
  if (
    DANGEROUS_CLICK_WORDS.some((word) =>
      normalizedTargetText.includes(word.toLowerCase()),
    )
  ) {
    items.push({
      label: "危险 CTA",
      value: -90,
      reason: "最终点击目标含下载、安装、打开等高危词",
    });
  }

  const text = target.attr.text ?? target.attr.desc ?? "";
  if (
    text &&
    GENERIC_ACTION_TEXT.includes(text) &&
    usesUnprotectedGenericText(plan, text)
  ) {
    items.push({
      label: "泛化短词",
      value: -20,
      reason: "短动作词缺少上下文 selector",
    });
  }
}

function addDynamicCountdownScore(items: RiskItem[], plan: SelectorPlan): void {
  if (!usesExactDynamicCountdownText(plan)) return;

  items.push({
    label: "动态倒计时",
    value: -45,
    reason: "selector 精确匹配了跳过倒计时文本，跨秒数不稳定",
  });
}

function addAdSdkOverlayScore(
  items: RiskItem[],
  target: NormalizedSnapshotNode | null,
): void {
  if (!target || !isAdSdkOverlayTarget(target)) return;

  items.push({
    label: "广告遮罩热区",
    value: -90,
    reason: "最终点击目标像广告 SDK 遮罩/热区，可能打开广告详情",
  });
}

function addAdContextScore(
  items: RiskItem[],
  snapshot: ParsedGkdSnapshot,
  target: NormalizedSnapshotNode | null,
): void {
  if (!target) return;

  if (isLargeAdHotArea(snapshot, target)) {
    items.push({
      label: "广告热区",
      value: -90,
      reason: "最终点击目标像广告热区或整屏广告容器",
    });
    return;
  }

  if (hasAdAncestor(snapshot, target) && isSkipOrCloseNode(target)) {
    items.push({
      label: "广告容器上下文",
      value: 8,
      reason: "目标位于广告容器内，且具有跳过/关闭语义",
    });
  }
}

function addParentRiskScore(
  items: RiskItem[],
  snapshot: ParsedGkdSnapshot,
  plan: SelectorPlan,
  validation: SelectorValidation,
): void {
  if (plan.kind !== "parentChild" || plan.clickTarget !== "parent") return;

  const parent = validation.clickNodes[0];
  const child = validation.supportNodes[0];
  if (!parent || !child) return;

  const screenArea = snapshot.screenWidth * snapshot.screenHeight;
  const parentRatio = screenArea > 0 ? nodeArea(parent.attr) / screenArea : 1;
  const childArea = Math.max(1, nodeArea(child.attr));
  const areaRatio = nodeArea(parent.attr) / childArea;

  if (parentRatio > 0.35 || (areaRatio > 6 && parentRatio > 0.2)) {
    items.push({
      label: "父节点过大",
      value: -20,
      reason: "@ 抬升后的父节点点击区域偏大",
    });
  }
}

function addComplexityScore(items: RiskItem[], plan: SelectorPlan): void {
  if (plan.kind === "simple") return;

  const value = plan.kind === "matchesChain" ? 6 : -4;
  items.push({
    label: "结构复杂度",
    value,
    reason:
      plan.kind === "matchesChain"
        ? "上下文链降低泛化短词风险"
        : "使用了一跳结构关系，需要验证",
  });
}

function hasContext(plan: SelectorPlan): boolean {
  return (
    plan.kind === "matchesChain" ||
    plan.kind === "contextSibling" ||
    plan.kind === "sibling"
  );
}

function usesUnprotectedGenericText(plan: SelectorPlan, text: string): boolean {
  if (hasContext(plan)) return false;
  if (hasGuardedTextSelector(plan)) return false;

  switch (plan.kind) {
    case "simple":
      return selectorUsesGenericText(plan.selector, text);
    case "parentChild":
      return (
        selectorUsesGenericText(plan.child, text) ||
        selectorUsesGenericText(plan.parent, text)
      );
    case "sibling":
    case "contextSibling":
    case "matchesChain":
      return false;
    case "ancestorDescendant":
      return (
        selectorUsesGenericText(plan.descendant, text) ||
        selectorUsesGenericText(plan.ancestor, text)
      );
  }
}

function hasGuardedTextSelector(plan: SelectorPlan): boolean {
  const selectors = getPlanSelectors(plan);
  return selectors.some((selector) => {
    const hasText = selector.conditions.some((condition) => {
      return condition.attr === "text" || condition.attr === "desc";
    });
    if (!hasText) return false;

    const guardAttrs = new Set(selector.conditions.map((condition) => condition.attr));
    return (
      (guardAttrs.has("text.length") && guardAttrs.has("visibleToUser")) ||
      (hasStableResourceAnchor(selector) && guardAttrs.has("visibleToUser"))
    );
  });
}

function hasStableResourceAnchor(selector: SimpleSelector): boolean {
  return selector.conditions.some((condition) => {
    return (
      (condition.attr === "id" || condition.attr === "vid") &&
      condition.op === "eq"
    );
  });
}

function selectorUsesGenericText(
  selector: SimpleSelector,
  text: string,
): boolean {
  return selector.conditions.some((condition) => {
    if (condition.attr !== "text" && condition.attr !== "desc") return false;
    const value = String(condition.value);
    return value === text || text.includes(value) || value.includes(text);
  });
}

function usesExactDynamicCountdownText(plan: SelectorPlan): boolean {
  return getPlanSelectors(plan).some((selector) =>
    selector.conditions.some((condition) => {
      if (condition.op !== "eq") return false;
      if (condition.attr !== "text" && condition.attr !== "desc") return false;
      return isDynamicCountdownText(String(condition.value));
    }),
  );
}

function isDynamicCountdownText(text: string): boolean {
  const normalized = text.trim();
  return (
    /^跳过\s*\d+\s*s?$/i.test(normalized) ||
    /^\d+\s*s?\s*后?\s*跳过$/i.test(normalized) ||
    /^skip\s*\d+\s*s?$/i.test(normalized) ||
    /^\d+\s*s?\s*skip$/i.test(normalized)
  );
}

function hasAdAncestor(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): boolean {
  let pid = node.pid;
  while (pid >= 0) {
    const parent = snapshot.nodeById.get(pid);
    if (!parent) return false;
    if (isAdLikeNode(parent)) return true;
    pid = parent.pid;
  }
  return false;
}

function isLargeAdHotArea(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): boolean {
  const screenArea = snapshot.screenWidth * snapshot.screenHeight;
  const ratio = screenArea > 0 ? nodeArea(node.attr) / screenArea : 1;
  return ratio > 0.2 && isAdLikeNode(node);
}

function isAdSdkOverlayTarget(node: NormalizedSnapshotNode): boolean {
  const value = [node.attr.id, node.attr.vid, node.attr.desc, node.attr.text]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const hasSkipOrClose =
    value.includes("skip") ||
    value.includes("跳过") ||
    value.includes("close") ||
    value.includes("关闭");
  const hasOverlaySignal =
    value.includes("shade") ||
    value.includes("mask") ||
    value.includes("hotarea") ||
    value.includes("hot_area") ||
    value.includes("click_area") ||
    value.includes("clickarea") ||
    value.includes("ad_click") ||
    value.includes("splash_click");

  return hasOverlaySignal && (hasSkipOrClose || isAdLikeValue(value));
}

function isAdLikeValue(value: string): boolean {
  return (
    value.includes("advert") ||
    value.includes("splash") ||
    value.includes("nativead") ||
    value.includes("ad_") ||
    value.includes("_ad")
  );
}

function isAdLikeNode(node: NormalizedSnapshotNode): boolean {
  const value = `${node.attr.id ?? ""} ${node.attr.vid ?? ""} ${node.attr.name}`.toLowerCase();
  return (
    value.includes("advert") ||
    value.includes("splash") ||
    value.includes("nativead") ||
    value.includes("ptgadvertlayout") ||
    value.includes("hotarea") ||
    /\bad\b/.test(value)
  );
}

function isSkipOrCloseNode(node: NormalizedSnapshotNode): boolean {
  const value = [node.attr.text, node.attr.desc, node.attr.id, node.attr.vid]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    value.includes("跳过") ||
    value.includes("关闭") ||
    value.includes("skip") ||
    value.includes("close") ||
    value.includes("cancel")
  );
}

function getPlanSelectors(plan: SelectorPlan): SimpleSelector[] {
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
