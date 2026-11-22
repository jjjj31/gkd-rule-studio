/**
 * “视觉摞”判定：安卓界面里文字、图标、背景容器经常拥有几乎相同的矩形，
 * 它们视觉上是同一个目标，不该互相视为点偏。
 *
 * 只合并同尺寸且存在父子/同父兄弟关系的节点；尺寸差很多的祖先容器、
 * 不同分支的浮层不会被合并。
 */
import { DANGEROUS_CLICK_WORDS } from "../data/riskWords";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import { isSkipLikeText } from "./countdownText";

/** 两个矩形重叠面积 / 较大矩形面积，达到该比例视为同一视觉摞。 */
const SAME_VISUAL_RECT_RATIO = 0.9;

/** 防御异常快照里的超长兄弟列表。 */
const MAX_VISUAL_TARGET_NODES = 64;

const MAX_SAFE_ANCESTOR_DEPTH = 6;
const DEFAULT_ANCESTOR_MAX_AREA_RATIO = 0.08;
const DISMISS_ANCESTOR_MAX_AREA_RATIO = 0.15;

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

const DANGEROUS_CTA_WORDS = [
  ...DANGEROUS_CLICK_WORDS,
  "下载",
  "安装",
  "打开",
  "立即打开",
  "查看详情",
  "了解更多",
  "跳转",
  "购买",
];

export interface VisualTargetInput {
  snapshot: ParsedGkdSnapshot;
  pickedNode: NormalizedSnapshotNode;
  clickableAncestor?: NormalizedSnapshotNode | null;
}

export interface SafeClickableAncestorDiagnostics {
  safeAncestor: NormalizedSnapshotNode | null;
  unsafeClickableAncestor: NormalizedSnapshotNode | null;
  unsafeReason: string | null;
}

/**
 * 评估单个可点击候选节点是否不安全；返回 null 表示可安全作为点击目标。
 * 与 findSafeClickableAncestor / findSafeClickableAncestorWithDiagnostics 共用同一套判定口径。
 */
export function getUnsafeClickableTargetReason(
  snapshot: ParsedGkdSnapshot,
  candidate: NormalizedSnapshotNode,
  pickedNode: NormalizedSnapshotNode,
): string | null {
  if (!candidate.attr.clickable || !candidate.attr.visibleToUser) {
    return "节点不可点击或不可见";
  }
  const area = nodeRectArea(candidate);
  if (area <= 0) {
    return "节点面积为 0";
  }
  const screenArea = Math.max(1, snapshot.screenWidth * snapshot.screenHeight);
  return getClickableCandidateUnsafeReason(
    snapshot,
    candidate,
    pickedNode,
    screenArea,
    area,
  );
}

/**
 * 向上查找安全的可点击祖先（如包裹"跳过"文字的 skip_ll）并返回首个不安全可点击祖先诊断：
 * - 最多向上 6 层（depth < 6）
 * - 必须 clickable && visibleToUser 且面积 > 0
 * - 过滤广告遮罩/热区资源名与正向危险 CTA 词
 * - 收紧面积上限：常规 <= 0.08，自带 skip/close/cancel/跳过/关闭 信号时 <= 0.15
 * - 拒绝包含多个不同动作文本或多个独立可点击按钮的复合容器
 */
export function findSafeClickableAncestorWithDiagnostics(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): SafeClickableAncestorDiagnostics {
  const screenArea = Math.max(1, snapshot.screenWidth * snapshot.screenHeight);
  let pid = node.pid;
  let depth = 0;
  let unsafeClickableAncestor: NormalizedSnapshotNode | null = null;
  let unsafeReason: string | null = null;

  while (pid >= 0 && depth < MAX_SAFE_ANCESTOR_DEPTH) {
    const ancestor = snapshot.nodeById.get(pid);
    if (!ancestor) break;

    if (ancestor.attr.clickable && ancestor.attr.visibleToUser) {
      const area = nodeRectArea(ancestor);
      if (area > 0) {
        const reason = getClickableCandidateUnsafeReason(
          snapshot,
          ancestor,
          node,
          screenArea,
          area,
        );
        if (!reason) {
          return {
            safeAncestor: ancestor,
            unsafeClickableAncestor,
            unsafeReason,
          };
        }
        if (!unsafeClickableAncestor) {
          unsafeClickableAncestor = ancestor;
          unsafeReason = reason;
        }
      }
    }

    pid = ancestor.pid;
    depth += 1;
  }

  return {
    safeAncestor: null,
    unsafeClickableAncestor,
    unsafeReason,
  };
}

