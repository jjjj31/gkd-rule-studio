/**
 * 14 种 selector 策略的具体实现。
 * 每个策略接收 GenerationContext 产出一个或多个 SelectorCandidate 种子。
 * 核心策略包括：稳定资源、id/vid/text/desc 精准定位、上下文保护、广告容器兜底等。
 * @see regionCandidates.ts 调用本模块的入口
 * @see candidateGuidance.ts 为每个候选生成可读标签
 */
import {
  CONTEXT_HINT_WORDS,
  GENERIC_ACTION_TEXT,
  NEGATIVE_ACTION_TEXT,
  NEGATIVE_ACTION_VARIANT_GROUPS,
  POSITIVE_CTA_TEXT,
} from "../data/riskWords";
import type { NormalizedSnapshotNode } from "../types/gkdSnapshot";
import type {
  GenerationContext,
  MvpStrategyName,
  SelectorCandidate,
  SelectorPlan,
  SimpleSelector,
} from "../types/ruleDraft";
import { applyActionPlanToRule, buildActionPlan } from "./actionPlan";
import { candidateDedupeKey } from "./candidateIdentity";
import { scoreCandidate } from "./riskScoring";
import {
  clickableSelector,
  createRuleDraft,
  exactSelector,
  serializePlan,
} from "./selectorSerialize";
import { validateSelectorPlan } from "./selectorMatcher";

interface CandidateSeed {
  strategyName: MvpStrategyName;
  title: string;
  baseScore: number;
  plan: SelectorPlan;
  groupName: string;
  debugReasons: string[];
}

export function generateSelectorCandidates(
  context: GenerationContext,
): SelectorCandidate[] {
  const seeds = [
    ...stableResourceSemantic(context),
    ...exactVid(context),
    ...exactId(context),
    ...exactDesc(context),
    ...typePlusExactAttr(context),
    ...exactTextWithContext(context),
    ...textSkipGuarded(context),
    ...clickParentDirectChildText(context),
    ...clickParentByChildIdVid(context),
    ...simpleSiblingCancelVsCTA(context),
    ...simpleContextRelation(context),
    ...adContainerSkipFallback(context),
    ...clickableAncestorFallback(context),
    ...visibleNodeFallback(context),
    ...negativeActionVariantUnion(context),
  ];

  const candidates = seeds.map((seed, index) => buildCandidate(context, seed, index));
  return dedupeCandidates(candidates).sort((a, b) => {
    const bEffectiveScore = effectiveCandidateScore(b);
    const aEffectiveScore = effectiveCandidateScore(a);
    if (bEffectiveScore !== aEffectiveScore) {
      return bEffectiveScore - aEffectiveScore;
    }
    if (b.risk.finalScore !== a.risk.finalScore) {
      return b.risk.finalScore - a.risk.finalScore;
    }
    return b.baseScore - a.baseScore;
  });
}

function exactVid(context: GenerationContext): CandidateSeed[] {
  const vid = context.pickedNode.attr.vid;
  if (!vid) return [];
  return [
    singleSeed("exactVid", "精确 vid", 95, exactSelector("vid", vid), [
      `点击节点 vid=${vid}`,
    ]),
  ];
}

function exactId(context: GenerationContext): CandidateSeed[] {
  const id = context.pickedNode.attr.id;
  if (!id) return [];
  return [
    singleSeed("exactId", "精确 id", 93, exactSelector("id", id), [
      `点击节点 id=${id}`,
    ]),
  ];
}

function exactDesc(context: GenerationContext): CandidateSeed[] {
  const desc = context.pickedNode.attr.desc;
  if (!desc) return [];
  return [
    singleSeed("exactDesc", "精确 desc", 82, exactSelector("desc", desc), [
      `点击节点 desc=${desc}`,
    ]),
  ];
}

function typePlusExactAttr(context: GenerationContext): CandidateSeed[] {
  const node = context.pickedNode;
  const typeName = shortTypeName(node);
  const attr = preferredTextualAttr(node);
  if (!typeName || !attr) return [];
  if (attr.key === "text" && isDynamicCountdownText(attr.value)) return [];

  return [
    singleSeed(
      "typePlusExactAttr",
      "类型 + 精确属性",
      84,
      exactSelector(attr.key, attr.value, typeName),
      [`使用 ${typeName} 限制裸 ${attr.key}`],
    ),
  ];
}

