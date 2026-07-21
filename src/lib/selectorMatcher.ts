import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type {
  SelectorAttr,
  SelectorCondition,
  SelectorOperator,
  SelectorPlan,
  SelectorValidation,
  SimpleSelector,
} from "../types/ruleDraft";
import type { AiRuleCandidate } from "./aiModel";

// GKD 关系选择器解析后的中间结构：一条 matches 字符串 = 一串带关系的段。
// 第一个段 relation 为 "root"，后续段携带它和前一段的关系算子。
type GkdRelation =
  | "root"
  | "child" // >   直系父子（左是右的父，depth 差 1）
  | "parent" // <   左是右的子（即右是左的祖先，任意 depth）
  | "next" // +N  右在左后面第 N 个兄弟
  | "previous"; // -N  右在左前面第 N 个兄弟

interface GkdSegment {
  relation: GkdRelation;
  selector: SimpleSelector;
  isClickTarget: boolean; // 该段是否有 @ 标记
  // 兄弟关系专用：距离。数字=固定；number[]=元组；"n"=多项式简写。
  // 复杂多项式 (2n+3) 解析失败就整条降级。
  distance?: number | number[] | "n";
}

interface GkdSelectorExpr {
  segments: GkdSegment[];
}

export function validateSelectorPlan(
  snapshot: ParsedGkdSnapshot,
  plan: SelectorPlan,
): SelectorValidation {
  switch (plan.kind) {
    case "simple": {
      const clickNodes = matchSimpleSelector(snapshot, plan.selector);
      return { hitCount: clickNodes.length, clickNodes, supportNodes: [] };
    }
    case "parentChild": {
      const parents = matchSimpleSelector(snapshot, plan.parent);
      const childMatches = new Set(matchSimpleSelector(snapshot, plan.child).map((node) => node.id));
      const pairs = parents.flatMap((parent) =>
        parent.children
          .map((childId) => snapshot.nodeById.get(childId))
          .filter((child): child is NormalizedSnapshotNode => {
            return Boolean(child && childMatches.has(child.id));
          })
          .map((child) => ({ parent, child })),
      );
      const clickNodes = uniqueNodes(
        pairs.map((pair) =>
          plan.clickTarget === "parent" ? pair.parent : pair.child,
        ),
      );
      return {
        hitCount: clickNodes.length,
        clickNodes,
        supportNodes: uniqueNodes(pairs.map((pair) => pair.child)),
      };
    }
    case "sibling": {
      const pairs = matchSiblingPairs(snapshot, plan.target, plan.neighbor, plan);
      const clickNodes = uniqueNodes(pairs.map((pair) => pair.target));
      return {
        hitCount: clickNodes.length,
        clickNodes,
        supportNodes: uniqueNodes(pairs.map((pair) => pair.neighbor)),
      };
    }
    case "contextSibling": {
      const pairs = matchSiblingPairs(snapshot, plan.context, plan.target, plan);
      const clickNodes = uniqueNodes(pairs.map((pair) => pair.neighbor));
      return {
        hitCount: clickNodes.length,
        clickNodes,
        supportNodes: uniqueNodes(pairs.map((pair) => pair.target)),
      };
    }
    case "matchesChain": {
      const contextNodes = matchSimpleSelector(snapshot, plan.context);
      const targetNodes = contextNodes.length
        ? matchSimpleSelector(snapshot, plan.target)
        : [];
      return {
        hitCount: targetNodes.length,
        clickNodes: targetNodes,
        supportNodes: contextNodes,
      };
    }
    case "ancestorDescendant": {
      const ancestors = matchSimpleSelector(snapshot, plan.ancestor);
      const ancestorIds = new Set(ancestors.map((node) => node.id));
      const descendants = matchSimpleSelector(snapshot, plan.descendant).filter((node) =>
        hasAncestor(snapshot, node, ancestorIds),
      );
      return {
        hitCount: descendants.length,
        clickNodes: descendants,
        supportNodes: ancestors,
      };
    }
  }
}

