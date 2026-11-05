import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type {
  RuleActionPlan,
  RuleDraft,
  SelectorCandidate,
  SelectorCondition,
  SelectorOperator,
  SelectorPlan,
  SelectorValidation,
  SimpleSelector,
} from "../types/ruleDraft";
import { scoreCandidate } from "./riskScoring";
import { RULE_ACTION_NAMES } from "../data/ruleSettings";
import { validateAppRuleAgainstSnapshot } from "./selectorMatcher";
import { serializePlan } from "./selectorSerialize";

type EditableAttr = "text" | "desc" | "id" | "vid";
type EditableOperator = "eq" | "contains" | "startsWith" | "endsWith";
export interface ConditionEditorCondition {
  attr: EditableAttr;
  op: EditableOperator;
  value: string;
}

export interface ConditionEditorSelector {
  typeName: string;
  conditions: ConditionEditorCondition[];
  clickable: boolean;
  visibleToUser: boolean;
}

export type ConditionEditorRelation =
  | { kind: "none" }
  | {
      kind: "parentChild";
      contextRole: "parent" | "child";
      context: ConditionEditorSelector;
    }
  | {
      kind: "adjacent";
      contextPosition: "before" | "after";
      context: ConditionEditorSelector;
    };

export interface ConditionEditorDraft {
  target: ConditionEditorSelector;
  relation: ConditionEditorRelation;
}

export type ConditionEditorModel =
  | { supported: true; draft: ConditionEditorDraft; readOnlyRuleFields: (keyof RuleDraft)[] }
  | { supported: false; reason: string };

export interface ConditionEditorResult {
  candidate: SelectorCandidate | null;
  /** 可解析的草稿即使零命中仍可预览；只有 candidate 非空时允许应用。 */
  previewCandidate?: SelectorCandidate;
  validation: SelectorValidation | null;
  error?: string;
  normalizations?: string[];
  /** 条件可编辑，但这些执行字段只在 JSON 中保留。 */
  preservedRuleFields?: string[];
  /** 条件编辑不会改写这些字段；仅在 JSON 中展示。 */
  preservedActionPlanFields?: string[];
}

const RULE_FIELDS = new Set([
  "key",
  "name",
  "matches",
  "activityIds",
  "fastQuery",
  "action",
  "actionDelay",
  "matchTime",
  "actionMaximum",
  "actionCd",
  "forcedTime",
  "matchRoot",
  "resetMatch",
]);

const RULE_PASSTHROUGH_FIELDS = new Set<keyof RuleDraft>([
  "activityIds",
  "fastQuery",
  "action",
  "actionDelay",
  "matchTime",
  "actionMaximum",
  "actionCd",
  "forcedTime",
  "matchRoot",
  "resetMatch",
]);

const RULE_CONTENT_FIELDS = [
  "activityIds",
  "action",
  "actionDelay",
  "matchTime",
  "actionMaximum",
  "actionCd",
  "forcedTime",
  "matchRoot",
  "resetMatch",
] as const;

const ACTION_PLAN_FIELDS = [
  "activityIds",
  "action",
  "actionDelay",
  "matchTime",
  "actionMaximum",
  "actionCd",
  "forcedTime",
  "matchRoot",
  "resetMatch",
] as const;

/**
 * 只有整条 typed plan 和会进入交付规则的条件字段都能由表单完整恢复时，
 * 才返回可编辑草稿；否则调用方必须保留原 JSON。
 */
