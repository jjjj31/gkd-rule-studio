/** 左侧节点树面板（桌面版）。以树形结构展示快照的所有节点，用户可点击节点直接选中（不靠坐标）。安卓版没有此面板。 */
import { ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { nodeLabel } from "../types/gkdSnapshot";
import type { SelectorCandidate } from "../types/ruleDraft";

interface NodeTreePanelProps {
  snapshot: ParsedGkdSnapshot | null;
  pickedNodeId: number | null;
  selectedCandidate: SelectorCandidate | null;
  onNodeSelected: (node: NormalizedSnapshotNode) => void;
}

export function NodeTreePanel({
  snapshot,
  pickedNodeId,
  selectedCandidate,
  onNodeSelected,
}: NodeTreePanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const hitIds = new Set(
    selectedCandidate?.validation.clickNodes.map((node) => node.id) ?? [],
  );
  const supportIds = new Set(
    selectedCandidate?.validation.supportNodes.map((node) => node.id) ?? [],
  );
  const tree = useMemo(() => {
    if (!snapshot) return [];
    return buildVisibleTree(snapshot, expandedIds);
  }, [snapshot, expandedIds]);

  useEffect(() => {
    setExpandedIds(new Set());
  }, [snapshot?.id, snapshot?.sourceName]);

  useEffect(() => {
    if (!snapshot || pickedNodeId === null) return;
    const ancestors = getAncestorIds(snapshot, pickedNodeId);
    setExpandedIds((current) => {
      const next = new Set(current);
      ancestors.forEach((id) => next.add(id));
      return next;
    });
  }, [snapshot, pickedNodeId]);

  function toggleNode(nodeId: number): void {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }

  return (
    <CollapsiblePanel className="node-tree-panel" title="节点树">
      {!snapshot ? (
        <p className="muted">加载快照后显示节点树</p>
      ) : (
        <>
          <p className="node-tree-hint">
            共 {snapshot.nodes.length} 个节点。默认折叠，点击箭头展开，选中节点会自动展开所在路径。
          </p>
          <div className="node-tree-list">
            {tree.map(({ node, level, hasChildren, expanded }) => (
              <div
                key={node.id}
                className={[
                  "node-tree-row",
                  node.id === pickedNodeId ? "node-tree-picked" : "",
                  hitIds.has(node.id) ? "node-tree-hit" : "",
                  supportIds.has(node.id) ? "node-tree-support" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ paddingLeft: `${6 + Math.min(level, 16) * 14}px` }}
              >
                <button
                  aria-label={`${expanded ? "折叠" : "展开"}节点 #${node.id}`}
                  className="node-tree-toggle"
                  disabled={!hasChildren}
                  type="button"
                  onClick={() => toggleNode(node.id)}
                >
                  <ChevronRight
                    className={expanded ? "node-tree-toggle-open" : ""}
                    size={13}
                  />
                </button>
                <button
                  className="node-tree-main"
                  title={formatNodeTitle(node)}
                  type="button"
                  onClick={() => onNodeSelected(node)}
                >
                  <span className="node-tree-id">#{node.id}</span>
                  <span className="node-tree-name">{shortName(node.attr.name)}</span>
                  {node.attr.clickable && <span className="node-tree-chip">可点</span>}
                  {!node.attr.visibleToUser && <span className="node-tree-chip">隐藏</span>}
                  <span className="node-tree-label">{nodeLabel(node)}</span>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </CollapsiblePanel>
  );
}

interface VisibleTreeNode {
  node: NormalizedSnapshotNode;
  level: number;
  hasChildren: boolean;
  expanded: boolean;
}

function buildVisibleTree(
  snapshot: ParsedGkdSnapshot,
  expandedIds: Set<number>,
): VisibleTreeNode[] {
  const roots = snapshot.nodes.filter((node) => {
    return node.pid < 0 || !snapshot.nodeById.has(node.pid);
  });
  const visible: VisibleTreeNode[] = [];

  function visit(node: NormalizedSnapshotNode, level: number): void {
    const children = node.children
      .map((childId) => snapshot.nodeById.get(childId))
      .filter((child): child is NormalizedSnapshotNode => Boolean(child));
    const expanded = expandedIds.has(node.id);
    visible.push({
      node,
      level,
      hasChildren: children.length > 0,
      expanded,
    });

    if (expanded) {
      children.forEach((child) => visit(child, level + 1));
    }
  }

  roots.forEach((root) => visit(root, 0));
  return visible;
}

function getAncestorIds(snapshot: ParsedGkdSnapshot, nodeId: number): number[] {
  const ids: number[] = [];
  let current = snapshot.nodeById.get(nodeId);
  while (current && current.pid >= 0) {
    ids.push(current.pid);
    current = snapshot.nodeById.get(current.pid);
  }
  return ids;
}

function formatNodeTitle(node: NormalizedSnapshotNode): string {
  return [
    `id: ${node.id}`,
    `pid: ${node.pid}`,
    `name: ${node.attr.name}`,
    `text: ${node.attr.text ?? "-"}`,
    `desc: ${node.attr.desc ?? "-"}`,
    `vid: ${node.attr.vid ?? "-"}`,
    `idAttr: ${node.attr.id ?? "-"}`,
    `clickable: ${node.attr.clickable}`,
    `bounds: ${node.attr.left}, ${node.attr.top}, ${node.attr.right}, ${node.attr.bottom}`,
  ].join("\n");
}

function shortName(name: string): string {
  return name.split(".").at(-1) ?? name;
}