export function matchSimpleSelector(
  snapshot: ParsedGkdSnapshot,
  selector: SimpleSelector,
): NormalizedSnapshotNode[] {
  return snapshot.nodes.filter((node) => {
    if (!matchesType(node, selector.typeName)) return false;
    return selector.conditions.every((condition) => matchesCondition(node, condition));
  });
}

function matchSiblingPairs(
  snapshot: ParsedGkdSnapshot,
  firstSelector: SimpleSelector,
  secondSelector: SimpleSelector,
  relation: { relation: "next" | "previous"; distance: number | number[] | "n" },
): Array<{ target: NormalizedSnapshotNode; neighbor: NormalizedSnapshotNode }> {
  const firstNodes = matchSimpleSelector(snapshot, firstSelector);
  const secondIds = new Set(matchSimpleSelector(snapshot, secondSelector).map((node) => node.id));
  const pairs: Array<{ target: NormalizedSnapshotNode; neighbor: NormalizedSnapshotNode }> = [];

  // 计算要尝试的偏移量集合。
  // 数字 → 单个偏移；数组 → 每个元素都尝试；"n" → 所有合法正整数偏移。
  const sign = relation.relation === "next" ? 1 : -1;
  const offsets: number[] = [];
  if (relation.distance === "n") {
    // +(n) 等价于 +(1n+0)，从 1 起递增到父节点子节点数量上限。
    // 实际上限由 parent.children.length 决定，下面逐个尝试。
    offsets.push(-1); // 标记：稍后用动态范围处理
  } else if (Array.isArray(relation.distance)) {
    offsets.push(...relation.distance.map((d) => d * sign));
  } else {
    offsets.push(relation.distance * sign);
  }

  for (const firstNode of firstNodes) {
    if (firstNode.pid < 0) continue;
    const parent = snapshot.nodeById.get(firstNode.pid);
    if (!parent) continue;

    const siblingIndex = parent.children.indexOf(firstNode.id);
    if (siblingIndex < 0) continue;

    const tryOffsets =
      relation.distance === "n"
        ? // +(n)：尝试所有正方向（直到数组越界）的偏移，教程 §5.3.2.3.2。
          Array.from(
            { length: parent.children.length },
            (_, i) => (i + 1) * sign,
          )
        : offsets;

    for (const offset of tryOffsets) {
      const neighborId = parent.children[siblingIndex + offset];
      const neighbor =
        neighborId === undefined ? undefined : snapshot.nodeById.get(neighborId);

      if (neighbor && secondIds.has(neighbor.id)) {
        // 同一个 firstNode 可能匹配多个 neighbor（元组/多项式场景），都保留。
        if (!pairs.some((p) => p.target.id === firstNode.id && p.neighbor.id === neighbor.id)) {
          pairs.push({ target: firstNode, neighbor });
        }
      }
    }
  }

  return pairs;
}

function matchesType(node: NormalizedSnapshotNode, typeName?: string): boolean {
  if (!typeName || typeName === "*") return true;
  const actual = node.attr.name.split(".").at(-1) ?? node.attr.name;
  return actual === typeName || node.attr.name === typeName;
}

function matchesCondition(
  node: NormalizedSnapshotNode,
  condition: SelectorCondition,
): boolean {
  const value = readAttr(node, condition.attr);

  switch (condition.op) {
    case "eq":
      return value === condition.value;
    case "notEq":
      return value !== condition.value;
    case "contains":
      return typeof value === "string" && value.includes(String(condition.value));
    case "startsWith":
      return typeof value === "string" && value.startsWith(String(condition.value));
    case "notStartsWith":
      return typeof value === "string" && !value.startsWith(String(condition.value));
    case "endsWith":
      return typeof value === "string" && value.endsWith(String(condition.value));
    case "notEndsWith":
      return typeof value === "string" && !value.endsWith(String(condition.value));
    case "lt":
      return typeof value === "number" && value < Number(condition.value);
    case "lte":
      return typeof value === "number" && value <= Number(condition.value);
    case "gt":
      return typeof value === "number" && value > Number(condition.value);
    case "gte":
      return typeof value === "number" && value >= Number(condition.value);
    case "orEq":
      // 任一字符串命中即可，用于同义否定词/简繁变体合并。
      return (
        typeof value === "string" &&
        Array.isArray(condition.value) &&
        condition.value.includes(value)
      );
  }
}

