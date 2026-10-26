import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NodeSelectionPanel } from "../components/NodeSelectionPanel";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";
import { getNodeSelectionOptions, pickNodeAtPoint } from "../lib/nodePicker";
import { normalizeSnapshot } from "../lib/snapshotNormalize";

describe("node selection options", () => {
  it("offers the picked label and its clickable ancestor as distinct choices", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          id: "com.demo:id/close",
          vid: "close",
          clickable: true,
          left: 100,
          top: 200,
          right: 260,
          bottom: 260,
          childCount: 1,
        }),
      ),
      node(
        2,
        1,
        attr({
          name: "android.widget.TextView",
          text: "关闭",
          left: 120,
          top: 215,
          right: 240,
          bottom: 245,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 180, y: 230 });
    expect(pick?.pickedNode.id).toBe(2);

    expect(getNodeSelectionOptions(snapshot, pick!)).toEqual([
      expect.objectContaining({
        node: expect.objectContaining({ id: 2 }),
        label: "关闭",
        typeLabel: "TextView",
        role: "picked",
        clickable: false,
        boundsLabel: "120,215 · 120×30",
      }),
      expect.objectContaining({
        node: expect.objectContaining({ id: 1 }),
        label: "close",
        typeLabel: "View",
        role: "clickable-ancestor",
        clickable: true,
        boundsLabel: "100,200 · 160×60",
      }),
    ]);
  });

  it("omits a whole-screen ancestor and recovery is left to the panel", () => {
    const snapshot = buildSnapshot([
      node(
        0,
        -1,
        attr({
          clickable: true,
          left: 0,
          top: 0,
          right: 1080,
          bottom: 1920,
          childCount: 1,
        }),
      ),
      node(
        1,
        0,
        attr({
          name: "android.widget.TextView",
          text: "关闭",
          left: 100,
          top: 200,
          right: 260,
          bottom: 260,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 180, y: 230 });
    const options = getNodeSelectionOptions(snapshot, pick!);

    expect(options.map((option) => option.node.id)).toEqual([1]);
  });

  it("shows a picked container as its own uncertain target without inventing a parent", () => {
    const snapshot = buildSnapshot([
      node(
        0,
        -1,
        attr({
          name: "android.widget.FrameLayout",
          left: 120,
          top: 300,
          right: 900,
          bottom: 1200,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 400, y: 600 });
    const [option] = getNodeSelectionOptions(snapshot, pick!);

    expect(option).toMatchObject({
      role: "picked",
      clickable: false,
      boundsLabel: "120,300 · 780×900",
    });
    expect(option.role).not.toBe("clickable-ancestor");
  });

  it("offers other meaningful nodes whose bounds overlap the point", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 3 })),
      node(
        1,
        0,
        attr({
          name: "android.view.View",
          left: 100,
          top: 200,
          right: 400,
          bottom: 320,
        }),
      ),
      node(
        2,
        0,
        attr({
          id: "com.demo:id/ad_hotspot",
          vid: "ad_hotspot",
          clickable: true,
          left: 100,
          top: 200,
          right: 400,
          bottom: 320,
          index: 1,
        }),
      ),
      node(
        3,
        0,
        attr({
          name: "android.widget.TextView",
          text: "跳过 5",
          left: 120,
          top: 215,
          right: 240,
          bottom: 245,
          index: 2,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 180, y: 230 });
    const options = getNodeSelectionOptions(snapshot, pick!);

    expect(options.map((option) => option.node.id)).toEqual([3, 2]);
    expect(options.map((option) => option.label)).toEqual(["跳过 5", "ad_hotspot"]);
  });

  it("treats a directly chosen overlapping node as the new picked target", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 2 })),
      node(
        1,
        0,
        attr({
          name: "android.widget.TextView",
          text: "关闭",
          left: 120,
          top: 215,
          right: 240,
          bottom: 245,
        }),
      ),
      node(
        2,
        0,
        attr({
          id: "com.demo:id/ad_hotspot",
          vid: "ad_hotspot",
          clickable: true,
          left: 100,
          top: 200,
          right: 400,
          bottom: 320,
          index: 1,
        }),
      ),
    ]);
    const pickedByScreenshot = pickNodeAtPoint(snapshot, { x: 180, y: 230 });
    const pickedByList = { ...pickedByScreenshot!, pickedNode: snapshot.nodeById.get(2)! };

    const options = getNodeSelectionOptions(snapshot, pickedByList);

    expect(options[0]).toMatchObject({
      node: expect.objectContaining({ id: 2 }),
      role: "picked",
    });
    expect(options.some((option) => option.node.id === 2 && option.role === "picked")).toBe(true);
    expect(options.some((option) => option.node.id === 1 && option.role === "overlap")).toBe(true);
  });

  it("includes the remaining clickable ancestors of a chosen parent", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          id: "com.demo:id/close_region",
          clickable: true,
          left: 100,
          top: 200,
          right: 360,
          bottom: 320,
          childCount: 1,
        }),
      ),
      node(
        2,
        1,
        attr({
          name: "android.widget.TextView",
          text: "关闭",
          left: 120,
          top: 215,
          right: 240,
          bottom: 245,
        }),
      ),
    ]);
    const pickedByScreenshot = pickNodeAtPoint(snapshot, { x: 180, y: 230 });
    const pickedByList = { ...pickedByScreenshot!, pickedNode: snapshot.nodeById.get(1)! };

    const options = getNodeSelectionOptions(snapshot, pickedByList);

    expect(options.some((option) => option.node.id === 1 && option.role === "picked")).toBe(true);
    expect(options.some((option) => option.node.id === 2 && option.role === "overlap")).toBe(true);
  });

  it("keeps the actual click target independent when validation is unavailable", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          name: "android.widget.TextView",
          text: "关闭",
          left: 120,
          top: 215,
          right: 240,
          bottom: 245,
        }),
      ),
    ]);
    const pick = pickNodeAtPoint(snapshot, { x: 180, y: 230 });
    const markup = renderToStaticMarkup(
      createElement(NodeSelectionPanel, {
        snapshot,
        pickResult: pick,
        clickNodes: [],
        onSelectNode: () => undefined,
      }),
    );

    expect(markup).toContain("候选没有给出可确认的实际点击范围");
    expect(markup).not.toContain("实际点击：");
  });
});

