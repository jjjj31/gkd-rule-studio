import type { AiCandidateVerification } from "../src/lib/aiCandidateVerification";
import type { AiRuleCandidate } from "../src/lib/aiModel";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../src/types/gkdSnapshot";

export const AI_FAILURE_CATEGORY_LABELS = {
  selector_syntax: "选择器语法错",
  attribute_value: "属性名/值错",
  text_mismatch: "文字不匹配",
  structure_condition: "结构条件错",
  wrong_target: "选错节点",
  format_parse: "格式解析失败",
  unclassified: "待人工归类",
} as const;

export type AiFailureCategory = keyof typeof AI_FAILURE_CATEGORY_LABELS;

export interface AiFailureEvidence {
  category: AiFailureCategory;
  label: string;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  failureCodes: string[];
  selectors: string[];
}

export interface SelectorLiteral {
  attr: string;
  operator: string;
  value: string;
  raw: string;
}

export function classifyRequestError(message: string): AiFailureEvidence {
  const selectorSyntax = /选择器语法错误|SyntaxException|Expect\s+(?:EOF|WHITESPACE).*index|at\s+index\s+\d+/i.test(
    message,
  );
  if (selectorSyntax) {
    return evidence(
      "selector_syntax",
      "high",
      ["响应中的 selector 未通过语法解析。"],
      [],
      [],
    );
  }

  const formatError =
    /JSON5|Unexpected token|not valid JSON|不是有效|缺少\s*app|候选.*必须是对象|app\s*不合法/i.test(
      message,
    );
  if (formatError) {
    return evidence(
      "format_parse",
      "high",
      ["响应无法解析成约定的 candidates/app 结构。"],
      [],
      [],
    );
  }

  return evidence(
    "unclassified",
    "low",
    ["请求失败不属于六类规则错误，需要查看原始错误。"],
    [],
    [],
  );
}

export function classifyVerificationFailure({
  snapshot,
  candidate,
  verification,
  targetNode,
}: {
  snapshot: ParsedGkdSnapshot;
  candidate: AiRuleCandidate;
  verification: AiCandidateVerification;
  targetNode: NormalizedSnapshotNode;
}): AiFailureEvidence | null {
  if (verification.status === "pass" || verification.failureCodes.length === 0) {
    return null;
  }

  const failingRules = verification.rules.filter(
    (rule) => rule.status !== "pass" && rule.matches.length > 0,
  );
  const selectors = failingRules.flatMap((rule) => rule.matches);
  const codes = verification.failureCodes;

  if (codes.includes("invalid_selector")) {
    return evidence(
      "selector_syntax",
      "high",
      ["本地 selector 解析器明确报语法错误。"],
      codes,
      selectors,
    );
  }

  if (codes.includes("wrong_target") || codes.includes("multi_hit")) {
    return evidence(
      "wrong_target",
      "high",
      verification.diagnostics,
      codes,
      selectors,
    );
  }

  if (codes.includes("unsatisfied_condition")) {
    return evidence(
      "structure_condition",
      "medium",
      [
        ...verification.diagnostics,
        "selector 语法可解析，但排除条件或 anyMatches 分支没有同时满足。",
      ],
      codes,
      selectors,
    );
  }

  if (codes.includes("zero_hit")) {
    return classifyZeroHit({
      snapshot,
      candidate,
      targetNode,
      selectors,
      codes,
      diagnostics: verification.diagnostics,
    });
  }

  return evidence(
    "unclassified",
    "low",
    verification.diagnostics.length > 0
      ? verification.diagnostics
      : [`未归类失败：${codes.join(", ")}`],
    codes,
    selectors,
  );
}

function classifyZeroHit({
  snapshot,
  candidate,
  targetNode,
  selectors,
  codes,
  diagnostics,
}: {
  snapshot: ParsedGkdSnapshot;
  candidate: AiRuleCandidate;
  targetNode: NormalizedSnapshotNode;
  selectors: string[];
  codes: string[];
  diagnostics: string[];
}): AiFailureEvidence {
  const literals = selectors.flatMap(extractSelectorLiterals);
  const missingText = literals.filter(
    (literal) =>
      (literal.attr === "text" || literal.attr === "desc") &&
      !snapshotHasAttrValue(snapshot, literal.attr, literal.operator, literal.value),
  );
  const missingAttr = literals.filter(
    (literal) =>
      literal.attr !== "text" &&
      literal.attr !== "desc" &&
      !snapshotHasAttrValue(snapshot, literal.attr, literal.operator, literal.value),
  );
  const missingClass = selectors
    .flatMap(extractClassTokens)
    .filter((token) => !snapshotHasClassName(snapshot, token));
  const hasStructure = selectors.some(selectorHasStructure);
  const targetText = targetNode.attr.text || targetNode.attr.desc || "";
  const reasons = [...diagnostics];

  if (missingText.length > 0) {
    reasons.push(
      `selector 引用的文字在快照中不存在：${missingText
        .map((literal) => `${literal.attr}${literal.operator}${JSON.stringify(literal.value)}`)
        .join("；")}。`,
    );
    if (targetText) {
      reasons.push(`用户目标节点的文字是 ${JSON.stringify(targetText)}。`);
    }
    return evidence("text_mismatch", "high", reasons, codes, selectors);
  }

  if (missingAttr.length > 0 || missingClass.length > 0) {
    const missing = [
      ...missingAttr.map(
        (literal) => `${literal.attr}${literal.operator}${JSON.stringify(literal.value)}`,
      ),
      ...missingClass.map((token) => `class=${JSON.stringify(token)}`),
    ];
    reasons.push(`selector 引用的属性值或类名在快照中不存在：${missing.join("；")}。`);
    return evidence("attribute_value", "high", reasons, codes, selectors);
  }

  if (hasStructure) {
    reasons.push(
      "selector 的字面值都能在快照中找到，但层级、兄弟或父子条件没有命中。",
    );
    return evidence("structure_condition", "medium", reasons, codes, selectors);
  }

  reasons.push(
    "selector 字面值存在但零命中，优先怀疑可见性、索引、逻辑组合或未覆盖的运行时条件。",
  );
  return evidence(
    "structure_condition",
    "low",
    reasons,
    codes,
    selectors,
  );
}

