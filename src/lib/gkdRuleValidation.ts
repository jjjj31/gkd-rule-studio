/**
 * GKD 应用规则的运行时结构校验。
 *
 * TypeScript 类型只在编译期生效；AI 返回的是 JSON5，必须在进入测试区或发送到
 * GKD 前再做一次真实值校验，尤其要区分 matchRoot 这类布尔字段和 selector 字符串。
 */
import type { AppRuleDraft } from "../types/ruleDraft";
import { validateGkdSelectorSyntax } from "./selectorAdapter";

export type GkdRuleValidationCode =
  | "missing"
  | "type"
  | "value"
  | "selector-syntax"
  | "unknown-field";

export interface GkdRuleValidationIssue {
  path: string;
  message: string;
  code: GkdRuleValidationCode;
}

export interface GkdRuleValidationOptions {
  /** AI 输出使用严格模式：未知字段直接拒绝。导入外部订阅时允许保留未知字段。 */
  strict?: boolean;
  /** 是否调用本地 selector 解析器检查语法。 */
  validateSelectors?: boolean;
}

export interface GkdRuleValidationResult {
  valid: boolean;
  issues: GkdRuleValidationIssue[];
}

const APP_FIELDS = new Set(["id", "name", "groups"]);

const GROUP_FIELDS = new Set([
  "key",
  "name",
  "desc",
  "enable",
  "rules",
  "activityIds",
  "excludeActivityIds",
  "versionCode",
  "excludeVersionCodes",
  "versionCodes",
  "versionName",
  "excludeVersionNames",
  "versionNames",
  "actionCd",
  "cd",
  "actionDelay",
  "delay",
  "fastQuery",
  "matchRoot",
  "matchDelay",
  "matchTime",
  "actionMaximum",
  "resetMatch",
  "actionCdKey",
  "actionMaximumKey",
  "order",
  "forcedTime",
  "snapshotUrls",
  "excludeSnapshotUrls",
  "exampleUrls",
  "priorityTime",
  "priorityActionMaximum",
  "scopeKeys",
  "ignoreGlobalGroupMatch",
]);

const RULE_FIELDS = new Set([
  "key",
  "name",
  "preKeys",
  "action",
  "matches",
  "anyMatches",
  "excludeMatches",
  "excludeAllMatches",
  "activityIds",
  "excludeActivityIds",
  "enable",
  "fastQuery",
  "matchRoot",
  "actionDelay",
  "matchDelay",
  "matchTime",
  "actionMaximum",
  "actionCd",
  "cd",
  "delay",
  "forcedTime",
  "resetMatch",
  "versionCode",
  "versionCodes",
  "excludeVersionCodes",
  "versionName",
  "versionNames",
  "excludeVersionNames",
  "snapshotUrls",
  "excludeSnapshotUrls",
  "exampleUrls",
  "actionCdKey",
  "actionMaximumKey",
  "order",
  "priorityTime",
  "priorityActionMaximum",
  "position",
  "swipeArg",
]);

const ACTION_NAMES = new Set([
  "click",
  "clickNode",
  "clickCenter",
  "longClick",
  "longClickNode",
  "longClickCenter",
  "back",
  "swipe",
  "none",
]);

const RESET_MATCH_VALUES = new Set(["app", "activity", "match"]);
const SELECTOR_FIELDS = [
  "matches",
  "anyMatches",
  "excludeMatches",
  "excludeAllMatches",
] as const;

export function validateAppRuleDraft(
  value: unknown,
  options: GkdRuleValidationOptions = {},
): GkdRuleValidationResult {
  const issues: GkdRuleValidationIssue[] = [];
  const strict = options.strict === true;
  const validateSelectors = options.validateSelectors !== false;

  if (!isRecord(value)) {
    return invalid("app", "必须是对象", "type", issues);
  }

  checkKnownFields(value, "app", APP_FIELDS, strict, issues);
  requireNonEmptyString(value.id, "app.id", issues);
  checkOptionalString(value.name, "app.name", issues);

  if (!Array.isArray(value.groups)) {
    issue("app.groups", "必须是数组", "type", issues);
    return result(issues);
  }
  if (value.groups.length === 0) {
    issue("app.groups", "至少需要一个规则组", "value", issues);
  }
  value.groups.forEach((group, groupIndex) => {
    validateGroup(
      group,
      `app.groups[${groupIndex}]`,
      { strict, validateSelectors, issues },
    );
  });

  return result(issues);
}

