import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { AppRuleDraft, SelectorValidation } from "../types/ruleDraft";
import { RULE_ACTION_NAMES } from "../data/ruleSettings";

export function describeRulePreview(
  app: AppRuleDraft,
  snapshot: ParsedGkdSnapshot,
  validation: SelectorValidation,
) {
  const unknowns = new Set<string>();
  const summaries = app.groups.flatMap((group) => group.rules.map((rule) => {
    const effective = { ...group, ...rule };
    const parts = [RULE_ACTION_NAMES[effective.action ?? "click"] ?? `动作：${effective.action}`];
    const activities = typeof effective.activityIds === "string"
      ? [effective.activityIds] : effective.activityIds ?? [];
    parts.push(activities.length ? `页面：${activities.join("、")}` : "应用内所有页面");
    const excludedActivities = typeof effective.excludeActivityIds === "string"
      ? [effective.excludeActivityIds] : effective.excludeActivityIds ?? [];
    if (excludedActivities.length) parts.push(`排除页面：${excludedActivities.join("、")}`);
    if (effective.matchTime !== undefined) {
      const reset = effective.resetMatch ?? "activity";
      const origin = reset === "app" ? "重新进入应用" : reset === "match"
        ? "从不匹配切到匹配" : "Activity 刷新";
      parts.push(`${origin}后 ${effective.matchTime / 1000} 秒内`);
      unknowns.add("匹配时间窗口是否仍有效，需要设备运行状态确认。");
    }
    if (effective.actionMaximum !== undefined) {
      parts.push(`最多 ${effective.actionMaximum} 次`);
      unknowns.add("剩余执行次数需要设备运行状态确认。");
    }
    if (effective.actionCd !== undefined) {
      parts.push(`间隔至少 ${effective.actionCd / 1000} 秒`);
      unknowns.add("当前冷却状态需要设备运行状态确认。");
    }
    if (effective.actionDelay !== undefined) parts.push(`延迟 ${effective.actionDelay / 1000} 秒`);
    if (effective.preKeys?.length) unknowns.add("前置步骤是否执行，需要设备日志或实际测试确认。");
    if (!effective.matchRoot) unknowns.add("当前按快照全树验证；设备的事件节点查询范围尚未确认。");
    return parts.join("；");
  }));
  const stamp = typeof snapshot.id === "number" && snapshot.id > 1e11
    ? new Date(snapshot.id).toLocaleString("zh-CN") : `#${snapshot.id}（采集时间未知）`;
  return {
    snapshotLabel: `快照 ${stamp} · ${snapshot.activityId ?? "Activity 未知"}`,
    status: validation.status === "invalid" || validation.unparsedMatches?.length
      ? "规则解析或身份检查失败，未完整验证"
      : validation.status === "partial" ? "当前快照未完整验证"
      : validation.status === "unsatisfied" ? "当前快照不满足规则条件"
      : `当前快照命中 ${validation.hitCount} 个点击目标`,
    diagnostics: validation.diagnostics ?? [],
    targetLabel: validation.clickNodes.length
      ? `当前目标：${[...new Set(validation.clickNodes.slice(0, 3).map((node) =>
        node.attr.text || node.attr.desc || node.attr.vid || node.attr.id || `节点 #${node.id}`,
      ))].join("、")}${validation.clickNodes.length > 3 ? "等" : ""}`
      : "当前没有已确认的点击目标",
    summaries,
    unknowns: [...unknowns],
  };
}
