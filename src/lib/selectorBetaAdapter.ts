import { JsNodeAdapter, Selector, MatchOptions, createDefaultSelectorTypeModel } from "@gkd-kit/selector-beta";
import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { MatchResult } from "./selectorAdapter";

const typeModel = createDefaultSelectorTypeModel(true);

export function matchBetaSelector(snapshot: ParsedGkdSnapshot, expression: string): MatchResult {
  try {
    const selector = Selector.compile(expression).value;
    selector.validateType(typeModel).value;
    class SnapshotAdapter extends JsNodeAdapter<NormalizedSnapshotNode> {
      getAttr(target: unknown, name: string): unknown {
        if (!target || typeof target !== "object" || !("attr" in target)) return null;
        const node = target as NormalizedSnapshotNode;
        if (name === "_id") return node.id;
        if (name === "_pid") return node.pid;
        if (name === "parent") return this.getParent(node);
        return (node.attr as unknown as Record<string, unknown>)[name] ?? null;
      }
      getInvoke(target: unknown, name: string, args: unknown[]): unknown {
        if (name === "getChild" && target && typeof target === "object" && "attr" in target
          && typeof args[0] === "number") return this.getChild(target as NormalizedSnapshotNode, args[0]);
        return null;
      }
      getName(node: NormalizedSnapshotNode) { return node.attr.name; }
      getChildCount(node: NormalizedSnapshotNode) { return node.children.length; }
      getChild(node: NormalizedSnapshotNode, index: number) { return snapshot.nodeById.get(node.children[index]) ?? null; }
      getParent(node: NormalizedSnapshotNode) { return snapshot.nodeById.get(node.pid) ?? null; }
      getNodeKey(node: NormalizedSnapshotNode) { return node.id; }
    }
    const root = snapshot.nodes.find(node => node.pid < 0) ?? snapshot.nodes[0];
    if (!root) throw new Error("empty-snapshot");
    const results = new SnapshotAdapter().querySelectorAllWithTrace(root, selector, new MatchOptions(false));
    const clickIds = new Set<number>();
    const supportIds = new Set<number>();
    for (const result of results) {
      clickIds.add(result.target.id);
      for (const unit of result.units) {
        supportIds.add(unit.queryNode.id);
        supportIds.add(unit.target.id);
        for (const step of unit.steps) {
          supportIds.add(step.source.id);
          supportIds.add(step.target.id);
        }
      }
    }
    for (const id of clickIds) supportIds.delete(id);
    return { clickIds: [...clickIds], supportIds: [...supportIds], unparsed: false };
  } catch (error) {
    return { clickIds: [], supportIds: [], unparsed: true,
      unparsedReason: error instanceof Error ? error.message : String(error) };
  }
}