export function createConditionEditorModel(
  candidate: SelectorCandidate,
): ConditionEditorModel {
  const unsupportedRuleField = Object.keys(candidate.rule).find(
    (key) => !RULE_FIELDS.has(key),
  );
  if (unsupportedRuleField) {
    return unsupported(
      `规则字段 ${unsupportedRuleField} 不能由条件表单完整表示。`,
    );
  }
  const invalidExecutionField = [...RULE_PASSTHROUGH_FIELDS].find((field) =>
    !executionValueSupported(field, candidate.rule[field]),
  );
  if (invalidExecutionField) {
    return unsupported(`执行字段 ${invalidExecutionField} 的值不能由条件界面完整表示。`);
  }

  const serialized = serializePlan(candidate.plan);
  if (!sameStrings(serialized, candidate.rule.matches)) {
    return unsupported("候选 plan 与 rule.matches 不一致，不能安全反解。");
  }

  for (const field of RULE_CONTENT_FIELDS) {
    if (!sameValue(candidate.rule[field], candidate.actionPlan[field])) {
      return unsupported(
        `规则的 ${field} 与动作计划不一致，不能确定编辑后应保留哪一份。`,
      );
    }
  }

  for (const field of ACTION_PLAN_FIELDS) {
    if (!sameValue(candidate.rule[field], candidate.actionPlan[field])) {
      return unsupported(`动作字段 ${field} 不能被条件表单完整保留。`);
    }
  }

  const planDraft = draftFromPlan(candidate.plan);
  if (!planDraft.supported) return planDraft;

  const editableSelectors = selectorParts(planDraft.draft);
  const passthroughField = Object.keys(candidate.rule).find(
    (key) =>
      !RULE_PASSTHROUGH_FIELDS.has(key as keyof RuleDraft) &&
      key !== "matches" &&
      key !== "key" &&
      key !== "name" &&
      !editableSelectors.some((selector) => selectorContainsField(selector, key)),
  );
  if (passthroughField) {
    return unsupported(`规则字段 ${passthroughField} 不能由条件表单完整表示。`);
  }

  const rulePlanCount = candidate.rule.matches.length;
  if (rulePlanCount !== serialized.length) {
    return unsupported("规则包含无法定位到 typed plan 的匹配条件。");
  }

  return {
    supported: true,
    draft: planDraft.draft,
    readOnlyRuleFields: preservedRuleFields(candidate),
  };
}

/** 从快照节点提取表单可编辑的基本条件，作为新上下文。 */
export function selectorFromSnapshotNode(
  node: NormalizedSnapshotNode,
): ConditionEditorSelector {
  const conditions: ConditionEditorCondition[] = [];
  for (const attr of ["text", "desc", "id", "vid"] as const) {
    const value = node.attr[attr];
    if (value) conditions.push({ attr, op: "eq", value });
  }
  return {
    typeName: shortTypeName(node),
    conditions,
    clickable: node.attr.clickable,
    visibleToUser: false,
  };
}

/**
 * 从表单重建候选。匹配条件必须重新通过官方规则层验证；零命中或其他不满足
 * 状态不会成为可应用候选，但仍返回验证结果供界面解释。
 */
export function applyConditionEditorDraft(input: {
  snapshot: ParsedGkdSnapshot;
  candidate: SelectorCandidate;
  draft: ConditionEditorDraft;
}): ConditionEditorResult {
  const { snapshot, candidate, draft } = input;
  const model = createConditionEditorModel(candidate);
  if (!model.supported) {
    return {
      candidate: null,
      validation: null,
      error: `原候选不支持可视化编辑：${model.reason}`,
    };
  }

  const normalized = normalizeDraft(draft);
  const invalidType = selectorParts(normalized.draft).find(
    (selector) => {
      const typeName = selector.typeName.trim();
      return Boolean(typeName) && !TYPE_NAME_PATTERN.test(typeName);
    },
  );
  if (invalidType) {
    return {
      candidate: null,
      validation: null,
      error: "类型只能填写 TextView、android.widget.TextView 这类标识符。",
    };
  }
  const planResult = planFromDraft(normalized.draft);
  if (!planResult.plan) {
    return { candidate: null, validation: null, error: planResult.reason };
  }

  const plan = planResult.plan;
  const matches = serializePlan(plan);
  const rule = { ...candidate.rule, matches };

  const validation = validateAppRuleAgainstSnapshot(snapshot, {
    id: snapshot.appId,
    name: snapshot.appInfo?.name ?? snapshot.appId,
    groups: [{ key: 0, name: "condition-editor", rules: [rule] }],
  })[0];
  const canApply = validation.status === "satisfied" && validation.hitCount > 0;

  const actionPlan = actionPlanFromRule(rule, candidate.actionPlan);
  const risk = scoreCandidate({
    baseScore: candidate.baseScore,
    snapshot,
    plan,
    rule,
    validation,
    allowNoActivityIds: Boolean(
      rule.actionMaximum === 1 && (rule.matchTime ?? 0) <= 10000,
    ),
  });
  const content = JSON.stringify({ plan, rule, actionPlan });
  const debugReasons = [
    ...candidate.debugReasons.filter((reason) => !reason.startsWith("matches: ")),
    `matches: ${matches.join(" && ")}`,
    ...normalized.notes,
  ];
  const readOnlyRuleFields = preservedRuleFieldsForPlan(candidate, plan);
  const previewCandidate: SelectorCandidate = {
      ...candidate,
      id: `${candidate.id}-edited-${shortHash(content)}`,
      plan,
      rule,
      actionPlan,
      validation,
      risk,
      riskNotes: [
        ...candidate.riskNotes,
        ...(readOnlyRuleFields.length > 0
          ? [`执行字段由高级 JSON 保留：${readOnlyRuleFields.join("、")}`]
          : []),
      ],
      debugReasons,
  };
  return {
    candidate: canApply ? previewCandidate : null,
    previewCandidate,
    validation,
    ...(!canApply ? { error: validation.diagnostics?.[0] || "当前规则没有点击目标，不能应用。" } : {}),
    preservedRuleFields: readOnlyRuleFields,
    preservedActionPlanFields: preservedActionPlanFields(candidate),
    ...(normalized.notes.length > 0 ? { normalizations: normalized.notes } : {}),
  };
}