export function formatGkdRuleValidationIssues(
  validation: GkdRuleValidationResult,
): string {
  return validation.issues
    .slice(0, 6)
    .map((item) => `${item.path}: ${item.message}`)
    .join("；");
}

export function assertValidAppRuleDraft(
  value: unknown,
  label = "规则",
  options: GkdRuleValidationOptions = {},
): asserts value is AppRuleDraft {
  const validation = validateAppRuleDraft(value, options);
  if (!validation.valid) {
    throw new Error(`${label}不合法：${formatGkdRuleValidationIssues(validation)}`);
  }
}

interface ValidationContext {
  strict: boolean;
  validateSelectors: boolean;
  issues: GkdRuleValidationIssue[];
}

function validateGroup(
  value: unknown,
  path: string,
  context: ValidationContext,
): void {
  if (!isRecord(value)) {
    issue(path, "必须是对象", "type", context.issues);
    return;
  }

  checkKnownFields(value, path, GROUP_FIELDS, context.strict, context.issues);
  requireInteger(value.key, `${path}.key`, context.issues);
  requireNonEmptyString(value.name, `${path}.name`, context.issues);
  checkOptionalString(value.desc, `${path}.desc`, context.issues);
  checkOptionalBoolean(value.enable, `${path}.enable`, context.issues);
  checkActivityIds(value.activityIds, `${path}.activityIds`, context.issues);
  checkActivityIds(
    value.excludeActivityIds,
    `${path}.excludeActivityIds`,
    context.issues,
  );
  checkOptionalNumber(value.matchTime, `${path}.matchTime`, context.issues);
  checkOptionalInteger(value.actionMaximum, `${path}.actionMaximum`, context.issues);
  checkOptionalInteger(value.actionCd, `${path}.actionCd`, context.issues);
  checkOptionalInteger(value.cd, `${path}.cd`, context.issues);
  checkOptionalInteger(value.actionDelay, `${path}.actionDelay`, context.issues);
  checkOptionalInteger(value.delay, `${path}.delay`, context.issues);
  checkOptionalNumber(value.matchDelay, `${path}.matchDelay`, context.issues);
  checkOptionalInteger(value.forcedTime, `${path}.forcedTime`, context.issues);
  checkOptionalBoolean(value.fastQuery, `${path}.fastQuery`, context.issues);
  checkOptionalBoolean(value.matchRoot, `${path}.matchRoot`, context.issues);
  checkOptionalBoolean(
    value.ignoreGlobalGroupMatch,
    `${path}.ignoreGlobalGroupMatch`,
    context.issues,
  );
  checkOptionalEnum(
    value.resetMatch,
    `${path}.resetMatch`,
    RESET_MATCH_VALUES,
    context.issues,
  );
  checkOptionalStringList(value.snapshotUrls, `${path}.snapshotUrls`, context.issues);
  checkOptionalStringList(
    value.excludeSnapshotUrls,
    `${path}.excludeSnapshotUrls`,
    context.issues,
  );
  checkOptionalStringList(value.exampleUrls, `${path}.exampleUrls`, context.issues);
  checkOptionalIntegerList(value.scopeKeys, `${path}.scopeKeys`, context.issues);
  checkOptionalVersionCode(value.versionCode, `${path}.versionCode`, context.issues);
  checkOptionalVersionCodes(value.versionCodes, `${path}.versionCodes`, context.issues);
  checkOptionalVersionCodes(
    value.excludeVersionCodes,
    `${path}.excludeVersionCodes`,
    context.issues,
  );
  checkOptionalVersionName(value.versionName, `${path}.versionName`, context.issues);
  checkOptionalVersionNames(value.versionNames, `${path}.versionNames`, context.issues);
  checkOptionalVersionNames(
    value.excludeVersionNames,
    `${path}.excludeVersionNames`,
    context.issues,
  );

  if (!Array.isArray(value.rules)) {
    issue(`${path}.rules`, "必须是数组", "type", context.issues);
    return;
  }
  if (value.rules.length === 0) {
    issue(`${path}.rules`, "至少需要一条规则", "value", context.issues);
  }
  value.rules.forEach((rule, ruleIndex) => {
    validateRule(rule, `${path}.rules[${ruleIndex}]`, context);
  });
}

