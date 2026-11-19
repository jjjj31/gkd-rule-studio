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
import {
  validateAppRuleAgainstSnapshot,
  validateSelectorPlan,
} from "./selectorMatcher";
import {
  buildVisualTargetIds,
  isClickWithinVisualTarget,
} from "./visualTarget";

interface CandidateSeed {
  strategyName: MvpStrategyName;
  title: string;
  baseScore: number;
  plan: SelectorPlan;
  groupName: string;
  debugReasons: string[];
}

/** 候选点击目标偏离用户所选控件（且不是其可点祖先）时的排序降权分。 */
const OFF_TARGET_RANK_PENALTY = 25;

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
    ...ambiguousTargetNarrowing(context),
    ...structuralTargetFallback(context),
    ...adContainerSkipFallback(context),
    ...clickableAncestorFallback(context),
    ...visibleNodeFallback(context),
    ...negativeActionVariantUnion(context),
  ];

  const visualTargetIds = buildVisualTargetIds({
    snapshot: context.snapshot,
    pickedNode: context.pickedNode,
    clickableAncestor: context.clickableAncestor,
  });
  const candidates = seeds
    .map((seed, index) => buildCandidate(context, seed, index, visualTargetIds))
    // 收窄候选必须真的收窄成功。动作计划可能在最后一步放宽选择器，
    // 这里以最终规则验证为准，避免“收窄后反而点到别的控件”。
    .filter(
      (candidate) =>
        candidate.strategyName !== "ambiguousTargetNarrowing" ||
        (candidate.validation.hitCount === 1 &&
          candidate.validation.clickNodes[0]?.id === context.pickedNode.id),
    );
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
  const seeds: CandidateSeed[] = [];
  if (context.pickedNode.attr.visibleToUser) {
    seeds.push(
      singleSeed(
        "exactVid",
        "精确 vid（可见）",
        96,
        {
          conditions: [
            { attr: "vid", op: "eq", value: vid },
            { attr: "visibleToUser", op: "eq", value: true },
          ],
        },
        [`点击可见节点 vid=${vid}`],
      ),
    );
    const stableText = semanticNodeText(context.pickedNode);
    if (
      stableText &&
      !isDynamicCountdownText(stableText) &&
      !hasDynamicNumericPart(stableText) &&
      isHighCollisionGenericResource(vid)
    ) {
      seeds.push(
        singleSeed(
          "exactVid",
          "精确 vid + 文本守卫",
          97,
          {
            conditions: [
              { attr: "vid", op: "eq", value: vid },
              {
                attr: context.pickedNode.attr.text ? "text" : "desc",
                op: "eq",
                value: stableText,
              },
              { attr: "visibleToUser", op: "eq", value: true },
            ],
          },
          [`点击泛化 vid=${vid} 且匹配文本 ${stableText}`],
        ),
      );
    }
  }
  seeds.push(
    singleSeed("exactVid", "精确 vid", 95, exactSelector("vid", vid), [
      `点击节点 vid=${vid}`,
    ]),
  );
  return seeds;
}

function exactId(context: GenerationContext): CandidateSeed[] {
  const id = context.pickedNode.attr.id;
  if (!id) return [];
  const seeds: CandidateSeed[] = [];
  if (context.pickedNode.attr.visibleToUser) {
    seeds.push(
      singleSeed(
        "exactId",
        "精确 id（可见）",
        94,
        {
          conditions: [
            { attr: "id", op: "eq", value: id },
            { attr: "visibleToUser", op: "eq", value: true },
          ],
        },
        [`点击可见节点 id=${id}`],
      ),
    );
  }
  seeds.push(
    singleSeed("exactId", "精确 id", 93, exactSelector("id", id), [
      `点击节点 id=${id}`,
    ]),
  );
  return seeds;
}

