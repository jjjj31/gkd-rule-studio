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

function formatRelation(relation: "next" | "previous", distance: number): string {
  const symbol = relation === "next" ? "+" : "-";
  return distance === 1 ? symbol : `${symbol}${distance}`;
}

function formatCondition(condition: SelectorCondition): string {
  switch (condition.op) {
    case "eq":
      if (typeof condition.value === "boolean") {
        return `[${condition.attr}=${condition.value ? "true" : "false"}]`;
      }
      return `[${condition.attr}="${escapeSelectorString(String(condition.value))}"]`;
    case "contains":
      return `[${condition.attr}*="${escapeSelectorString(String(condition.value))}"]`;
    case "startsWith":
      return `[${condition.attr}^="${escapeSelectorString(String(condition.value))}"]`;
    case "lt":
      return `[${condition.attr}<${condition.value}]`;
    case "lte":
      return `[${condition.attr}<=${condition.value}]`;
  }
}

function escapeSelectorString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