function validateRule(
  value: unknown,
  path: string,
  context: ValidationContext,
): void {
  if (!isRecord(value)) {
    issue(path, "必须是对象", "type", context.issues);
    return;
  }

  checkKnownFields(value, path, RULE_FIELDS, context.strict, context.issues);
  checkOptionalInteger(value.key, `${path}.key`, context.issues);
  checkOptionalString(value.name, `${path}.name`, context.issues);
  checkOptionalIntegerList(value.preKeys, `${path}.preKeys`, context.issues);
  checkOptionalString(value.action, `${path}.action`, context.issues);
  checkOptionalEnum(value.action, `${path}.action`, ACTION_NAMES, context.issues);
  checkActivityIds(value.activityIds, `${path}.activityIds`, context.issues);
  checkActivityIds(
    value.excludeActivityIds,
    `${path}.excludeActivityIds`,
    context.issues,
  );
  checkOptionalBoolean(value.enable, `${path}.enable`, context.issues);
  checkOptionalBoolean(value.fastQuery, `${path}.fastQuery`, context.issues);
  checkOptionalBoolean(value.matchRoot, `${path}.matchRoot`, context.issues);
  checkOptionalInteger(value.actionDelay, `${path}.actionDelay`, context.issues);
  checkOptionalNumber(value.matchDelay, `${path}.matchDelay`, context.issues);
  checkOptionalNumber(value.matchTime, `${path}.matchTime`, context.issues);
  checkOptionalInteger(value.actionMaximum, `${path}.actionMaximum`, context.issues);
  checkOptionalInteger(value.actionCd, `${path}.actionCd`, context.issues);
  checkOptionalInteger(value.cd, `${path}.cd`, context.issues);
  checkOptionalInteger(value.delay, `${path}.delay`, context.issues);
  checkOptionalInteger(value.forcedTime, `${path}.forcedTime`, context.issues);
  checkOptionalEnum(
    value.resetMatch,
    `${path}.resetMatch`,
    RESET_MATCH_VALUES,
    context.issues,
  );
  checkOptionalVersionCode(value.versionCode, `${path}.versionCode`, context.issues);
  checkOptionalVersionCodes(value.versionCodes, `${path}.versionCodes`, context.issues);
  checkOptionalVersionCodes(
    value.excludeVersionCodes,
    `${path}.excludeVersionCodes`,
    context.issues,
  );
  checkOptionalVersionName(value.versionName, `${path}.versionName`, context.issues);
  checkOptionalVersionNames(value.versionNames, `${path}.versionNames`, context.issues);
  checkOptionalVersionNames(
    value.excludeVersionNames,
    `${path}.excludeVersionNames`,
    context.issues,
  );
  checkOptionalStringList(value.snapshotUrls, `${path}.snapshotUrls`, context.issues);
  checkOptionalStringList(
    value.excludeSnapshotUrls,
    `${path}.excludeSnapshotUrls`,
    context.issues,
  );
  checkOptionalStringList(value.exampleUrls, `${path}.exampleUrls`, context.issues);
  checkOptionalPosition(value.position, `${path}.position`, context.issues);
  checkOptionalSwipeArg(value.swipeArg, `${path}.swipeArg`, context.issues);

  let hasMatches = false;
  for (const field of SELECTOR_FIELDS) {
    const selectors = readStringList(value[field]);
    if (selectors === null) {
      if (value[field] !== undefined && value[field] !== null) {
        issue(
          `${path}.${field}`,
          "必须是选择器字符串或字符串数组",
          "type",
          context.issues,
        );
      }
      continue;
    }
    if (field === "matches" || field === "anyMatches") {
      hasMatches ||= selectors.length > 0;
    }
    selectors.forEach((selector, index) => {
      if (!selector.trim()) {
        issue(
          `${path}.${field}[${index}]`,
          "选择器不能为空字符串",
          "value",
          context.issues,
        );
        return;
      }
      if (!context.validateSelectors) return;
      const syntaxError = validateGkdSelectorSyntax(selector);
      if (syntaxError) {
        issue(
          `${path}.${field}[${index}]`,
          `选择器语法错误：${syntaxError}`,
          "selector-syntax",
          context.issues,
        );
      }
    });
  }
  if (!hasMatches) {
    issue(
      path,
      "至少需要 matches 或 anyMatches 中的一条非空选择器",
      "value",
      context.issues,
    );
  }
}

