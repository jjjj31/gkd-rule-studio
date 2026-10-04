/** 动作计划：为每条候选决定触发后的行为（action/max/cd/delay/matchRoot 等）。 */
import { nodeArea } from "../types/gkdSnapshot";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type {
  MvpStrategyName,
  RuleActionPlan,
  RuleDraft,
  RuleSettings,
  SelectorPlan,
  SelectorValidation,
} from "../types/ruleDraft";

export interface RuleRunObservation {
  selectorMatched: boolean;
  hasTriggerRecord?: boolean;
  actionExecuted?: boolean;
  uiStateChanged?: boolean;
  clickedWrongTarget?: boolean;
  intermittent?: boolean;
}

export type RuleRunDiagnosis =
  | "selector_failed"
  | "action_failed_or_too_early"
  | "unstable_timing_or_refresh"
  | "dangerous_or_wrong_target"
  | "success"
  | "unknown";

export function buildActionPlan(input: {
  snapshot: ParsedGkdSnapshot;
  pickedNode: NormalizedSnapshotNode;
  plan: SelectorPlan;
  validation: SelectorValidation;
  strategyName: MvpStrategyName;
  ruleSettings: RuleSettings;
}): RuleActionPlan {
  const {
    snapshot,
    pickedNode,
    plan,
    validation,
    strategyName,
    ruleSettings,
  } = input;
  const targetNode = validation.clickNodes[0] ?? pickedNode;
  const relatedNodes = uniqueNodes([
    pickedNode,
    targetNode,
    ...validation.clickNodes,
    ...validation.supportNodes,
    ...ancestorsOf(snapshot, pickedNode),
    ...ancestorsOf(snapshot, targetNode),
  ]);
  const pickedInAdLayer = hasAdContext(snapshot, pickedNode);
  const targetInAdLayer = hasAdContext(snapshot, targetNode);
  const pickedInWebView = hasWebViewContext(snapshot, pickedNode);
  const targetInWebView = hasWebViewContext(snapshot, targetNode);
  const planCrossesLayer = isCrossLayerPlan(plan);
  const hasCountdown = relatedNodes.some((node) =>
    isDynamicCountdownText(readActionText(node)),
  );
  const hasNativeDismissTarget = isSmallNativeDismissControl(snapshot, targetNode);
  const hasWebOrAdContext =
    targetInWebView ||
    pickedInWebView ||
    planCrossesLayer ||
    relatedNodes.some((node) => isWebViewNode(node)) ||
    (!hasNativeDismissTarget &&
      (targetInAdLayer ||
        pickedInAdLayer ||
        relatedNodes.some((node) => isLargeAdContainer(snapshot, node))));
  const hasDynamicFullscreenContext =
    hasWebOrAdContext ||
    isSplashActivity(snapshot.activityId) ||
    relatedNodes.some((node) => isLargeAdContainer(snapshot, node));
  const needsActivityGuard =
    !ruleSettings.activityIds.trim() &&
    Boolean(snapshot.activityId) &&
    isGenericDismissAction(targetNode, relatedNodes);
  const likelyCoveredStableNode =
    strategyName === "stableResourceSemantic" &&
    pickedInAdLayer &&
    targetNode.id !== pickedNode.id &&
    !isAncestorOf(snapshot, targetNode, pickedNode);
  const actionPlan: RuleActionPlan = {
    rankAdjustment: 0,
    riskNotes: [],
    debugAdvice: buildBaseDebugAdvice(),
  };

  if (hasWebOrAdContext || planCrossesLayer) {
    actionPlan.action = "clickCenter";
    actionPlan.matchRoot = true;
    actionPlan.rankAdjustment += 4;
    actionPlan.riskNotes.push(
      "目标处于 WebView/广告容器或跨层级 selector，默认用 clickCenter 并开启 matchRoot。",
    );
  }

  if (hasCountdown) {
    actionPlan.actionDelay = pickCountdownDelay(relatedNodes);
    actionPlan.actionMaximum = 3;
    actionPlan.actionCd = 1000;
    actionPlan.rankAdjustment += 6;
    actionPlan.riskNotes.push(
      "检测到跳过倒计时，延迟点击并允许重试，避免过早点一次后规则休眠。",
    );
  }

  if (needsActivityGuard) {
    actionPlan.activityIds = snapshot.activityId ? [snapshot.activityId] : [];
    actionPlan.rankAdjustment += 10;
    actionPlan.riskNotes.push(
      "跳过/关闭类泛化动作默认补充当前 Activity，降低误触并减少无效扫描。",
    );
  }

  if (hasDynamicFullscreenContext) {
    const configuredActivityIds = ruleSettings.activityIds.trim();
    const snapshotActivityId = (snapshot.activityId ?? "").trim();
    actionPlan.activityIds =
      configuredActivityIds ||
      actionPlan.activityIds ||
      // activityId 为 null/空串时不能退化成 [""]——那种 activityIds 永不匹配任何界面。
      (snapshotActivityId ? [snapshotActivityId] : undefined);
    actionPlan.forcedTime = 10000;
    actionPlan.matchTime = 10000;
    actionPlan.riskNotes.push(
      "动态全屏广告可能不稳定触发无障碍事件，建议 forcedTime=10000。",
    );
  } else if (ruleSettings.matchTime !== null) {
    actionPlan.matchTime = ruleSettings.matchTime;
  }

  if (isSplashActivity(snapshot.activityId) || isAppEntryAd(ruleSettings)) {
    actionPlan.resetMatch = "app";
  } else if (ruleSettings.resetMatch) {
    actionPlan.resetMatch = ruleSettings.resetMatch;
  }

  if (!hasCountdown) {
    if (ruleSettings.actionMaximum !== null) {
      actionPlan.actionMaximum = ruleSettings.actionMaximum;
    }
    if (ruleSettings.actionCd !== null) {
      actionPlan.actionCd = ruleSettings.actionCd;
    }
  }

  applyExplicitActionSettings(actionPlan, ruleSettings);

  if (strategyName === "adContainerSkipFallback" && pickedInAdLayer) {
    actionPlan.rankAdjustment += 25;
    actionPlan.riskNotes.push(
      "用户实际点击位于 WebView 广告层，优先把该层的跳过按钮作为动作目标。",
    );
  }

  if (likelyCoveredStableNode) {
    actionPlan.rankAdjustment -= 35;
    actionPlan.riskNotes.push(
      "稳定原生 ID 可能被上层 WebView/广告层遮挡，不能因为资源 ID 稳定就阻断兜底规则。",
    );
  }

  if (isDangerousActionNode(targetNode)) {
    actionPlan.rankAdjustment -= 60;
    actionPlan.riskNotes.push(
      "点击目标疑似下载、打开、详情或广告热区，禁止作为首选动作目标。",
    );
  }

  return actionPlan;
}

