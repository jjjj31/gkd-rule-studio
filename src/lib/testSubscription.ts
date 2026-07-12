/**
 * GKD 订阅导入模块。
 * 管理"测试用的内存订阅"和"已导入 selector 的跟踪"。
 * 与 deviceApi.updateSubscription / appendLocalRules 配合完成规则导入。
 * 与 inlineRuleTesting 配合：后者构建活跃测试集，本模块输出 payload。
 */
import JSON5 from "json5";
import type { AppRuleDraft, RuleDraft } from "../types/ruleDraft";

export interface RawSubscriptionDraft {
  id: number;
  name: string;
  version: number;
  author: string;
  apps: AppRuleDraft[];
}

export interface TestSubscriptionDraft {
  apps: AppRuleDraft[];
  dirty: boolean;
  lastImportedAt?: number;
  lastImportedSummary?: TestSubscriptionSummary;
  importedSelectors: string[];
  importedRules: ImportedRuleRecord[];
}

export interface TestSubscriptionSummary {
  appCount: number;
  groupCount: number;
  ruleCount: number;
}

export interface ImportedRuleRecord {
  id: string;
  importedAt: number;
  appId: string;
  appName: string;
  groupName: string;
  ruleName: string;
  activityIds?: string | string[];
  matches: string[];
}

export interface AppIdentity {
  id: string;
  name: string;
}

/** 初始空测试订阅。每次新建状态时调用。 */
export function createEmptyTestSubscription(): TestSubscriptionDraft {
  return {
    apps: [],
    dirty: false,
    importedSelectors: [],
    importedRules: [],
  };
}

/**
 * 把一条 AppRuleDraft（单候选或 AI 候选产生的）添加到测试订阅里。
 * 同一个 appId 会合并 group，同名 selector 不会重复追加。
 */
export function addAppDraftToTestSubscription(
  draft: TestSubscriptionDraft,
  appDraft: AppRuleDraft,
): TestSubscriptionDraft {
  let next: TestSubscriptionDraft = {
    ...draft,
    apps: draft.apps.map(cloneAppDraft),
    dirty: true,
  };

  for (const group of appDraft.groups) {
    next = addGroupToTestSubscription(next, appDraft, group);
  }

  return next;
}

/** 把用户粘贴的 JSON5 字符串解析后导入测试订阅。外部 AI 返回的规则文本走这里。 */
export function importJson5ToTestSubscription(
  draft: TestSubscriptionDraft,
  source: string,
  fallbackApp?: AppIdentity,
): TestSubscriptionDraft {
  const parsed = JSON5.parse(source) as unknown;
  const apps = normalizeImportValue(parsed, fallbackApp);

  return apps.reduce(
    (current, app) => addAppDraftToTestSubscription(current, app),
    draft,
  );
}

/** 输出完整的 GKD 兼容 HTTP 订阅 payload，用于 deviceApi.updateSubscription。 */
export function exportRawSubscription(
  draft: TestSubscriptionDraft,
): RawSubscriptionDraft {
  return removeUndefinedDeep({
    id: 0,
    name: "GKD Rule Studio 测试订阅",
    version: 1,
    author: "local",
    apps: draft.apps.map(cloneAppDraft),
  }) as RawSubscriptionDraft;
}

export function markTestSubscriptionImported(
  draft: TestSubscriptionDraft,
  importedAt = Date.now(),
): TestSubscriptionDraft {
  return {
    ...draft,
    dirty: false,
    lastImportedAt: importedAt,
    lastImportedSummary: summarizeTestSubscription(draft),
  };
}

export function markImportedAndClearBuffer(
  draft: TestSubscriptionDraft,
  importedAt = Date.now(),
): TestSubscriptionDraft {
  const selectors = new Set(draft.importedSelectors);
  const ruleRecords = new Map(
    (draft.importedRules ?? []).map((rule) => [rule.id, rule]),
  );
  collectRuleSelectors(draft).forEach((selector) => selectors.add(selector));
  collectImportedRuleRecords(draft, importedAt).forEach((rule) => {
    ruleRecords.set(rule.id, rule);
  });
  const lastImportedSummary = summarizeTestSubscription(draft);

  return {
    apps: [],
    dirty: false,
    lastImportedAt: importedAt,
    lastImportedSummary,
    importedSelectors: [...selectors],
    importedRules: [...ruleRecords.values()],
  };
}

export function wasSelectorImported(
  draft: TestSubscriptionDraft,
  matches: string[],
): boolean {
  return draft.importedSelectors.includes(selectorKey(matches));
}

export function removeImportedRule(
  draft: TestSubscriptionDraft,
  importedRuleId: string,
): TestSubscriptionDraft {
  const importedRules = (draft.importedRules ?? []).filter(
    (rule) => rule.id !== importedRuleId,
  );

  return {
    ...draft,
    importedRules,
    importedSelectors: importedRules.map((rule) => selectorKey(rule.matches)),
    lastImportedSummary: importedRules.length
      ? summarizeImportedRules(importedRules)
      : undefined,
    lastImportedAt: importedRules.length ? draft.lastImportedAt : undefined,
  };
}

export function clearImportedRules(draft: TestSubscriptionDraft): TestSubscriptionDraft {
  return {
    ...draft,
    importedRules: [],
    importedSelectors: [],
    lastImportedAt: undefined,
    lastImportedSummary: undefined,
  };
}

export function summarizeTestSubscription(
  draft: TestSubscriptionDraft,
): TestSubscriptionSummary {
  return {
    appCount: draft.apps.length,
    groupCount: draft.apps.reduce((sum, app) => sum + app.groups.length, 0),
    ruleCount: draft.apps.reduce(
      (sum, app) =>
        sum + app.groups.reduce((groupSum, group) => groupSum + group.rules.length, 0),
      0,
    ),
  };
}

