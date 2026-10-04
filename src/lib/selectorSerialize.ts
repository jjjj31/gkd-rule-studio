import type {
  RuleDraft,
  RuleSettings,
  SelectorCondition,
  SelectorPlan,
  SimpleSelector,
} from "../types/ruleDraft";

export function serializePlan(plan: SelectorPlan): string[] {
  switch (plan.kind) {
    case "simple":
      return [formatSimpleSelector(plan.selector)];
    case "parentChild":
      return [
        `${formatSimpleSelector({
          ...plan.parent,
          at: plan.clickTarget === "parent",
        })} > ${formatSimpleSelector({
          ...plan.child,
          at: plan.clickTarget === "child",
        })}`,
      ];
    case "sibling":
      return [
        `${formatSimpleSelector({ ...plan.target, at: true })} ${formatRelation(
          plan.relation,
          plan.distance,
        )} ${formatSimpleSelector(plan.neighbor)}`,
      ];
    case "contextSibling":
      return [
        `${formatSimpleSelector(plan.context)} ${formatRelation(
          plan.relation,
          plan.distance,
        )} ${formatSimpleSelector(plan.target)}`,
      ];
    case "matchesChain":
      return [formatSimpleSelector(plan.context), formatSimpleSelector(plan.target)];
    case "ancestorDescendant":
      return [
        `${formatSimpleSelector(plan.ancestor)} ${formatSimpleSelector(
          plan.descendant,
        )}`,
      ];
  }
}

export function createRuleDraft(
  plan: SelectorPlan,
  ruleSettings: RuleSettings,
  name?: string,
): RuleDraft {
  const matches = serializePlan(plan);
  const rule: RuleDraft = {
    key: 0,
    matches,
  };

  if (name) {
    rule.name = name;
  }

  const activityIds = ruleSettings.activityIds.trim();
  if (activityIds) {
    rule.activityIds = activityIds;
  }

  if (isFastQueryFriendlyPlan(plan)) {
    rule.fastQuery = true;
  }

  if (ruleSettings.matchTime !== null) {
    rule.matchTime = ruleSettings.matchTime;
  }

  if (ruleSettings.actionMaximum !== null) {
    rule.actionMaximum = ruleSettings.actionMaximum;
  }

  if (ruleSettings.actionCd !== null) {
    rule.actionCd = ruleSettings.actionCd;
  }

  if (ruleSettings.resetMatch) {
    rule.resetMatch = ruleSettings.resetMatch;
  }

  return rule;
}

export function formatSimpleSelector(selector: SimpleSelector): string {
  const prefix = `${selector.at ? "@" : ""}${selector.typeName ?? ""}`;
  return `${prefix}${selector.conditions.map(formatCondition).join("")}`;
}

export function exactSelector(
  attr: "id" | "vid" | "text" | "desc",
  value: string,
  typeName?: string,
): SimpleSelector {
  return {
    typeName,
    conditions: [
      {
        attr,
        op: "eq",
        value,
      },
    ],
  };
}

export function clickableSelector(at = false): SimpleSelector {
  return {
    at,
    conditions: [
      {
        attr: "clickable",
        op: "eq",
        value: true,
      },
    ],
  };
}

export function firstFastQueryAttr(selector: SimpleSelector): boolean {
  const first = selector.conditions[0];
  if (!first) return false;
  return (
    first.attr === "id" ||
    first.attr === "vid" ||
    first.attr === "text"
  );
}

function isFastQueryFriendlyPlan(plan: SelectorPlan): boolean {
  switch (plan.kind) {
    case "simple":
      return firstFastQueryAttr(plan.selector);
    case "parentChild":
      return firstFastQueryAttr(plan.child);
    case "sibling":
      return firstFastQueryAttr(plan.target);
    case "contextSibling":
      return firstFastQueryAttr(plan.target);
    case "matchesChain":
      return firstFastQueryAttr(plan.target);
    case "ancestorDescendant":
      return false;
  }
}

function formatRelation(
  relation: "next" | "previous",
  distance: number | number[] | "n",
): string {
  const symbol = relation === "next" ? "+" : "-";
  if (distance === "n") {
    // 教程 §5.3.2.3.2 简写：+(n) 可以省略括号 → +n。
    return `${symbol}n`;
  }
  if (Array.isArray(distance)) {
    // 教程 §5.3.2.3.1 元组表达式：+(1,2,3)。
    // 单元素元组 (1) 等价于普通 +1，但保留括号更清楚。
    return `${symbol}(${distance.join(",")})`;
  }
  return distance === 1 ? symbol : `${symbol}${distance}`;
}

function formatCondition(condition: SelectorCondition): string {
  switch (condition.op) {
    case "eq":
      if (typeof condition.value === "boolean") {
        return `[${condition.attr}=${condition.value ? "true" : "false"}]`;
      }
      return `[${condition.attr}="${escapeSelectorString(String(condition.value))}"]`;
    case "notEq":
      return `[${condition.attr}!="${escapeSelectorString(String(condition.value))}"]`;
    case "contains":
      return `[${condition.attr}*="${escapeSelectorString(String(condition.value))}"]`;
    case "startsWith":
      return `[${condition.attr}^="${escapeSelectorString(String(condition.value))}"]`;
    case "notStartsWith":
      return `[${condition.attr}!^="${escapeSelectorString(String(condition.value))}"]`;
    case "endsWith":
      return `[${condition.attr}$="${escapeSelectorString(String(condition.value))}"]`;
    case "notEndsWith":
      return `[${condition.attr}!$="${escapeSelectorString(String(condition.value))}"]`;
    case "lt":
      return `[${condition.attr}<${condition.value}]`;
    case "lte":
      return `[${condition.attr}<=${condition.value}]`;
    case "gt":
      return `[${condition.attr}>${condition.value}]`;
    case "gte":
      return `[${condition.attr}>=${condition.value}]`;
    case "orEq":
      // 教程研究报告 logicalOrVariantUnion：[text="否" || text="暂不"]
      // 用于版本差异/简繁差异/同义否定词合并。
      if (!Array.isArray(condition.value) || condition.value.length === 0) {
        return "";
      }
      return `[${condition.value
        .map((v) => `${condition.attr}="${escapeSelectorString(String(v))}"`)
        .join(" || ")}]`;
  }
}

function escapeSelectorString(value: string): string {
  return (
    value
      // 反斜杠必须最先转义，否则会把后面插入的转义序列再转义一遍。
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      // 控制字符在 selector 字符串字面量里非法（库会报 "Expect no control character"），
      // 必须写成反斜杠转义序列；实测库会把 \n/\r/\t 还原成真实字符参与匹配。
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      // 其余 C0 控制字符与 DEL 没有对应转义序列，直接剔除。
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  );
}