function exactDesc(context: GenerationContext): CandidateSeed[] {
  const desc = context.pickedNode.attr.desc;
  if (!desc || isMachineAssetText(desc)) return [];
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
  if (!attr) return [];
  if (attr.key === "text" && isDynamicCountdownText(attr.value)) return [];

  const seeds: CandidateSeed[] = [];
  const dynamicPrefix =
    attr.key === "text" ? extractDynamicNumericPrefix(attr.value) : null;
  if (dynamicPrefix && node.attr.visibleToUser) {
    seeds.push(
      singleSeed(
        "typePlusExactAttr",
        "类型 + 稳定文本前缀",
        86,
        {
          typeName,
          conditions: [
            { attr: "text", op: "startsWith", value: dynamicPrefix },
            { attr: "visibleToUser", op: "eq", value: true },
          ],
        },
        [`文本含动态数值，使用前缀 ${dynamicPrefix} 提升跨版本稳定性`],
      ),
    );
  }

  if (typeName && node.attr.visibleToUser) {
    seeds.push(
      singleSeed(
        "typePlusExactAttr",
        "类型 + 精确属性（可见）",
        85,
        {
          typeName,
          conditions: [
            { attr: attr.key, op: "eq", value: attr.value },
            { attr: "visibleToUser", op: "eq", value: true },
          ],
        },
        [`使用 ${typeName} + visibleToUser 限制 ${attr.key}`],
      ),
    );
  }

  if (typeName) {
    seeds.push(
      singleSeed(
        "typePlusExactAttr",
        "类型 + 精确属性",
        84,
        exactSelector(attr.key, attr.value, typeName),
        [`使用 ${typeName} 限制裸 ${attr.key}`],
      ),
    );
  }
  return seeds;
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
  if (!targetText) return anonymousClickableContextRelation(context);
  if (context.pickedNode.pid < 0) return [];

  const contextSibling = context.siblings.find((node) => {
    const value = nodeText(node);
    return value && CONTEXT_HINT_WORDS.some((word) => value.includes(word));
  });

  if (!contextSibling) return [];

  // contextSibling 序列化为「上下文 <关系符> 目标」，所以这里按目标相对上下文的方位取符号。
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

/**
 * 匿名可点控件（无 vid/id/text/desc）用相邻文字做锚点。
 * 官方真值里大量出现 `@ImageView[clickable=true] - [text="反馈"]` 这类写法：
 * 关闭图标本身没有任何稳定属性，只能靠旁边的文案定位。
 */
function anonymousClickableContextRelation(
  context: GenerationContext,
): CandidateSeed[] {
  const picked = context.pickedNode;
  if (!picked.attr.clickable) return [];
  if (picked.attr.vid || picked.attr.id || picked.attr.desc) return [];

  const anchor = context.siblings
    .filter((node) => node.attr.visibleToUser)
    .map((node) => ({ node, value: nodeText(node) }))
    .filter(
      ({ value }) =>
        Boolean(value) && value!.length <= 16 && !/^\d+$/.test(value!),
    )
    .sort((a, b) => a.value!.length - b.value!.length)[0];
  if (!anchor) return [];

  const distance = Math.abs(picked.attr.index - anchor.node.attr.index);
  if (distance < 1 || distance > 4) return [];

  const relation =
    anchor.node.attr.index > picked.attr.index ? "next" : "previous";
  const contextSel = selectorForTextNode(anchor.node);
  const groupName = groupNameForContext(anchor.node, "功能类-自动生成");
  const reason = `目标无稳定资源名，用相邻文字 ${anchor.value} 锚定`;

  return [
    {
      strategyName: "simpleContextRelation",
      title: "匿名图标 + 相邻文字锚点",
      baseScore: 76,
      plan: {
        kind: "sibling",
        target: { ...clickableSelector(true), typeName: shortTypeName(picked) },
        neighbor: contextSel,
        relation,
        distance,
      },
      groupName,
      debugReasons: [reason],
    },
    {
      strategyName: "simpleContextRelation",
      title: "匿名可点控件 + 相邻文字锚点",
      baseScore: 74,
      plan: {
        kind: "sibling",
        target: clickableSelector(true),
        neighbor: contextSel,
        relation,
        distance,
      },
      groupName,
      debugReasons: [reason],
    },
  ];
}

type NarrowStrength = "text" | "resource" | "structure";

interface NarrowTarget {
  selector: SimpleSelector;
  label: string;
}

interface NarrowContext {
  selector: SimpleSelector;
  strength: NarrowStrength;
}

const NARROWING_MAX_TARGET_SELECTORS = 4;
const NARROWING_MAX_CONTEXTS = 6;

/**
 * 多命中收窄：目标自身的选择器命中多个控件时，补一个唯一的祖先、兄弟或父容器
 * 约束，直到只剩用户所选控件。只接受“收窄后精确点中目标”的结果。
 */
function ambiguousTargetNarrowing(context: GenerationContext): CandidateSeed[] {
  const seeds: CandidateSeed[] = [];
  let ambiguousTargets = 0;

  for (const target of narrowingTargetSelectors(context.pickedNode)) {
    if (ambiguousTargets >= NARROWING_MAX_TARGET_SELECTORS) break;
    const hitCount = selectorHitCount(context.snapshot, target.selector);
    if (hitCount <= 1) continue;
    ambiguousTargets += 1;

    seeds.push(
      ...narrowByDescendant(context, target, hitCount),
      ...narrowByAncestor(context, target, hitCount),
      ...narrowBySibling(context, target, hitCount),
      ...narrowByParent(context, target, hitCount),
    );
  }

  return seeds;
}

/**
 * 后代锚点收窄：当用户选中的是可点外层容器/悬浮窗（如 @[vid="frog_float"] 或 @[vid="reason1_layout"]），
 * 自身在界面上重复出现时，用其内部唯一的子文本或子资源收窄并保持点击外层容器。
 */
function narrowByDescendant(
  context: GenerationContext,
  target: NarrowTarget,
  targetHitCount: number,
): CandidateSeed[] {
  const picked = context.pickedNode;
  if (picked.attr.childCount <= 0) return [];

  const descendants = collectVisibleDescendants(context.snapshot, picked.id, 3);
  const seeds: CandidateSeed[] = [];

  for (const child of descendants.slice(0, 10)) {
    const childCtx = narrowingContextSelector(child);
    if (!childCtx || childCtx.strength === "structure") continue;

    const isDirectChild = child.pid === picked.id;
    const plan: SelectorPlan = isDirectChild
      ? {
          kind: "parentChild",
          parent: target.selector,
          child: childCtx.selector,
          clickTarget: "parent",
        }
      : {
          kind: "ancestorDescendant",
          ancestor: { ...target.selector, at: true },
          descendant: childCtx.selector,
        };

    if (!planHitsExactly(context.snapshot, plan, picked.id)) continue;

    seeds.push({
      strategyName: "ambiguousTargetNarrowing",
      title: isDirectChild ? "子锚点收窄父容器" : "后代锚点收窄容器",
      baseScore: childCtx.strength === "text" ? 88 : 86,
      plan,
      groupName: groupNameForContext(child, "功能类-自动生成"),
      debugReasons: [
        `目标${target.label}命中 ${targetHitCount} 个控件，用内部${isDirectChild ? "子节点" : "后代"} ${semanticNodeText(child) || child.attr.vid || child.attr.id || child.attr.name} 收窄`,
      ],
    });
    break;
  }

  return seeds;
}

function collectVisibleDescendants(
  snapshot: GenerationContext["snapshot"],
  rootId: number,
  maxDepth: number,
): NormalizedSnapshotNode[] {
  const out: NormalizedSnapshotNode[] = [];
  const queue: Array<{ id: number; depth: number }> = [{ id: rootId, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    const node = snapshot.nodeById.get(current.id);
    if (!node) continue;
    for (const childId of node.children) {
      const child = snapshot.nodeById.get(childId);
      if (!child) continue;
      if (child.attr.visibleToUser) out.push(child);
      queue.push({ id: childId, depth: current.depth + 1 });
    }
  }
  return out;
}

/**
 * 匿名控件的结构兜底：没有 text/desc/id/vid 时，用类型、可点性、
 * childCount 和尺寸收窄；仍不唯一时再尝试 index / depth。
 */
function structuralTargetFallback(context: GenerationContext): CandidateSeed[] {
  const node = context.pickedNode;
  if (
    preferredTextualAttr(node) ||
    (node.attr.id && !isObfuscatedResourceId(node.attr.id)) ||
    (node.attr.vid && !isObfuscatedResourceId(node.attr.vid))
  ) {
    return [];
  }

  const sizeFreeBase = structuralTargetSelectorWithoutSize(node);
  const relaxedBase = structuralTargetSelector(node, "relaxed");
  const tightBase = structuralTargetSelector(node, "tight");
  const variants: Array<{
    selector: SimpleSelector;
    score: number;
    suffix: string;
  }> = [
    { selector: sizeFreeBase, score: 69, suffix: "（无尺寸锁死）" },
    { selector: relaxedBase, score: 68, suffix: "（宽松尺寸）" },
    { selector: tightBase, score: 66, suffix: "" },
    {
      selector: {
        ...relaxedBase,
        conditions: [
          ...relaxedBase.conditions,
          { attr: "index", op: "eq", value: node.attr.index },
        ],
      },
      score: 60,
      suffix: " + index",
    },
    {
      selector: {
        ...relaxedBase,
        conditions: [
          ...relaxedBase.conditions,
          { attr: "depth", op: "eq", value: node.attr.depth },
        ],
      },
      score: 60,
      suffix: " + depth",
    },
    {
      selector: {
        ...tightBase,
        conditions: [
          ...tightBase.conditions,
          { attr: "index", op: "eq", value: node.attr.index },
          { attr: "depth", op: "eq", value: node.attr.depth },
        ],
      },
      score: 56,
      suffix: " + index + depth",
    },
  ];

  for (const variant of variants) {
    const plan: SelectorPlan = { kind: "simple", selector: variant.selector };
    if (!planHitsExactly(context.snapshot, plan, node.id)) continue;
    return [
      {
        strategyName: "structuralTargetFallback",
        title: "匿名控件结构定位",
        baseScore: variant.score,
        plan,
        groupName: "功能类-自动生成",
        debugReasons: [
          `目标无稳定文字/资源名，用类型、childCount${variant.suffix}收窄到唯一控件；换版本后需复核`,
        ],
      },
    ];
  }

  return [];
}

function narrowByAncestor(
  context: GenerationContext,
  target: NarrowTarget,
  targetHitCount: number,
): CandidateSeed[] {
  for (const ancestor of context.ancestors.slice(0, NARROWING_MAX_CONTEXTS)) {
    if (isWholeScreenAncestor(context.snapshot, ancestor)) continue;
    const narrowContext = narrowingContextSelector(ancestor);
    if (!narrowContext) continue;
    // 祖先本身不唯一时，祖先 + 目标组合仍可能唯一，交给最终验证判断。
    const ancestorHits = selectorHitCount(context.snapshot, narrowContext.selector);
    if (ancestorHits === 0 || ancestorHits > 8) continue;

    const plan: SelectorPlan = {
      kind: "ancestorDescendant",
      ancestor: narrowContext.selector,
      descendant: target.selector,
    };
    if (!planHitsExactly(context.snapshot, plan, context.pickedNode.id)) continue;

    return [
      {
        strategyName: "ambiguousTargetNarrowing",
        title: "祖先上下文收窄",
        baseScore: narrowScore("ancestor", narrowContext.strength),
        plan,
        groupName: groupNameForContext(ancestor, "功能类-自动生成"),
        debugReasons: [
          `目标${target.label}命中 ${targetHitCount} 个控件，用唯一祖先 ${nodeText(ancestor) || ancestor.attr.id || ancestor.attr.vid || ancestor.attr.name} 收窄`,
        ],
      },
    ];
  }

  return [];
}

function narrowBySibling(
  context: GenerationContext,
  target: NarrowTarget,
  targetHitCount: number,
): CandidateSeed[] {
  const siblings = [...context.siblings].sort(
    (a, b) =>
      Math.abs(a.attr.index - context.pickedNode.attr.index) -
      Math.abs(b.attr.index - context.pickedNode.attr.index),
  );

  for (const sibling of siblings.slice(0, NARROWING_MAX_CONTEXTS)) {
    const distance = Math.abs(
      sibling.attr.index - context.pickedNode.attr.index,
    );
    if (distance < 1 || distance > 6) continue;
    const narrowContext = narrowingContextSelector(sibling);
    if (!narrowContext) continue;
    if (selectorHitCount(context.snapshot, narrowContext.selector) !== 1) continue;

    const relation =
      context.pickedNode.attr.index > sibling.attr.index ? "next" : "previous";
    // 距离 ≥2 时优先尝试弹性距离 +n/-n：在当前快照仍能唯一命中时，跨版本增删兄弟节点不易断裂
    if (distance >= 2 && narrowContext.strength !== "structure") {
      const flexiblePlan: SelectorPlan = {
        kind: "contextSibling",
        context: narrowContext.selector,
        target: target.selector,
        relation,
        distance: "n",
      };
      if (planHitsExactly(context.snapshot, flexiblePlan, context.pickedNode.id)) {
        return [
          {
            strategyName: "ambiguousTargetNarrowing",
            title: "相邻兄弟弹性收窄",
            baseScore: narrowScore("sibling", narrowContext.strength) + 1,
            plan: flexiblePlan,
            groupName: groupNameForContext(sibling, "功能类-自动生成"),
            debugReasons: [
              `目标${target.label}命中 ${targetHitCount} 个控件，用唯一兄弟 ${semanticNodeText(sibling) || sibling.attr.id || sibling.attr.vid || sibling.attr.name} 弹性距离收窄`,
            ],
          },
        ];
      }
    }

    const plan: SelectorPlan = {
      kind: "contextSibling",
      context: narrowContext.selector,
      target: target.selector,
      relation,
      distance,
    };
    if (!planHitsExactly(context.snapshot, plan, context.pickedNode.id)) continue;

    return [
      {
        strategyName: "ambiguousTargetNarrowing",
        title: "相邻兄弟收窄",
        baseScore: narrowScore("sibling", narrowContext.strength),
        plan,
        groupName: groupNameForContext(sibling, "功能类-自动生成"),
        debugReasons: [
          `目标${target.label}命中 ${targetHitCount} 个控件，用唯一兄弟 ${semanticNodeText(sibling) || sibling.attr.id || sibling.attr.vid || sibling.attr.name} 收窄`,
        ],
      },
    ];
  }

  return [];
}

function narrowByParent(
  context: GenerationContext,
  target: NarrowTarget,
  targetHitCount: number,
): CandidateSeed[] {
  // 收窄要找“目标的直接父容器”，不能直接用 clickableAncestor：
  // 目标自己可点时，clickableAncestor 就是目标本身。
  const parent = context.ancestors[0] ?? context.clickableAncestor;
  if (!parent) return [];
  const narrowContext = narrowingContextSelector(parent);
  if (!narrowContext) return [];
  // 父容器本身不一定唯一；父 + 子组合起来唯一即可。
  // 例如两个同尺寸按钮的父容器都是 childCount=2，但只有一个父容器下面有目标类型。
  const parentHits = selectorHitCount(context.snapshot, narrowContext.selector);
  if (parentHits === 0 || parentHits > 8) return [];

  const plan: SelectorPlan = {
    kind: "parentChild",
    parent: narrowContext.selector,
    child: target.selector,
    clickTarget: "child",
  };
  if (!planHitsExactly(context.snapshot, plan, context.pickedNode.id)) return [];

  return [
    {
      strategyName: "ambiguousTargetNarrowing",
      title: "父容器收窄",
      baseScore: narrowScore("parent", narrowContext.strength),
      plan,
      groupName: groupNameForContext(parent, "功能类-自动生成"),
      debugReasons: [
        `目标${target.label}命中 ${targetHitCount} 个控件，用唯一父容器收窄`,
      ],
    },
  ];
}

function narrowingTargetSelectors(node: NormalizedSnapshotNode): NarrowTarget[] {
  const result: NarrowTarget[] = [];
  const seen = new Set<string>();
  const push = (selector: SimpleSelector, label: string) => {
    const key = JSON.stringify(selector);
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ selector, label });
  };

  if (preferredTextualAttr(node)) {
    push(selectorForTextNode(node), "文本");
  }
  if (node.attr.vid && !isObfuscatedResourceId(node.attr.vid)) {
    push(
      {
        typeName: shortTypeName(node),
        conditions: [
          { attr: "vid", op: "eq", value: node.attr.vid },
          ...(node.attr.visibleToUser
            ? [{ attr: "visibleToUser" as const, op: "eq" as const, value: true }]
            : []),
        ],
      },
      "vid",
    );
  }
  if (node.attr.id && !isObfuscatedResourceId(node.attr.id)) {
    push(
      {
        typeName: shortTypeName(node),
        conditions: [
          { attr: "id", op: "eq", value: node.attr.id },
          ...(node.attr.visibleToUser
            ? [{ attr: "visibleToUser" as const, op: "eq" as const, value: true }]
            : []),
        ],
      },
      "id",
    );
  }
  if (node.attr.clickable) {
    push(
      {
        typeName: shortTypeName(node),
        conditions: [
          { attr: "clickable", op: "eq", value: true },
          { attr: "visibleToUser", op: "eq", value: true },
        ],
      },
      "可点类型",
    );
  }
  push(structuralTargetSelectorWithoutSize(node), "无尺寸结构");
  push(structuralTargetSelector(node, "relaxed"), "宽松结构");

  return result;
}