/**
 * 向上查找安全的可点击祖先（如包裹"跳过"文字的 skip_ll）。
 */
export function findSafeClickableAncestor(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): NormalizedSnapshotNode | null {
  return findSafeClickableAncestorWithDiagnostics(snapshot, node).safeAncestor;
}

/**
 * 返回用户所选控件所属的视觉摞节点 id。
 *
 * 从所选控件出发，沿三个方向收集同尺寸节点：
 * - 祖先（文字/图标外面的同尺寸容器）
 * - 后代（容器里的同尺寸文字/图标）
 * - 同父兄弟（背景 View 与可点 ImageButton 这类分层节点）
 *
 * 始终无条件包含 pickedNode.id（即便其 visibleToUser=false）；
 * BFS 扩展时同时约束候选节点与初始种子节点（pickedNode 或 clickableAncestor）的矩形相似度，
 * 防止相邻 0.9 逐步放大产生链式漂移。
 */
export function buildVisualTargetIds({
  snapshot,
  pickedNode,
  clickableAncestor,
}: VisualTargetInput): Set<number> {
  const result = new Set<number>([pickedNode.id]);
  const queued = new Set<number>();
  const queue: NormalizedSnapshotNode[] = [];
  const anchorSeeds: NormalizedSnapshotNode[] = [];

  if (hasPositiveRect(pickedNode)) {
    anchorSeeds.push(pickedNode);
    queued.add(pickedNode.id);
    queue.push(pickedNode);
  }

  if (clickableAncestor && isUsableNode(clickableAncestor)) {
    anchorSeeds.push(clickableAncestor);
    if (!queued.has(clickableAncestor.id)) {
      queued.add(clickableAncestor.id);
      queue.push(clickableAncestor);
    }
  }

  const enqueueNeighbor = (candidate: NormalizedSnapshotNode | undefined | null) => {
    if (!candidate || queued.has(candidate.id)) return;
    if (!isUsableNode(candidate)) return;
    if (!anchorSeeds.some((seed) => isSimilarRect(seed, candidate))) return;
    queued.add(candidate.id);
    queue.push(candidate);
  };

  while (queue.length > 0 && result.size < MAX_VISUAL_TARGET_NODES) {
    const node = queue.shift()!;
    result.add(node.id);

    for (const ancestor of similarAncestors(snapshot, node)) {
      enqueueNeighbor(ancestor);
    }
    for (const sibling of similarSiblings(snapshot, node)) {
      enqueueNeighbor(sibling);
    }
    for (const child of similarChildren(snapshot, node)) {
      enqueueNeighbor(child);
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
  return node.attr.visibleToUser && hasPositiveRect(node);
}

function hasPositiveRect(node: NormalizedSnapshotNode): boolean {
  const rect = normalizedRect(node);
  return rect.right > rect.left && rect.bottom > rect.top;
}

function nodeRectArea(node: NormalizedSnapshotNode): number {
  const rect = normalizedRect(node);
  const w =
    rect.right > rect.left ? rect.right - rect.left : Math.max(0, node.attr.width);
  const h =
    rect.bottom > rect.top ? rect.bottom - rect.top : Math.max(0, node.attr.height);
  return w * h;
}

function hasExplicitDismissSignal(node: NormalizedSnapshotNode): boolean {
  const value = [node.attr.id, node.attr.vid, node.attr.text, node.attr.desc]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    value.includes("skip") ||
    value.includes("close") ||
    value.includes("cancel") ||
    value.includes("跳过") ||
    value.includes("关闭")
  );
}

function getClickableCandidateUnsafeReason(
  snapshot: ParsedGkdSnapshot,
  candidate: NormalizedSnapshotNode,
  pickedNode: NormalizedSnapshotNode,
  screenArea: number,
  area: number,
): string | null {
  const areaRatio = area / screenArea;
  const maxAreaRatio = hasExplicitDismissSignal(candidate)
    ? DISMISS_ANCESTOR_MAX_AREA_RATIO
    : DEFAULT_ANCESTOR_MAX_AREA_RATIO;
  if (areaRatio > maxAreaRatio) {
    return `面积占屏幕 ${(areaRatio * 100).toFixed(1)}% (>${Math.round(maxAreaRatio * 100)}%)`;
  }

  const overlayOrCtaReason = getOverlayOrCtaUnsafeReason(candidate);
  if (overlayOrCtaReason) {
    return overlayOrCtaReason;
  }

  if (containsMultipleActionControls(snapshot, candidate, pickedNode)) {
    return "包含多个动作控件或正向 CTA 按钮";
  }

  return null;
}

function getOverlayOrCtaUnsafeReason(node: NormalizedSnapshotNode): string | null {
  const value = [node.attr.id, node.attr.vid, node.attr.text, node.attr.desc]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!value) return null;
  if (OVERLAY_RESOURCE_SIGNALS.some((signal) => value.includes(signal))) {
    const label = node.attr.vid || node.attr.id || node.attr.desc || node.attr.text || "";
    return `命中遮罩/广告热区关键字（${label}）`;
  }
  if (DANGEROUS_CTA_WORDS.some((word) => value.includes(word.toLowerCase()))) {
    const label = node.attr.text || node.attr.desc || node.attr.vid || node.attr.id || "";
    return `包含正向 CTA 文案（${label}）`;
  }
  return null;
}

