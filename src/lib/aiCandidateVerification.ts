import { DANGEROUS_CLICK_WORDS } from "../data/riskWords";
import type { AiRuleCandidate } from "./aiModel";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { AppRuleDraft, RuleDraft } from "../types/ruleDraft";
import {
  isDynamicActivityId,
  isDynamicCountdownText,
  isSkipLikeText,
} from "./countdownText";
import { canSelectorFastQuery } from "./selectorAdapter";
import { validateAppRuleAgainstSnapshot } from "./selectorMatcher";
import { buildVisualTargetIds, findSafeClickableAncestor } from "./visualTarget";

export type AiVerificationFailureCode =
  | "app_mismatch"
  | "picked_node_missing"
  | "missing_matches"
  | "invalid_selector"
  | "partial_scope"
  | "activity_mismatch"
  | "zero_hit"
  | "unsatisfied_condition"
  | "multi_hit"
  | "wrong_target";

export interface AiVerifiedNode {
  id: number;
  className: string;
  text: string | null;
  desc: string | null;
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
}

export interface AiRuleVerification {
  groupIndex: number;
  ruleIndex: number;
  matches: string[];
  anyMatches?: string[];
  status: "pass" | "fail" | "unknown";
  hitCount: number;
  hitNodes: AiVerifiedNode[];
  hitNodeIds: number[];
  extraNodeIds: number[];
  hitPickedNode: boolean;
  failureCodes: AiVerificationFailureCode[];
  diagnostics: string[];
}

export interface AiCandidateVerification {
  candidateId: string;
  title: string;
  status: "pass" | "fail" | "unknown";
  allRulesPass: boolean;
  rules: AiRuleVerification[];
  matchedNodeIds: number[];
  extraNodeIds: number[];
  hitPickedNode: boolean;
  failureCodes: AiVerificationFailureCode[];
  diagnostics: string[];
}

const OVERLAY_RESOURCE_SIGNALS = [
  "shade",
  "mask",
  "hotarea",
  "hot_area",
  "click_area",
  "clickarea",
  "click_group",
  "ad_click",
  "splash_click",
];

const HIGH_RISK_AREA_RATIO = 0.35;

const DANGEROUS_CTA_WORDS = [
  ...new Set([
    ...DANGEROUS_CLICK_WORDS,
    "下载",
    "安装",
    "打开",
    "立即打开",
    "查看详情",
    "了解更多",
    "跳转",
    "购买",
  ]),
];

const NEGATIVE_DISMISS_GUARD_RE =
  /(?:取消|关闭|跳过|暂不|拒绝|放弃|忽略|不感兴趣|不再提示|不了|稍后|以后再说|残忍拒绝|退出)/;

const NON_CLICK_ACTIONS = new Set(["back", "swipe", "none"]);
const CENTER_CLICK_ACTIONS = new Set(["clickCenter", "longClickCenter"]);

/**
 * 本地验证 AI 候选。命中判断只使用 selector 本身，不带 activity/version 范围；
 * 范围问题单独报告，避免 activity 不一致时把可命中的 selector 误判成 0 命中。
 */
export function verifyAiCandidates(
  snapshot: ParsedGkdSnapshot,
  candidates: AiRuleCandidate[],
  pickedNode: NormalizedSnapshotNode | null,
): AiCandidateVerification[] {
  const expectedNode = pickedNode
    ? snapshot.nodeById.get(pickedNode.id) ?? null
    : null;
  return candidates.map((candidate) =>
    verifyCandidate(snapshot, candidate, expectedNode),
  );
}

function verifyCandidate(
  snapshot: ParsedGkdSnapshot,
  candidate: AiRuleCandidate,
  pickedNode: NormalizedSnapshotNode | null,
): AiCandidateVerification {
  const candidateCodes = new Set<AiVerificationFailureCode>();
  const candidateDiagnostics: string[] = [];
  const rules: AiRuleVerification[] = [];

  if (candidate.app.id !== snapshot.appId) {
    candidateCodes.add("app_mismatch");
    candidateDiagnostics.push(
      `规则 appId 是 ${candidate.app.id}，当前快照是 ${snapshot.appId}。`,
    );
  }
  if (!pickedNode) {
    candidateCodes.add("picked_node_missing");
    candidateDiagnostics.push("没有可对照的用户选点，只能报告命中数量，不能判断是否点对。");
  }
  // 视觉摞：文字、图标、背景容器（含小尺寸安全可点击祖先，如 skip_ll）点中任何一个都算点对。
  const clickableAncestor = pickedNode
    ? findSafeClickableAncestor(snapshot, pickedNode)
    : null;
  const targetIds = pickedNode
    ? buildVisualTargetIds({ snapshot, pickedNode, clickableAncestor })
    : null;

  for (const [groupIndex, group] of candidate.app.groups.entries()) {
    for (const [ruleIndex, rule] of group.rules.entries()) {
      const result = verifyRule({
        snapshot,
        group,
        rule,
        groupIndex,
        ruleIndex,
        pickedNode,
        targetIds,
        appIdMismatch: candidate.app.id !== snapshot.appId,
      });
      rules.push(result);
      for (const code of result.failureCodes) candidateCodes.add(code);
      for (const diagnostic of result.diagnostics) {
        if (!candidateDiagnostics.includes(diagnostic)) {
          candidateDiagnostics.push(diagnostic);
        }
      }
    }
  }

  if (rules.length === 0) {
    candidateCodes.add("missing_matches");
    candidateDiagnostics.push("候选没有任何可验证的规则。");
  }

  const matchedNodeIds = uniqueSorted(
    rules.flatMap((rule) => rule.hitNodeIds),
  );
  const hitPickedNode =
    targetIds !== null && matchedNodeIds.some((id) => targetIds.has(id));
  const extraNodeIds = targetIds === null
    ? matchedNodeIds
    : matchedNodeIds.filter((id) => !targetIds.has(id));

  const dangerousFailedRules = rules.filter(
    (rule) =>
      rule.failureCodes.includes("invalid_selector") ||
      rule.failureCodes.includes("wrong_target") ||
      (rule.failureCodes.includes("multi_hit") && rule.extraNodeIds.length > 0),
  );
  if (dangerousFailedRules.length > 0) {
    for (const badRule of dangerousFailedRules) {
      const badCodes = badRule.failureCodes.filter(
        (code) =>
          code === "invalid_selector" ||
          code === "wrong_target" ||
          code === "multi_hit",
      );
      candidateDiagnostics.push(
        `第 ${badRule.groupIndex + 1} 组第 ${badRule.ruleIndex + 1} 条规则存在高危失败（${badCodes.join("/")}），整候选判为不通过。`,
      );
    }
  }

  const allDisabled =
    rules.length > 0 &&
    rules.every(
      (rule) =>
        rule.status === "fail" &&
        rule.diagnostics.some((d) => d.includes("enable=false")),
    );

  let status: AiCandidateVerification["status"];
  if (
    candidate.app.id !== snapshot.appId ||
    rules.length === 0 ||
    dangerousFailedRules.length > 0 ||
    allDisabled
  ) {
    status = "fail";
  } else if (pickedNode === null) {
    status = "unknown";
  } else if (rules.some((rule) => rule.status === "pass")) {
    status = "pass";
  } else if (rules.some((rule) => rule.status === "unknown")) {
    status = "unknown";
  } else {
    status = "fail";
  }

  return {
    candidateId: candidate.id,
    title: candidate.title,
    status,
    allRulesPass: rules.length > 0 && rules.every((rule) => rule.status === "pass"),
    rules,
    matchedNodeIds,
    extraNodeIds,
    hitPickedNode,
    failureCodes: [...candidateCodes],
    diagnostics: uniqueStrings(candidateDiagnostics),
  };
}