function relaxedUpperBound(px: number): number {
  const padded = Math.max(px + 20, Math.ceil(px * 1.25));
  return Math.ceil(padded / 10) * 10;
}

function structuralTargetSelectorWithoutSize(
  node: NormalizedSnapshotNode,
): SimpleSelector {
  const conditions: SimpleSelector["conditions"] = [];
  if (node.attr.clickable) {
    conditions.push({ attr: "clickable", op: "eq", value: true });
  }
  conditions.push({ attr: "visibleToUser", op: "eq", value: true });
  conditions.push({
    attr: "childCount",
    op: "eq",
    value: node.attr.childCount,
  });
  return {
    typeName: fallbackTypeName(node),
    conditions,
  };
}

/**
 * 匿名控件的结构选择器：类型 + 可点性 + 子节点数 + 尺寸上限。
 * 默认使用带容差的宽松上限，避免不同版本/DPI 差几个像素就 0 命中。
 */
function structuralTargetSelector(
  node: NormalizedSnapshotNode,
  mode: "relaxed" | "tight" = "relaxed",
): SimpleSelector {
  const base = structuralTargetSelectorWithoutSize(node);
  const conditions = [...base.conditions];
  if (node.attr.width > 0) {
    conditions.push({
      attr: "width",
      op: "lte",
      value: mode === "relaxed" ? relaxedUpperBound(node.attr.width) : node.attr.width,
    });
  }
  if (node.attr.height > 0) {
    conditions.push({
      attr: "height",
      op: "lte",
      value: mode === "relaxed" ? relaxedUpperBound(node.attr.height) : node.attr.height,
    });
  }
  return {
    typeName: base.typeName,
    conditions,
  };
}

