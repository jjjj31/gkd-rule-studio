import type { NodePickResult, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import { nodeArea, nodeLabel } from "../types/gkdSnapshot";

interface NodeInspectorProps {
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
}

export function NodeInspector({ snapshot, pickResult }: NodeInspectorProps) {
  if (!snapshot) {
    return (
      <section className="panel">
        <h2>当前快照</h2>
        <p className="muted">拖入或导入 zip 后开始生成规则</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>当前快照</h2>
      <div className="summary-box">
        <strong>{snapshot.appInfo?.name ?? snapshot.appId}</strong>
        <span>{shortActivity(snapshot.activityId)}</span>
      </div>

      <h2>点击目标</h2>
      {pickResult ? (
        <>
          <div className="target-summary">
            <strong>{humanNodeName(pickResult)}</strong>
            <span>{humanClickState(pickResult)}</span>
            <span>{humanSize(pickResult, snapshot)}</span>
          </div>
          <details className="debug-details">
            <summary>调试属性</summary>
            <dl className="meta-grid">
              <dt>节点号</dt>
              <dd>{pickResult.pickedNode.id}</dd>
              <dt>类型</dt>
              <dd>{pickResult.pickedNode.attr.name}</dd>
              <dt>文本</dt>
              <dd>{pickResult.pickedNode.attr.text ?? "-"}</dd>
              <dt>描述</dt>
              <dd>{pickResult.pickedNode.attr.desc ?? "-"}</dd>
              <dt>vid</dt>
              <dd>{pickResult.pickedNode.attr.vid ?? "-"}</dd>
              <dt>id</dt>
              <dd>{pickResult.pickedNode.attr.id ?? "-"}</dd>
              <dt>重叠</dt>
              <dd>{pickResult.containingNodes.length} 个候选节点</dd>
            </dl>
          </details>
        </>
      ) : (
        <p className="muted">点击截图上的目标按钮或关闭图标</p>
      )}
    </section>
  );
}

function shortActivity(activityId: string): string {
  return activityId.split(".").slice(-2).join(".");
}

function humanNodeName(pickResult: NodePickResult): string {
  const node = pickResult.pickedNode;
  const label = node.attr.text ?? node.attr.desc ?? node.attr.vid ?? node.attr.id;
  if (label) return label;
  return nodeLabel(node);
}

function humanClickState(pickResult: NodePickResult): string {
  if (pickResult.pickedNode.attr.clickable) {
    return "目标本身可点击";
  }

  if (pickResult.clickableAncestor) {
    return "目标不可点，将尝试点击最近的可点父节点";
  }

  return "目标不可点，需要人工确认点击位置";
}

function humanSize(
  pickResult: NodePickResult,
  snapshot: ParsedGkdSnapshot,
): string {
  const ratio =
    nodeArea(pickResult.pickedNode.attr) /
    Math.max(1, snapshot.screenWidth * snapshot.screenHeight);

  if (ratio <= 0.03) return "小目标";
  if (ratio <= 0.08) return "中等目标";
  return "目标区域偏大";
}
