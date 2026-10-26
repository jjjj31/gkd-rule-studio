import type {
  NodePickResult,
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import { getNodeSelectionOptions } from "../lib/nodePicker";
import "./NodeSelectionPanel.css";

export interface NodeSelectionPanelProps {
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
  clickNodes: NormalizedSnapshotNode[];
  onSelectNode: (node: NormalizedSnapshotNode) => void;
  onChooseSnapshot?: () => void;
}

export function NodeSelectionPanel({
  snapshot,
  pickResult,
  clickNodes,
  onSelectNode,
  onChooseSnapshot,
}: NodeSelectionPanelProps) {
  if (!snapshot || !pickResult) {
    return (
      <section className="node-selection-panel node-selection-empty" aria-label="节点选择">
        <div>
          <strong>{snapshot ? "没有命中的节点" : "还没有快照"}</strong>
          <span>请重新拖动放大镜选点，或重新采集当前界面。</span>
        </div>
        {onChooseSnapshot && (
          <button type="button" onClick={onChooseSnapshot}>
            选择其他快照
          </button>
        )}
      </section>
    );
  }

  const options = getNodeSelectionOptions(snapshot, pickResult);
  if (!options.length) {
    return (
      <section className="node-selection-panel node-selection-empty" aria-label="节点选择">
        <div>
          <strong>当前选点没有可用的目标节点</strong>
          <span>请避开整屏空白区域重新选点；原快照和草稿会保留。</span>
        </div>
        {onChooseSnapshot && (
          <button type="button" onClick={onChooseSnapshot}>
            选择其他快照
          </button>
        )}
      </section>
    );
  }

  const actualTargets = dedupeNodes(clickNodes);
  const singleOption = options.length === 1;

  return (
    <section className="node-selection-panel" aria-label="节点选择">
      <div className="node-selection-heading">
        <div>
          <strong>{singleOption ? "目标节点" : "这里有多个节点"}</strong>
          <span>
            {singleOption
              ? "已按当前选点继续，可重新拖动放大镜改选。"
              : "选择文字、热区或可点父节点查看对应的点击范围。"}
          </span>
        </div>
        {actualTargets.length > 0 && (
          <span className="node-selection-actual-summary">
            可能点击：{actualTargets.map((node) => `#${node.id} ${labelFor(node)}`).join("、")}
          </span>
        )}
      </div>

      {!singleOption && (
        <div className="node-selection-options" aria-label="可切换的节点">
          {options.map((option) => {
            const isPicked = option.node.id === pickResult.pickedNode.id;
            const isActual = actualTargets.some((node) => node.id === option.node.id);
            return (
              <button
                key={option.node.id}
                className={`node-selection-option${isPicked ? " is-picked" : ""}`}
                type="button"
                aria-pressed={isPicked}
                onClick={() => onSelectNode(option.node)}
              >
                <span className="node-selection-option-main">
                  <strong>{option.label}</strong>
                  <span>{option.typeLabel}</span>
                </span>
                <span className="node-selection-tags">
                  <span>{roleLabel(option.role)}</span>
                  <span>{option.clickable ? "可点击" : "不可点击"}</span>
                  {isActual && <span>点击目标</span>}
                </span>
                <span className="node-selection-bounds">{option.boundsLabel}</span>
              </button>
            );
          })}
        </div>
      )}

      {singleOption && actualTargets.length === 0 && (
        <div className="node-selection-warning" role="status">
          当前只有选点节点，候选没有给出可确认的实际点击范围。请查看候选验证后再测试。
        </div>
      )}
      {actualTargets.length === 0 && options.length > 1 && (
        <div className="node-selection-warning" role="status">
          候选尚未给出实际点击节点；选择目标后会同步生成对应候选。
        </div>
      )}
    </section>
  );
}

function dedupeNodes(nodes: NormalizedSnapshotNode[]): NormalizedSnapshotNode[] {
  const seen = new Set<number>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function labelFor(node: NormalizedSnapshotNode): string {
  return (
    node.attr.text ||
    node.attr.desc ||
    node.attr.vid ||
    node.attr.id?.split("/").pop() ||
    node.attr.name.split(".").pop() ||
    node.attr.name
  );
}

function roleLabel(role: "picked" | "clickable-ancestor" | "overlap"): string {
  if (role === "picked") return "选点节点";
  if (role === "clickable-ancestor") return "可点父节点";
  return "同点节点";
}