function exactTextWithContext(context: GenerationContext): CandidateSeed[] {
  const targetText = context.pickedNode.attr.text;
  if (!targetText || !isGenericText(targetText)) return [];
  if (isDynamicCountdownText(targetText)) return [];

  const contextNode = findContextTextNode(context);
  if (!contextNode) return [];

  const contextSelector = selectorForTextNode(contextNode);
  const targetSelector = exactSelector("text", targetText, shortTypeName(context.pickedNode));

  return [
    {
      strategyName: "exactTextWithContext",
      title: "上下文 + 精确文本",
      baseScore: 80,
      plan: {
        kind: "matchesChain",
        context: contextSelector,
        target: targetSelector,
      },
      groupName: groupNameForContext(contextNode, "功能类-自动生成"),
      debugReasons: [`${targetText} 是泛化短词，补充上下文 ${nodeText(contextNode)}`],
    },
  ];
}

function textSkipGuarded(context: GenerationContext): CandidateSeed[] {
  const text = context.pickedNode.attr.text ?? context.pickedNode.attr.desc;
  if (!text || !isSkipLikeText(text)) return [];

  return [
    singleSeed("textSkipGuarded", "归一化跳过文本", 78, skipTextSelector(), [
      "包含跳过语义，并归一化倒计时文本",
    ]),
  ];
}

function stableResourceSemantic(context: GenerationContext): CandidateSeed[] {
  const seeds: CandidateSeed[] = [];
  context.snapshot.nodes
    .filter((node) => node.attr.visibleToUser)
    .filter((node) => hasStableActionResource(node))
    .filter((node) => !isDangerousActionNode(node))
    .forEach((node) => {
      if (isGenericSkipContainer(node) && hasPreferredSkipControlDescendant(context, node)) {
        return;
      }
      const selector = stableResourceSelector(node);
      if (!selector) return;
      const actionResourceScore = stableActionResourceScore(node);
      seeds.push({
        strategyName: "stableResourceSemantic",
        title: "稳定资源 ID + 动作语义",
        baseScore: actionResourceScore,
        plan: {
          kind: "simple",
          selector,
        },
        groupName: resourceText(node).includes("跳过") ? "开屏广告" : "功能类-自动生成",
        debugReasons: [
          `发现稳定动作资源 ${node.attr.id ?? node.attr.vid}`,
          `动作语义 ${resourceText(node) || "来自资源名"}`,
        ],
      });
    });
  return seeds;
}

function adContainerSkipFallback(context: GenerationContext): CandidateSeed[] {
  const seeds: CandidateSeed[] = [];
  const skipNodes = context.snapshot.nodes.filter((node) => {
    const text = node.attr.text ?? node.attr.desc ?? "";
    return node.attr.visibleToUser && isSkipLikeText(text) && !isDangerousActionNode(node);
  });

  for (const container of context.snapshot.nodes.filter(isAdContainerNode)) {
    const ancestor = stableContainerSelector(container);
    if (!ancestor) continue;

    const descendant = skipNodes.find((node) => isDescendantOf(context, node, container));
    if (!descendant) continue;

    seeds.push({
      strategyName: "adContainerSkipFallback",
      title: "点击 WebView 广告右上角跳过",
      baseScore: 88,
      plan: {
        kind: "ancestorDescendant",
        ancestor,
        descendant: skipTextSelector(shortTypeName(descendant)),
      },
      groupName: "开屏广告",
      debugReasons: [
        `跳过节点位于广告容器 ${container.attr.id ?? container.attr.vid ?? container.attr.name} 内`,
      ],
    });
  }

  return seeds;
}