function applyExplicitActionSettings(
  actionPlan: RuleActionPlan,
  ruleSettings: RuleSettings,
): void {
  if (ruleSettings.action) {
    actionPlan.action = ruleSettings.action;
  }
  if (ruleSettings.actionDelay !== null && ruleSettings.actionDelay !== undefined) {
    actionPlan.actionDelay = ruleSettings.actionDelay;
  }
  if (ruleSettings.forcedTime !== null && ruleSettings.forcedTime !== undefined) {
    actionPlan.forcedTime = ruleSettings.forcedTime;
  }
  if (ruleSettings.matchRoot !== null && ruleSettings.matchRoot !== undefined) {
    actionPlan.matchRoot = ruleSettings.matchRoot;
  }
}

export function applyActionPlanToRule(
  rule: RuleDraft,
  actionPlan: RuleActionPlan,
): RuleDraft {
  return removeUndefined({
    ...rule,
    activityIds: actionPlan.activityIds ?? rule.activityIds,
    action: actionPlan.action,
    actionDelay: actionPlan.actionDelay,
    matchTime: actionPlan.matchTime,
    actionMaximum: actionPlan.actionMaximum,
    actionCd: actionPlan.actionCd,
    forcedTime: actionPlan.forcedTime,
    matchRoot: actionPlan.matchRoot,
    resetMatch: actionPlan.resetMatch,
  });
}

export function diagnoseRuleRun(
  observation: RuleRunObservation,
): { diagnosis: RuleRunDiagnosis; debugAdvice: string[] } {
  if (observation.clickedWrongTarget) {
    return {
      diagnosis: "dangerous_or_wrong_target",
      debugAdvice: [
        "点错广告或打开详情时，先检查危险 CTA 黑名单、广告热区和 selector 命中节点。",
        ...buildBaseDebugAdvice(),
      ],
    };
  }

  if (observation.uiStateChanged === true) {
    return {
      diagnosis: "success",
      debugAdvice: ["selector 匹配、动作执行后 UI 已变化，规则可进入收紧参数阶段。"],
    };
  }

  if (observation.intermittent) {
    return {
      diagnosis: "unstable_timing_or_refresh",
      debugAdvice: [
        "偶尔关闭偶尔失败时，优先检查 forcedTime、actionDelay、WebView 动态刷新和倒计时变化。",
        ...buildBaseDebugAdvice(),
      ],
    };
  }

  if (!observation.selectorMatched && !observation.hasTriggerRecord) {
    return {
      diagnosis: "selector_failed",
      debugAdvice: [
        "没有触发记录时，优先检查 selector、activityIds、matchRoot 和 matchTime 窗口。",
        ...buildBaseDebugAdvice(),
      ],
    };
  }

  if (
    observation.hasTriggerRecord ||
    observation.selectorMatched ||
    observation.actionExecuted
  ) {
    if (observation.uiStateChanged === false) {
      return {
        diagnosis: "action_failed_or_too_early",
        debugAdvice: [
          "有触发记录但广告没关，说明 selector 已经匹配，优先调整 actionDelay、clickCenter、actionMaximum 和 actionCd。",
          ...buildBaseDebugAdvice(),
        ],
      };
    }
  }

  return {
    diagnosis: "unknown",
    debugAdvice: buildBaseDebugAdvice(),
  };
}

