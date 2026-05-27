import JSON5 from "json5";
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type {
  AppRuleDraft,
  RuleDraft,
  RuleGenerationPlan,
  SelectorCandidate,
} from "../types/ruleDraft";

export function createAppRuleDraft(
  snapshot: ParsedGkdSnapshot,
  candidate: SelectorCandidate,
  fallbackCandidates: SelectorCandidate[] = [],
): AppRuleDraft {
  const draftCandidates = selectDraftCandidates(candidate, fallbackCandidates);
  const primaryCandidate = draftCandidates[0] ?? candidate;
  const { groupFields, rule } = splitGroupFields(primaryCandidate.rule);
  const fallbackRules = draftCandidates.slice(1).map(
    (fallbackCandidate) => {
      return splitGroupFields(fallbackCandidate.rule).rule;
    },
  );

  return {
    id: snapshot.appId,
    name: snapshot.appInfo?.name ?? snapshot.appId,
    groups: [
      {
        key: 0,
        name: groupNameForDraft(primaryCandidate),
        ...groupFields,
        rules: [
          {
            ...rule,
            key: 0,
          },
          ...fallbackRules.map((fallbackRule, index) => ({
            ...fallbackRule,
            key: index + 1,
          })),
        ],
      },
    ],
  };
}

export function selectFallbackCandidates(
  primary: SelectorCandidate,
  candidates: SelectorCandidate[],
): SelectorCandidate[] {
  const seen = new Set([primary.rule.matches.join("\n")]);
  const fallbackStrategies: SelectorCandidate["strategyName"][] =
    primary.strategyName === "adContainerSkipFallback"
      ? []
      : ["adContainerSkipFallback"];

  return candidates.filter((candidate) => {
    if (!fallbackStrategies.includes(candidate.strategyName)) return false;
    const key = candidate.rule.matches.join("\n");
    if (seen.has(key)) return false;
    seen.add(key);
    return candidate.validation.hitCount > 0 && candidate.risk.finalScore >= 70;
  });
}

function selectDraftCandidates(
  primary: SelectorCandidate,
  candidates: SelectorCandidate[],
): SelectorCandidate[] {
  const fallbackCandidates = selectFallbackCandidates(primary, candidates);
  const promoted = findWebViewActionCandidate(primary, fallbackCandidates);

  if (promoted) {
    return [promoted];
  }

  return [primary, ...fallbackCandidates];
}

function findWebViewActionCandidate(
  primary: SelectorCandidate,
  candidates: SelectorCandidate[],
): SelectorCandidate | null {
  if (primary.strategyName === "adContainerSkipFallback") return null;
  if (primary.strategyName !== "stableResourceSemantic") return null;

  return (
    candidates.find((candidate) => {
      return (
        candidate.strategyName === "adContainerSkipFallback" &&
        candidate.actionPlan.action === "clickCenter" &&
        candidate.actionPlan.actionDelay !== undefined &&
        candidate.actionPlan.matchRoot === true
      );
    }) ?? null
  );
}

export function createRuleGenerationPlan(
  candidates: SelectorCandidate[],
): RuleGenerationPlan {
  const preferredSelector = candidates[0] ?? null;
  const fallbackPlan = preferredSelector
    ? selectFallbackCandidates(preferredSelector, candidates)
    : [];

  return {
    selectorCandidates: candidates,
    preferredSelector,
    actionPlan: preferredSelector?.actionPlan ?? null,
    fallbackPlan,
    riskNotes: preferredSelector?.riskNotes ?? [],
    debugAdvice: preferredSelector?.debugAdvice ?? [],
  };
}

export function stringifyRuleDraft(draft: AppRuleDraft): string {
  return JSON5.stringify(compactSingletonMatches(draft), null, 2);
}

export function compactSingletonMatches<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => compactSingletonMatches(item)) as T;
  }

  if (!value || typeof value !== "object") return value;

  const entries = Object.entries(value).map(([key, item]) => {
    if (
      key === "matches" &&
      Array.isArray(item) &&
      item.length === 1 &&
      typeof item[0] === "string"
    ) {
      return [key, item[0]];
    }
    return [key, compactSingletonMatches(item)];
  });

  return Object.fromEntries(entries) as T;
}

function splitGroupFields(rule: RuleDraft): {
  groupFields: Omit<AppRuleDraft["groups"][number], "key" | "name" | "rules">;
  rule: RuleDraft;
} {
  const {
    matchTime,
    actionMaximum,
    actionCd,
    forcedTime,
    matchRoot,
    resetMatch,
    ...ruleFields
  } = rule;

  return {
    groupFields: removeUndefined({
      matchTime,
      actionMaximum,
      actionCd,
      forcedTime,
      matchRoot,
      resetMatch,
    }),
    rule: ruleFields,
  };
}

function groupNameForDraft(candidate: SelectorCandidate): string {
  if (
    candidate.strategyName === "adContainerSkipFallback" &&
    candidate.groupName === "开屏广告"
  ) {
    return "全屏广告";
  }

  return candidate.groupName;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