describe("NodeSelectionPanel", () => {
  it("does not add a mandatory choice for one clear target", () => {
    const snapshot = buildSnapshot([
      node(
        0,
        -1,
        attr({
          name: "android.widget.Button",
          text: "关闭",
          clickable: true,
          left: 100,
          top: 200,
          right: 260,
          bottom: 260,
        }),
      ),
    ]);
    const pick = pickNodeAtPoint(snapshot, { x: 180, y: 230 });
    const markup = renderToStaticMarkup(
      createElement(NodeSelectionPanel, {
        snapshot,
        pickResult: pick,
        clickNodes: [pick!.pickedNode],
        onSelectNode: () => undefined,
      }),
    );

    expect(markup).toContain("目标节点");
    expect(markup).toContain("可能点击：#0 关闭");
    expect(markup).not.toContain("node-selection-option");
  });

  it("offers switching targets and keeps actual click targets distinct", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          id: "com.demo:id/close",
          vid: "close",
          clickable: true,
          left: 100,
          top: 200,
          right: 260,
          bottom: 260,
          childCount: 1,
        }),
      ),
      node(
        2,
        1,
        attr({
          name: "android.widget.TextView",
          text: "关闭",
          left: 120,
          top: 215,
          right: 240,
          bottom: 245,
        }),
      ),
    ]);
    const pick = pickNodeAtPoint(snapshot, { x: 180, y: 230 });
    const clickableAncestor = snapshot.nodeById.get(1)!;
    const markup = renderToStaticMarkup(
      createElement(NodeSelectionPanel, {
        snapshot,
        pickResult: pick,
        clickNodes: [clickableAncestor],
        onSelectNode: () => undefined,
      }),
    );

    expect(markup).toContain("这里有多个节点");
    expect(markup.match(/node-selection-option(?:\s|\")/g)).toHaveLength(2);
    expect(markup).toContain("选点节点");
    expect(markup).toContain("可点父节点");
    expect(markup).toContain("可能点击：#1 close");
  });

  it("shows a recovery action when no node is available", () => {
    const markup = renderToStaticMarkup(
      createElement(NodeSelectionPanel, {
        snapshot: null,
        pickResult: null,
        clickNodes: [],
        onSelectNode: () => undefined,
        onChooseSnapshot: () => undefined,
      }),
    );

    expect(markup).toContain("还没有快照");
    expect(markup).toContain("选择其他快照");
  });
});

function buildSnapshot(nodes: SnapshotNode[]) {
  const raw: RawGkdSnapshot = {
    id: 1,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 1080,
    screenHeight: 1920,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes,
  };

  return normalizeSnapshot(raw, "blob://demo", "test snapshot");
}

function node(id: number, pid: number, attrValue: SnapshotNodeAttr): SnapshotNode {
  return {
    id,
    pid,
    idQf: Boolean(attrValue.id),
    textQf: Boolean(attrValue.text),
    attr: attrValue,
  };
}

function attr(overrides: Partial<SnapshotNodeAttr>): SnapshotNodeAttr {
  return {
    id: null,
    vid: null,
    name: "android.view.View",
    text: null,
    desc: null,
    clickable: false,
    focusable: false,
    checkable: false,
    checked: false,
    editable: false,
    longClickable: false,
    visibleToUser: true,
    left: 0,
    top: 0,
    right: 1080,
    bottom: 1920,
    width: (overrides.right ?? 1080) - (overrides.left ?? 0),
    height: (overrides.bottom ?? 1920) - (overrides.top ?? 0),
    childCount: 0,
    index: 0,
    depth: 0,
    ...overrides,
  };
}
