import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type {
  SelectorCondition,
  SelectorPlan,
  SelectorValidation,
  SimpleSelector,
} from "../types/ruleDraft";
import type { AiRuleCandidate } from "./aiModel";

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
  if (!typeName) return true;
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
    case "contains":
      return typeof value === "string" && value.includes(String(condition.value));
    case "startsWith":
      return typeof value === "string" && value.startsWith(String(condition.value));
    case "lt":
      return typeof value === "number" && value < Number(condition.value);
    case "lte":
      return typeof value === "number" && value <= Number(condition.value);
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

// 把 AI 候选的 GKD selector 表达式（如 [vid="close"]、TextView[text="跳过"]）
// 解析成 SimpleSelector，方便用 matchSimpleSelector 在当前快照里找命中节点来画绿框。
export function validateAiCandidateAgainstSnapshot(
  candidate: AiRuleCandidate,
  snapshot: ParsedGkdSnapshot,
): SelectorValidation {
  const allClickNodes: NormalizedSnapshotNode[] = [];

  for (const group of candidate.app.groups) {
    for (const rule of group.rules) {
      for (const match of rule.matches) {
        const simple = parseGkdSelectorExpression(match);
        if (simple) {
          allClickNodes.push(...matchSimpleSelector(snapshot, simple));
        }
      }
    }
  }

  return {
    hitCount: allClickNodes.length,
    clickNodes: uniqueNodes(allClickNodes),
    supportNodes: [],
  };
}

// 解析工具自己 serialize 出去的简单 selector 字符串。
// 只处理 SimpleSelector（[@]TypeName[attr=val]...）和 parent > child（取右侧）。
// 复合的 sibling / ancestor-descendant / matchesChain 暂不处理，返回 null。
export function parseGkdSelectorExpression(
  expr: string,
): SimpleSelector | null {
  let target = expr.trim();
  if (!target) return null;

  // parent > child → 取 child（右侧就是点击目标）
  const gtIdx = target.lastIndexOf(">");
  if (gtIdx >= 0) {
    target = target.slice(gtIdx + 1).trim();
  }

  return parseSimpleSelector(target);
}

const RE_COND = /\[([a-zA-Z_.]+)([*^]?)=(?:"((?:[^"\\]|\\.)*)"|(true|false)|(\d+))\]|\[([a-zA-Z_.]+)(<=?)(\d+)\]/g;

function parseSimpleSelector(expr: string): SimpleSelector | null {
  let remaining = expr.trim();
  if (!remaining) return null;

  let at = false;
  if (remaining.startsWith("@")) {
    at = true;
    remaining = remaining.slice(1);
  }

  let typeName: string | undefined;
  const bracketIdx = remaining.indexOf("[");
  if (bracketIdx > 0) {
    typeName = remaining.slice(0, bracketIdx);
    remaining = remaining.slice(bracketIdx);
  } else if (bracketIdx === -1) {
    if (remaining.length > 0) {
      return { typeName: remaining, at: at || undefined, conditions: [] };
    }
    return null;
  }

  const conditions: SelectorCondition[] = [];
  RE_COND.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_COND.exec(remaining)) !== null) {
    if (m[1] !== undefined) {
      // = 形式: [attr="val"] / [attr=true] / [attr*="val"] / [attr^="val"] / [attr=123]
      const attr = m[1] as SelectorCondition["attr"];
      const opChar = m[2] || "";
      const quoted = m[3];
      const boolVal = m[4];
      const numVal = m[5];

      let op: SelectorCondition["op"];
      let value: string | number | boolean;

      if (opChar === "^") op = "startsWith";
      else if (opChar === "*") op = "contains";
      else op = "eq";

      if (boolVal !== undefined) {
        value = boolVal === "true";
      } else if (numVal !== undefined) {
        value = Number(numVal);
      } else if (quoted !== undefined) {
        value = quoted.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      } else {
        continue;
      }

      conditions.push({ attr, op, value });
    } else if (m[6] !== undefined) {
      // < / <= 形式: [attr<123] / [attr<=123]
      const attr = m[6] as SelectorCondition["attr"];
      const op = m[7] === "<=" ? "lte" : "lt";
      const value = Number(m[8]);
      conditions.push({ attr, op, value });
    }
  }

  return { typeName: typeName || undefined, at: at || undefined, conditions };
}
