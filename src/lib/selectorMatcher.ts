import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type {
  SelectorCondition,
  SelectorPlan,
  SelectorValidation,
  SimpleSelector,
} from "../types/ruleDraft";

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
  relation: { relation: "next" | "previous"; distance: number },
): Array<{ target: NormalizedSnapshotNode; neighbor: NormalizedSnapshotNode }> {
  const firstNodes = matchSimpleSelector(snapshot, firstSelector);
  const secondIds = new Set(matchSimpleSelector(snapshot, secondSelector).map((node) => node.id));
  const pairs: Array<{ target: NormalizedSnapshotNode; neighbor: NormalizedSnapshotNode }> = [];

  for (const firstNode of firstNodes) {
    if (firstNode.pid < 0) continue;
    const parent = snapshot.nodeById.get(firstNode.pid);
    if (!parent) continue;

    const siblingIndex = parent.children.indexOf(firstNode.id);
    if (siblingIndex < 0) continue;

    const offset = relation.relation === "next" ? relation.distance : -relation.distance;
    const neighborId = parent.children[siblingIndex + offset];
    const neighbor = neighborId === undefined ? undefined : snapshot.nodeById.get(neighborId);

    if (neighbor && secondIds.has(neighbor.id)) {
      pairs.push({ target: firstNode, neighbor });
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
