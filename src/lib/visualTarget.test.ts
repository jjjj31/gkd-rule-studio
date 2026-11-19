import { describe, expect, it } from "vitest";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";
import { pickNodeAtPoint } from "./nodePicker";
import { generateRegionSelectorCandidates } from "./regionCandidates";
import { normalizeSnapshot } from "./snapshotNormalize";
import {
  buildVisualTargetIds,
  isClickWithinVisualTarget,
  visualRectSimilarity,
} from "./visualTarget";

describe("visual target stack", () => {
  it("merges same-size ancestors, children and siblings but not larger containers", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 2 })),
      node(
        1,
        0,
        attr({
          name: "android.widget.FrameLayout",
          left: 100,
          top: 100,
          right: 300,
          bottom: 300,
          childCount: 2,
        }),
      ),
      node(
        2,
        1,
        attr({
          name: "android.view.View",
          left: 100,
          top: 100,
          right: 300,
          bottom: 300,
          childCount: 1,
        }),
      ),
      node(
        3,
        2,
        attr({
          name: "android.widget.TextView",
          text: "关闭",
          left: 100,
          top: 100,
          right: 300,
          bottom: 300,
        }),
      ),
      node(
        4,
        1,
        attr({
          id: "com.demo:id/close",
          vid: "close",
          name: "android.widget.ImageButton",
          clickable: true,
          left: 100,
          top: 100,
          right: 300,
          bottom: 300,
          index: 1,
        }),
      ),
      node(
        5,
        6,
        attr({
          name: "android.view.View",
          left: 100,
          top: 100,
          right: 300,
          bottom: 300,
        }),
      ),
      node(6, 0, attr({ name: "android.widget.FrameLayout", index: 1 })),
    ]);

    const picked = snapshot.nodeById.get(3)!;
    const ids = buildVisualTargetIds({ snapshot, pickedNode: picked });

    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(ids.has(0)).toBe(false);
    expect(ids.has(5)).toBe(false);
  });

  it("treats a same-size sibling as the same visual target", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 2 })),
      node(
        1,
        0,
        attr({
          name: "android.view.View",
          left: 10,
          top: 10,
          right: 110,
          bottom: 60,
        }),
      ),
      node(
        2,
        0,
        attr({
          id: "com.demo:id/close",
          name: "android.widget.ImageButton",
          clickable: true,
          left: 10,
          top: 10,
          right: 110,
          bottom: 60,
          index: 1,
        }),
      ),
    ]);

    const ids = buildVisualTargetIds({
      snapshot,
      pickedNode: snapshot.nodeById.get(1)!,
    });
    expect(ids.has(2)).toBe(true);
    expect(visualRectSimilarity(snapshot.nodeById.get(1)!, snapshot.nodeById.get(2)!)).toBe(1);
  });

  it("checks whether all clicked nodes stay inside the stack", () => {
    const ids = new Set([1, 2, 3]);
    expect(isClickWithinVisualTarget([1], ids)).toBe(true);
    expect(isClickWithinVisualTarget([1, 2], ids)).toBe(true);
    expect(isClickWithinVisualTarget([1, 9], ids)).toBe(false);
    expect(isClickWithinVisualTarget([], ids)).toBe(false);
  });
});

describe("visual stack hard ranking", () => {
  it("puts a same-stack sibling above a far-away stable-vid button", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 3 })),
      node(
        1,
        0,
        attr({
          name: "android.view.View",
          left: 100,
          top: 100,
          right: 300,
          bottom: 300,
        }),
      ),
      node(
        2,
        0,
        attr({
          id: "com.demo:id/close",
          vid: "close",
          name: "android.widget.ImageButton",
          clickable: true,
          left: 100,
          top: 100,
          right: 300,
          bottom: 300,
          index: 1,
        }),
      ),
      node(
        3,
        0,
        attr({
          id: "com.demo:id/far_skip",
          vid: "far_skip",
          name: "android.widget.Button",
          text: "跳过",
          clickable: true,
          left: 800,
          top: 800,
          right: 980,
          bottom: 880,
          index: 2,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 150, y: 150 });
    expect(pick?.pickedNode.id).toBe(1);

    const candidates = generateRegionSelectorCandidates({
      snapshot,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      pickResult: pick!,
    });

    expect(candidates[0].validation.clickNodes.map((node) => node.id)).toEqual([2]);
    expect(candidates[0].rule.matches[0]).toContain("close");
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
