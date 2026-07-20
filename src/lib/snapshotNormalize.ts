/** normalizeSnapshot 归一化原始 GKD 快照，展开节点树、生成 nodeById Map。
 * 被 deviceApi.loadSnapshot 和测试文件复用。 */
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
  RawGkdSnapshot,
  SnapshotNode,
} from "../types/gkdSnapshot";

export function normalizeSnapshot(
  raw: RawGkdSnapshot,
  screenshotUrl: string,
  sourceName: string,
): ParsedGkdSnapshot {
  const nodes = raw.nodes.map(normalizeNode);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    if (node.pid >= 0) {
      nodeById.get(node.pid)?.children.push(node.id);
    }
  }

  return {
    id: raw.id,
    appId: raw.appId,
    activityId: raw.activityId,
    screenWidth: raw.screenWidth,
    screenHeight: raw.screenHeight,
    isLandscape: raw.isLandscape,
    appInfo: raw.appInfo,
    nodes,
    nodeById,
    screenshotUrl,
    sourceName,
  };
}

function normalizeNode(node: SnapshotNode): NormalizedSnapshotNode {
  return {
    ...node,
    attr: {
      ...node.attr,
      id: node.attr.id ?? null,
      vid: node.attr.vid ?? null,
      text: node.attr.text ?? null,
      desc: node.attr.desc ?? null,
      clickable: Boolean(node.attr.clickable),
      focusable: Boolean(node.attr.focusable),
      checkable: Boolean(node.attr.checkable),
      checked: Boolean(node.attr.checked),
      editable: Boolean(node.attr.editable),
      longClickable: Boolean(node.attr.longClickable),
      visibleToUser: Boolean(node.attr.visibleToUser),
    },
    children: [],
  };
}