function buildBaseDebugAdvice(): string[] {
  return [
    "没触发：检查 selector 是否命中、activityIds 是否过窄、是否需要 matchRoot。",
    "有触发但没关：检查 actionDelay、clickCenter、actionMaximum、actionCd。",
    "偶尔关偶尔不关：检查 forcedTime、倒计时变化和 WebView 动态刷新。",
    "点错广告：检查危险 CTA 黑名单、广告热区和大面积可点击容器。",
  ];
}

function pickCountdownDelay(nodes: NormalizedSnapshotNode[]): number {
  const countdownText = nodes.map(readActionText).find(isDynamicCountdownText);
  const number = countdownText?.match(/\d+/)?.[0];
  if (!number) return 2500;

  return Math.max(2500, Math.min(Number(number) * 800, 3500));
}

function readActionText(node: NormalizedSnapshotNode): string {
  return node.attr.text ?? node.attr.desc ?? "";
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

function isGenericDismissAction(
  targetNode: NormalizedSnapshotNode,
  relatedNodes: NormalizedSnapshotNode[],
): boolean {
  return [targetNode, ...relatedNodes].some((node) => {
    const value = [
      node.attr.text,
      node.attr.desc,
      node.attr.id,
      node.attr.vid,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return (
      value.includes("跳过") ||
      value.includes("关闭") ||
      value.includes("取消") ||
      value.includes("暂不") ||
      /(^|[_\-.])(skip|close|cancel)([_\-.]|$)/.test(value)
    );
  });
}

function isCrossLayerPlan(plan: SelectorPlan): boolean {
  return plan.kind === "ancestorDescendant" || plan.kind === "matchesChain";
}

function hasWebViewContext(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): boolean {
  return [node, ...ancestorsOf(snapshot, node)].some(isWebViewNode);
}

function hasAdContext(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): boolean {
  return [node, ...ancestorsOf(snapshot, node)].some(isAdLikeNode);
}

function ancestorsOf(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): NormalizedSnapshotNode[] {
  const ancestors: NormalizedSnapshotNode[] = [];
  let pid = node.pid;
  while (pid >= 0) {
    const parent = snapshot.nodeById.get(pid);
    if (!parent) break;
    ancestors.push(parent);
    pid = parent.pid;
  }
  return ancestors;
}

function isAncestorOf(
  snapshot: ParsedGkdSnapshot,
  ancestor: NormalizedSnapshotNode,
  node: NormalizedSnapshotNode,
): boolean {
  let pid = node.pid;
  while (pid >= 0) {
    if (pid === ancestor.id) return true;
    pid = snapshot.nodeById.get(pid)?.pid ?? -1;
  }
  return false;
}

function isWebViewNode(node: NormalizedSnapshotNode): boolean {
  return node.attr.name.toLowerCase().includes("webview");
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

function isLargeAdContainer(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): boolean {
  const screenArea = snapshot.screenWidth * snapshot.screenHeight;
  if (screenArea <= 0) return false;
  return nodeArea(node.attr) / screenArea > 0.35 && isAdLikeNode(node);
}

function isSmallNativeDismissControl(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): boolean {
  const screenArea = snapshot.screenWidth * snapshot.screenHeight;
  const ratio = screenArea > 0 ? nodeArea(node.attr) / screenArea : 1;
  if (ratio > 0.08) return false;

  const value = [node.attr.id, node.attr.vid, node.attr.text, node.attr.desc]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (isDangerousActionNode(node)) return false;
  if (
    value.includes("shade") ||
    value.includes("mask") ||
    value.includes("hotarea") ||
    value.includes("hot_area") ||
    value.includes("click_area") ||
    value.includes("clickarea") ||
    value.includes("ad_click") ||
    value.includes("splash_click")
  ) {
    return false;
  }

  return (
    value.includes("跳过") ||
    value.includes("关闭") ||
    value.includes("skip_ll") ||
    value.includes("skip_btn") ||
    value.includes("sound_and_skip") ||
    value.includes("sound_skip") ||
    value.includes("btn_skip") ||
    value.includes("tv_ad_skip") ||
    value.includes("ad_skip") ||
    value.includes("close") ||
    value.includes("cancel")
  );
}

function isSplashActivity(activityId: string | null | undefined): boolean {
  return (activityId ?? "").toLowerCase().includes("splash");
}

function isAppEntryAd(settings: RuleSettings): boolean {
  return settings.groupName.includes("开屏") || settings.groupName.includes("全屏广告");
}

function isDangerousActionNode(node: NormalizedSnapshotNode): boolean {
  const value = [node.attr.text, node.attr.desc, node.attr.id, node.attr.vid]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return [
    "下载",
    "安装",
    "打开",
    "立即打开",
    "查看详情",
    "了解更多",
    "跳转",
    "第三方应用",
    "软件商店",
    "福利",
    "领取",
    "购买",
    "会员",
    "开通",
    "广告热区",
    "hotarea",
    "splashhotarea",
    "shade",
    "mask",
    "click_area",
    "clickarea",
  ].some((word) => value.includes(word.toLowerCase()));
}

function uniqueNodes(nodes: NormalizedSnapshotNode[]): NormalizedSnapshotNode[] {
  const seen = new Set<number>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