function narrowingContextSelector(
  node: NormalizedSnapshotNode,
): NarrowContext | null {
  if (preferredTextualAttr(node)) {
    return { selector: selectorForTextNode(node), strength: "text" };
  }
  if (node.attr.vid && !isObfuscatedResourceId(node.attr.vid)) {
    return {
      selector: exactSelector("vid", node.attr.vid, shortTypeName(node)),
      strength: "resource",
    };
  }
  if (node.attr.id && !isObfuscatedResourceId(node.attr.id)) {
    return {
      selector: exactSelector("id", node.attr.id, shortTypeName(node)),
      strength: "resource",
    };
  }
  if (node.attr.childCount > 0) {
    const conditions: SimpleSelector["conditions"] = [
      { attr: "childCount", op: "eq", value: node.attr.childCount },
      { attr: "visibleToUser", op: "eq", value: true },
    ];
    return {
      selector: {
        typeName: shortTypeName(node),
        conditions,
      },
      strength: "structure",
    };
  }
  return null;
}

function narrowScore(
  kind: "ancestor" | "sibling" | "parent",
  strength: NarrowStrength,
): number {
  const table = {
    ancestor: { text: 86, resource: 82, structure: 70 },
    sibling: { text: 82, resource: 78, structure: 66 },
    parent: { text: 84, resource: 80, structure: 68 },
  } as const;
  return table[kind][strength];
}

