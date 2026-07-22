/**
 * 规则和候选的类型定义。
 * RuleSettings：用户选择的规则参数（场景/活动/匹配时间等）。
 * SelectorCandidate：一条候选规则（含 strategyName → selector匹配 → 验证结果 → 评分 → 动作计划）。
 * AppRuleDraft：针对一个 App 的完整规则组，可 JSON5 序列化后导入 GKD。
 */

import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "./gkdSnapshot";

export interface RuleSettings {
  groupName: string;
  activityIds: string;
  matchTime: number | null;
  actionMaximum: number | null;
  actionCd: number | null;
  resetMatch: "app" | "activity" | "match" | "";
  action?: string;
  actionDelay?: number | null;
  forcedTime?: number | null;
  matchRoot?: boolean | null;
}

export type SelectorAttr =
  | "id"
  | "vid"
  | "text"
  | "desc"
  | "clickable"
  | "visibleToUser"
  | "width"
  | "height"
  | "text.length"
  | "depth"
  | "index"
  | "childCount";

export type SelectorOperator =
  | "eq"
  | "notEq"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "notStartsWith"
  | "notEndsWith"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "orEq";

export interface SelectorCondition {
  attr: SelectorAttr;
  op: SelectorOperator;
  // orEq 时 value 是字符串数组，序列化为 [text="否" || text="暂不"]。
  value: string | number | boolean | string[];
}

export interface SimpleSelector {
  typeName?: string;
  at?: boolean;
  conditions: SelectorCondition[];
}

export type SelectorPlan =
  | {
      kind: "simple";
      selector: SimpleSelector;
    }
  | {
      kind: "parentChild";
      parent: SimpleSelector;
      child: SimpleSelector;
      clickTarget: "parent" | "child";
    }
  | {
      kind: "sibling";
      target: SimpleSelector;
      neighbor: SimpleSelector;
      relation: "next" | "previous";
      // 教程 §5.3.2.3：数字 = 固定距离（+1 / +2）；
      // 数字数组 = 元组表达式（+(1,2) 同时命中多个距离）；
      // "n" = 多项式简写（+n 等价 +(1n+0)，表示任意正距离）。
      distance: number | number[] | "n";
    }
  | {
      kind: "contextSibling";
      context: SimpleSelector;
      target: SimpleSelector;
      relation: "next" | "previous";
      // 同 sibling.distance。
      distance: number | number[] | "n";
    }
  | {
      kind: "matchesChain";
      context: SimpleSelector;
      target: SimpleSelector;
    }
  | {
      kind: "ancestorDescendant";
      ancestor: SimpleSelector;
      descendant: SimpleSelector;
    };

export interface RuleDraft {
  key: number;
  name?: string;
  preKeys?: number[];
  activityIds?: string | string[];
  matches: string[];
  fastQuery?: boolean;
  action?: string;
  actionDelay?: number;
  matchTime?: number;
  actionMaximum?: number;
  actionCd?: number;
  forcedTime?: number;
  matchRoot?: boolean;
  resetMatch?: "app" | "activity" | "match";
}

export interface RuleActionPlan {
  activityIds?: string | string[];
  action?: string;
  actionDelay?: number;
  matchTime?: number;
  actionMaximum?: number;
  actionCd?: number;
  forcedTime?: number;
  matchRoot?: boolean;
  resetMatch?: "app" | "activity" | "match";
  rankAdjustment: number;
  riskNotes: string[];
  debugAdvice: string[];
}

export interface RuleGenerationPlan {
  selectorCandidates: SelectorCandidate[];
  preferredSelector: SelectorCandidate | null;
  actionPlan: RuleActionPlan | null;
  fallbackPlan: SelectorCandidate[];
  riskNotes: string[];
  debugAdvice: string[];
}

export interface AppRuleDraft {
  id: string;
  name: string;
  groups: Array<{
    key: number;
    name: string;
    desc?: string;
    fastQuery?: boolean;
    activityIds?: string | string[];
    matchTime?: number;
    actionMaximum?: number;
    actionCd?: number;
    forcedTime?: number;
    matchRoot?: boolean;
    resetMatch?: "app" | "activity" | "match";
    rules: RuleDraft[];
  }>;
}

export interface SelectorValidation {
  hitCount: number;
  clickNodes: NormalizedSnapshotNode[];
  supportNodes: NormalizedSnapshotNode[];
  /**
   * AI 路径专用：本工具无法解析、无法预览的 matches 字符串。
   * 来自 AI 候选的 matches 列表解析失败时，原文进这里，前端不画框并显示警示。
   */
  unparsedMatches?: string[];
}

export interface RiskItem {
  label: string;
  value: number;
  reason: string;
}

export interface RiskBreakdown {
  finalScore: number;
  level: "low" | "medium" | "high";
  items: RiskItem[];
  positiveScore: number;
  cappedPositiveScore: number;
  penaltyScore: number;
}

export type MvpStrategyName =
  | "stableResourceSemantic"
  | "exactVid"
  | "exactId"
  | "exactDesc"
  | "typePlusExactAttr"
  | "exactTextWithContext"
  | "textSkipGuarded"
  | "clickParentDirectChildText"
  | "clickParentByChildIdVid"
  | "simpleSiblingCancelVsCTA"
  | "simpleContextRelation"
  | "adContainerSkipFallback"
  | "clickableAncestorFallback"
  | "visibleNodeFallback"
  | "negativeActionVariantUnion";

export interface SelectorCandidate {
  id: string;
  strategyName: MvpStrategyName;
  title: string;
  plan: SelectorPlan;
  rule: RuleDraft;
  actionPlan: RuleActionPlan;
  groupName: string;
  baseScore: number;
  validation: SelectorValidation;
  risk: RiskBreakdown;
  riskNotes: string[];
  debugAdvice: string[];
  debugReasons: string[];
}

export interface GenerationContext {
  snapshot: ParsedGkdSnapshot;
  ruleSettings: RuleSettings;
  pickedNode: NormalizedSnapshotNode;
  ancestors: NormalizedSnapshotNode[];
  siblings: NormalizedSnapshotNode[];
  clickableAncestor: NormalizedSnapshotNode | null;
  nearbyTextNodes: NormalizedSnapshotNode[];
}