function clickParentDirectChildText(context: GenerationContext): CandidateSeed[] {
  const text = context.pickedNode.attr.text;
  const parent = context.clickableAncestor;
  if (!text || !parent || context.pickedNode.attr.clickable) return [];
  const child = isDynamicCountdownText(text)
    ? skipTextSelector(shortTypeName(context.pickedNode))
    : exactSelector("text", text, shortTypeName(context.pickedNode));

  return [
    {
      strategyName: "clickParentDirectChildText",
      title: "点击父节点 + 子文本",
      baseScore: 76,
      plan: {
        kind: "parentChild",
        parent: clickableSelector(),
        child,
        clickTarget: "parent",
      },
      groupName: "功能类-自动生成",
      debugReasons: ["子文本不可点击，最近 clickable 祖先可作为点击目标"],
    },
  ];
}

function clickParentByChildIdVid(context: GenerationContext): CandidateSeed[] {
  const parent = context.clickableAncestor;
  if (!parent || context.pickedNode.attr.clickable) return [];

  const childSelector = childStableSelector(context.pickedNode);
  if (!childSelector) return [];

  return [
    {
      strategyName: "clickParentByChildIdVid",
      title: "点击父节点 + 子稳定属性",
      baseScore: 79,
      plan: {
        kind: "parentChild",
        parent: clickableSelector(),
        child: childSelector,
        clickTarget: "parent",
      },
      groupName: "功能类-自动生成",
      debugReasons: ["子节点有稳定属性，但点击热区在父节点"],
    },
  ];
}

function clickableAncestorFallback(context: GenerationContext): CandidateSeed[] {
  const parent = context.clickableAncestor;
  if (!parent || context.pickedNode.attr.clickable) return [];
  if (preferredTextualAttr(context.pickedNode) || childStableSelector(context.pickedNode)) {
    return [];
  }

  return [
    {
      strategyName: "clickableAncestorFallback",
      title: "可点击父区域兜底",
      baseScore: 46,
      plan: {
        kind: "simple",
        selector: fallbackNodeSelector(parent, { requireClickable: true }),
      },
      groupName: "功能类-自动生成",
      debugReasons: [
        "点击节点缺少 id/vid/text/desc，使用最近可点击父区域作为低分兜底。",
      ],
    },
  ];
}

function visibleNodeFallback(context: GenerationContext): CandidateSeed[] {
  const node = context.pickedNode;
  if (preferredTextualAttr(node) || childStableSelector(node)) return [];
  if (!node.attr.clickable && context.clickableAncestor) return [];

  return [
    {
      strategyName: "visibleNodeFallback",
      title: "可见节点兜底",
      baseScore: node.attr.clickable ? 42 : 32,
      plan: {
        kind: "simple",
        selector: fallbackNodeSelector(node, { requireClickable: node.attr.clickable }),
      },
      groupName: "功能类-自动生成",
      debugReasons: [
        "目标节点缺少稳定属性，生成低分兜底 selector，主要用于避免候选为空和辅助人工判断。",
      ],
    },
  ];
}

function negativeActionVariantUnion(context: GenerationContext): CandidateSeed[] {
  const node = context.pickedNode;
  const text = node.attr.text;
  if (!text) return [];

  // 在同义否定词变体组里找 pickedNode.text 属于哪个组。
  const variantGroup = NEGATIVE_ACTION_VARIANT_GROUPS.find((group) =>
    group.some((word) => word === text),
  );
  if (!variantGroup || variantGroup.length <= 1) return [];

  // 组内只有 1 个词等于 text 时才需要合并，否则 text 本身就是唯一的词。
  const allVariants = variantGroup;
  const typeName = shortTypeName(node);

  return [
    {
      strategyName: "negativeActionVariantUnion",
      title: "否定动作变体合并",
      baseScore: 65,
      plan: {
        kind: "simple",
        selector: {
          typeName,
          conditions: [
            { attr: "text", op: "orEq", value: allVariants },
            { attr: "visibleToUser", op: "eq", value: true },
          ],
        },
      },
      groupName: groupNameForContextByText(text, "功能类-自动生成"),
      debugReasons: [
        `"${text}" 属于同义否定词组 (${allVariants.join(" / ")})，合并为 orEq 变体`,
      ],
    },
  ];
}