function selectorHitCount(
  snapshot: GenerationContext["snapshot"],
  selector: SimpleSelector,
): number {
  return validateSelectorPlan(snapshot, { kind: "simple", selector }).hitCount;
}

function planHitsExactly(
  snapshot: GenerationContext["snapshot"],
  plan: SelectorPlan,
  nodeId: number,
): boolean {
  const validation = validateSelectorPlan(snapshot, plan);
  return (
    validation.hitCount === 1 && validation.clickNodes[0]?.id === nodeId
  );
}

function isWholeScreenAncestor(
  snapshot: GenerationContext["snapshot"],
  node: NormalizedSnapshotNode,
): boolean {
  return (
    Math.max(0, node.attr.width) * Math.max(0, node.attr.height) >=
    snapshot.screenWidth * snapshot.screenHeight * 0.9
  );
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
  visualTargetIds: Set<number>,
): SelectorCandidate {
  const baseRule = createRuleDraft(
    seed.plan,
    context.ruleSettings,
    seed.title,
  );
  const actionPlan = buildActionPlan({
    snapshot: context.snapshot,
    pickedNode: context.pickedNode,
    plan: seed.plan,
    validation: validateAppRuleAgainstSnapshot(context.snapshot, {
      id: context.snapshot.appId,
      name: context.snapshot.appInfo?.name ?? context.snapshot.appId,
      groups: [
        {
          key: 0,
          name: context.ruleSettings.groupName.trim() || seed.groupName,
          ...(context.ruleSettings.activityIds.trim()
            ? { activityIds: context.ruleSettings.activityIds.trim() }
            : {}),
          rules: [{ key: 0, matches: serializePlan(seed.plan) }],
        },
      ],
    })[0],
    strategyName: seed.strategyName,
    ruleSettings: context.ruleSettings,
  });
  const rule = applyActionPlanToRule(baseRule, actionPlan);
  const validation = validateAppRuleAgainstSnapshot(context.snapshot, {
    id: context.snapshot.appId,
    name: context.snapshot.appInfo?.name ?? context.snapshot.appId,
    groups: [{ key: 0, name: context.ruleSettings.groupName.trim() || seed.groupName, rules: [rule] }],
  })[0];
  const risk = scoreCandidate({
    baseScore: seed.baseScore,
    snapshot: context.snapshot,
    plan: seed.plan,
    rule,
    validation,
    allowNoActivityIds: hasShortOneShotWindow(context.ruleSettings),
  });

  // 用户点的是哪个控件，规则就该点哪个控件。点击目标跑到别的节点上的候选
  // （例如整屏扫描出来的同名关闭按钮、同框文字标签）一律降权。
  const clickedIds = validation.clickNodes.map((node) => node.id);
  const offTarget =
    clickedIds.length > 0 &&
    !isClickWithinVisualTarget(clickedIds, visualTargetIds);

  return {
    id: `${seed.strategyName}-${index}`,
    strategyName: seed.strategyName,
    title: seed.title,
    plan: seed.plan,
    rule,
    actionPlan,
    groupName: context.ruleSettings.groupName.trim() || seed.groupName,
    baseScore: seed.baseScore,
    rankPenalty: offTarget ? OFF_TARGET_RANK_PENALTY : 0,
    validation,
    risk,
    riskNotes: actionPlan.riskNotes,
    debugAdvice: actionPlan.debugAdvice,
    debugReasons: [
      ...seed.debugReasons,
      ...(offTarget
        ? [
            `点击目标 #${clickedIds.join(",")} 偏离所选控件 #${context.pickedNode.id} 的视觉摞，排序降权`,
          ]
        : []),
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
    Math.min(
      140,
      candidate.risk.finalScore +
        candidate.actionPlan.rankAdjustment -
        (candidate.rankPenalty ?? 0),
    ),
  );
}

function preferredTextualAttr(
  node: NormalizedSnapshotNode,
): { key: "text" | "desc"; value: string } | null {
  if (node.attr.text && !isMachineAssetText(node.attr.text)) {
    return { key: "text", value: node.attr.text };
  }
  if (node.attr.desc && !isMachineAssetText(node.attr.desc)) {
    return { key: "desc", value: node.attr.desc };
  }
  return null;
}

function childStableSelector(node: NormalizedSnapshotNode): SimpleSelector | null {
  if (node.attr.vid && !isObfuscatedResourceId(node.attr.vid)) {
    return exactSelector("vid", node.attr.vid, shortTypeName(node));
  }
  if (node.attr.id && !isObfuscatedResourceId(node.attr.id)) {
    return exactSelector("id", node.attr.id, shortTypeName(node));
  }
  if (node.attr.desc && !isMachineAssetText(node.attr.desc)) {
    return exactSelector("desc", node.attr.desc, shortTypeName(node));
  }
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

  if (node.attr.text && !isMachineAssetText(node.attr.text)) {
    const dynPrefix = extractDynamicNumericPrefix(node.attr.text);
    if (dynPrefix) {
      return {
        typeName: shortTypeName(node),
        conditions: [{ attr: "text", op: "startsWith", value: dynPrefix }],
      };
    }
    return exactSelector("text", node.attr.text, shortTypeName(node));
  }

  if (node.attr.desc && !isMachineAssetText(node.attr.desc)) {
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
  return semanticNodeText(node);
}

function semanticNodeText(node: NormalizedSnapshotNode): string | null {
  if (node.attr.text && !isMachineAssetText(node.attr.text)) {
    return node.attr.text;
  }
  if (node.attr.desc && !isMachineAssetText(node.attr.desc)) {
    return node.attr.desc;
  }
  return null;
}

/** 排除图片格式后缀、CDN 文件名或资源哈希等非用户可读伪文本（如 "webp"、"O1CN01...jpg_"）。 */
export function isMachineAssetText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^(?:webp|png|jpe?g|gif|svg|avif|bmp|mp4|json)$/i.test(trimmed)) {
    return true;
  }
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (/^O1CN01[0-9A-Za-z_!-]{8,}/.test(trimmed)) return true;
  if (/\.(?:png|jpe?g|webp|gif|svg)(?:_\d+x\d+[^\s]*)?_?$/i.test(trimmed)) {
    return true;
  }
  return false;
}