function draftFromPlan(
  plan: SelectorPlan,
): { supported: true; draft: ConditionEditorDraft } | { supported: false; reason: string } {
  switch (plan.kind) {
    case "simple": {
      const target = targetFromSimple(plan.selector);
      return target.supported
        ? { supported: true, draft: { target: target.selector, relation: { kind: "none" } } }
        : target;
    }
    case "parentChild": {
      const target = targetFromSimple(
        plan.clickTarget === "parent" ? plan.parent : plan.child,
      );
      const context = selectorFromSimple(
        plan.clickTarget === "parent" ? plan.child : plan.parent,
      );
      if (!target.supported) return target;
      if (!context) return unsupported("父子上下文的操作符不能由条件表单完整表示。");
      return {
        supported: true,
        draft: {
          target: target.selector,
          relation: {
            kind: "parentChild",
            contextRole: plan.clickTarget === "parent" ? "child" : "parent",
            context,
          },
        },
      };
    }
    case "sibling": {
      const target = targetFromSimple(plan.target);
      const context = selectorFromSimple(plan.neighbor);
      if (!target.supported) return target;
      if (!context) return unsupported("相邻上下文的操作符不能由条件表单完整表示。");
      if (!isEditableDistance(plan.distance)) {
        return unsupported("相邻距离只能是固定相邻 +1/-1。");
      }
      return {
        supported: true,
        draft: {
          target: target.selector,
          relation: {
            kind: "adjacent",
            contextPosition: plan.relation === "next" ? "after" : "before",
            context,
          },
        },
      };
    }
    case "contextSibling": {
      const target = targetFromSimple(plan.target);
      const context = selectorFromSimple(plan.context);
      if (!target.supported) return target;
      if (!context) return unsupported("相邻上下文的操作符不能由条件表单完整表示。");
      if (!isEditableDistance(plan.distance)) {
        return unsupported("相邻距离只能是固定相邻 +1/-1。");
      }
      return {
        supported: true,
        draft: {
          target: target.selector,
          relation: {
            kind: "adjacent",
            contextPosition: plan.relation === "next" ? "before" : "after",
            context,
          },
        },
      };
    }
    case "matchesChain":
      return unsupported("多段默认点击目标链不能无损简化成一组 AND 条件。");
    case "ancestorDescendant":
      return unsupported("任意深度祖先关系不能由单一父子上下文完整表示。");
  }
}

function targetFromSimple(
  selector: SimpleSelector,
): { supported: true; selector: ConditionEditorSelector } | { supported: false; reason: string } {
  const parsed = selectorFromSimple(selector);
  if (parsed) return { supported: true, selector: parsed };
  const condition = selector.conditions.find((item) => !isSupportedCondition(item));
  return {
    supported: false,
    reason: condition
      ? `目标条件 ${condition.attr} ${condition.op} 不能由表单表示。`
      : "目标条件含表单不可编辑的 @ 点击标记。",
  };
}