function hasDangerousCtaText(node: NormalizedSnapshotNode): boolean {
  const value = [node.attr.text, node.attr.desc]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!value) return false;
  return DANGEROUS_CTA_WORDS.some((word) => value.includes(word.toLowerCase()));
}

function canonicalActionLabel(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (/^[|｜·•:：\-/\s()（）]+$/.test(trimmed)) return null;
  if (/^\(?（?\d+\s*(?:s|秒)?[)）]?$/i.test(trimmed)) return null;
  if (isSkipLikeText(trimmed)) return "__skip__";
  return trimmed.toLowerCase();
}

function containsMultipleActionControls(
  snapshot: ParsedGkdSnapshot,
  ancestor: NormalizedSnapshotNode,
  pickedNode: NormalizedSnapshotNode,
): boolean {
  const pickedHasDanger = hasDangerousCtaText(pickedNode);
  const distinctActions = new Set<string>();
  const clickableDescendants: NormalizedSnapshotNode[] = [];
  const queue: NormalizedSnapshotNode[] = [ancestor];
  const visited = new Set<number>([ancestor.id]);
  let scanned = 0;

  while (queue.length > 0 && scanned < MAX_VISUAL_TARGET_NODES) {
    const current = queue.shift()!;
    scanned += 1;

    if (current.id !== ancestor.id && !current.attr.visibleToUser) {
      continue;
    }

    if (
      current.id !== ancestor.id &&
      current.id !== pickedNode.id &&
      !pickedHasDanger &&
      hasDangerousCtaText(current)
    ) {
      return true;
    }

    for (const raw of [current.attr.text, current.attr.desc]) {
      const label = canonicalActionLabel(raw);
      if (label) {
        distinctActions.add(label);
        if (distinctActions.size >= 2) return true;
      }
    }

    if (
      current.id !== ancestor.id &&
      current.attr.clickable &&
      hasPositiveRect(current) &&
      !clickableDescendants.some((other) => isSimilarRect(other, current))
    ) {
      clickableDescendants.push(current);
      if (clickableDescendants.length >= 2) return true;
    }

    for (const childId of current.children) {
      if (visited.has(childId)) continue;
      const child = snapshot.nodeById.get(childId);
      if (!child) continue;
      visited.add(childId);
      queue.push(child);
    }
  }

  return false;
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