const KNOWN_SHORT_SEMANTIC_IDS = new Set([
  "ad", "ok", "no", "tv", "iv", "bt", "bg", "up", "go", "id",
  "btn", "txt", "img", "icn", "lbl", "msg", "nav", "tab", "bar",
  "dlg", "hdr", "ftr", "cnt", "lyt", "box", "row", "col", "src",
  "url", "tag", "num", "max", "min", "top", "btm", "lft", "rgt",
  "sdk", "app", "web", "vip", "pay", "buy", "cls", "del", "add",
  "sub", "opt", "cfg", "tip", "adv", "end", "new", "hot", "pop",
]);

/** 判断 id/vid 是否属于混淆构建产物或通用无意义占位符（换版本极易变化或全屏大量撞名）。 */
export function isObfuscatedResourceId(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const short = (raw.includes(":id/") ? raw.split(":id/").pop() ?? raw : raw).trim();
  if (!short) return false;
  const lower = short.toLowerCase();
  if (
    lower === "obfuscated" ||
    lower === "0_resource_name_obfuscated" ||
    lower === "arg" ||
    lower === "pdd" ||
    lower.startsWith("unused_res_")
  ) {
    return true;
  }
  // 2~3 位字母数字混合短混淆码（如 2x1、c6n）
  if (/^[a-z0-9]{2,3}$/.test(lower) && /\d/.test(lower) && !/^v\d+$/.test(lower)) {
    return true;
  }
  // 3 字母纯辅音且不在常见 UI 缩写词表中（如 AndResGuard 生成的 dzp、rvc、hzx）
  if (
    /^[bcdfghjklmnpqrstvwxz]{3}$/.test(lower) &&
    !KNOWN_SHORT_SEMANTIC_IDS.has(lower)
  ) {
    return true;
  }
  return false;
}