function groupNameForContextByText(text: string, fallback: string): string {
  if (text.includes("权限")) return "权限提示";
  if (text.includes("通知")) return "通知提示";
  if (text.includes("更新") || text.includes("升级")) return "更新提示";
  if (text.includes("评价") || text.includes("评分") || text.includes("好评")) {
    return "评价提示";
  }
  if (text.includes("青少年")) return "青少年模式";
  return fallback;
}

function simpleSiblingCancelVsCTA(context: GenerationContext): CandidateSeed[] {
  const text = context.pickedNode.attr.text;
  if (!text || !NEGATIVE_ACTION_TEXT.includes(text)) return [];

  const ctaSibling = context.siblings.find((node) => {
    const value = nodeText(node);
    return value && POSITIVE_CTA_TEXT.some((word) => value.includes(word));
  });

  if (!ctaSibling) return [];

  const relation = ctaSibling.attr.index > context.pickedNode.attr.index ? "next" : "previous";
  const distance = Math.abs(ctaSibling.attr.index - context.pickedNode.attr.index);

  if (distance < 1 || distance > 5) return [];

  return [
    {
      strategyName: "simpleSiblingCancelVsCTA",
      title: "取消按钮 + 同层 CTA",
      baseScore: 74,
      plan: {
        kind: "sibling",
        target: exactSelector("text", text, shortTypeName(context.pickedNode)),
        neighbor: selectorForTextNode(ctaSibling),
        relation,
        distance,
      },
      groupName: groupNameForContext(ctaSibling, "功能类-自动生成"),
      debugReasons: [`${text} 与 ${nodeText(ctaSibling)} 是同层相邻动作`],
    },
  ];
}

function simpleContextRelation(context: GenerationContext): CandidateSeed[] {
  const targetText = context.pickedNode.attr.text ?? context.pickedNode.attr.desc;
  if (!targetText || context.pickedNode.pid < 0) return [];

  const contextSibling = context.siblings.find((node) => {
    const value = nodeText(node);
    return value && CONTEXT_HINT_WORDS.some((word) => value.includes(word));
  });

  if (!contextSibling) return [];

  const relation =
    context.pickedNode.attr.index > contextSibling.attr.index ? "next" : "previous";
  const distance = Math.abs(context.pickedNode.attr.index - contextSibling.attr.index);

  if (distance < 1 || distance > 5) return [];

  const contextSel = selectorForTextNode(contextSibling);
  const targetSel = selectorForTextNode(context.pickedNode);
  const groupName = groupNameForContext(contextSibling, "功能类-自动生成");
  const baseReason = `目标与上下文 ${nodeText(contextSibling)} 在同一父节点下`;

  const seeds: CandidateSeed[] = [
    {
      strategyName: "simpleContextRelation",
      title: "一跳上下文关系",
      baseScore: 72,
      plan: {
        kind: "contextSibling",
        context: contextSel,
        target: targetSel,
        relation,
        distance,
      },
      groupName,
      debugReasons: [baseReason],
    },
  ];

  // 教程 §5.3.2.3.2：当上下文与目标之间间隔 ≥2 个节点时，
  // 同 App 不同快照里这个距离可能漂移（如 keep 广告 +1 / +2 两个变体）。
  // 额外产出一条 +(n) 多项式候选作为兼容变体，baseScore 降 4 分体现不确定性。
  // n 从 1 起递增，但父节点子节点有限，不会死循环。
  if (distance >= 2) {
    seeds.push({
      strategyName: "simpleContextRelation",
      title: "上下文 + 多项式距离",
      baseScore: 68,
      plan: {
        kind: "contextSibling",
        context: contextSel,
        target: targetSel,
        relation,
        distance: "n",
      },
      groupName,
      debugReasons: [
        `${baseReason}，且距离为 ${distance}，额外用 +(n) 兼容间距漂移`,
      ],
    });
  }

  return seeds;
}

function singleSeed(
  strategyName: MvpStrategyName,
  title: string,
  baseScore: number,
  selector: SimpleSelector,
  debugReasons: string[],
): CandidateSeed {
  return {
    strategyName,
    title,
    baseScore,
    plan: {
      kind: "simple",
      selector,
    },
    groupName: strategyName === "textSkipGuarded" ? "开屏广告" : "功能类-自动生成",
    debugReasons,
  };
}