function selectorFromSimple(selector: SimpleSelector): ConditionEditorSelector | null {
  if (selector.at) return null;
  const conditions: ConditionEditorCondition[] = [];
  let clickable = false;
  let visibleToUser = false;
  for (const condition of selector.conditions) {
    if (
      (condition.attr === "text" ||
        condition.attr === "desc" ||
        condition.attr === "id" ||
        condition.attr === "vid") &&
      isEditableStringOperator(condition.op) &&
      typeof condition.value === "string"
    ) {
      conditions.push({ attr: condition.attr, op: condition.op, value: condition.value });
      continue;
    }
    if (
      (condition.attr === "clickable" || condition.attr === "visibleToUser") &&
      condition.op === "eq" &&
      condition.value === true
    ) {
      if (condition.attr === "clickable") clickable = true;
      else visibleToUser = true;
      continue;
    }
    return null;
  }
  return {
    typeName: selector.typeName ?? "",
    conditions,
    clickable,
    visibleToUser,
  };
}

function normalizeDraft(input: ConditionEditorDraft): {
  draft: ConditionEditorDraft;
  notes: string[];
} {
  const notes: string[] = [];
  const target = normalizeSelector(input.target, notes);
  let relation = input.relation;
  if (relation.kind !== "none") {
    relation = { ...relation, context: normalizeSelector(relation.context, notes) };
  }
  return { draft: { target, relation }, notes };
}

function normalizeSelector(
  input: ConditionEditorSelector,
  notes: string[],
): ConditionEditorSelector {
  return {
    typeName: input.typeName.trim(),
    clickable: input.clickable,
    visibleToUser: input.visibleToUser,
    conditions: input.conditions.map((condition) => {
      const countdown = countdownPattern(condition.value);
      if (condition.attr === "text" && condition.op === "eq" && countdown) {
        notes.push('倒计时文本已改为包含“跳过”，避免锁定秒数。');
        return { attr: "text", op: "contains", value: countdown };
      }
      return { ...condition, value: condition.value };
    }),
  };
}

function planFromDraft(
  draft: ConditionEditorDraft,
): { plan: SelectorPlan | null; reason?: string } {
  const target = simpleFromDraft(draft.target);
  if (!target) return { plan: null, reason: "目标条件不能为空，且只能使用文字、描述、ID 或类型等支持的值。" };
  if (!draft.relation || draft.relation.kind === "none") {
    return { plan: { kind: "simple", selector: target } };
  }
  const context = simpleFromDraft(draft.relation.context);
  if (!context) return { plan: null, reason: "上下文条件不能为空或不完整。" };
  if (draft.relation.kind === "parentChild") {
    return draft.relation.contextRole === "parent"
      ? {
          plan: {
            kind: "parentChild",
            parent: context,
            child: target,
            clickTarget: "child",
          },
        }
      : {
          plan: {
            kind: "parentChild",
            parent: target,
            child: context,
            clickTarget: "parent",
          },
        };
  }
  return draft.relation.contextPosition === "before"
    ? {
        plan: {
          kind: "contextSibling",
          context,
          target,
          relation: "next",
          distance: 1,
        },
      }
    : {
        plan: {
          kind: "contextSibling",
          context,
          target,
          relation: "previous",
          distance: 1,
        },
      };
}

function simpleFromDraft(selector: ConditionEditorSelector): SimpleSelector | null {
  const conditions: SelectorCondition[] = selector.conditions.map((condition) => ({
    attr: condition.attr,
    op: condition.op as SelectorOperator,
    value: condition.value,
  }));
  if (selector.clickable) {
    conditions.push({ attr: "clickable", op: "eq", value: true });
  }
  if (selector.visibleToUser) {
    conditions.push({ attr: "visibleToUser", op: "eq", value: true });
  }
  if (!conditions.length && !selector.typeName.trim()) return null;
  return {
    ...(selector.typeName.trim() ? { typeName: selector.typeName.trim() } : {}),
    conditions,
  };
}