function hasAncestor(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
  ancestorIds: Set<number>,
): boolean {
  let currentPid = node.pid;
  while (currentPid >= 0) {
    if (ancestorIds.has(currentPid)) return true;
    currentPid = snapshot.nodeById.get(currentPid)?.pid ?? -1;
  }
  return false;
}

function readAttr(
  node: NormalizedSnapshotNode,
  attr: SelectorCondition["attr"],
): string | number | boolean | null {
  switch (attr) {
    case "text.length":
      return node.attr.text?.length ?? 0;
    default:
      return node.attr[attr];
  }
}

function uniqueNodes(nodes: NormalizedSnapshotNode[]): NormalizedSnapshotNode[] {
  const seen = new Set<number>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

// 解析 AI 候选的 GKD selector 表达式，支持关系算子（> < +N -N + - +n -n +(1,2) -(1,2)）、
// @ 点击标记、* 通配、完整的属性运算符（= != *= ^= $= !^= !$= < <= > >=）、
// 以及 [attr="v1" || attr="v2"] 形式的多值 OR。
// 解析失败的 matches 串（不合法类型名、多项式 (2n+3)、>(1,2) 等）在调用方
// 收集到 SelectorValidation.unparsedMatches。
export function parseGkdSelectorExpression(expr: string): GkdSelectorExpr | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  const segments: GkdSegment[] = [];
  let pos = 0;
  let firstSegmentAt = false;
  if (trimmed.startsWith("@")) {
    firstSegmentAt = true;
    pos = 1;
  }
  // 跳过前导空白
  while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

  // 第一个段（relation = "root"）
  const firstAtom = readAtom(trimmed, pos);
  if (!firstAtom) return null;
  segments.push({
    relation: "root",
    selector: firstAtom.selector,
    isClickTarget: firstSegmentAt || firstAtom.atMark,
  });
  pos = firstAtom.end;

  // 后续段：必须先有关系算子，再有原子。
  while (pos < trimmed.length) {
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;
    if (pos >= trimmed.length) break;

    const rel = readRelation(trimmed, pos);
    if (!rel) return null;
    pos = rel.end;
    while (pos < trimmed.length && /\s/.test(trimmed[pos])) pos++;

    const atom = readAtom(trimmed, pos);
    if (!atom) return null;
    pos = atom.end;

    segments.push({
      relation: rel.op,
      selector: atom.selector,
      isClickTarget: atom.atMark,
      distance: rel.distance,
    });
  }

  if (segments.length === 0) return null;
  return { segments };
}

// 从 s[start] 开始读一个原子（[@]TypeName[attrs]...），返回结束时下一个字符的位置。
// 扫描时维护引号状态和方括号深度，顶层遇到 > < +N -N + - 时停。
function readAtom(
  s: string,
  start: number,
): { selector: SimpleSelector; end: number; atMark: boolean } | null {
  let pos = start;
  while (pos < s.length && /\s/.test(s[pos])) pos++;

  let atMark = false;
  if (s[pos] === "@") {
    atMark = true;
    pos++;
    while (pos < s.length && /\s/.test(s[pos])) pos++;
  }

  const atomStart = pos;
  let depth = 0;
  let inQuote = false;
  let escape = false;
  while (pos < s.length) {
    const c = s[pos];
    if (escape) {
      escape = false;
      pos++;
      continue;
    }
    if (c === "\\" && inQuote) {
      escape = true;
      pos++;
      continue;
    }
    if (c === '"') {
      inQuote = !inQuote;
      pos++;
      continue;
    }
    if (!inQuote) {
      if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (depth === 0) {
        if (c === ">" || c === "<") break;
        if (c === "+" || c === "-") {
          // 顶层 + / - 一定是关系算子：后接数字 / n / ( 显式距离，
          // 或后接空白分隔下一个原子。带 + - 的字面量都在 [...] 内或字符串里，
          // 不会走到这里。
          break;
        }
      }
    }
    pos++;
  }

  const atomText = s.slice(atomStart, pos).trim();
  if (!atomText) return null;

  const selector = parseSimpleSelector(atomText);
  if (!selector) return null;

  return { selector, end: pos, atMark };
}