const HIGH_COLLISION_GENERIC_RESOURCES = new Set([
  "title", "tvtitle", "tv_title", "alerttitle", "dialog_title",
  "desc", "tvdesc", "tv_desc", "content", "tvcontent", "tv_content",
  "name", "tvname", "tv_name", "text", "tvtext", "tv_text",
  "button1", "button2", "text1", "text2",
]);

export function isHighCollisionGenericResource(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const short = (raw.includes(":id/") ? raw.split(":id/").pop() ?? raw : raw)
    .trim()
    .toLowerCase();
  return HIGH_COLLISION_GENERIC_RESOURCES.has(short);
}

function hasDynamicNumericPart(text: string): boolean {
  return /\d/.test(text);
}

/** 提取带可变数值/文件大小/天数后缀文案中的固定前缀（如 "查看原图（1.7M）" → "查看原图"）。 */
function extractDynamicNumericPrefix(text: string): string | null {
  const trimmed = text.trim();
  const parenMatch = /^([\u4e00-\u9fa5A-Za-z]{2,10})[（(]\s*\d+(?:\.\d+)?\s*[A-Za-z%MBKGT天秒次个件条张]*\s*[）)]$/.exec(
    trimmed,
  );
  if (parenMatch?.[1]) return parenMatch[1];
  const suffixMatch = /^([\u4e00-\u9fa5]{3,10}?)\s*\d+(?:\.\d+)?\s*(?:天|秒|次|个|件|条|%|MB|KB|GB|M|K)$/i.exec(
    trimmed,
  );
  if (suffixMatch?.[1]) return suffixMatch[1];
  return null;
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