function actionPlanFromRule(rule: RuleDraft, original: RuleActionPlan): RuleActionPlan {
  return {
    ...original,
    ...(rule.activityIds === undefined ? {} : { activityIds: rule.activityIds }),
    ...(rule.action === undefined ? {} : { action: rule.action }),
    ...(rule.actionDelay === undefined ? {} : { actionDelay: rule.actionDelay }),
    ...(rule.matchTime === undefined ? {} : { matchTime: rule.matchTime }),
    ...(rule.actionMaximum === undefined ? {} : { actionMaximum: rule.actionMaximum }),
    ...(rule.actionCd === undefined ? {} : { actionCd: rule.actionCd }),
    ...(rule.forcedTime === undefined ? {} : { forcedTime: rule.forcedTime }),
    ...(rule.matchRoot === undefined ? {} : { matchRoot: rule.matchRoot }),
    ...(rule.resetMatch === undefined ? {} : { resetMatch: rule.resetMatch }),
  };
}

function isEditableDistance(distance: number | number[] | "n"): boolean {
  return distance === 1;
}

function isSupportedCondition(condition: SelectorCondition): boolean {
  return (
    ((condition.attr === "text" ||
      condition.attr === "desc" ||
      condition.attr === "id" ||
      condition.attr === "vid") &&
      isEditableStringOperator(condition.op) &&
      typeof condition.value === "string") ||
    ((condition.attr === "clickable" || condition.attr === "visibleToUser") &&
      condition.op === "eq" &&
      condition.value === true)
  );
}

function isEditableStringOperator(
  op: SelectorOperator,
): op is EditableOperator {
  return (
    op === "eq" ||
    op === "contains" ||
    op === "startsWith" ||
    op === "endsWith"
  );
}

function shortTypeName(node: NormalizedSnapshotNode): string {
  const short = node.attr.name.split(".").at(-1);
  return !short || short === "View" ? "" : short;
}

function countdownPattern(value: string): string | null {
  const text = value.trim();
  if (
    /^跳过\s*\d+\s*s?$/i.test(text) ||
    /^\d+\s*s?\s*后?\s*跳过$/i.test(text) ||
    /^skip\s*\d+\s*s?$/i.test(text) ||
    /^\d+\s*s?\s*skip$/i.test(text)
  ) {
    return /skip/i.test(text) ? "Skip" : "跳过";
  }
  return null;
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return sameStrings(a.map(String), b.map(String));
  return a === b;
}

function preservedRuleFields(candidate: SelectorCandidate): (keyof RuleDraft)[] {
  const fields = new Set([
    ...RULE_CONTENT_FIELDS.filter(
      (field) => candidate.rule[field] !== undefined,
    ),
    ...(candidate.rule.fastQuery === undefined ? [] : ["fastQuery" as const]),
  ]);
  return [...fields];
}

function executionValueSupported(field: string, value: unknown): boolean {
  if (value === undefined) return true;
  if (field === "activityIds") {
    return typeof value === "string" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"));
  }
  if (field === "action") return typeof value === "string" && Object.hasOwn(RULE_ACTION_NAMES, value);
  if (field === "resetMatch") return typeof value === "string" && ["app", "activity", "match"].includes(value);
  if (field === "fastQuery" || field === "matchRoot") return typeof value === "boolean";
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    (field !== "actionMaximum" || Number.isInteger(value));
}

function preservedRuleFieldsForPlan(
  candidate: SelectorCandidate,
  plan: SelectorPlan,
): (keyof RuleDraft)[] {
  const editable = draftFromPlan(plan);
  if (!editable.supported) return preservedRuleFields(candidate);
  return preservedRuleFields(candidate).filter((field) =>
    !selectorParts(editable.draft).some((selector) => selectorContainsField(selector, field)),
  );
}

function preservedActionPlanFields(candidate: SelectorCandidate): string[] {
  const fields: string[] = [];
  if (candidate.actionPlan.rankAdjustment !== 0) fields.push("排序调整");
  if (candidate.actionPlan.riskNotes.length > 0) fields.push("风险说明");
  if (candidate.actionPlan.debugAdvice.length > 0) fields.push("调试建议");
  return fields;
}

function selectorParts(draft: ConditionEditorDraft): ConditionEditorSelector[] {
  return draft.relation.kind === "none"
    ? [draft.target]
    : [draft.target, draft.relation.context];
}

function selectorContainsField(selector: ConditionEditorSelector, field: string): boolean {
  return selector.conditions.some((condition) => condition.attr === field);
}

function unsupported(reason: string): { supported: false; reason: string } {
  return { supported: false, reason };
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const TYPE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