function verifyRule({
  snapshot,
  group,
  rule,
  groupIndex,
  ruleIndex,
  pickedNode,
  targetIds,
  appIdMismatch,
}: {
  snapshot: ParsedGkdSnapshot;
  group: AppRuleDraft["groups"][number];
  rule: RuleDraft;
  groupIndex: number;
  ruleIndex: number;
  pickedNode: NormalizedSnapshotNode | null;
  targetIds: Set<number> | null;
  appIdMismatch: boolean;
}): AiRuleVerification {
  const failureCodes = new Set<AiVerificationFailureCode>();
  const diagnostics: string[] = [];
  const matches = [...(rule.matches ?? [])];
  const anyMatches = [...(rule.anyMatches ?? [])];

  if (appIdMismatch) {
    failureCodes.add("app_mismatch");
  }

  if (group.enable === false || rule.enable === false) {
    failureCodes.add("unsatisfied_condition");
    diagnostics.push("规则或规则组 enable=false，已明确禁用。");
    return ruleResult({
      groupIndex,
      ruleIndex,
      matches,
      anyMatches,
      status: "fail",
      hitNodes: [],
      pickedNode,
      targetIds,
      failureCodes,
      diagnostics,
    });
  }

  const scope = describeActivityScope(snapshot, group, rule);
  if (scope.mismatch) {
    failureCodes.add("activity_mismatch");
    diagnostics.push(scope.message);
  }
  if (hasVersionScope(group, rule)) {
    failureCodes.add("partial_scope");
    diagnostics.push("规则包含版本范围条件，本地快照无法完整验证。");
  }

  if (matches.length === 0 && anyMatches.length === 0) {
    failureCodes.add("missing_matches");
    diagnostics.push("规则缺少 matches 和 anyMatches。");
    return ruleResult({
      groupIndex,
      ruleIndex,
      matches,
      anyMatches,
      status: "fail",
      hitNodes: [],
      pickedNode,
      targetIds,
      failureCodes,
      diagnostics,
    });
  }

  // 只保留选择器条件与 enable：activity/version 范围单独报告，不参与命中计算，
  // 否则 activity 不一致时会把本来能命中的 selector 误判成 0 命中。
  const validation = validateAppRuleAgainstSnapshot(snapshot, {
    id: snapshot.appId,
    name: "AI 候选验证",
    groups: [
      {
        key: 0,
        name: "verify",
        ...(group.enable !== undefined ? { enable: group.enable } : {}),
        rules: [
          {
            key: rule.key ?? 0,
            matches,
            ...(rule.enable !== undefined ? { enable: rule.enable } : {}),
            ...(anyMatches.length > 0 ? { anyMatches } : {}),
            ...(rule.excludeMatches
              ? { excludeMatches: rule.excludeMatches }
              : {}),
            ...(rule.excludeAllMatches
              ? { excludeAllMatches: rule.excludeAllMatches }
              : {}),
          },
        ],
      },
    ],
  })[0];
  const hitNodes = validation.clickNodes;
  const outsideTarget = targetIds === null
    ? hitNodes
    : hitNodes.filter((node) => !targetIds.has(node.id));

  if (validation.status === "invalid" || (validation.unparsedMatches?.length ?? 0) > 0) {
    failureCodes.add("invalid_selector");
    diagnostics.push(
      validation.diagnostics?.join("；") ||
        `无法解析 selector：${validation.unparsedMatches?.join("；") || "未知错误"}`,
    );
  } else if (validation.status === "partial") {
    failureCodes.add("partial_scope");
    diagnostics.push(
      validation.diagnostics?.join("；") || "规则包含本地无法确认的条件。",
    );
  } else if (validation.status === "unsatisfied") {
    const reason = validation.failureReason;
    if (reason === "disabled") {
      failureCodes.add("unsatisfied_condition");
      diagnostics.push(
        validation.diagnostics?.join("；") || "规则或规则组 enable=false，已明确禁用。",
      );
    } else if (
      reason === "excluded" ||
      reason === "any_matches_miss" ||
      (validation.excludedMatches?.length ?? 0) > 0
    ) {
      failureCodes.add("unsatisfied_condition");
      diagnostics.push(
        validation.diagnostics?.join("；") ||
          "规则条件不满足：被 excludeMatches 否决，或 anyMatches 全部分支未命中。",
      );
    } else if (reason === "context_miss" || reason === "target_miss") {
      failureCodes.add("zero_hit");
      diagnostics.push(
        validation.diagnostics?.join("；") ||
          "selector 在当前快照上没有命中任何节点。",
      );
    }
  }

  if (hitNodes.length === 0) {
    if (
      !failureCodes.has("invalid_selector") &&
      !failureCodes.has("partial_scope") &&
      !failureCodes.has("unsatisfied_condition") &&
      !failureCodes.has("zero_hit")
    ) {
      failureCodes.add("zero_hit");
      diagnostics.push("selector 在当前快照上没有命中任何节点。");
    }
  } else if (hitNodes.length > 1) {
    if (outsideTarget.length > 0) {
      failureCodes.add("multi_hit");
      diagnostics.push(
        `selector 命中 ${hitNodes.length} 个节点：${formatNodeList(hitNodes)}；需要收窄到唯一目标。`,
      );
    } else {
      diagnostics.push(
        `selector 命中 ${hitNodes.length} 个节点，但都属于用户所选控件的视觉摞，按同一目标处理。`,
      );
    }
  }

  if (pickedNode && outsideTarget.length > 0) {
    failureCodes.add("wrong_target");
    diagnostics.push(
      `selector 命中了 ${formatNodeList(outsideTarget)}，但用户选的是 ${formatNode(pickedNode)}。`,
    );
  }

  const status: AiRuleVerification["status"] =
    failureCodes.has("invalid_selector")
      ? "fail"
      : pickedNode === null
        ? "unknown"
        : failureCodes.size === 0
          ? "pass"
          : failureCodes.has("partial_scope")
            ? "unknown"
            : "fail";

  return ruleResult({
    groupIndex,
    ruleIndex,
    matches,
    anyMatches,
    status,
    hitNodes,
    pickedNode,
    targetIds,
    failureCodes,
    diagnostics,
  });
}

function ruleResult({
  groupIndex,
  ruleIndex,
  matches,
  anyMatches,
  status,
  hitNodes,
  pickedNode,
  targetIds,
  failureCodes,
  diagnostics,
}: {
  groupIndex: number;
  ruleIndex: number;
  matches: string[];
  anyMatches?: string[];
  status: AiRuleVerification["status"];
  hitNodes: NormalizedSnapshotNode[];
  pickedNode: NormalizedSnapshotNode | null;
  targetIds: Set<number> | null;
  failureCodes: Set<AiVerificationFailureCode>;
  diagnostics: string[];
}): AiRuleVerification {
  const hitNodeIds = uniqueSorted(hitNodes.map((node) => node.id));
  const acceptableIds =
    targetIds ?? (pickedNode ? new Set([pickedNode.id]) : null);
  return {
    groupIndex,
    ruleIndex,
    matches,
    ...(anyMatches && anyMatches.length > 0 ? { anyMatches } : {}),
    status,
    hitCount: hitNodes.length,
    hitNodes: hitNodes.map(toVerifiedNode),
    hitNodeIds,
    extraNodeIds: acceptableIds === null
      ? hitNodeIds
      : hitNodeIds.filter((id) => !acceptableIds.has(id)),
    hitPickedNode:
      acceptableIds !== null && hitNodeIds.some((id) => acceptableIds.has(id)),
    failureCodes: [...failureCodes],
    diagnostics: uniqueStrings(diagnostics),
  };
}

