import type { AiRuleCandidate } from "./aiModel";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { AppRuleDraft, RuleDraft } from "../types/ruleDraft";
import { validateAppRuleAgainstSnapshot } from "./selectorMatcher";
import { buildVisualTargetIds } from "./visualTarget";

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
  // 视觉摞：文字、图标、背景容器常常完全重合，点中其中任何一个都算点对。
  const targetIds = pickedNode
    ? buildVisualTargetIds({ snapshot, pickedNode })
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

  let status: AiCandidateVerification["status"];
  if (candidate.app.id !== snapshot.appId || rules.length === 0) {
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
  const matches = [...rule.matches];

  if (appIdMismatch) {
    failureCodes.add("app_mismatch");
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

  if (matches.length === 0) {
    failureCodes.add("missing_matches");
    diagnostics.push("规则没有 matches。");
    return ruleResult({
      groupIndex,
      ruleIndex,
      matches,
      status: "fail",
      hitNodes: [],
      pickedNode,
      targetIds,
      failureCodes,
      diagnostics,
    });
  }

  // 只保留选择器条件：activity/version 范围单独报告，不参与命中计算，
  // 否则 activity 不一致时会把本来能命中的 selector 误判成 0 命中。
  const validation = validateAppRuleAgainstSnapshot(snapshot, {
    id: snapshot.appId,
    name: "AI 候选验证",
    groups: [
      {
        key: 0,
        name: "verify",
        rules: [
          {
            key: rule.key ?? 0,
            matches,
            ...(rule.anyMatches ? { anyMatches: rule.anyMatches } : {}),
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
    // 纯粹的「末项没打到节点」交给下面的 zero_hit 报告；
    // 这里只区分被排除条件否决、或 anyMatches 全部分支未命中。
    const vetoed = (validation.excludedMatches?.length ?? 0) > 0;
    const anyBranchMiss = (rule.anyMatches?.length ?? 0) > 0;
    if (vetoed || anyBranchMiss) {
      failureCodes.add("unsatisfied_condition");
      diagnostics.push(
        validation.diagnostics?.join("；") ||
          "规则条件不满足：被 excludeMatches 否决，或 anyMatches 全部分支未命中。",
      );
    }
  }

  if (hitNodes.length === 0) {
    if (
      !failureCodes.has("invalid_selector") &&
      !failureCodes.has("partial_scope") &&
      !failureCodes.has("unsatisfied_condition")
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
    pickedNode === null
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
    activityMatches(snapshot, excludeActivityIds)
  ) {
    return {
      mismatch: true,
      message: `规则排除当前 Activity：${formatScopeValue(excludeActivityIds)}，快照是 ${snapshot.activityId ?? "未知"}。`,
    };
  }

  const activityIds =
    rule.activityIds === undefined ? group.activityIds : rule.activityIds;
  if (activityIds !== undefined && !activityMatches(snapshot, activityIds)) {
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
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (!snapshot.activityId) return false;
  const ids = (Array.isArray(value) ? value : [value]).map((id) =>
    id.startsWith(".") ? `${snapshot.appId}${id}` : id,
  );
  return ids.some((id) => snapshot.activityId!.startsWith(id));
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

/**
 * 针对大模型高频出现的机械错误进行确定性纠偏：
 * 1. 把快照中实际只存在 id="pkg:id/xxx" 的节点误写成 vid="xxx"（且快照中全无 vid="xxx"）
 * 2. 把快照中实际只存在 vid="xxx" 的节点误写成 id="xxx"
 */
export function repairAiCandidateSelector(
  selector: string,
  snapshot: ParsedGkdSnapshot,
): { selector: string; repaired: boolean; note?: string } {
  let modified = selector;
  let hasRepair = false;
  const notes: string[] = [];

  // 检测 [vid="xxx"]
  const vidRegex = /\[vid=(["'])(.*?)\1\]/g;
  modified = modified.replace(vidRegex, (fullMatch, quote, vidValue) => {
    const hasRealVid = snapshot.nodes.some((n) => n.attr.vid === vidValue);
    if (hasRealVid) return fullMatch;

    const matchingNode = snapshot.nodes.find(
      (n) =>
        n.attr.id &&
        (n.attr.id === `${snapshot.appId}:id/${vidValue}` ||
          n.attr.id.endsWith(`:id/${vidValue}`) ||
          n.attr.id.endsWith(`/${vidValue}`)),
    );

    if (matchingNode && matchingNode.attr.id) {
      hasRepair = true;
      notes.push(`将不存在的 vid="${vidValue}" 纠正为真实存在的 id="${matchingNode.attr.id}"`);
      return `[id=${quote}${matchingNode.attr.id}${quote}]`;
    }

    return fullMatch;
  });

  // 检测 [id="xxx"] (若误将纯 vid 写成 id 且全无该 id)
  const idRegex = /\[id=(["'])(.*?)\1\]/g;
  modified = modified.replace(idRegex, (fullMatch, quote, idValue) => {
    const hasRealId = snapshot.nodes.some((n) => n.attr.id === idValue);
    if (hasRealId) return fullMatch;

    const matchingNode = snapshot.nodes.find((n) => n.attr.vid === idValue);
    if (matchingNode && matchingNode.attr.vid) {
      hasRepair = true;
      notes.push(`将不存在的 id="${idValue}" 纠正为真实存在的 vid="${matchingNode.attr.vid}"`);
      return `[vid=${quote}${matchingNode.attr.vid}${quote}]`;
    }

    return fullMatch;
  });

  return {
    selector: modified,
    repaired: hasRepair,
    note: notes.length > 0 ? notes.join("；") : undefined,
  };
}

/**
 * 对一个 AI 候选的所有选择器进行确定性自动纠偏
 */
export function repairAiCandidate(
  candidate: AiRuleCandidate,
  snapshot: ParsedGkdSnapshot,
): { candidate: AiRuleCandidate; repaired: boolean; changes: string[] } {
  let anyRepaired = false;
  const allChanges: string[] = [];

  const nextGroups = candidate.app.groups.map((group) => {
    const nextRules = group.rules.map((rule) => {
      let ruleRepaired = false;
      const nextMatches = rule.matches.map((selector) => {
        const res = repairAiCandidateSelector(selector, snapshot);
        if (res.repaired) {
          ruleRepaired = true;
          anyRepaired = true;
          if (res.note) allChanges.push(res.note);
          return res.selector;
        }
        return selector;
      });

      const nextAnyMatches = rule.anyMatches
        ? rule.anyMatches.map((selector) => {
            const res = repairAiCandidateSelector(selector, snapshot);
            if (res.repaired) {
              ruleRepaired = true;
              anyRepaired = true;
              if (res.note) allChanges.push(res.note);
              return res.selector;
            }
            return selector;
          })
        : undefined;

      if (!ruleRepaired) return rule;
      return {
        ...rule,
        matches: nextMatches,
        ...(nextAnyMatches ? { anyMatches: nextAnyMatches } : {}),
      };
    });

    return { ...group, rules: nextRules };
  });

  if (!anyRepaired) {
    return { candidate, repaired: false, changes: [] };
  }

  const repairedSummary = candidate.summary
    ? `${candidate.summary} (已自动纠偏: ${allChanges.join("，")})`
    : `(已自动纠偏: ${allChanges.join("，")})`;

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
    changes: allChanges,
  };
}

export interface RerankedAiCandidatesResult {
  rankedCandidates: AiRuleCandidate[];
  verifications: AiCandidateVerification[];
  bestPassed: boolean;
  repairedCount: number;
}

/**
 * 本地静态验证重排：对候选执行自动纠偏、静态验证和多维度打分，高置信度通过的候选排在首位
 */
export function rerankAiCandidates(
  snapshot: ParsedGkdSnapshot,
  candidates: AiRuleCandidate[],
  pickedNode: NormalizedSnapshotNode | null,
): RerankedAiCandidatesResult {
  let repairedCount = 0;
  const repairedCandidates = candidates.map((candidate) => {
    const res = repairAiCandidate(candidate, snapshot);
    if (res.repaired) repairedCount += 1;
    return res.candidate;
  });

  const verifications = verifyAiCandidates(snapshot, repairedCandidates, pickedNode);
  const verifByCandidateId = new Map<string, AiCandidateVerification>();
  verifications.forEach((v) => verifByCandidateId.set(v.candidateId, v));

  const scored = repairedCandidates.map((candidate, originalIndex) => {
    const v = verifByCandidateId.get(candidate.id);
    let score = 0;

    if (v) {
      if (v.status === "pass") {
        if (v.hitPickedNode) {
          score = v.extraNodeIds.length === 0 ? 100 : 75;
        } else {
          score = 55;
        }
      } else if (v.status === "unknown" && v.failureCodes.includes("picked_node_missing")) {
        // 未选点场景：无法判断是否点中目标，但能成功匹配快照节点的候选应优于 0 命中或语法错误
        if (v.matchedNodeIds.length === 1 && !v.failureCodes.includes("zero_hit")) {
          score = 65; // 单节点命中
        } else if (v.matchedNodeIds.length > 1 && !v.failureCodes.includes("zero_hit")) {
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
  const bestScore = scored[0]?.score ?? 0;
  const bestPassed = bestScore >= 70;

  return {
    rankedCandidates,
    verifications: rankedVerifications,
    bestPassed,
    repairedCount,
  };
}

/**
 * 生成全静态失败时的打回重修提示词（零成本一键贴回外部 AI）
 */
export function buildAiStaticFailurePrompt(input: {
  snapshot: ParsedGkdSnapshot;
  candidates: AiRuleCandidate[];
  verifications: AiCandidateVerification[];
  pickedNode: NormalizedSnapshotNode | null;
}): string {
  const { snapshot, candidates, verifications, pickedNode } = input;
  const lines: string[] = [
    "你上一轮生成的 GKD 规则测试版未能通过本地静态快照验证，具体失败诊断如下：",
    "",
  ];

  candidates.forEach((c) => {
    const v = verifications.find((item) => item.candidateId === c.id);
    const rule = c.app.groups[0]?.rules[0];
    const selector = rule?.matches?.join(" ") || "-";
    lines.push(`【${c.title} (${c.id})】`);
    lines.push(`- 生成的选择器: ${selector}`);
    if (v) {
      if (v.failureCodes.includes("zero_hit")) {
        lines.push("- 诊断: 快照中未找到任何匹配节点（0 命中）！请检查是否编造了不存在的 vid 或属性名。");
      } else if (v.failureCodes.includes("wrong_target")) {
        lines.push("- 诊断: 匹配到了错误节点，未命中用户选中的目标区域。");
      } else if (v.failureCodes.includes("invalid_selector")) {
        lines.push("- 诊断: 选择器语法无效，无法解析。");
      } else if (v.failureCodes.includes("app_mismatch")) {
        lines.push(`- 诊断: 规则 appId (${c.app.id}) 与快照 appId (${snapshot.appId}) 不匹配。`);
      } else {
        lines.push(`- 诊断: ${v.diagnostics.join("；") || "静态验证未通过"}`);
      }
    }
    lines.push("");
  });

  if (pickedNode) {
    lines.push(
      "目标区域真实参考事实：",
      `- 目标节点: #${pickedNode.id} ${shortName(pickedNode.attr.name)} (clickable=${pickedNode.attr.clickable})`,
      pickedNode.attr.text ? `- 真实文本: [text=${JSON.stringify(pickedNode.attr.text)}]` : "",
      pickedNode.attr.desc ? `- 真实描述: [desc=${JSON.stringify(pickedNode.attr.desc)}]` : "",
      pickedNode.attr.vid ? `- 真实 vid: [vid="${pickedNode.attr.vid}"]` : "- vid: 无",
      pickedNode.attr.id ? `- 真实 id: [id="${pickedNode.attr.id}"]` : "- id: 无",
      "",
    );
  }

  lines.push(
    "请根据上述具体诊断重新生成 2-3 个符合 JSON5 规范的候选规则：",
    "1. 严格使用快照中真实存在的属性，严禁编造 vid；树中只有 id= 的必须写 [id=\"...\"]。",
    "2. 若目标文本节点的 clickable=false，必须在可点击父容器前加 @，例如 @[clickable=true] > [text=\"...\"]。",
    "3. 所有测试版必须放在唯一一个 ```json5 代码块中，块内格式为 { candidates: [...] }。",
  );

  return lines.filter(Boolean).join("\n");
}