function readRelation(
  s: string,
  start: number,
): { op: GkdRelation; distance: number | number[] | "n" | undefined; end: number } | null {
  let pos = start;
  while (pos < s.length && /\s/.test(s[pos])) pos++;

  const c = s[pos];
  if (c === ">") {
    pos++;
    // >(tuple) — GKD 父子元组，本工具不实现，降级为失败。
    if (s[pos] === "(") return null;
    return { op: "child", distance: undefined, end: pos };
  }
  if (c === "<") {
    pos++;
    if (s[pos] === "(") return null;
    return { op: "parent", distance: undefined, end: pos };
  }
  if (c === "+") {
    pos++;
    while (pos < s.length && /\s/.test(s[pos])) pos++;
    return readDistance(s, pos, "next");
  }
  if (c === "-") {
    pos++;
    while (pos < s.length && /\s/.test(s[pos])) pos++;
    return readDistance(s, pos, "previous");
  }
  return null;
}

function readDistance(
  s: string,
  start: number,
  op: "next" | "previous",
): { op: GkdRelation; distance: number | number[] | "n"; end: number } | null {
  let pos = start;
  // +(1,2) / -(1,2) 元组
  if (s[pos] === "(") {
    const close = s.indexOf(")", pos);
    if (close < 0) return null;
    const inner = s.slice(pos + 1, close).replace(/\s+/g, "");
    if (!/^[\d,]+$/.test(inner)) return null;
    const nums = inner.split(",").map((t) => Number(t));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return { op, distance: nums, end: close + 1 };
  }
  // +n / -n 多项式简写
  if (s[pos] === "n") {
    return { op, distance: "n", end: pos + 1 };
  }
  // +3 / -3 固定距离
  const numMatch = /^\d+/.exec(s.slice(pos));
  if (numMatch) {
    return { op, distance: Number(numMatch[0]), end: pos + numMatch[0].length };
  }
  // + / - 单独 = 距离 1
  return { op, distance: 1, end: pos };
}

const VALID_TYPENAME = /^[A-Za-z_*][A-Za-z0-9_.$*]*$/;

function parseSimpleSelector(expr: string): SimpleSelector | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  let at = false;
  let s = trimmed;
  if (s.startsWith("@")) {
    at = true;
    s = s.slice(1).trim();
  }
  if (!s) return null;

  // 提取 typeName：第一个 [ 之前的部分。
  let typeName: string | undefined;
  const bracketIdx = s.indexOf("[");
  if (bracketIdx > 0) {
    typeName = s.slice(0, bracketIdx);
    s = s.slice(bracketIdx);
  } else if (bracketIdx === -1) {
    // 没有方括号，整体作为 typeName。
    if (!VALID_TYPENAME.test(s)) return null;
    return { typeName: s, at: at || undefined, conditions: [] };
  } else {
    // bracketIdx === 0：没有 typeName。
    typeName = undefined;
  }

  if (typeName && !VALID_TYPENAME.test(typeName)) return null;

  // 扫所有 [...] 块，逐个 parseCondition。块外只能有空白。
  const conditions: SelectorCondition[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "[") {
      let depth = 1;
      let inQuote = false;
      let escape = false;
      const innerStart = i + 1;
      let j = i + 1;
      while (j < s.length && depth > 0) {
        const ch = s[j];
        if (escape) {
          escape = false;
          j++;
          continue;
        }
        if (ch === "\\" && inQuote) {
          escape = true;
          j++;
          continue;
        }
        if (ch === '"') {
          inQuote = !inQuote;
          j++;
          continue;
        }
        if (!inQuote) {
          if (ch === "[") depth++;
          else if (ch === "]") depth--;
        }
        if (depth > 0) j++;
      }
      if (depth !== 0) return null;
      const inner = s.slice(innerStart, j);
      const cond = parseCondition(inner);
      if (!cond) return null;
      conditions.push(cond);
      i = j + 1;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      // 块之间出现了非空白字符（不期望的关系算子或非法字符）。
      return null;
    }
  }

  if (conditions.length === 0 && !typeName) return null;

  return { typeName, at: at || undefined, conditions };
}

