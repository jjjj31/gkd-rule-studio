/**
 * GKD selector 桥接层：把官方 `@gkd-kit/selector`（0.6.x，对应 GKD 1.13+）
 * 适配到本项目的 `NormalizedSnapshotNode` 节点结构上。
 */
import {
  JsNodeAdapter,
  MatchOptions,
  Selector,
  createDefaultSelectorTypeModel,
} from "@gkd-kit/selector";
import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";

export interface MatchResult {
  clickIds: number[];
  /** 选择器链中作为上下文参与匹配的节点，不含最终点击目标。 */
  supportIds: number[];
  unparsed: boolean;
  unparsedReason?: string;
  /** 官方解析器判定该 selector 是否支持 fastQuery（fastQueryList.length > 0）。 */
  canFastQuery?: boolean;
}

let cachedTypeModel: ReturnType<typeof createDefaultSelectorTypeModel> | null = null;
function ensureTypeModel() {
  cachedTypeModel ??= createDefaultSelectorTypeModel(true);
  return cachedTypeModel;
}

/** 只用本地解析器检查语法/类型，不要求当前有快照。 */
export function validateGkdSelectorSyntax(expression: string): string | null {
  try {
    const selector = Selector.compile(expression).value;
    selector.validateType(ensureTypeModel()).value;
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** 判断单个 selector 字符串是否满足官方 fastQuery 条件；解析或类型校验失败返回 false。 */
export function canSelectorFastQuery(selectorSource: string): boolean {
  if (!selectorSource.trim()) return false;
  try {
    const selector = Selector.compile(selectorSource).value;
    selector.validateType(ensureTypeModel()).value;
    return selector.fastQueryList.length > 0;
  } catch {
    return false;
  }
}

export function matchGkdSelectorString(
  snapshot: ParsedGkdSnapshot,
  expr: string,
): MatchResult {
  try {
    const selector = Selector.compile(expr).value;
    selector.validateType(ensureTypeModel()).value;
    const canFastQuery = selector.fastQueryList.length > 0;

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
        if (
          name === "getChild" &&
          target &&
          typeof target === "object" &&
          "attr" in target &&
          typeof args[0] === "number" &&
          Number.isInteger(args[0])
        ) {
          const node = target as NormalizedSnapshotNode;
          const rawIndex = args[0];
          const resolvedIndex = rawIndex < 0 ? node.children.length + rawIndex : rawIndex;
          if (resolvedIndex < 0 || resolvedIndex >= node.children.length) {
            return null;
          }
          return this.getChild(node, resolvedIndex);
        }
        return null;
      }

      getName(node: NormalizedSnapshotNode) {
        return node.attr.name;
      }

      getChildCount(node: NormalizedSnapshotNode) {
        return node.children.length;
      }

      getChild(node: NormalizedSnapshotNode, index: number) {
        if (!Number.isInteger(index)) return null;
        const resolvedIndex = index < 0 ? node.children.length + index : index;
        if (resolvedIndex < 0 || resolvedIndex >= node.children.length) {
          return null;
        }
        const childId = node.children[resolvedIndex];
        return childId === undefined ? null : snapshot.nodeById.get(childId) ?? null;
      }

      getParent(node: NormalizedSnapshotNode) {
        return snapshot.nodeById.get(node.pid) ?? null;
      }

      getNodeKey(node: NormalizedSnapshotNode) {
        return node.id;
      }
    }

    const root = snapshot.nodes.find((node) => node.pid < 0) ?? snapshot.nodes[0];
    if (!root) {
      return {
        clickIds: [],
        supportIds: [],
        unparsed: true,
        unparsedReason: "empty-snapshot",
        canFastQuery,
      };
    }

    const results = new SnapshotAdapter().querySelectorAllWithTrace(
      root,
      selector,
      new MatchOptions(false),
    );
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
    return {
      clickIds: [...clickIds],
      supportIds: [...supportIds],
      unparsed: false,
      canFastQuery,
    };
  } catch (error) {
    return {
      clickIds: [],
      supportIds: [],
      unparsed: true,
      unparsedReason: error instanceof Error ? error.message : String(error),
      canFastQuery: false,
    };
  }
}
