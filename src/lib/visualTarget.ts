/**
 * “视觉摞”判定：安卓界面里文字、图标、背景容器经常拥有几乎相同的矩形，
 * 它们视觉上是同一个目标，不该互相视为点偏。
 *
 * 只合并同尺寸且存在父子/同父兄弟关系的节点；尺寸差很多的祖先容器、
 * 不同分支的浮层不会被合并。
 */
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";

/** 两个矩形重叠面积 / 较大矩形面积，达到该比例视为同一视觉摞。 */
const SAME_VISUAL_RECT_RATIO = 0.9;

/** 防御异常快照里的超长兄弟列表。 */
const MAX_VISUAL_TARGET_NODES = 64;

export interface VisualTargetInput {
  snapshot: ParsedGkdSnapshot;
  pickedNode: NormalizedSnapshotNode;
  clickableAncestor?: NormalizedSnapshotNode | null;
}

/**
 * 返回用户所选控件所属的视觉摞节点 id。
 *
 * 从所选控件出发，沿三个方向收集同尺寸节点：
 * - 祖先（文字/图标外面的同尺寸容器）
 * - 后代（容器里的同尺寸文字/图标）
 * - 同父兄弟（背景 View 与可点 ImageButton 这类分层节点）
 */
export function buildVisualTargetIds({
  snapshot,
  pickedNode,
  clickableAncestor,
}: VisualTargetInput): Set<number> {
  const result = new Set<number>();
  const queued = new Set<number>();
  const queue: NormalizedSnapshotNode[] = [];

  const enqueue = (node: NormalizedSnapshotNode | undefined | null) => {
    if (!node || queued.has(node.id)) return;
    if (!isUsableNode(node)) return;
    queued.add(node.id);
    queue.push(node);
  };

  enqueue(pickedNode);
  enqueue(clickableAncestor);

  while (queue.length > 0 && result.size < MAX_VISUAL_TARGET_NODES) {
    const node = queue.shift()!;
    if (result.has(node.id)) continue;
    result.add(node.id);

    for (const ancestor of similarAncestors(snapshot, node)) {
      enqueue(ancestor);
    }
    for (const sibling of similarSiblings(snapshot, node)) {
      enqueue(sibling);
    }
    for (const child of similarChildren(snapshot, node)) {
      enqueue(child);
    }
  }

  return result;
}

/** 候选点击的节点是否全部落在视觉摞里。 */
export function isClickWithinVisualTarget(
  clickedIds: number[],
  visualTargetIds: Set<number>,
): boolean {
  return (
    clickedIds.length > 0 &&
    clickedIds.every((id) => visualTargetIds.has(id))
  );
}

/** 候选是否只点中视觉摞里的一个节点。 */
export function isUniqueVisualTargetHit(
  clickedIds: number[],
  visualTargetIds: Set<number>,
): boolean {
  return clickedIds.length === 1 && visualTargetIds.has(clickedIds[0]);
}

/** 两个节点矩形的相似度，1 表示完全重合，0 表示没有重叠。 */
export function visualRectSimilarity(
  a: NormalizedSnapshotNode,
  b: NormalizedSnapshotNode,
): number {
  const aRect = normalizedRect(a);
  const bRect = normalizedRect(b);
  const aArea = (aRect.right - aRect.left) * (aRect.bottom - aRect.top);
  const bArea = (bRect.right - bRect.left) * (bRect.bottom - bRect.top);
  const maxArea = Math.max(aArea, bArea);
  if (maxArea <= 0) return 0;

  const width = Math.max(
    0,
    Math.min(aRect.right, bRect.right) - Math.max(aRect.left, bRect.left),
  );
  const height = Math.max(
    0,
    Math.min(aRect.bottom, bRect.bottom) - Math.max(aRect.top, bRect.top),
  );
  return (width * height) / maxArea;
}

function similarAncestors(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): NormalizedSnapshotNode[] {
  const result: NormalizedSnapshotNode[] = [];
  let current = node;

  while (current.pid >= 0) {
    const parent = snapshot.nodeById.get(current.pid);
    if (!parent || !isSimilarRect(node, parent)) break;
    result.push(parent);
    current = parent;
  }

  return result;
}

function similarSiblings(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): NormalizedSnapshotNode[] {
  if (node.pid < 0) return [];
  const parent = snapshot.nodeById.get(node.pid);
  if (!parent) return [];

  return parent.children
    .map((id) => snapshot.nodeById.get(id))
    .filter(
      (candidate): candidate is NormalizedSnapshotNode =>
        Boolean(
          candidate &&
            candidate.id !== node.id &&
            isUsableNode(candidate) &&
            isSimilarRect(node, candidate),
        ),
    );
}

function similarChildren(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): NormalizedSnapshotNode[] {
  return node.children
    .map((id) => snapshot.nodeById.get(id))
    .filter(
      (candidate): candidate is NormalizedSnapshotNode =>
        Boolean(
          candidate &&
            isUsableNode(candidate) &&
            isSimilarRect(node, candidate),
        ),
    );
}

function isSimilarRect(
  a: NormalizedSnapshotNode,
  b: NormalizedSnapshotNode,
): boolean {
  return visualRectSimilarity(a, b) >= SAME_VISUAL_RECT_RATIO;
}

function isUsableNode(node: NormalizedSnapshotNode): boolean {
  return (
    node.attr.visibleToUser &&
    normalizedRect(node).right > normalizedRect(node).left &&
    normalizedRect(node).bottom > normalizedRect(node).top
  );
}

function normalizedRect(node: NormalizedSnapshotNode): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  return {
    left: Math.min(node.attr.left, node.attr.right),
    top: Math.min(node.attr.top, node.attr.bottom),
    right: Math.max(node.attr.left, node.attr.right),
    bottom: Math.max(node.attr.top, node.attr.bottom),
  };
}