function checkKnownFields(
  value: Record<string, unknown>,
  path: string,
  fields: Set<string>,
  strict: boolean,
  issues: GkdRuleValidationIssue[],
): void {
  if (!strict) return;
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) {
      issue(
        `${path}.${key}`,
        "不是当前支持的应用规则字段",
        "unknown-field",
        issues,
      );
    }
  }
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) {
    issue(path, "必填字段缺失", "missing", issues);
  } else if (typeof value !== "string") {
    issue(path, "必须是字符串", "type", issues);
  } else if (!value.trim()) {
    issue(path, "不能是空字符串", "value", issues);
  }
}

function requireInteger(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) {
    issue(path, "必填字段缺失", "missing", issues);
  } else if (!Number.isSafeInteger(value)) {
    issue(path, "必须是整数", "type", issues);
  }
}

function checkOptionalString(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    issue(path, "必须是字符串", "type", issues);
  }
}

function checkOptionalBoolean(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value !== undefined && value !== null && typeof value !== "boolean") {
    issue(path, "必须是布尔值 true/false，不能是选择器字符串", "type", issues);
  }
}

function checkOptionalInteger(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value !== undefined && value !== null && !Number.isSafeInteger(value)) {
    issue(path, "必须是整数", "type", issues);
  }
}

function checkOptionalNumber(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (
    value !== undefined &&
    value !== null &&
    (typeof value !== "number" || !Number.isFinite(value) || value < 0)
  ) {
    issue(path, "必须是大于等于 0 的数字", "type", issues);
  }
}

function checkActivityIds(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (readStringList(value) === null) {
    issue(path, "必须是字符串或字符串数组", "type", issues);
  }
}

function checkOptionalStringList(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (readStringList(value) === null) {
    issue(path, "必须是字符串或字符串数组", "type", issues);
  }
}

function checkOptionalIntegerList(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((item) => Number.isSafeInteger(item))) {
    issue(path, "必须是整数或整数数组", "type", issues);
  }
}

function checkOptionalEnum(
  value: unknown,
  path: string,
  allowed: Set<string>,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !allowed.has(value)) {
    issue(path, `必须是以下值之一：${[...allowed].join(" / ")}`, "value", issues);
  }
}

function checkOptionalVersionCode(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issue(path, "必须是版本匹配对象", "type", issues);
    return;
  }
  checkOptionalInteger(value.minimum, `${path}.minimum`, issues);
  checkOptionalInteger(value.maximum, `${path}.maximum`, issues);
  checkOptionalIntegerList(value.include, `${path}.include`, issues);
  checkOptionalIntegerList(value.exclude, `${path}.exclude`, issues);
}

function checkOptionalVersionCodes(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  checkOptionalIntegerList(value, path, issues);
}

function checkOptionalVersionName(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issue(path, "必须是版本匹配对象", "type", issues);
    return;
  }
  checkOptionalString(value.pattern, `${path}.pattern`, issues);
  checkOptionalStringList(value.include, `${path}.include`, issues);
  checkOptionalStringList(value.exclude, `${path}.exclude`, issues);
}

function checkOptionalVersionNames(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  checkOptionalStringList(value, path, issues);
}

function checkOptionalPosition(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issue(path, "必须是对象", "type", issues);
    return;
  }
  for (const key of ["left", "top", "right", "bottom", "x", "y"]) {
    const item = value[key];
    if (
      item !== undefined &&
      item !== null &&
      typeof item !== "string" &&
      typeof item !== "number"
    ) {
      issue(`${path}.${key}`, "必须是字符串或数字", "type", issues);
    }
  }
}

function checkOptionalSwipeArg(
  value: unknown,
  path: string,
  issues: GkdRuleValidationIssue[],
): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) {
    issue(path, "必须是对象", "type", issues);
    return;
  }
  if (!isRecord(value.start)) {
    issue(`${path}.start`, "必须是对象", "type", issues);
  } else {
    checkOptionalPosition(value.start, `${path}.start`, issues);
  }
  if (value.end !== undefined && value.end !== null) {
    checkOptionalPosition(value.end, `${path}.end`, issues);
  }
  checkOptionalInteger(value.duration, `${path}.duration`, issues);
}

function readStringList(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  return null;
}

function issue(
  path: string,
  message: string,
  code: GkdRuleValidationCode,
  issues: GkdRuleValidationIssue[],
): void {
  issues.push({ path, message, code });
}

function invalid(
  path: string,
  message: string,
  code: GkdRuleValidationCode,
  issues: GkdRuleValidationIssue[],
): GkdRuleValidationResult {
  issue(path, message, code, issues);
  return result(issues);
}

function result(issues: GkdRuleValidationIssue[]): GkdRuleValidationResult {
  return { valid: issues.length === 0, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