function addGroupToTestSubscription(
  draft: TestSubscriptionDraft,
  sourceApp: AppRuleDraft,
  sourceGroup: AppRuleDraft["groups"][number],
): TestSubscriptionDraft {
  const apps = draft.apps.map(cloneAppDraft);
  let app = apps.find((item) => item.id === sourceApp.id);

  if (!app) {
    app = {
      id: sourceApp.id,
      name: sourceApp.name,
      groups: [],
    };
    apps.push(app);
  }

  let group = app.groups.find(
    (item) => item.name === sourceGroup.name || item.key === sourceGroup.key,
  );

  if (!group) {
    group = {
      ...stripRules(sourceGroup),
      key: nextGroupKey(app),
      rules: [],
    };
    app.groups.push(group);
  }

  for (const rule of sourceGroup.rules) {
    if (group.rules.some((item) => sameRuleSelector(item, rule))) continue;
    const cleanRule = removeUndefinedDeep(rule) as RuleDraft;
    group.rules.push({
      ...cleanRule,
      key: nextRuleKey(group),
      matches: normalizeMatches(rule.matches),
    });
  }

  return {
    ...draft,
    apps,
    dirty: true,
  };
}

function normalizeImportValue(
  value: unknown,
  fallbackApp?: AppIdentity,
): AppRuleDraft[] {
  if (!isRecord(value)) {
    throw new Error("AI 返回内容必须是对象形式");
  }

  if (Array.isArray(value.apps)) {
    return value.apps.map(normalizeAppDraft);
  }

  if (typeof value.id === "string" && Array.isArray(value.groups)) {
    return [normalizeAppDraft(value)];
  }

  if (Array.isArray(value.rules)) {
    if (!fallbackApp) {
      throw new Error("导入单个 group 时需要当前快照 app 信息");
    }
    return [
      normalizeAppDraft({
        id: fallbackApp.id,
        name: fallbackApp.name,
        groups: [value],
      }),
    ];
  }

  throw new Error("无法识别 JSON5：请粘贴完整订阅、应用规则或单个 group");
}

function normalizeAppDraft(value: unknown): AppRuleDraft {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("应用规则缺少 id");
  }
  if (!Array.isArray(value.groups)) {
    throw new Error("应用规则缺少 groups");
  }

  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
    groups: value.groups.map(normalizeGroupDraft),
  };
}

function normalizeGroupDraft(
  value: unknown,
): AppRuleDraft["groups"][number] {
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    throw new Error("规则组缺少 rules");
  }

  const key = typeof value.key === "number" ? value.key : 0;
  const name = typeof value.name === "string" ? value.name : "测试规则";

  return removeUndefinedDeep({
    ...value,
    key,
    name,
    rules: value.rules.map(normalizeRuleDraft),
  }) as AppRuleDraft["groups"][number];
}

function normalizeRuleDraft(value: unknown): RuleDraft {
  if (!isRecord(value)) {
    throw new Error("规则必须是对象");
  }

  return removeUndefinedDeep({
    ...value,
    key: typeof value.key === "number" ? value.key : 0,
    matches: normalizeMatches(value.matches),
  }) as RuleDraft;
}

function normalizeMatches(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...value];
  }
  throw new Error("规则缺少 matches");
}

function sameRuleSelector(a: RuleDraft, b: RuleDraft): boolean {
  return selectorKey(normalizeMatches(a.matches)) === selectorKey(normalizeMatches(b.matches));
}

function collectRuleSelectors(draft: TestSubscriptionDraft): string[] {
  return draft.apps.flatMap((app) =>
    app.groups.flatMap((group) =>
      group.rules.map((rule) => selectorKey(normalizeMatches(rule.matches))),
    ),
  );
}

function collectImportedRuleRecords(
  draft: TestSubscriptionDraft,
  importedAt: number,
): ImportedRuleRecord[] {
  return draft.apps.flatMap((app) =>
    app.groups.flatMap((group) =>
      group.rules.map((rule) => {
        const matches = normalizeMatches(rule.matches);
        return {
          id: [app.id, group.key, rule.key, selectorKey(matches)].join("|"),
          importedAt,
          appId: app.id,
          appName: app.name,
          groupName: group.name,
          ruleName: rule.name ?? `规则 ${rule.key}`,
          activityIds: rule.activityIds,
          matches,
        };
      }),
    ),
  );
}

function summarizeImportedRules(
  rules: ImportedRuleRecord[],
): TestSubscriptionSummary {
  const apps = new Set(rules.map((rule) => rule.appId));
  const groups = new Set(rules.map((rule) => `${rule.appId}\n${rule.groupName}`));
  return {
    appCount: apps.size,
    groupCount: groups.size,
    ruleCount: rules.length,
  };
}

function selectorKey(matches: string[]): string {
  return matches.join("\n");
}

function stripRules(
  group: AppRuleDraft["groups"][number],
): Omit<AppRuleDraft["groups"][number], "rules"> {
  const { rules: _rules, ...rest } = group;
  return removeUndefinedDeep(rest) as Omit<AppRuleDraft["groups"][number], "rules">;
}

function nextGroupKey(app: AppRuleDraft): number {
  const keys = app.groups.map((group) => group.key);
  return keys.length === 0 ? 0 : Math.max(...keys) + 1;
}

function nextRuleKey(group: AppRuleDraft["groups"][number]): number {
  const keys = group.rules.map((rule) => rule.key);
  return keys.length === 0 ? 0 : Math.max(...keys) + 1;
}

function cloneAppDraft(app: AppRuleDraft): AppRuleDraft {
  return removeUndefinedDeep(app) as AppRuleDraft;
}

function removeUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }

  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, removeUndefinedDeep(item)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
