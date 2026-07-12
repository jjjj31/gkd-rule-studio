/**
 * 根据屏幕坐标找到命中节点及其上下文（祖先/兄弟/邻近文本/可点祖先）。
 * 这是"放大镜松手后选中目标"的核心函数。
 * 返回值（NodePickResult）是后续候选生成（regionCandidates）的输入。
 */

import type {
  NodePickResult,
  NodePoint,
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import { nodeArea } from "../types/gkdSnapshot";

/**
 * 从截图的屏幕坐标 → 找到命中的节点。
 * 内部调用 findNodesByPoint 做三层过滤（子节点覆盖父节点、同级去重、面积排序）。
 * 返回 null 表示该坐标没有可见节点。
 * @see regionCandidates 后续用它生成候选
 */
export function pickNodeAtPoint(
  snapshot: ParsedGkdSnapshot,
  point: NodePoint,
): NodePickResult | null {
  const containingNodes = findNodesByPoint(snapshot, point);

  const pickedNode = containingNodes[0];
  if (!pickedNode) return null;

  const ancestors = getAncestors(snapshot, pickedNode);
  const siblings = getSiblings(snapshot, pickedNode);
  const clickableAncestor = findClickableAncestor(ancestors);
  const nearbyTextNodes = findNearbyTextNodes(snapshot, point, pickedNode.id);

  return {
    point,
    pickedNode,
    containingNodes,
    ancestors,
    siblings,
    clickableAncestor,
    nearbyTextNodes,
  };
}

/**
 * 从节点树的直接选中（不靠坐标），用在桌面版左侧节点树点选场景。
 * 取节点的中心点作为坐标，其余逻辑同 pickNodeAtPoint。
 */
export function pickExistingNode(
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode,
): NodePickResult {
  const point = {
    x: Math.round((pickedNode.attr.left + pickedNode.attr.right) / 2),
    y: Math.round((pickedNode.attr.top + pickedNode.attr.bottom) / 2),
  };
  const ancestors = getAncestors(snapshot, pickedNode);

  return {
    point,
    pickedNode,
    containingNodes: [pickedNode],
    ancestors,
    siblings: getSiblings(snapshot, pickedNode),
    clickableAncestor: findClickableAncestor(ancestors),
    nearbyTextNodes: findNearbyTextNodes(snapshot, point, pickedNode.id),
  };
}

/** 沿 pid 向上找所有祖先节点，用于策略分析和选区框绘制。 */
export function getAncestors(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): NormalizedSnapshotNode[] {
  const ancestors: NormalizedSnapshotNode[] = [];
  let current = node;

  while (current.pid >= 0) {
    const parent = snapshot.nodeById.get(current.pid);
    if (!parent) break;
    ancestors.push(parent);
    current = parent;
  }

  return ancestors;
}

/** 取同一父节点下的其他子节点（去掉自己），按 index 排序。 */
export function getSiblings(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): NormalizedSnapshotNode[] {
  if (node.pid < 0) return [];
  const parent = snapshot.nodeById.get(node.pid);
  if (!parent) return [];

  return parent.children
    .map((id) => snapshot.nodeById.get(id))
    .filter((candidate): candidate is NormalizedSnapshotNode => {
      return Boolean(candidate && candidate.id !== node.id);
    })
    .sort((a, b) => a.attr.index - b.attr.index);
}

/** 判断坐标是否在节点矩形范围内。 */
export function containsPoint(
  node: NormalizedSnapshotNode,
  point: NodePoint,
): boolean {
  return (
    node.attr.left <= point.x &&
    point.x <= node.attr.right &&
    node.attr.top <= point.y &&
    point.y <= node.attr.bottom
  );
}

export function isVisibleNode(node: NormalizedSnapshotNode): boolean {
  const { width, height } = normalizedSize(node);
  return node.attr.visibleToUser && width > 0 && height > 0;
}

function findClickableAncestor(
  ancestors: NormalizedSnapshotNode[],
): NormalizedSnapshotNode | null {
  return (
    ancestors
      .slice(0, 4)
      .find((node) => node.attr.clickable && isVisibleNode(node)) ?? null
  );
}

function findNodesByPoint(
  snapshot: ParsedGkdSnapshot,
  point: NodePoint,
): NormalizedSnapshotNode[] {
  let results = snapshot.nodes.filter((node) => {
    return isVisibleNode(node) && containsPoint(node, point);
  });

  if (results.length <= 1) return results;

  results = results.filter((node) => {
    return !results.some((other) => {
      return (
        isAncestor(snapshot, node, other) &&
        includesRectNode(node, other)
      );
    });
  });

  if (results.length <= 1) return results;

  results = results.filter((node) => {
    const parent = node.pid >= 0 ? snapshot.nodeById.get(node.pid) : undefined;
    return !results.some((other) => {
      return (
        node.id !== other.id &&
        (isAncestor(snapshot, node, other) ||
          Boolean(parent && isAncestor(snapshot, parent, other))) &&
        includesRectNode(node, other) &&
        !equalRectNode(node, other)
      );
    });
  });

  return results.sort((a, b) => {
    const areaDelta = nodeArea(a.attr) - nodeArea(b.attr);
    if (areaDelta !== 0) return areaDelta;
    return b.attr.depth - a.attr.depth;
  });
}

function isAncestor(
  snapshot: ParsedGkdSnapshot,
  parent: NormalizedSnapshotNode | undefined,
  child: NormalizedSnapshotNode,
): boolean {
  if (!parent?.children.length) return false;

  let current: NormalizedSnapshotNode | undefined = child;
  while (current && current.pid >= 0) {
    current = snapshot.nodeById.get(current.pid);
    if (current?.id === parent.id) return true;
  }

  return false;
}

function includesRectNode(
  outer: NormalizedSnapshotNode,
  inner: NormalizedSnapshotNode,
): boolean {
  return (
    outer.attr.left <= inner.attr.left &&
    outer.attr.top <= inner.attr.top &&
    outer.attr.right >= inner.attr.right &&
    outer.attr.bottom >= inner.attr.bottom
  );
}

function equalRectNode(
  a: NormalizedSnapshotNode,
  b: NormalizedSnapshotNode,
): boolean {
  return (
    a.attr.left === b.attr.left &&
    a.attr.top === b.attr.top &&
    a.attr.right === b.attr.right &&
    a.attr.bottom === b.attr.bottom
  );
}

function findNearbyTextNodes(
  snapshot: ParsedGkdSnapshot,
  point: NodePoint,
  pickedNodeId: number,
): NormalizedSnapshotNode[] {
  return snapshot.nodes
    .filter((node) => {
      if (node.id === pickedNodeId || !isVisibleNode(node)) return false;
      return Boolean(node.attr.text || node.attr.desc);
    })
    .sort((a, b) => distanceToCenter(a, point) - distanceToCenter(b, point))
    .slice(0, 12);
}

function distanceToCenter(node: NormalizedSnapshotNode, point: NodePoint): number {
  const { left, top, right, bottom } = normalizedBounds(node);
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  return Math.hypot(centerX - point.x, centerY - point.y);
}

function normalizedBounds(node: NormalizedSnapshotNode): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const left = Math.min(node.attr.left, node.attr.right);
  const right = Math.max(node.attr.left, node.attr.right);
  const top = Math.min(node.attr.top, node.attr.bottom);
  const bottom = Math.max(node.attr.top, node.attr.bottom);
  return { left, top, right, bottom };
}

function normalizedSize(node: NormalizedSnapshotNode): {
  width: number;
  height: number;
} {
  const { left, top, right, bottom } = normalizedBounds(node);
  return {
    width: right - left,
    height: bottom - top,
  };
}