function describeActivityScope(
  snapshot: ParsedGkdSnapshot,
  group: AppRuleDraft["groups"][number],
  rule: RuleDraft,
): { mismatch: boolean; message: string } {
  const excludeActivityIds =
    rule.excludeActivityIds === undefined
      ? group.excludeActivityIds
      : rule.excludeActivityIds;
  if (
    excludeActivityIds !== undefined &&
    !(Array.isArray(excludeActivityIds) && excludeActivityIds.length === 0) &&
    activityMatches(snapshot, excludeActivityIds)
  ) {
    return {
      mismatch: true,
      message: `规则排除当前 Activity：${formatScopeValue(excludeActivityIds)}，快照是 ${snapshot.activityId ?? "未知"}。`,
    };
  }

  const activityIds =
    rule.activityIds === undefined ? group.activityIds : rule.activityIds;
  if (
    activityIds !== undefined &&
    !(Array.isArray(activityIds) && activityIds.length === 0) &&
    !activityMatches(snapshot, activityIds)
  ) {
    return {
      mismatch: true,
      message: `规则限定 Activity：${formatScopeValue(activityIds)}，快照是 ${snapshot.activityId ?? "未知"}。`,
    };
  }

  return { mismatch: false, message: "" };
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

function hasVersionScope(
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

function formatScopeValue(value: string | string[]): string {
  return Array.isArray(value) ? value.join(" | ") : value;
}

function formatNodeList(nodes: NormalizedSnapshotNode[]): string {
  const visible = nodes.slice(0, 5).map(formatNode);
  return nodes.length > visible.length
    ? `${visible.join("、")} 等 ${nodes.length} 个`
    : visible.join("、");
}

function formatNode(node: NormalizedSnapshotNode): string {
  const label = node.attr.text || node.attr.desc || node.attr.vid || node.attr.id;
  const className = node.attr.name.split(".").at(-1) || node.attr.name;
  return `#${node.id} ${className}${label ? ` ${JSON.stringify(label)}` : ""}`;
}

function toVerifiedNode(node: NormalizedSnapshotNode): AiVerifiedNode {
  return {
    id: node.id,
    className: node.attr.name,
    text: node.attr.text,
    desc: node.attr.desc,
    bounds: {
      left: node.attr.left,
      top: node.attr.top,
      right: node.attr.right,
      bottom: node.attr.bottom,
    },
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function shortName(name: string): string {
  return name.split(".").at(-1) ?? name;
}

function nodeAreaRatio(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): number {
  const screenArea = Math.max(1, snapshot.screenWidth * snapshot.screenHeight);
  const w =
    node.attr.right > node.attr.left
      ? node.attr.right - node.attr.left
      : Math.max(0, node.attr.width);
  const h =
    node.attr.bottom > node.attr.top
      ? node.attr.bottom - node.attr.top
      : Math.max(0, node.attr.height);
  return (w * h) / screenArea;
}

function isNodeInsideWebView(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): boolean {
  let current: NormalizedSnapshotNode | undefined = node;
  let guard = 0;
  while (current && guard < 128) {
    if (/webview/i.test(current.attr.name)) return true;
    current = current.pid >= 0 ? snapshot.nodeById.get(current.pid) : undefined;
    guard += 1;
  }
  return false;
}

function isOverlayOrHotAreaNode(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): boolean {
  if (nodeAreaRatio(snapshot, node) > HIGH_RISK_AREA_RATIO) {
    return true;
  }
  const signals = `${node.attr.id ?? ""} ${node.attr.vid ?? ""} ${node.attr.desc ?? ""}`.toLowerCase();
  return OVERLAY_RESOURCE_SIGNALS.some((kw) => signals.includes(kw));
}

function isDangerousCtaNode(node: NormalizedSnapshotNode): boolean {
  const textLabel = `${node.attr.text ?? ""} ${node.attr.desc ?? ""}`.trim();
  if (!textLabel) return false;
  if (NEGATIVE_DISMISS_GUARD_RE.test(textLabel) || isSkipLikeText(textLabel)) {
    return false;
  }
  const lower = textLabel.toLowerCase();
  return DANGEROUS_CTA_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

function resolveEffectiveDelay(
  group: AppRuleDraft["groups"][number],
  rule: RuleDraft,
): number {
  const raw =
    rule.actionDelay ??
    (rule as { delay?: number }).delay ??
    (group as { actionDelay?: number }).actionDelay ??
    (group as { delay?: number }).delay;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/**
 * 提取 selector 中所有 `[...]` 括号内部内容（忽略引号内的方括号）。
 */
function extractBracketContents(selector: string): string[] {
  const contents: string[] = [];
  let inBracket = false;
  let bracketStart = -1;
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" && !inBracket) {
      inBracket = true;
      bracketStart = i + 1;
      continue;
    }
    if (ch === "]" && inBracket) {
      contents.push(selector.slice(bracketStart, i));
      inBracket = false;
      bracketStart = -1;
    }
  }
  return contents;
}

/**
 * 扫描并转换 selector 内所有 `[...]` 括号的表达式（尊重字符串引号）。
 */
function mapSelectorBrackets(
  selector: string,
  transform: (inner: string) => string,
): string {
  let out = "";
  let inBracket = false;
  let bracketStart = -1;
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      if (!inBracket) out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      if (!inBracket) out += ch;
      continue;
    }
    if (ch === "[" && !inBracket) {
      inBracket = true;
      bracketStart = i + 1;
      continue;
    }
    if (ch === "]" && inBracket) {
      const inner = selector.slice(bracketStart, i);
      out += `[${transform(inner)}]`;
      inBracket = false;
      bracketStart = -1;
      continue;
    }
    if (!inBracket) out += ch;
  }

  if (inBracket && bracketStart >= 0) {
    out += `[${selector.slice(bracketStart)}`;
  }
  return out;
}

/** 将括号内部的字符串字面量替换为占位，避免把文案内容误当成属性名。 */
function maskQuotedLiterals(text: string): string {
  return text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[0]);
}

/**
 * 针对括号内的属性等式进行安全重写（只匹配引号外的属性赋值，支持复合括号如 `[clickable=true && vid="skip"]`）。
 */
function rewriteBracketAttrEquals(
  inner: string,
  attrName: "vid" | "id",
  replacer: (quote: string, value: string) => string | null,
): string {
  let result = "";
  let i = 0;
  const len = inner.length;

  while (i < len) {
    const ch = inner[i]!;
    if (ch === '"' || ch === "'") {
      const q = ch;
      result += ch;
      i += 1;
      while (i < len) {
        const cur = inner[i]!;
        result += cur;
        i += 1;
        if (cur === "\\" && i < len) {
          result += inner[i]!;
          i += 1;
        } else if (cur === q) {
          break;
        }
      }
      continue;
    }

    const prevChar = i > 0 ? inner[i - 1]! : "";
    const isBoundary = !/[A-Za-z0-9_.]/.test(prevChar);
    if (isBoundary && inner.startsWith(attrName, i)) {
      const afterName = i + attrName.length;
      const nextChar = inner[afterName] ?? "";
      if (!/[A-Za-z0-9_.]/.test(nextChar)) {
        const rest = inner.slice(afterName);
        const eqMatch = /^(\s*=\s*)(["'])((?:\\.|(?!\2).)*)\2/.exec(rest);
        if (eqMatch) {
          const quote = eqMatch[2]!;
          const rawValue = eqMatch[3]!;
          const replaced = replacer(quote, rawValue);
          if (replaced !== null) {
            result += replaced;
          } else {
            result += `${attrName}${eqMatch[0]}`;
          }
          i = afterName + eqMatch[0].length;
          continue;
        }
      }
    }

    result += ch;
    i += 1;
  }

  return result;
}

function findBestMatchingIdNode(
  snapshot: ParsedGkdSnapshot,
  vidValue: string,
  visualTargetIds: Set<number> | null,
): NormalizedSnapshotNode | null {
  const candidates = snapshot.nodes.filter(
    (n) =>
      n.attr.id &&
      (n.attr.id === `${snapshot.appId}:id/${vidValue}` ||
        n.attr.id.endsWith(`:id/${vidValue}`) ||
        n.attr.id.endsWith(`/${vidValue}`)),
  );
  if (candidates.length === 0) return null;

  // 优先级 1：pickedNode 视觉摞内节点
  if (visualTargetIds) {
    const inVisualStack = candidates.find((n) => visualTargetIds.has(n.id));
    if (inVisualStack) return inVisualStack;
  }
  // 优先级 2：当前应用包名 ${appId}:id/${vidValue}
  const exactAppId = candidates.find(
    (n) => n.attr.id === `${snapshot.appId}:id/${vidValue}`,
  );
  if (exactAppId) return exactAppId;
  // 优先级 3：其他非系统框架 id
  const nonSystem = candidates.find(
    (n) => n.attr.id && !isGenericFrameworkId(n.attr.id),
  );
  if (nonSystem) return nonSystem;
  // 优先级 4：兜底
  return candidates[0] ?? null;
}

/**
 * 针对大模型高频出现的机械错误进行确定性纠偏：
 * 1. 把快照中实际只存在 id="pkg:id/xxx" 的节点误写成 vid="xxx"（且快照中全无 vid="xxx"）
 * 2. 把快照中实际只存在 vid="xxx" 的节点误写成 id="xxx"
 * 支持复合括号属性（如 `[clickable=true && vid="skip"]`）。
 */
export function repairAiCandidateSelector(
  selector: string,
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode | null = null,
): { selector: string; repaired: boolean; note?: string } {
  let hasRepair = false;
  const notes: string[] = [];

  const expectedNode = pickedNode
    ? snapshot.nodeById.get(pickedNode.id) ?? null
    : null;
  const clickableAncestor = expectedNode
    ? findSafeClickableAncestor(snapshot, expectedNode)
    : null;
  const visualTargetIds = expectedNode
    ? buildVisualTargetIds({
        snapshot,
        pickedNode: expectedNode,
        clickableAncestor,
      })
    : null;

  const modified = mapSelectorBrackets(selector, (inner) => {
    let next = rewriteBracketAttrEquals(inner, "vid", (quote, vidValue) => {
      const hasRealVid = snapshot.nodes.some((n) => n.attr.vid === vidValue);
      if (hasRealVid) return null;

      const matchingNode = findBestMatchingIdNode(
        snapshot,
        vidValue,
        visualTargetIds,
      );
      if (matchingNode?.attr.id) {
        hasRepair = true;
        notes.push(
          `将不存在的 vid="${vidValue}" 纠正为真实存在的 id="${matchingNode.attr.id}"`,
        );
        return `id=${quote}${matchingNode.attr.id}${quote}`;
      }
      return null;
    });

    next = rewriteBracketAttrEquals(next, "id", (quote, idValue) => {
      const hasRealId = snapshot.nodes.some((n) => n.attr.id === idValue);
      if (hasRealId) return null;

      const vidMatches = snapshot.nodes.filter((n) => n.attr.vid === idValue);
      const matchingNode =
        (visualTargetIds
          ? vidMatches.find((n) => visualTargetIds.has(n.id))
          : undefined) ?? vidMatches[0];
      if (matchingNode?.attr.vid) {
        hasRepair = true;
        notes.push(
          `将不存在的 id="${idValue}" 纠正为真实存在的 vid="${matchingNode.attr.vid}"`,
        );
        return `vid=${quote}${matchingNode.attr.vid}${quote}`;
      }
      return null;
    });

    return next;
  });

  return {
    selector: modified,
    repaired: hasRepair,
    note: notes.length > 0 ? uniqueStrings(notes).join("；") : undefined,
  };
}

/**
 * 对一个 AI 候选的所有选择器与执行参数进行确定性自动纠偏：
 * - vid/id 混淆纠偏（支持复合括号）
 * - fastQuery: true 真实兼容性检查与自动关闭（含官方 fastQueryList 与 WebView 祖先链检查）
 * - 跨分支多段 matches / WebView 自动补充 matchRoot: true
 */
export function repairAiCandidate(
  candidate: AiRuleCandidate,
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode | null = null,
): { candidate: AiRuleCandidate; repaired: boolean; changes: string[] } {
  let anyRepaired = false;
  const allChanges: string[] = [];

  const nextGroups = candidate.app.groups.map((group) => {
    const nextRules = group.rules.map((rule) => {
      let ruleRepaired = false;
      const repairList = (list: string[] | undefined): string[] | undefined => {
        if (!list) return undefined;
        return list.map((selector) => {
          const res = repairAiCandidateSelector(selector, snapshot, pickedNode);
          if (res.repaired) {
            ruleRepaired = true;
            anyRepaired = true;
            if (res.note) allChanges.push(res.note);
            return res.selector;
          }
          return selector;
        });
      };

      const nextMatches = repairList(rule.matches);
      const nextAnyMatches = repairList(rule.anyMatches);
      const nextExcludeMatches = repairList(rule.excludeMatches);
      const nextExcludeAllMatches = repairList(rule.excludeAllMatches);

      const effectiveMatches = nextMatches ?? [];
      const effectiveAnyMatches = nextAnyMatches ?? [];
      const primarySelectors = [...effectiveMatches, ...effectiveAnyMatches];
      const allFastQuerySelectors = [
        ...primarySelectors,
        ...(nextExcludeMatches ?? []),
        ...(nextExcludeAllMatches ?? []),
      ];

      // 评估该 rule 在当前快照上的真实命中节点与前置锚点（判断是否位于 WebView 下）
      let matchedNodes: NormalizedSnapshotNode[] = [];
      if (primarySelectors.length > 0) {
        const ruleValidation = validateAppRuleAgainstSnapshot(snapshot, {
          id: snapshot.appId,
          name: "repair-check",
          groups: [
            {
              key: 0,
              name: "check",
              rules: [
                {
                  key: rule.key ?? 0,
                  matches: effectiveMatches,
                  ...(effectiveAnyMatches.length > 0
                    ? { anyMatches: effectiveAnyMatches }
                    : {}),
                  ...(nextExcludeMatches
                    ? { excludeMatches: nextExcludeMatches }
                    : {}),
                  ...(nextExcludeAllMatches
                    ? { excludeAllMatches: nextExcludeAllMatches }
                    : {}),
                },
              ],
            },
          ],
        })[0];
        matchedNodes = [
          ...(ruleValidation?.clickNodes ?? []),
          ...(ruleValidation?.supportNodes ?? []),
        ];
      }

      const inWebView = matchedNodes.some((node) => isNodeInsideWebView(snapshot, node));
      let nextFastQuery = rule.fastQuery;
      let nextMatchRoot = rule.matchRoot;

      // P0-1: fastQuery: true 真实兼容性自动纠偏（含 excludeMatches/excludeAllMatches 与前置锚点 WebView）
      const effectiveFastQuery = rule.fastQuery ?? group.fastQuery;
      if (effectiveFastQuery === true && allFastQuerySelectors.length > 0) {
        const hasIncompatibleSelector = allFastQuerySelectors.some(
          (sel) => !canSelectorFastQuery(sel),
        );
        if (hasIncompatibleSelector || inWebView) {
          nextFastQuery = false;
          ruleRepaired = true;
          anyRepaired = true;
          if (inWebView && hasIncompatibleSelector) {
            allChanges.push(
              "选择器不满足 fastQuery 条件且命中节点位于 WebView 内，已将 fastQuery 纠正为 false",
            );
          } else if (inWebView) {
            allChanges.push(
              "命中节点位于 WebView 祖先链下，已将 fastQuery 纠正为 false",
            );
          } else {
            allChanges.push(
              "选择器不满足官方 fastQuery 条件（缺少右端精确 id/vid/text），已将 fastQuery 纠正为 false",
            );
          }
        }
      }

      // P1-8: 跨分支多段 matches / WebView 自动补充 matchRoot: true
      if (
        (effectiveMatches.length >= 2 || inWebView) &&
        rule.matchRoot === undefined &&
        group.matchRoot === undefined
      ) {
        nextMatchRoot = true;
        ruleRepaired = true;
        anyRepaired = true;
        if (inWebView && effectiveMatches.length >= 2) {
          allChanges.push(
            "多段 matches 且命中节点位于 WebView 内，已自动补充 matchRoot: true",
          );
        } else if (inWebView) {
          allChanges.push("命中节点位于 WebView 祖先链下，已自动补充 matchRoot: true");
        } else {
          allChanges.push("多段 matches 跨分支匹配，已自动补充 matchRoot: true");
        }
      }

      if (!ruleRepaired) return rule;

      const updatedRule: Record<string, unknown> = {
        ...rule,
        ...(nextAnyMatches ? { anyMatches: nextAnyMatches } : {}),
        ...(nextExcludeMatches ? { excludeMatches: nextExcludeMatches } : {}),
        ...(nextExcludeAllMatches
          ? { excludeAllMatches: nextExcludeAllMatches }
          : {}),
        ...(nextFastQuery !== undefined ? { fastQuery: nextFastQuery } : {}),
        ...(nextMatchRoot !== undefined ? { matchRoot: nextMatchRoot } : {}),
      };
      if (nextMatches && nextMatches.length > 0) {
        updatedRule.matches = nextMatches;
      } else if (rule.matches === undefined && effectiveAnyMatches.length > 0) {
        delete updatedRule.matches;
      } else if (nextMatches) {
        updatedRule.matches = nextMatches;
      }
      return updatedRule as unknown as RuleDraft;
    });

    if (
      group.fastQuery === true &&
      nextRules.length > 0 &&
      nextRules.every((r) => r.fastQuery === false)
    ) {
      anyRepaired = true;
      return { ...group, fastQuery: false, rules: nextRules };
    }
    return { ...group, rules: nextRules };
  });

  const uniqueChanges = uniqueStrings(allChanges);
  if (!anyRepaired) {
    return { candidate, repaired: false, changes: [] };
  }

  const repairedSummary = candidate.summary
    ? `${candidate.summary} (已自动纠偏: ${uniqueChanges.join("，")})`
    : `(已自动纠偏: ${uniqueChanges.join("，")})`;

  return {
    candidate: {
      ...candidate,
      summary: repairedSummary,
      app: {
        ...candidate.app,
        groups: nextGroups,
      },
    },
    repaired: true,
    changes: uniqueChanges,
  };
}

export interface AiCandidateVerificationOptions {
  allowActionDelay?: boolean;
}

export interface RerankedAiCandidatesResult {
  rankedCandidates: AiRuleCandidate[];
  verifications: AiCandidateVerification[];
  bestPassed: boolean;
  repairedCount: number;
}

interface ScoredCandidateEntry {
  candidate: AiRuleCandidate;
  verification: AiCandidateVerification | undefined;
  score: number;
  originalIndex: number;
}

function scoreAndRankPreRepaired(
  snapshot: ParsedGkdSnapshot,
  candidates: AiRuleCandidate[],
  pickedNode: NormalizedSnapshotNode | null,
  options?: AiCandidateVerificationOptions,
): {
  scored: ScoredCandidateEntry[];
  rankedCandidates: AiRuleCandidate[];
  verifications: AiCandidateVerification[];
  bestPassed: boolean;
  bestScore: number;
} {
  const verifications = verifyAiCandidates(snapshot, candidates, pickedNode);
  const verifByCandidateId = new Map<string, AiCandidateVerification>();
  verifications.forEach((v) => verifByCandidateId.set(v.candidateId, v));

  const scored: ScoredCandidateEntry[] = candidates.map((candidate, originalIndex) => {
    const v = verifByCandidateId.get(candidate.id);
    let score = 0;

    if (v) {
      if (v.status === "pass") {
        if (v.hitPickedNode) {
          score = v.extraNodeIds.length === 0 ? 100 : 75;
        } else {
          score = 55;
        }
      } else if (
        v.status === "unknown" &&
        v.failureCodes.includes("picked_node_missing")
      ) {
        // 未选点场景：无法判断是否点中目标，但能成功匹配快照节点的候选应优于 0 命中或语法错误
        if (v.matchedNodeIds.length === 1 && !v.failureCodes.includes("zero_hit")) {
          score = 65; // 单节点命中
        } else if (
          v.matchedNodeIds.length > 1 &&
          !v.failureCodes.includes("zero_hit")
        ) {
          score = 50; // 多节点命中
        } else if (v.failureCodes.includes("zero_hit")) {
          score = 10;
        } else {
          score = 0;
        }
      } else {
        if (v.failureCodes.includes("activity_mismatch")) {
          score = 45;
        } else if (v.failureCodes.includes("wrong_target")) {
          score = 30;
        } else if (v.failureCodes.includes("multi_hit")) {
          score = 25;
        } else if (v.failureCodes.includes("zero_hit")) {
          score = 10;
        } else {
          score = 0;
        }
      }

      if (v.status === "pass" || v.status === "unknown") {
        score += executionReadinessAdjustment(snapshot, candidate, v, options);
      }

      // picked_node_missing 下禁止越过 70 分通过线
      if (v.failureCodes.includes("picked_node_missing")) {
        score = Math.min(score, 69);
      }
    }

    return { candidate, verification: v, score, originalIndex };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  const rankedCandidates = scored.map((item) => item.candidate);
  const rankedVerifications = scored
    .map((item) => item.verification)
    .filter(Boolean) as AiCandidateVerification[];
  const top = scored[0];
  const bestScore = top?.score ?? 0;
  const bestPassed = Boolean(
    top &&
      top.verification &&
      top.verification.status === "pass" &&
      !top.verification.failureCodes.includes("picked_node_missing") &&
      bestScore >= 70,
  );

  return {
    scored,
    rankedCandidates,
    verifications: rankedVerifications,
    bestPassed,
    bestScore,
  };
}

/**
 * 本地静态验证重排：对候选执行自动纠偏、静态验证和多维度打分，高置信度通过的候选排在首位
 */
export function rerankAiCandidates(
  snapshot: ParsedGkdSnapshot,
  candidates: AiRuleCandidate[],
  pickedNode: NormalizedSnapshotNode | null,
  options?: AiCandidateVerificationOptions,
): RerankedAiCandidatesResult {
  let repairedCount = 0;
  const repairedCandidates = candidates.map((candidate) => {
    const res = repairAiCandidate(candidate, snapshot, pickedNode);
    if (res.repaired) repairedCount += 1;
    return res.candidate;
  });

  const ranked = scoreAndRankPreRepaired(
    snapshot,
    repairedCandidates,
    pickedNode,
    options,
  );

  return {
    rankedCandidates: ranked.rankedCandidates,
    verifications: ranked.verifications,
    bestPassed: ranked.bestPassed,
    repairedCount,
  };
}

const GENERIC_DISMISS_LABELS = new Set([
  "关闭",
  "取消",
  "跳过",
  "确定",
  "确认",
  "知道",
  "知道了",
  "不再提示",
  "close",
  "cancel",
  "skip",
  "ok",
]);

function hasHardcodedPositionAttrs(selectors: string[]): boolean {
  return selectors.some((expr) =>
    extractBracketContents(expr).some((inner) => {
      const masked = maskQuotedLiterals(inner);
      return /(?:^|[\s&|(,!])(?:left|top|right|bottom)\s*(?:=|!=|<|>|<=|>=)/.test(
        masked,
      );
    }),
  );
}

function hasDynamicCountdownLiteral(selectors: string[]): boolean {
  for (const expr of selectors) {
    for (const inner of extractBracketContents(expr)) {
      for (const m of inner.matchAll(
        /(?:^|[\s&|(])(?:text|desc)\s*=\s*(["'])((?:\\.|(?!\1).)*)\1/g,
      )) {
        if (m[2] && isDynamicCountdownText(m[2])) {
          return true;
        }
      }
    }
  }
  return false;
}

function isGenericFrameworkId(idValue: string): boolean {
  return /^(?:android:id\/|com\.android\.systemui:id\/)/i.test(idValue.trim());
}

function isBareGenericDismissText(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return true;
  if (GENERIC_DISMISS_LABELS.has(trimmed)) return true;
  return isDynamicCountdownText(trimmed);
}

function collectContextualAnchorLiterals(snapshot: ParsedGkdSnapshot): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const node of snapshot.nodes) {
    if (!node.attr.visibleToUser) continue;
    for (const raw of [node.attr.text, node.attr.desc]) {
      const value = raw?.trim();
      if (!value || value.length < 2 || value.length > 40) continue;
      if (/^\d+$/.test(value)) continue;
      if (isBareGenericDismissText(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function hasNonGenericContextualAnchor(
  selectors: string[],
  anyMatches: string[] = [],
): boolean {
  const combined = [...selectors, ...anyMatches];
  for (const expr of combined) {
    for (const inner of extractBracketContents(expr)) {
      for (const m of inner.matchAll(
        /(?:^|[\s&|(])(?:text|desc)\s*(?:\^=|\$=|\*=|=)\s*(["'])((?:\\.|(?!\1).)*)\1/g,
      )) {
        if (m[2] && !isBareGenericDismissText(m[2])) {
          return true;
        }
      }
      for (const m of inner.matchAll(
        /(?:^|[\s&|(])vid\s*(?:\^=|\$=|\*=|=)\s*(["'])((?:\\.|(?!\1).)*)\1/g,
      )) {
        if (m[2]?.trim()) return true;
      }
      for (const m of inner.matchAll(
        /(?:^|[\s&|(])id\s*(?:\^=|\$=|\*=|=)\s*(["'])((?:\\.|(?!\1).)*)\1/g,
      )) {
        if (m[2]?.trim() && !isGenericFrameworkId(m[2])) return true;
      }
    }
  }
  return false;
}

function hasSemanticAttrInSelectors(selectors: string[]): boolean {
  return selectors.some((expr) =>
    extractBracketContents(expr).some((inner) => {
      const masked = maskQuotedLiterals(inner);
      return /(?:^|[\s&|(])(?:id|vid|text|desc)(?:\s*(?:=|!=|\^=|\$=|\*=|~=)|\b)/.test(
        masked,
      );
    }),
  );
}

function hasOnlyGenericSystemId(selectors: string[]): boolean {
  const idMatches: string[] = [];
  let hasVid = false;
  let hasTextDesc = false;

  for (const expr of selectors) {
    for (const inner of extractBracketContents(expr)) {
      const masked = maskQuotedLiterals(inner);
      if (/(?:^|[\s&|(])vid(?:\s*(?:=|!=|\^=|\$=|\*=|~=)|\b)/.test(masked)) {
        hasVid = true;
      }
      if (
        /(?:^|[\s&|(])(?:text|desc)(?:\s*(?:=|!=|\^=|\$=|\*=|~=)|\b)/.test(masked)
      ) {
        hasTextDesc = true;
      }
      for (const m of inner.matchAll(
        /(?:^|[\s&|(])id\s*(?:\^=|\$=|\*=|=)\s*(["'])((?:\\.|(?!\1).)*)\1/g,
      )) {
        if (m[2]) idMatches.push(m[2]);
      }
    }
  }

  return idMatches.length > 0 && !hasVid && !hasTextDesc && idMatches.every(isGenericFrameworkId);
}

interface CandidateRuleEntry {
  group: AppRuleDraft["groups"][number];
  groupIndex: number;
  rule: RuleDraft;
  ruleIndex: number;
  ruleVerification: AiRuleVerification | undefined;
  matches: string[];
  anyMatches: string[];
  allMatches: string[];
  hitNodes: NormalizedSnapshotNode[];
  primaryHitNode: NormalizedSnapshotNode | null;
}

function collectCandidateRuleEntries(
  snapshot: ParsedGkdSnapshot,
  candidate: AiRuleCandidate,
  verification?: AiCandidateVerification,
): CandidateRuleEntry[] {
  const entries: CandidateRuleEntry[] = [];
  for (const [groupIndex, group] of candidate.app.groups.entries()) {
    for (const [ruleIndex, rule] of group.rules.entries()) {
      const ruleVerification = verification?.rules.find(
        (r) => r.groupIndex === groupIndex && r.ruleIndex === ruleIndex,
      );
      const matches = rule.matches ?? [];
      const anyMatches = rule.anyMatches ?? [];
      const allMatches = [...matches, ...anyMatches];
      const hitNodes = (ruleVerification?.hitNodes ?? [])
        .map((n) => snapshot.nodeById.get(n.id))
        .filter((node): node is NormalizedSnapshotNode => Boolean(node));
      const primaryHitNode = hitNodes[0] ?? null;

      entries.push({
        group,
        groupIndex,
        rule,
        ruleIndex,
        ruleVerification,
        matches,
        anyMatches,
        allMatches,
        hitNodes,
        primaryHitNode,
      });
    }
  }
  return entries;
}

function hasIncompatibleFastQuery(
  snapshot: ParsedGkdSnapshot,
  entry: CandidateRuleEntry,
): boolean {
  const effectiveFastQuery = entry.rule.fastQuery ?? entry.group.fastQuery;
  if (effectiveFastQuery !== true) return false;
  const allSelectors = [
    ...entry.allMatches,
    ...(entry.rule.excludeMatches ?? []),
    ...(entry.rule.excludeAllMatches ?? []),
  ];
  if (allSelectors.some((sel) => !canSelectorFastQuery(sel))) return true;
  return entry.hitNodes.some((node) => isNodeInsideWebView(snapshot, node));
}

export interface AiAutoRepairAssessment {
  needsRepair: boolean;
  reasons: string[];
}

/**
 * 评估经过静态校验与重排后的 AI 候选是否仍存在硬伤，需要静默自动返修。
 */
export function assessAiAutoRepairNeed(
  snapshot: ParsedGkdSnapshot,
  reranked: RerankedAiCandidatesResult,
  pickedNode: NormalizedSnapshotNode | null,
  options?: AiCandidateVerificationOptions,
): AiAutoRepairAssessment {
  const reasons: string[] = [];
  const topCandidate = reranked.rankedCandidates[0];
  const topVerification = reranked.verifications[0];

  if (!topCandidate || !topVerification) {
    reasons.push("未返回有效候选或未能完成本地快照静态验证");
    return { needsRepair: true, reasons };
  }

  if (!reranked.bestPassed) {
    if (topVerification.failureCodes.includes("zero_hit")) {
      reasons.push("候选在当前快照中 0 命中");
    } else if (topVerification.failureCodes.includes("wrong_target")) {
      reasons.push("候选未命中用户选中的目标节点（错靶）");
    } else if (topVerification.failureCodes.includes("invalid_selector")) {
      reasons.push("候选选择器语法无法解析");
    } else if (topVerification.failureCodes.includes("multi_hit")) {
      reasons.push("候选命中多个非视觉摞节点，存在高误触风险");
    } else if (topVerification.failureCodes.includes("unsatisfied_condition")) {
      reasons.push("候选被禁用（enable=false）或条件不满足（excludeMatches / anyMatches 未命中）");
    } else {
      reasons.push("首选候选未达到静态稳定性通过线（可能缺少锚点或含硬编码风险）");
    }
  }

  const entries = collectCandidateRuleEntries(snapshot, topCandidate, topVerification);
  const contextLiterals = collectContextualAnchorLiterals(snapshot);
  const targetLacksSelfKey =
    !pickedNode || (!pickedNode.attr.id && !pickedNode.attr.vid);

  let flaggedCoords = false;
  let flaggedUnclickable = false;
  let flaggedOverlay = false;
  let flaggedDangerousCta = false;
  let flaggedCountdown = false;
  let flaggedDynamicActivity = false;
  let flaggedFastQuery = false;
  let flaggedMissingAnchor = false;

  for (const entry of entries) {
    const action = entry.rule.action;
    const isNonClickAction = Boolean(action && NON_CLICK_ACTIONS.has(action));
    const isCenterClick = Boolean(action && CENTER_CLICK_ACTIONS.has(action));

    if (!flaggedCoords && hasHardcodedPositionAttrs(entry.allMatches)) {
      flaggedCoords = true;
      reasons.push("规则硬编码了 left/top/right/bottom 屏幕像素坐标，换分辨率或弹窗位移易失效");
    }

    if (
      !flaggedUnclickable &&
      !isNonClickAction &&
      !isCenterClick &&
      entry.primaryHitNode &&
      !entry.primaryHitNode.attr.clickable
    ) {
      flaggedUnclickable = true;
      reasons.push("实际点击目标 clickable=false 但未设置 action: \"clickCenter\"");
    }

    if (
      !flaggedOverlay &&
      !isNonClickAction &&
      entry.hitNodes.some((node) => isOverlayOrHotAreaNode(snapshot, node))
    ) {
      flaggedOverlay = true;
      reasons.push("命中目标面积过大（>35%）或包含广告遮罩/热区关键词（shade/mask/hotArea/click_area 等），极易误触广告跳转");
    }

    if (
      !flaggedDangerousCta &&
      !isNonClickAction &&
      entry.hitNodes.some((node) => isDangerousCtaNode(node))
    ) {
      flaggedDangerousCta = true;
      reasons.push("命中目标包含下载/安装/打开/查看详情/跳转/购买等正向危险 CTA 文案，禁止作为点击目标");
    }

    if (!flaggedCountdown && hasDynamicCountdownLiteral(entry.allMatches)) {
      flaggedCountdown = true;
      reasons.push("选择器写死了动态倒计时数字，应改用前缀/后缀匹配（text^=/text$=）或稳定容器属性");
    }

    const scopes = [entry.group.activityIds, entry.rule.activityIds]
      .flat()
      .filter((item): item is string => typeof item === "string" && item.length > 0);
    if (!flaggedDynamicActivity && scopes.some((act) => isDynamicActivityId(act))) {
      flaggedDynamicActivity = true;
      reasons.push("规则写死了带动态数字/匿名后缀的 activityIds，下次启动极易失效");
    }

    if (!flaggedFastQuery && hasIncompatibleFastQuery(snapshot, entry)) {
      flaggedFastQuery = true;
      reasons.push("规则开启了 fastQuery: true 但选择器不满足官方 fastQuery 条件或位于 WebView 内");
    }

    if (
      !flaggedMissingAnchor &&
      targetLacksSelfKey &&
      contextLiterals.length > 0 &&
      entry.allMatches.length > 0 &&
      (!hasNonGenericContextualAnchor(entry.matches, entry.anyMatches) ||
        hasOnlyGenericSystemId(entry.allMatches))
    ) {
      flaggedMissingAnchor = true;
      reasons.push(
        `缺少非泛用业务文案上下文锚点（例如 ${contextLiterals.slice(0, 3).map((t) => JSON.stringify(t)).join(" / ")}），裸写泛用词或系统容器极易误触`,
      );
    }
  }

  const passingCandidates = reranked.rankedCandidates.filter(
    (_, index) => reranked.verifications[index]?.status === "pass",
  );
  if (
    !options?.allowActionDelay &&
    passingCandidates.length > 0 &&
    passingCandidates.every((cand) =>
      cand.app.groups.some((g) =>
        g.rules.some((r) => resolveEffectiveDelay(g, r) >= 1000),
      ),
    )
  ) {
    reasons.push(
      "所有通过验靶的候选均设置了 >=1000ms 的 actionDelay，3 秒开屏/弹窗会直接超时错过；首选测试版 A/B 必须去掉 actionDelay 实现立即点击",
    );
  }

  return {
    needsRepair: reasons.length > 0,
    reasons: uniqueStrings(reasons),
  };
}

/**
 * 生成全静态失败时的打回重修提示词（既供外部 AI 一键贴回，也供内置 AI 自动返修使用）
 */
export function buildAiStaticFailurePrompt(
  input: {
    snapshot: ParsedGkdSnapshot;
    candidates: AiRuleCandidate[];
    verifications: AiCandidateVerification[];
    pickedNode: NormalizedSnapshotNode | null;
    qualityReasons?: string[];
    machineHint?: {
      matches: string[];
      action?: string;
    } | null;
    audience?: "external" | "builtin";
    options?: AiCandidateVerificationOptions;
  },
  options?: AiCandidateVerificationOptions,
): string {
  const {
    snapshot,
    candidates,
    verifications,
    pickedNode,
    qualityReasons = [],
    machineHint = null,
    audience = "external",
  } = input;
  const allowActionDelay = Boolean(
    options?.allowActionDelay ?? input.options?.allowActionDelay,
  );
  const lines: string[] = [
    "你上一轮生成的 GKD 规则测试版未能通过本地静态快照验证或稳定性体检，具体失败诊断如下：",
    "",
  ];

  if (qualityReasons.length > 0) {
    lines.push("【首选候选稳定性诊断】");
    for (const reason of qualityReasons) {
      lines.push(`- ${reason}`);
    }
    lines.push("");
  }

  candidates.forEach((c) => {
    const v = verifications.find((item) => item.candidateId === c.id);
    const entries = collectCandidateRuleEntries(snapshot, c, v);
    lines.push(`【${c.title} (${c.id})】`);

    if (entries.length === 0) {
      lines.push("- 诊断: 候选不包含任何规则。");
      lines.push("");
      return;
    }

    for (const entry of entries) {
      const rulePrefix =
        entries.length > 1
          ? `[组${entry.groupIndex + 1}/规则${entry.ruleIndex + 1}] `
          : "";
      const selectorParts: string[] = [];
      if (entry.matches.length > 0) {
        selectorParts.push(`matches: ${entry.matches.join(" && ")}`);
      }
      if (entry.anyMatches.length > 0) {
        selectorParts.push(`anyMatches: ${entry.anyMatches.join(" || ")}`);
      }
      lines.push(`- ${rulePrefix}生成的选择器: ${selectorParts.join(" | ") || "-"}`);

      const rv = entry.ruleVerification;
      const codes = rv?.failureCodes ?? v?.failureCodes ?? [];
      const hasChainedSpaceText = entry.allMatches.some((expr) =>
        /\[(?:text|desc)[^\]]*\][^\n]*\s+\[(?:text|desc)/.test(expr),
      );

      if (codes.includes("zero_hit")) {
        lines.push(
          `- ${rulePrefix}诊断: 快照中未找到任何匹配节点（0 命中）！请检查是否编造了不存在的 vid 或属性名。`,
        );
        if (hasChainedSpaceText) {
          lines.push(
            `- ${rulePrefix}语法纠偏: 你用连续空格串联了两个 [text=...]/[desc=...]（在 GKD 里空格表示祖先后代关系，平行同框节点必 0 命中！）。请拆成 matches 多段数组，如 ["[text=\\"文案A\\"]", "@ImageView[width<120 && height<120]"]，或使用 <<n / +。`,
          );
        }
      } else if (codes.includes("wrong_target")) {
        lines.push(
          `- ${rulePrefix}诊断: 匹配到了错误节点（${rv?.diagnostics.join("；") || "错靶"}），未命中用户选中的目标区域。`,
        );
      } else if (codes.includes("invalid_selector")) {
        lines.push(
          `- ${rulePrefix}诊断: 选择器语法无效，无法解析（${rv?.diagnostics.join("；") || "语法错误"}）。`,
        );
      } else if (codes.includes("app_mismatch")) {
        lines.push(
          `- ${rulePrefix}诊断: 规则 appId (${c.app.id}) 与快照 appId (${snapshot.appId}) 不匹配。`,
        );
      } else if (codes.includes("multi_hit")) {
        lines.push(
          `- ${rulePrefix}诊断: 命中了多个非目标节点（${rv?.diagnostics.join("；") || "多命中"}），必须补充上下文或祖先/兄弟锚点收窄到唯一目标。`,
        );
      } else if (codes.includes("unsatisfied_condition")) {
        lines.push(
          `- ${rulePrefix}诊断: ${rv?.diagnostics.join("；") || "规则被禁用（enable=false）或被 excludeMatches / anyMatches 条件拦下。"}`,
        );
      } else if (rv) {
        lines.push(
          `- ${rulePrefix}诊断: ${rv.diagnostics.join("；") || "静态验证通过，但需按上方稳定性诊断加固"}`,
        );
      }

      if (hasHardcodedPositionAttrs(entry.allMatches)) {
        lines.push(
          `- ${rulePrefix}坐标禁忌: 严禁使用 left=/top=/right=/bottom= 像素坐标！请删除坐标属性，改为使用弹窗内真实业务文案作前置 matches 锚点。`,
        );
      }
      if (hasDynamicCountdownLiteral(entry.allMatches)) {
        lines.push(
          `- ${rulePrefix}倒计时禁忌: 请勿写死倒计时数字，改用 text^=/text$= 或稳定容器 vid/id。`,
        );
      }
      if (hasIncompatibleFastQuery(snapshot, entry)) {
        lines.push(
          `- ${rulePrefix}fastQuery 纠偏: 当前选择器或 WebView 环境不支持 fastQuery: true，请设为 false 或省略。`,
        );
      }
      const effectiveDelay = resolveEffectiveDelay(entry.group, entry.rule);
      if (!allowActionDelay && effectiveDelay >= 1000) {
        lines.push(
          `- ${rulePrefix}延迟纠偏: 设置了 ${effectiveDelay}ms 延迟（actionDelay/delay），首选测试版 A/B 必须去掉延迟立即点击。`,
        );
      }
      const scopes = [entry.group.activityIds, entry.rule.activityIds]
        .flat()
        .filter((item): item is string => typeof item === "string" && item.length > 0);
      if (scopes.some((act) => isDynamicActivityId(act))) {
        lines.push(
          `- ${rulePrefix}动态 Activity 禁忌: activityIds 含动态数字/匿名后缀（${scopes.join(", ")}），请删去动态 activityIds。`,
        );
      }
      const isNonClickAction = Boolean(
        entry.rule.action && NON_CLICK_ACTIONS.has(entry.rule.action),
      );
      if (
        !isNonClickAction &&
        entry.hitNodes.some((node) => isDangerousCtaNode(node))
      ) {
        lines.push(
          `- ${rulePrefix}危险 CTA 禁忌: 命中节点包含下载/安装/打开/查看详情/跳转/购买等正向 CTA，严禁点击！`,
        );
      }
      if (
        !isNonClickAction &&
        entry.hitNodes.some((node) => isOverlayOrHotAreaNode(snapshot, node))
      ) {
        lines.push(
          `- ${rulePrefix}遮罩/热区禁忌: 命中节点面积占比 >35% 或含 shade/mask/hotArea/click_area 等热区词，严禁点击外层遮罩/热区！`,
        );
      }
    }
    lines.push("");
  });

  const contextAnchors = collectContextualAnchorLiterals(snapshot);
  if (pickedNode) {
    lines.push(
      "目标区域真实参考事实：",
      `- 目标节点: #${pickedNode.id} ${shortName(pickedNode.attr.name)} (clickable=${pickedNode.attr.clickable})`,
      pickedNode.attr.text ? `- 真实文本: [text=${JSON.stringify(pickedNode.attr.text)}]` : "",
      pickedNode.attr.desc ? `- 真实描述: [desc=${JSON.stringify(pickedNode.attr.desc)}]` : "",
      pickedNode.attr.vid ? `- 真实 vid: [vid="${pickedNode.attr.vid}"]` : "- vid: 无",
      pickedNode.attr.id ? `- 真实 id: [id="${pickedNode.attr.id}"]` : "- id: 无",
      contextAnchors.length > 0
        ? `- 同屏可用于防误触的业务文案锚点: ${contextAnchors.map((t) => JSON.stringify(t)).join("、")}`
        : "",
      "",
    );
  }

  if (machineHint && machineHint.matches.length > 0) {
    lines.push(
      "可运行的本地结构化参考基线（已通过本快照命中校验，可在此基础上补充多分支或兄弟防误触，不要退化为坐标定位）：",
      `- matches: ${JSON.stringify(machineHint.matches)}${machineHint.action ? ` | action: ${machineHint.action}` : ""}`,
      "",
    );
  }

  lines.push(
    "请根据上述具体诊断重新生成 2-3 个符合 JSON5 规范的候选规则：",
    "1. 严格使用快照中真实存在的属性，严禁编造 vid；树中只有 id= 的必须写 [id=\"...\"]。",
    "2. 若目标文本节点的 clickable=false，必须在可点击父容器前加 @，例如 @[clickable=true] > [text=\"...\"]；若无安全 clickable=true 祖先则必须设置 action: \"clickCenter\"。",
    "3. 禁止使用 left=/top=/right=/bottom= 坐标、动态倒计时数字、动态 activityIds 或点击正向 CTA；多文案锚点请写成 matches 多段数组（前段写上下文锚点、最后一段写点击目标），不要用连续空格串联。",
    audience === "builtin"
      ? "4. 只返回一个单一 JSON5 对象：{ candidates: [...] }，不要输出 Markdown 解释或测试反馈格式。"
      : "4. 所有测试版必须放在唯一一个 ```json5 代码块中，块内格式为 { candidates: [...] }。",
  );

  return lines.filter(Boolean).join("\n");
}

function candidateCoreFingerprint(candidate: AiRuleCandidate): string {
  const normalizedGroups = candidate.app.groups.map((group) => ({
    enable: group.enable ?? null,
    fastQuery: group.fastQuery ?? null,
    matchRoot: group.matchRoot ?? null,
    activityIds: group.activityIds ?? null,
    excludeActivityIds: group.excludeActivityIds ?? null,
    actionDelay:
      (group as { actionDelay?: number }).actionDelay ??
      (group as { delay?: number }).delay ??
      null,
    rules: group.rules.map((rule) => ({
      enable: rule.enable ?? null,
      matches: rule.matches ?? [],
      anyMatches: rule.anyMatches ?? [],
      excludeMatches: rule.excludeMatches ?? [],
      excludeAllMatches: rule.excludeAllMatches ?? [],
      action: rule.action ?? null,
      actionDelay: rule.actionDelay ?? (rule as { delay?: number }).delay ?? null,
      fastQuery: rule.fastQuery ?? null,
      matchRoot: rule.matchRoot ?? null,
      activityIds: rule.activityIds ?? null,
      excludeActivityIds: rule.excludeActivityIds ?? null,
      preKeys: rule.preKeys ?? null,
    })),
  }));
  return JSON.stringify({
    id: candidate.app.id,
    groups: normalizedGroups,
  });
}

function deduplicateCandidatesByRule(
  candidates: AiRuleCandidate[],
): AiRuleCandidate[] {
  const seenFingerprints = new Set<string>();
  const out: AiRuleCandidate[] = [];
  for (const cand of candidates) {
    const fp = candidateCoreFingerprint(cand);
    if (seenFingerprints.has(fp)) continue;
    seenFingerprints.add(fp);
    out.push(cand);
  }
  return out;
}

export interface AutoRepairLoopResult extends RerankedAiCandidatesResult {
  autoRepairTriggered: boolean;
  autoRepairReasons: string[];
  autoRepairSucceeded: boolean;
}

/**
 * 静默自动“写-测-改”闭环：首轮生成后做本地验靶与稳定性评估；
 * 若存在 0 命中、错靶、硬编码像素坐标、缺 clickCenter、高危遮罩/CTA、倒计时或缺业务锚点等问题，
 * 自动触发最多 maxRepairRounds 轮（默认 2 轮）靶向返修，一旦通过体检立即提前结束。
 */
export async function runAiAutoRepairLoop(
  input: {
    snapshot: ParsedGkdSnapshot;
    pickedNode: NormalizedSnapshotNode | null;
    initialCandidates: AiRuleCandidate[];
    machineHint?: { matches: string[]; action?: string } | null;
    maxRepairRounds?: number;
    requestRepairCandidates: (failurePrompt: string) => Promise<AiRuleCandidate[]>;
    options?: AiCandidateVerificationOptions;
  },
  options?: AiCandidateVerificationOptions,
): Promise<AutoRepairLoopResult> {
  const {
    snapshot,
    pickedNode,
    initialCandidates,
    machineHint = null,
    maxRepairRounds = 2,
    requestRepairCandidates,
  } = input;
  const effectiveOptions = options ?? input.options;

  const maxRounds = Math.max(0, Math.floor(maxRepairRounds));

  // 首轮确定性纠偏（只做一次，后续复用已纠偏候选避免重复计数）
  let totalRepairedCount = 0;
  let currentPool: AiRuleCandidate[] = initialCandidates.map((cand) => {
    const res = repairAiCandidate(cand, snapshot, pickedNode);
    if (res.repaired) totalRepairedCount += 1;
    return res.candidate;
  });

  const usedIds = new Set<string>(currentPool.map((c) => c.id));
  const repairCandidateIds = new Set<string>();

  let currentRanked = scoreAndRankPreRepaired(
    snapshot,
    currentPool,
    pickedNode,
    effectiveOptions,
  );
  const initialBestScore = currentRanked.bestScore;

  const initialAssessment = assessAiAutoRepairNeed(
    snapshot,
    {
      rankedCandidates: currentRanked.rankedCandidates,
      verifications: currentRanked.verifications,
      bestPassed: currentRanked.bestPassed,
      repairedCount: totalRepairedCount,
    },
    pickedNode,
    effectiveOptions,
  );

  if (!initialAssessment.needsRepair || maxRounds === 0) {
    return {
      rankedCandidates: currentRanked.rankedCandidates,
      verifications: currentRanked.verifications,
      bestPassed: currentRanked.bestPassed,
      repairedCount: totalRepairedCount,
      autoRepairTriggered: false,
      autoRepairReasons: [],
      autoRepairSucceeded: false,
    };
  }

  let latestAssessment = initialAssessment;
  let autoRepairTriggered = false;

  for (let round = 1; round <= maxRounds; round += 1) {
    if (!latestAssessment.needsRepair) break;

    autoRepairTriggered = true;
    const failurePrompt = buildAiStaticFailurePrompt(
      {
        snapshot,
        candidates: currentRanked.rankedCandidates,
        verifications: currentRanked.verifications,
        pickedNode,
        qualityReasons: latestAssessment.reasons,
        machineHint,
        audience: "builtin",
        options: effectiveOptions,
      },
      effectiveOptions,
    );

    let roundCandidates: AiRuleCandidate[] = [];
    try {
      roundCandidates = await requestRepairCandidates(failurePrompt);
    } catch {
      break;
    }

    if (roundCandidates.length === 0) {
      break;
    }

    const normalizedRepairs = roundCandidates.map((c, index) => {
      let nextId = c.id?.trim() || `ai-repair-r${round}-${index + 1}`;
      if (usedIds.has(nextId)) {
        let suffix = 1;
        while (usedIds.has(`${nextId}-r${round}-${suffix}`)) {
          suffix += 1;
        }
        nextId = `${nextId}-r${round}-${suffix}`;
      }
      usedIds.add(nextId);
      repairCandidateIds.add(nextId);

      const repaired = repairAiCandidate(
        { ...c, id: nextId },
        snapshot,
        pickedNode,
      );
      if (repaired.repaired) totalRepairedCount += 1;
      return repaired.candidate;
    });

    // 合并前按核心规则指纹语义去重，优先保留返修轮版本
    currentPool = deduplicateCandidatesByRule([
      ...normalizedRepairs,
      ...currentRanked.rankedCandidates,
    ]);
    currentRanked = scoreAndRankPreRepaired(
      snapshot,
      currentPool,
      pickedNode,
      effectiveOptions,
    );

    latestAssessment = assessAiAutoRepairNeed(
      snapshot,
      {
        rankedCandidates: currentRanked.rankedCandidates,
        verifications: currentRanked.verifications,
        bestPassed: currentRanked.bestPassed,
        repairedCount: totalRepairedCount,
      },
      pickedNode,
      effectiveOptions,
    );

    if (!latestAssessment.needsRepair) {
      break;
    }
  }

  const finalLimit = 4;
  const finalCandidates = currentRanked.rankedCandidates.slice(0, finalLimit);
  const finalVerifications = currentRanked.verifications.slice(0, finalLimit);
  const topCandidate = finalCandidates[0];
  const topFromRepair = Boolean(
    topCandidate && repairCandidateIds.has(topCandidate.id),
  );
  const autoRepairSucceeded = Boolean(
    autoRepairTriggered &&
      topFromRepair &&
      (currentRanked.bestPassed || !latestAssessment.needsRepair) &&
      (currentRanked.bestScore > initialBestScore || !latestAssessment.needsRepair),
  );

  return {
    rankedCandidates: finalCandidates,
    verifications: finalVerifications,
    bestPassed: currentRanked.bestPassed,
    repairedCount: totalRepairedCount,
    autoRepairTriggered,
    autoRepairReasons: initialAssessment.reasons,
    autoRepairSucceeded,
  };
}

function executionReadinessAdjustment(
  snapshot: ParsedGkdSnapshot,
  candidate: AiRuleCandidate,
  verification: AiCandidateVerification,
  options?: AiCandidateVerificationOptions,
): number {
  const entries = collectCandidateRuleEntries(snapshot, candidate, verification);
  if (entries.length === 0) return 0;

  let delta = 0;
  let unclickablePenalized = false;
  let overlayPenalized = false;
  let ctaPenalized = false;
  let dynamicActivityPenalized = false;
  let countdownPenalized = false;
  let coordsPenalized = false;
  let noSemanticPenalized = false;
  let genericSystemIdPenalized = false;
  let fastQueryPenalized = false;
  let maxDelay = 0;

  let rulesWithSelectors = 0;
  let rulesWithAnchor = 0;

  for (const entry of entries) {
    const action = entry.rule.action;
    const isNonClickAction = Boolean(action && NON_CLICK_ACTIONS.has(action));
    const isCenterClick = Boolean(action && CENTER_CLICK_ACTIONS.has(action));

    // 1. 实际点击目标（hitNodes[0]）clickable=false 检查，豁免 clickCenter/longClickCenter/back/swipe/none
    if (
      !unclickablePenalized &&
      !isNonClickAction &&
      !isCenterClick &&
      entry.primaryHitNode &&
      !entry.primaryHitNode.attr.clickable
    ) {
      delta -= 30;
      unclickablePenalized = true;
    }

    // 2. 命中大面积遮罩（>35%）或广告热区关键词
    if (
      !overlayPenalized &&
      !isNonClickAction &&
      entry.hitNodes.some((node) => isOverlayOrHotAreaNode(snapshot, node))
    ) {
      delta -= 40;
      overlayPenalized = true;
    }

    // 3. 命中危险正向 CTA 词（下载/安装/打开/查看详情/了解更多/跳转/购买）
    if (
      !ctaPenalized &&
      !isNonClickAction &&
      entry.hitNodes.some((node) => isDangerousCtaNode(node))
    ) {
      delta -= 45;
      ctaPenalized = true;
    }

    // 4. 动态 activityIds
    const scopes = [entry.group.activityIds, entry.rule.activityIds]
      .flat()
      .filter((item): item is string => typeof item === "string" && item.length > 0);
    if (!dynamicActivityPenalized && scopes.some((act) => isDynamicActivityId(act))) {
      delta -= 15;
      dynamicActivityPenalized = true;
    }

    // 5. 精确倒计时文本字面量
    if (!countdownPenalized && hasDynamicCountdownLiteral(entry.allMatches)) {
      delta -= 20;
      countdownPenalized = true;
    }

    // 6. 硬编码像素坐标（含复合括号）
    if (!coordsPenalized && hasHardcodedPositionAttrs(entry.allMatches)) {
      delta -= 40;
      coordsPenalized = true;
    }

    // 7. 语义属性 / 系统框架 ID 检查
    if (entry.allMatches.length > 0) {
      rulesWithSelectors += 1;
      if (!noSemanticPenalized && !hasSemanticAttrInSelectors(entry.allMatches)) {
        delta -= 25;
        noSemanticPenalized = true;
      } else if (
        !genericSystemIdPenalized &&
        hasOnlyGenericSystemId(entry.allMatches)
      ) {
        delta -= 25;
        genericSystemIdPenalized = true;
      }

      if (hasNonGenericContextualAnchor(entry.matches, entry.anyMatches)) {
        rulesWithAnchor += 1;
      }
    }

    // 8. fastQuery 不兼容惩罚（防御未经 repairAiCandidate 直接调用的情况）
    if (!fastQueryPenalized && hasIncompatibleFastQuery(snapshot, entry)) {
      delta -= 25;
      fastQueryPenalized = true;
    }

    // 9. 继承的 actionDelay / delay
    const effectiveDelay = resolveEffectiveDelay(entry.group, entry.rule);
    if (effectiveDelay > maxDelay) maxDelay = effectiveDelay;
  }

  if (rulesWithSelectors > 0) {
    if (rulesWithAnchor === rulesWithSelectors) {
      delta += 12;
    } else if (collectContextualAnchorLiterals(snapshot).length > 0) {
      delta -= 15;
    }
  }

  if (!options?.allowActionDelay && maxDelay >= 1000) {
    delta -= maxDelay >= 2000 ? 30 : 20;
  }

  return delta;
}