function parseCondition(inner: string): SelectorCondition | null {
  const s = inner.trim();
  if (!s) return null;

  // OR 形式：[attr="v1" || attr="v2" || ...]
  if (s.includes("||")) {
    const orMatch = /^([a-zA-Z_.]+)=((?:"(?:[^"\\]|\\.)*"|true|false)(?:\s*\|\|\s*[a-zA-Z_.]+=(?:"(?:[^"\\]|\\.)*"|true|false))+)$/.exec(s);
    if (!orMatch) return null;
    const attr = orMatch[1] as SelectorAttr;
    const body = orMatch[2];
    const parts = body.split(/\s*\|\|\s*/);
    const values: (string | number | boolean)[] = [];
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq < 0) return null;
      const v = parseLiteralValue(part.slice(eq + 1));
      if (v === null) return null;
      values.push(v);
    }
    return { attr, op: "orEq", value: values as string[] };
  }

  // 简单形式：[attr op value]
  // 运算符按从长到短排，避免贪婪错配。
  const simpleMatch = /^([a-zA-Z_.]+)(!==?|!?[\^$]=|\*=|>=|<=|=|<|>)(.+)$/.exec(s);
  if (!simpleMatch) return null;
  const attr = simpleMatch[1] as SelectorAttr;
  const opStr = simpleMatch[2];
  const valueText = simpleMatch[3];

  const value = parseLiteralValue(valueText);
  if (value === null) return null;

  let op: SelectorOperator;
  switch (opStr) {
    case "=":
      op = "eq";
      break;
    case "!=":
      op = "notEq";
      break;
    case "*=":
      op = "contains";
      break;
    case "^=":
      op = "startsWith";
      break;
    case "$=":
      op = "endsWith";
      break;
    case "!^=":
      op = "notStartsWith";
      break;
    case "!$=":
      op = "notEndsWith";
      break;
    case "<":
      op = "lt";
      break;
    case "<=":
      op = "lte";
      break;
    case ">":
      op = "gt";
      break;
    case ">=":
      op = "gte";
      break;
    default:
      return null;
  }

  return { attr, op, value };
}

function parseLiteralValue(text: string): string | number | boolean | null {
  const s = text.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return Number(s);
  }
  return null;
}

// 在快照上执行整条 GKD selector 表达式，按链式关系（> < +N -N）逐步配对，
// 最后返回 isClickTarget 段（默认末段）的命中节点。
function matchGkdExpr(
  snapshot: ParsedGkdSnapshot,
  expr: GkdSelectorExpr,
): NormalizedSnapshotNode[] {
  const segments = expr.segments;
  if (segments.length === 0) return [];

  const explicitClickIdx = segments.findIndex((s) => s.isClickTarget);
  const clickIdx = explicitClickIdx >= 0 ? explicitClickIdx : segments.length - 1;

  // 每段的原始命中（按 SimpleSelector 在整张快照上找）。
  const raw: NormalizedSnapshotNode[][] = segments.map((seg) =>
    matchSimpleSelector(snapshot, seg.selector),
  );

  // 前向：forward[i] = raw[i] 过滤到满足"从 i-1 到 i"的关系。
  const forward: NormalizedSnapshotNode[][] = [raw[0]];
  for (let i = 1; i < segments.length; i++) {
    const prevSeg = segments[i - 1];
    const curSeg = segments[i];
    const leftFiltered = forward[i - 1];
    const rightRaw = raw[i];
    forward.push(filterByRelationForward(snapshot, prevSeg, curSeg, leftFiltered, rightRaw));
  }

  // 反向：backward[i] = raw[i] 过滤到满足"从 i 到 i+1"的关系。
  const last = segments.length - 1;
  const backward: NormalizedSnapshotNode[][] = new Array(segments.length);
  backward[last] = raw[last];
  for (let i = last - 1; i >= 0; i--) {
    const curSeg = segments[i];
    const nextSeg = segments[i + 1];
    const leftRaw = raw[i];
    const rightFiltered = backward[i + 1];
    backward[i] = filterByRelationBackward(snapshot, curSeg, nextSeg, leftRaw, rightFiltered);
  }

  // 点击目标段 = forward ∩ backward。
  const fwdIds = new Set(forward[clickIdx].map((n) => n.id));
  return uniqueNodes(backward[clickIdx].filter((n) => fwdIds.has(n.id)));
}