function buildCandidate(
  context: GenerationContext,
  seed: CandidateSeed,
  index: number,
): SelectorCandidate {
  const validation = validateSelectorPlan(context.snapshot, seed.plan);
  const baseRule = createRuleDraft(
    seed.plan,
    context.ruleSettings,
    seed.title,
  );
  const actionPlan = buildActionPlan({
    snapshot: context.snapshot,
    pickedNode: context.pickedNode,
    plan: seed.plan,
    validation,
    strategyName: seed.strategyName,
    ruleSettings: context.ruleSettings,
  });
  const rule = applyActionPlanToRule(baseRule, actionPlan);
  const risk = scoreCandidate({
    baseScore: seed.baseScore,
    snapshot: context.snapshot,
    plan: seed.plan,
    rule,
    validation,
    allowNoActivityIds: hasShortOneShotWindow(context.ruleSettings),
  });

  return {
    id: `${seed.strategyName}-${index}`,
    strategyName: seed.strategyName,
    title: seed.title,
    plan: seed.plan,
    rule,
    actionPlan,
    groupName: context.ruleSettings.groupName.trim() || seed.groupName,
    baseScore: seed.baseScore,
    validation,
    risk,
    riskNotes: actionPlan.riskNotes,
    debugAdvice: actionPlan.debugAdvice,
    debugReasons: [
      ...seed.debugReasons,
      `matches: ${serializePlan(seed.plan).join(" && ")}`,
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

function effectiveCandidateScore(candidate: SelectorCandidate): number {
  return Math.max(
    0,
    Math.min(140, candidate.risk.finalScore + candidate.actionPlan.rankAdjustment),
  );
}

function preferredTextualAttr(
  node: NormalizedSnapshotNode,
): { key: "text" | "desc"; value: string } | null {
  if (node.attr.text) return { key: "text", value: node.attr.text };
  if (node.attr.desc) return { key: "desc", value: node.attr.desc };
  return null;
}

function childStableSelector(node: NormalizedSnapshotNode): SimpleSelector | null {
  if (node.attr.vid) return exactSelector("vid", node.attr.vid, shortTypeName(node));
  if (node.attr.id) return exactSelector("id", node.attr.id, shortTypeName(node));
  if (node.attr.desc) return exactSelector("desc", node.attr.desc, shortTypeName(node));
  return null;
}

function stableResourceSelector(node: NormalizedSnapshotNode): SimpleSelector | null {
  const resourceAttr = node.attr.vid ? "vid" : node.attr.id ? "id" : null;
  const resourceValue = node.attr.vid ?? node.attr.id;
  if (!resourceAttr || !resourceValue) return null;

  const conditions: SimpleSelector["conditions"] = [
    { attr: resourceAttr, op: "eq", value: resourceValue },
  ];
  const text = resourceText(node);
  const prefix = text ? semanticTextPrefix(text) : null;
  const textAttr = node.attr.text ? "text" : node.attr.desc ? "desc" : null;

  if (prefix && textAttr) {
    conditions.push({ attr: textAttr, op: "startsWith", value: prefix });
  }

  conditions.push({ attr: "visibleToUser", op: "eq", value: true });

  return {
    conditions,
  };
}

function stableContainerSelector(node: NormalizedSnapshotNode): SimpleSelector | null {
  const typeName = containerTypeName(node);
  if (node.attr.id) return exactSelector("id", node.attr.id, typeName);
  if (node.attr.vid) return exactSelector("vid", node.attr.vid, typeName);
  return null;
}

function fallbackNodeSelector(
  node: NormalizedSnapshotNode,
  options: { requireClickable: boolean },
): SimpleSelector {
  const conditions: SimpleSelector["conditions"] = [];

  if (options.requireClickable) {
    conditions.push({ attr: "clickable", op: "eq", value: true });
  }

  conditions.push({ attr: "visibleToUser", op: "eq", value: true });

  if (node.attr.width > 0) {
    conditions.push({ attr: "width", op: "lte", value: node.attr.width });
  }
  if (node.attr.height > 0) {
    conditions.push({ attr: "height", op: "lte", value: node.attr.height });
  }

  return {
    typeName: fallbackTypeName(node),
    conditions,
  };
}

function containerTypeName(node: NormalizedSnapshotNode): string | undefined {
  const short = node.attr.name.split(".").at(-1);
  if (!short || short === "View") return undefined;
  return short;
}

function fallbackTypeName(node: NormalizedSnapshotNode): string | undefined {
  const short = node.attr.name.split(".").at(-1);
  if (!short || short === "View") return undefined;
  return short;
}

function skipTextSelector(typeName?: string): SimpleSelector {
  return {
    typeName,
    conditions: [
      { attr: "text", op: "startsWith", value: "跳过" },
      { attr: "text.length", op: "lt", value: 10 },
      // 尺寸保护：教程 §5.3.2 + 研究报告建议，排除超大 CTA、列表项、搜索框。
      // 跳过按钮通常是小尺寸角落控件，宽 >500 或高 >300 的基本不是真跳过。
      { attr: "width", op: "lte", value: 500 },
      { attr: "height", op: "lte", value: 300 },
      { attr: "visibleToUser", op: "eq", value: true },
    ],
  };
}

function selectorForTextNode(node: NormalizedSnapshotNode): SimpleSelector {
  if (node.attr.text && isDynamicCountdownText(node.attr.text)) {
    return skipTextSelector(shortTypeName(node));
  }

  if (node.attr.text) {
    return exactSelector("text", node.attr.text, shortTypeName(node));
  }

  if (node.attr.desc) {
    return exactSelector("desc", node.attr.desc, shortTypeName(node));
  }

  if (node.attr.vid) {
    return exactSelector("vid", node.attr.vid, shortTypeName(node));
  }

  return exactSelector("id", node.attr.id ?? String(node.id), shortTypeName(node));
}

function findContextTextNode(
  context: GenerationContext,
): NormalizedSnapshotNode | null {
  const all = [...context.siblings, ...context.nearbyTextNodes, ...context.ancestors];
  return (
    all.find((node) => {
      const text = nodeText(node);
      if (!text || text === nodeText(context.pickedNode)) return false;
      return CONTEXT_HINT_WORDS.some((word) => text.includes(word));
    }) ??
    all.find((node) => {
      const text = nodeText(node);
      return Boolean(text && text.length >= 3 && !isGenericText(text));
    }) ??
    null
  );
}

function groupNameForContext(
  node: NormalizedSnapshotNode,
  fallback: string,
): string {
  const text = nodeText(node) ?? "";
  if (text.includes("权限")) return "权限提示";
  if (text.includes("通知")) return "通知提示";
  if (text.includes("更新") || text.includes("升级")) return "更新提示";
  if (text.includes("评价") || text.includes("评分") || text.includes("好评")) {
    return "评价提示";
  }
  if (text.includes("广告")) return "局部广告";
  if (text.includes("青少年")) return "青少年模式";
  return fallback;
}

function shortTypeName(node: NormalizedSnapshotNode): string | undefined {
  const short = node.attr.name.split(".").at(-1);
  if (!short || short === "View" || short === "FrameLayout" || short === "LinearLayout") {
    return undefined;
  }
  return short;
}

function nodeText(node: NormalizedSnapshotNode): string | null {
  return node.attr.text ?? node.attr.desc ?? null;
}

function resourceText(node: NormalizedSnapshotNode): string {
  return node.attr.text ?? node.attr.desc ?? "";
}

function isGenericText(text: string): boolean {
  return GENERIC_ACTION_TEXT.includes(text) || isDynamicCountdownText(text) || text.length <= 2;
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

function isSkipLikeText(text: string): boolean {
  const normalized = text.trim();
  return normalized === "跳过" || isDynamicCountdownText(normalized) || /^skip\b/i.test(normalized);
}

function semanticTextPrefix(text: string): string | null {
  if (isSkipLikeText(text)) return "跳过";
  if (text.startsWith("关闭")) return "关闭";
  if (text.startsWith("取消")) return "取消";
  if (/^close\b/i.test(text)) return "Close";
  if (/^skip\b/i.test(text)) return "Skip";
  return null;
}

function hasStableActionResource(node: NormalizedSnapshotNode): boolean {
  const resource = `${node.attr.id ?? ""} ${node.attr.vid ?? ""}`.toLowerCase();
  if (isAdSdkOverlayResource(resource)) return false;

  return /(^|[_\-.])(skip|close|cancel)([_\-.]|$)/.test(resource) ||
    resource.includes("skipad") ||
    resource.includes("tv_ad_skip") ||
    resource.includes("ad_skip") ||
    resource.includes("btn_skip") ||
    resource.includes("btn_close") ||
    resource.includes("_close") ||
    resource.includes("_cancel");
}

function stableActionResourceScore(node: NormalizedSnapshotNode): number {
  const resource = `${node.attr.id ?? ""} ${node.attr.vid ?? ""}`.toLowerCase();

  if (
    resource.includes("skip_ll") ||
    resource.includes("skip_btn") ||
    resource.includes("btn_skip") ||
    resource.includes("tv_ad_skip") ||
    resource.includes("ad_skip")
  ) {
    return 99;
  }

  if (
    resource.includes("sound_and_skip") ||
    resource.includes("sound_skip") ||
    resource.includes("skip_layout")
  ) {
    return 90;
  }

  return 98;
}

function isGenericSkipContainer(node: NormalizedSnapshotNode): boolean {
  const resource = `${node.attr.id ?? ""} ${node.attr.vid ?? ""}`.toLowerCase();
  return (
    resource.includes("sound_and_skip") ||
    resource.includes("sound_skip") ||
    resource.includes("skip_layout")
  );
}

function hasPreferredSkipControlDescendant(
  context: GenerationContext,
  node: NormalizedSnapshotNode,
): boolean {
  return context.snapshot.nodes.some((candidate) => {
    if (candidate.id === node.id || !candidate.attr.visibleToUser) return false;
    if (!isDescendantOf(context, candidate, node)) return false;
    return stableActionResourceScore(candidate) > stableActionResourceScore(node);
  });
}

function isAdContainerNode(node: NormalizedSnapshotNode): boolean {
  const value = `${node.attr.id ?? ""} ${node.attr.vid ?? ""} ${node.attr.name}`.toLowerCase();
  return (
    value.includes("advert") ||
    value.includes("splash") ||
    value.includes("nativead") ||
    value.includes("ptgadvertlayout") ||
    /\bad\b/.test(value)
  );
}

function isDangerousActionNode(node: NormalizedSnapshotNode): boolean {
  const value = [
    node.attr.text,
    node.attr.desc,
    node.attr.id,
    node.attr.vid,
  ]
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

function isAdSdkOverlayResource(resource: string): boolean {
  const hasSkipOrClose =
    resource.includes("skip") ||
    resource.includes("close") ||
    resource.includes("cancel");
  const hasOverlaySignal =
    resource.includes("shade") ||
    resource.includes("mask") ||
    resource.includes("hotarea") ||
    resource.includes("hot_area") ||
    resource.includes("click_area") ||
    resource.includes("clickarea") ||
    resource.includes("ad_click") ||
    resource.includes("splash_click");

  return hasOverlaySignal && hasSkipOrClose;
}

function isDescendantOf(
  context: GenerationContext,
  node: NormalizedSnapshotNode,
  ancestor: NormalizedSnapshotNode,
): boolean {
  let pid = node.pid;
  while (pid >= 0) {
    if (pid === ancestor.id) return true;
    pid = context.snapshot.nodeById.get(pid)?.pid ?? -1;
  }
  return false;
}

function hasShortOneShotWindow(
  settings: GenerationContext["ruleSettings"],
): boolean {
  return (
    !settings.activityIds.trim() &&
    settings.matchTime !== null &&
    settings.matchTime <= 30000 &&
    settings.actionMaximum === 1 &&
    (settings.resetMatch === "app" || settings.resetMatch === "match")
  );
}