export function extractSelectorLiterals(selector: string): SelectorLiteral[] {
  const literals: SelectorLiteral[] = [];
  const pattern =
    /\[\s*([A-Za-z_$][\w$]*)\s*(=|\^=|\$=|\*=|~=)\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\]]+?))\s*\]/g;
  for (const match of selector.matchAll(pattern)) {
    const attr = match[1];
    const operator = match[2];
    const rawValue = match[3] ?? match[4] ?? match[5] ?? "";
    const value = unescapeQuotedValue(rawValue.trim());
    if (attr && operator && value) {
      literals.push({
        attr,
        operator,
        value,
        raw: match[0],
      });
    }
  }
  return literals;
}

export function selectorHasStructure(selector: string): boolean {
  return (
    /@/.test(selector) ||
    /\s[>+~]\s/.test(selector) ||
    /\bgetChild\s*\(/.test(selector) ||
    /\b(?:parent|child|sibling|index)\b/i.test(selector)
  );
}

function snapshotHasAttrValue(
  snapshot: ParsedGkdSnapshot,
  attr: string,
  operator: string,
  value: string,
): boolean {
  return snapshot.nodes.some((node) =>
    attrValues(node, attr).some((candidate) =>
      compareAttrValue(candidate, operator, value),
    ),
  );
}

function attrValues(node: NormalizedSnapshotNode, attr: string): string[] {
  switch (attr) {
    case "text":
      return node.attr.text ? [node.attr.text] : [];
    case "desc":
      return node.attr.desc ? [node.attr.desc] : [];
    case "vid":
      return node.attr.vid ? [node.attr.vid] : [];
    case "id":
      return node.attr.id
        ? [
            node.attr.id,
            node.attr.id.split(":id/").at(-1) ?? "",
            node.attr.id.split("/").at(-1) ?? "",
          ].filter(Boolean)
        : [];
    case "name":
    case "class":
      return [
        node.attr.name,
        node.attr.name.split(".").at(-1) ?? "",
      ].filter(Boolean);
    case "clickable":
    case "focusable":
    case "checkable":
    case "checked":
    case "editable":
    case "longClickable":
    case "visibleToUser":
      return [String(node.attr[attr])];
    case "childCount":
    case "index":
    case "depth":
    case "left":
    case "top":
    case "right":
    case "bottom":
    case "width":
    case "height":
      return [String(node.attr[attr])];
    default:
      return [];
  }
}

function compareAttrValue(
  candidate: string,
  operator: string,
  expected: string,
): boolean {
  switch (operator) {
    case "^=":
      return candidate.startsWith(expected);
    case "$=":
      return candidate.endsWith(expected);
    case "*=":
      return candidate.includes(expected);
    case "~=":
      try {
        return new RegExp(expected).test(candidate);
      } catch {
        return candidate === expected;
      }
    default:
      return candidate === expected || normalizeWhitespace(candidate) === normalizeWhitespace(expected);
  }
}

function extractClassTokens(selector: string): string[] {
  const withoutAttributes = selector.replace(/\[[^\]]*\]/g, " ");
  const tokens = withoutAttributes.match(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Z][A-Za-z0-9_$]*\b/g) ?? [];
  return [...new Set(tokens)];
}

function snapshotHasClassName(snapshot: ParsedGkdSnapshot, token: string): boolean {
  return snapshot.nodes.some(
    (node) =>
      node.attr.name === token ||
      (node.attr.name.split(".").at(-1) ?? "") === token,
  );
}

function unescapeQuotedValue(value: string): string {
  return value.replace(/\\(["'\\])/g, "$1").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function evidence(
  category: AiFailureCategory,
  confidence: AiFailureEvidence["confidence"],
  reasons: string[],
  failureCodes: string[],
  selectors: string[],
): AiFailureEvidence {
  return {
    category,
    label: AI_FAILURE_CATEGORY_LABELS[category],
    confidence,
    reasons: [...new Set(reasons.filter(Boolean))],
    failureCodes,
    selectors,
  };
}