// 前向：根据关系从前一段过滤出能与右段配对的右段节点。
function filterByRelationForward(
  snapshot: ParsedGkdSnapshot,
  prevSeg: GkdSegment,
  curSeg: GkdSegment,
  leftFiltered: NormalizedSnapshotNode[],
  rightRaw: NormalizedSnapshotNode[],
): NormalizedSnapshotNode[] {
  switch (curSeg.relation) {
    case "child": {
      const leftIds = new Set(leftFiltered.map((n) => n.id));
      return uniqueNodes(rightRaw.filter((n) => leftIds.has(n.pid)));
    }
    case "parent": {
      return uniqueNodes(
        rightRaw.filter((r) =>
          leftFiltered.some((l) => hasAncestor(snapshot, l, new Set([r.id]))),
        ),
      );
    }
    case "next":
    case "previous": {
      const distance = curSeg.distance ?? 1;
      const pairs = matchSiblingPairs(snapshot, prevSeg.selector, curSeg.selector, {
        relation: curSeg.relation,
        distance,
      });
      const leftIds = new Set(leftFiltered.map((n) => n.id));
      const seen = new Set<number>();
      const hits: NormalizedSnapshotNode[] = [];
      for (const p of pairs) {
        if (leftIds.has(p.target.id) && !seen.has(p.neighbor.id)) {
          seen.add(p.neighbor.id);
          hits.push(p.neighbor);
        }
      }
      return hits;
    }
    default:
      return [];
  }
}

// 反向：根据关系从后一段过滤出能与左段配对的左段节点。
function filterByRelationBackward(
  snapshot: ParsedGkdSnapshot,
  curSeg: GkdSegment,
  nextSeg: GkdSegment,
  leftRaw: NormalizedSnapshotNode[],
  rightFiltered: NormalizedSnapshotNode[],
): NormalizedSnapshotNode[] {
  switch (nextSeg.relation) {
    case "child": {
      const rightIds = new Set(rightFiltered.map((n) => n.id));
      return uniqueNodes(leftRaw.filter((n) => rightIds.has(n.pid)));
    }
    case "parent": {
      return uniqueNodes(
        leftRaw.filter((l) =>
          rightFiltered.some((r) => hasAncestor(snapshot, l, new Set([r.id]))),
        ),
      );
    }
    case "next":
    case "previous": {
      const distance = nextSeg.distance ?? 1;
      const pairs = matchSiblingPairs(snapshot, curSeg.selector, nextSeg.selector, {
        relation: nextSeg.relation,
        distance,
      });
      const rightIds = new Set(rightFiltered.map((n) => n.id));
      const seen = new Set<number>();
      const hits: NormalizedSnapshotNode[] = [];
      for (const p of pairs) {
        if (rightIds.has(p.neighbor.id) && !seen.has(p.target.id)) {
          seen.add(p.target.id);
          hits.push(p.target);
        }
      }
      return hits;
    }
    default:
      return [];
  }
}

export function validateAiCandidateAgainstSnapshot(
  candidate: AiRuleCandidate,
  snapshot: ParsedGkdSnapshot,
): SelectorValidation {
  const allClickNodes: NormalizedSnapshotNode[] = [];
  const unparsedMatches: string[] = [];

  for (const group of candidate.app.groups) {
    for (const rule of group.rules) {
      for (const match of rule.matches) {
        const expr = parseGkdSelectorExpression(match);
        if (!expr) {
          unparsedMatches.push(match);
          continue;
        }
        allClickNodes.push(...matchGkdExpr(snapshot, expr));
      }
    }
  }

  return {
    hitCount: allClickNodes.length,
    clickNodes: uniqueNodes(allClickNodes),
    supportNodes: [],
    unparsedMatches,
  };
}
