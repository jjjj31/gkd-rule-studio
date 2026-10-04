import type { SelectorCandidate } from "../types/ruleDraft";

/**
 * 候选去重 key。
 *
 * 必须包含 selector 之外的"动作/作用域"信息：同一个 selector 配不同 action、
 * activityIds 或动作参数，是两条不同的规则。只按 `matches` 去重会把它们误删，
 * 导致用户少看到一条真正不同的候选。
 */
export function candidateDedupeKey(candidate: SelectorCandidate): string {
  const { rule, actionPlan } = candidate;
  return JSON.stringify({
    matches: rule.matches,
    activityIds: rule.activityIds ?? null,
    action: actionPlan.action ?? null,
    actionDelay: actionPlan.actionDelay ?? null,
    actionMaximum: actionPlan.actionMaximum ?? null,
    actionCd: actionPlan.actionCd ?? null,
    matchRoot: actionPlan.matchRoot ?? null,
  });
}
