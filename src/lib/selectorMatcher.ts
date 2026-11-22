/**
 * GKD selector 反向匹配入口。单个选择器交给官方
 * `@gkd-kit/selector`；本文件只组合规则层语义。
 */
import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type {
  AppRuleDraft,
  RuleDraft,
  SelectorPlan,
  SelectorValidation,
} from "../types/ruleDraft";
import type { AiRuleCandidate } from "./aiModel";
import { matchGkdSelectorString } from "./selectorAdapter";
import { serializePlan } from "./selectorSerialize";

export type SelectorFailureReason =
  | "disabled"
  | "activity_mismatch"
  | "excluded"
  | "any_matches_miss"
  | "context_miss"
  | "target_miss"
  | "invalid"
  | "partial";

declare module "../types/ruleDraft" {
  interface SelectorValidation {
    failureReason?: SelectorFailureReason;
  }
}

function resolveNodes(
  snapshot: ParsedGkdSnapshot,
  ids: Iterable<number>,
): NormalizedSnapshotNode[] {
  const out: NormalizedSnapshotNode[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    const node = snapshot.nodeById.get(id);
    if (node && !seen.has(id)) {
      seen.add(id);
      out.push(node);
    }
  }
  return out;
}

function uniqueNodes(nodes: NormalizedSnapshotNode[]): NormalizedSnapshotNode[] {
  const seen = new Set<number>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function emptyValidation(
  status: SelectorValidation["status"],
  reason: string,
  failureReason?: SelectorFailureReason,
): SelectorValidation {
  return {
    hitCount: 0,
    clickNodes: [],
    supportNodes: [],
    status,
    ...(failureReason ? { failureReason } : {}),
    diagnostics: [reason],
  };
}

/**
 * 验证完整 AppRuleDraft 中的每条规则，按 group/rule 声明顺序返回结果。
 * 静态结果只描述当前快照，不表示运行次数、冷却或设备测试有效。
 */
export function validateAppRuleAgainstSnapshot(
  snapshot: ParsedGkdSnapshot,
  app: AppRuleDraft,
): SelectorValidation[] {
  if (app.groups.flatMap((group) => group.rules).length === 0) {
    return [emptyValidation("invalid", "App 规则不包含任何规则", "invalid")];
  }
  if (app.id !== snapshot.appId) {
    const results = app.groups.flatMap((group) =>
      group.rules.map(() =>
        emptyValidation(
          "invalid",
          `appId 不匹配：规则为 ${app.id}，快照为 ${snapshot.appId}`,
          "invalid",
        ),
      ),
    );
    return results.length > 0
      ? results
      : [emptyValidation("invalid", "App 规则不包含任何规则", "invalid")];
  }

  return app.groups.flatMap((group) =>
    group.rules.map((rule) => validateRule(snapshot, group, rule)),
  );
}

export function validateSelectorPlan(
  snapshot: ParsedGkdSnapshot,
  plan: SelectorPlan,
): SelectorValidation {
  // serializePlan 的 matchesChain 产出两条规则级 matches；不是两段可独立 union 的规则。
  return validateAppRuleAgainstSnapshot(snapshot, {
    id: snapshot.appId,
    name: snapshot.appInfo?.name ?? snapshot.appId,
    groups: [{ key: 0, name: "selector", rules: [{ key: 0, matches: serializePlan(plan) }] }],
  })[0];
}

/**
 * 兼容旧 AI 候选入口。一个候选含多条规则时汇总为一份结果；
 * 需要逐规则状态的新调用方使用 validateAppRuleAgainstSnapshot。
 */
export function validateAiCandidateAgainstSnapshot(
  candidate: AiRuleCandidate,
  snapshot: ParsedGkdSnapshot,
): SelectorValidation {
  const results =
    candidate.app.id === snapshot.appId
      ? validateAppRuleAgainstSnapshot(snapshot, candidate.app)
      : [emptyValidation(
          "invalid",
          `appId 不匹配：规则为 ${candidate.app.id}，快照为 ${snapshot.appId}`,
          "invalid",
        )];
  const invalid = results.some((result) => result.status === "invalid");
  const partial = results.some((result) => result.status === "partial");
  // App 中的每条规则是独立可执行规则；规则之间按“任一命中”聚合。
  // 单条规则内部的 matches 仍由 validateRule 按 AND 验证。
  const satisfiedResults = results.filter((result) => result.status === "satisfied");
  const canExecute = satisfiedResults.length > 0;
  const clickNodes = canExecute
    ? uniqueNodes(
        (invalid || partial ? [] : satisfiedResults).flatMap(
          (result) => result.clickNodes,
        ),
      )
    : [];
  const diagnostics = results.flatMap((result) => result.diagnostics ?? []);
  const unparsedMatches = results.flatMap((result) => result.unparsedMatches ?? []);
  const status: SelectorValidation["status"] = invalid
    ? "invalid"
    : partial
      ? "partial"
      : canExecute
        ? "satisfied"
        : "unsatisfied";
  const failureReason: SelectorFailureReason | undefined =
    status === "invalid"
      ? "invalid"
      : status === "partial"
        ? "partial"
        : status === "unsatisfied"
          ? results.find((result) => result.failureReason)?.failureReason
          : undefined;
  return {
    hitCount: clickNodes.length,
    clickNodes,
    supportNodes: uniqueNodes(satisfiedResults.flatMap((result) => result.supportNodes)),
    status,
    ...(failureReason ? { failureReason } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(unparsedMatches.length > 0 ? { unparsedMatches } : {}),
  };
}

function validateRule(
  snapshot: ParsedGkdSnapshot,
  group: AppRuleDraft["groups"][number],
  rule: RuleDraft,
): SelectorValidation {
  if (group.enable === false || rule.enable === false) {
    return emptyValidation(
      "unsatisfied",
      "规则或规则组 enable=false，已明确禁用",
      "disabled",
    );
  }
  if (group.enable !== undefined && typeof group.enable !== "boolean") {
    return emptyValidation("partial", "规则组 enable 字段类型无法验证，保留原值", "partial");
  }
  if (rule.enable !== undefined && typeof rule.enable !== "boolean") {
    return emptyValidation("partial", "规则 enable 字段类型无法验证，保留原值", "partial");
  }
  const excludeActivityIds =
    rule.excludeActivityIds === undefined
      ? group.excludeActivityIds
      : rule.excludeActivityIds;
  if (
    excludeActivityIds !== undefined &&
    !(Array.isArray(excludeActivityIds) && excludeActivityIds.length === 0) &&
    activityMatches(snapshot, excludeActivityIds)
  ) {
    return emptyValidation(
      "unsatisfied",
      `当前 Activity 被排除：${snapshot.activityId ?? "未知"}`,
      "activity_mismatch",
    );
  }
  const activityIds = rule.activityIds === undefined ? group.activityIds : rule.activityIds;
  if (
    activityIds !== undefined &&
    !(Array.isArray(activityIds) && activityIds.length === 0) &&
    !activityMatches(snapshot, activityIds)
  ) {
    return emptyValidation(
      "unsatisfied",
      `当前 Activity 不匹配：${snapshot.activityId ?? "未知"}`,
      "activity_mismatch",
    );
  }

  if (hasUnsupportedScopeField(group, rule)) {
    return emptyValidation(
      "partial",
      "规则包含当前版本范围条件，静态快照验证不完整",
      "partial",
    );
  }

  const excluded: string[] = [];
  const unparsed: string[] = [];
  for (const expr of rule.excludeMatches ?? []) {
    const result = matchGkdSelectorString(snapshot, expr);
    if (result.unparsed) unparsed.push(expr);
    else if (result.clickIds.length > 0) excluded.push(expr);
  }

  const excludeAll = rule.excludeAllMatches ?? [];
  const allResults = excludeAll.map((expr) => matchGkdSelectorString(snapshot, expr));
  allResults.forEach((result, index) => {
    if (result.unparsed) unparsed.push(excludeAll[index]);
  });
  if (allResults.length > 0 && allResults.every((result) => result.clickIds.length > 0)) {
    excluded.push(...excludeAll);
  }

  if (excluded.length > 0) {
    return {
      ...emptyValidation(
        "unsatisfied",
        `规则被排除条件否决：${excluded.join(" || ")}`,
        "excluded",
      ),
      excludedMatches: excluded,
      ...(unparsed.length > 0 ? { unparsedMatches: unparsed } : {}),
    };
  }
  if (unparsed.length > 0) {
    return {
      ...emptyValidation(
        "partial",
        `排除条件不可完整验证：${unparsed.join("；")}`,
        "partial",
      ),
      unparsedMatches: unparsed,
    };
  }

  const matches = rule.matches ?? [];
  const anyMatches = rule.anyMatches ?? [];

  if (matches.length === 0 && anyMatches.length === 0) {
    return emptyValidation("invalid", "规则缺少 matches 和 anyMatches", "invalid");
  }

  let anySupportIds: number[] = [];
  if (anyMatches.length > 0) {
    const anyResults = anyMatches.map((expr) => matchGkdSelectorString(snapshot, expr));
    anySupportIds = anyResults.flatMap((result) => [
      ...result.clickIds,
      ...result.supportIds,
    ]);
    anyResults.forEach((result, index) => {
      if (result.unparsed) unparsed.push(anyMatches[index]);
    });

    if (matches.length === 0) {
      if (unparsed.length > 0) {
        if (anyResults.every((result) => result.unparsed)) {
          return {
            ...emptyValidation(
              "invalid",
              `anyMatches 全部条件不可解析：${unparsed.join("；")}`,
              "invalid",
            ),
            unparsedMatches: unparsed,
          };
        }
        return {
          ...emptyValidation(
            "partial",
            `可选分支不可完整验证：${unparsed.join("；")}`,
            "partial",
          ),
          unparsedMatches: unparsed,
        };
      }

      const matchedBranches = anyResults.filter((result) => result.clickIds.length > 0);
      if (matchedBranches.length === 0) {
        return emptyValidation(
          "unsatisfied",
          "anyMatches 的所有分支均未命中",
          "any_matches_miss",
        );
      }

      const clickNodes = uniqueNodes(
        matchedBranches.flatMap((result) => resolveNodes(snapshot, result.clickIds)),
      );
      const supportNodes = uniqueNodes(
        matchedBranches.flatMap((result) => resolveNodes(snapshot, result.supportIds)),
      ).filter((node) => !clickNodes.some((target) => target.id === node.id));
      return {
        hitCount: clickNodes.length,
        clickNodes,
        supportNodes,
        status: "satisfied",
      };
    }

    if (
      unparsed.length === 0 &&
      anyResults.every((result) => result.clickIds.length === 0)
    ) {
      return emptyValidation(
        "unsatisfied",
        "anyMatches 的所有分支均未命中",
        "any_matches_miss",
      );
    }
    // 合法分支可命中时也无法确认未解析分支，因此保留后续结果并标记为部分验证。
  }

  const results = matches.map((expr) => matchGkdSelectorString(snapshot, expr));
  const matchesUnparsed = results.flatMap((result, index) =>
    result.unparsed ? [matches[index]] : [],
  );
  if (matchesUnparsed.length > 0) {
    return {
      ...emptyValidation(
        "invalid",
        `必需条件不可解析：${matchesUnparsed.join("；")}`,
        "invalid",
      ),
      unparsedMatches: [...unparsed, ...matchesUnparsed],
    };
  }
  if (unparsed.length > 0) {
    return {
      ...emptyValidation(
        "partial",
        `可选分支不可完整验证：${unparsed.join("；")}`,
        "partial",
      ),
      unparsedMatches: unparsed,
    };
  }

  const last = results[results.length - 1];
  const missing = matches
    .slice(0, -1)
    .filter((_, index) => results[index].clickIds.length === 0);
  if (missing.length > 0 || last.clickIds.length === 0) {
    const isContextMiss = missing.length > 0;
    const reason = isContextMiss
      ? `必需上下文未命中：${missing.join("；")}`
      : "末项点击目标未命中";
    return {
      ...emptyValidation(
        "unsatisfied",
        reason,
        isContextMiss ? "context_miss" : "target_miss",
      ),
      supportNodes: uniqueNodes(
        results.slice(0, -1).flatMap((result) => resolveNodes(snapshot, result.clickIds)),
      ),
    };
  }

  const clickNodes = resolveNodes(snapshot, last.clickIds);
  const supportNodes = uniqueNodes([
    ...results.slice(0, -1).flatMap((result) => resolveNodes(snapshot, result.clickIds)),
    ...matches.flatMap((_, index) =>
      resolveNodes(snapshot, results[index].supportIds),
    ),
    ...resolveNodes(snapshot, anySupportIds),
  ]).filter((node) => !clickNodes.some((target) => target.id === node.id));
  return {
    hitCount: clickNodes.length,
    clickNodes,
    supportNodes,
    status: "satisfied",
  };
}

function activityMatches(
  snapshot: ParsedGkdSnapshot,
  value: string | string[],
): boolean {
  if (!snapshot.activityId) return false;
  const rawIds = Array.isArray(value) ? value : [value];
  if (rawIds.length === 0) return false;
  return rawIds.some((rawId) => {
    const trimmed = rawId.trim();
    if (!trimmed) return false;
    const normalizedId = trimmed.startsWith(".")
      ? `${snapshot.appId}${trimmed}`
      : trimmed;
    return snapshot.activityId === normalizedId;
  });
}

function hasUnsupportedScopeField(
  group: AppRuleDraft["groups"][number],
  rule: RuleDraft,
): boolean {
  const fields = [
    "versionCode",
    "versionName",
    "versionCodes",
    "versionNames",
    "excludeVersionCodes",
    "excludeVersionNames",
  ] as const;
  return [group, rule].some((scope) =>
    fields.some((key) => (scope as Record<string, unknown>)[key] !== undefined),
  );
}
