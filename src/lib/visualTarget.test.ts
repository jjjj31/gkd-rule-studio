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
  findSafeClickableAncestor,
  findSafeClickableAncestorWithDiagnostics,
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

  it("unconditionally includes pickedNode.id even when visibleToUser is false", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          name: "android.view.View",
          visibleToUser: false,
          left: 100,
          top: 100,
          right: 200,
          bottom: 200,
        }),
      ),
    ]);

    const ids = buildVisualTargetIds({
      snapshot,
      pickedNode: snapshot.nodeById.get(1)!,
    });
    expect(ids.has(1)).toBe(true);
  });

  it("prevents BFS chain drift across gradually larger ancestors", () => {
    // 每层仅比子层大 ~8%（相邻重叠 >= 0.9），但第 3/4 层相对 pickedNode 已漂移超过 10%
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(1, 0, attr({ left: 100, top: 100, right: 230, bottom: 200, childCount: 1 })),
      node(2, 1, attr({ left: 100, top: 100, right: 218, bottom: 200, childCount: 1 })),
      node(3, 2, attr({ left: 100, top: 100, right: 208, bottom: 200, childCount: 1 })),
      node(4, 3, attr({ left: 100, top: 100, right: 200, bottom: 200 })),
    ]);

    const ids = buildVisualTargetIds({
      snapshot,
      pickedNode: snapshot.nodeById.get(4)!,
    });
    expect(ids.has(4)).toBe(true);
    expect(ids.has(3)).toBe(true);
    // 100x100 vs 118x100 = 0.847 < 0.9，不允许链式漂移
    expect(ids.has(2)).toBe(false);
    expect(ids.has(1)).toBe(false);
  });
});

describe("findSafeClickableAncestor", () => {
  it("walks up to depth 5 (depth < 6), skips overlay shades, and rejects dangerous CTA ancestors", () => {
    const deepSafeSnap = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      // depth=4 (0-indexed from node 6: 5->0, 4->1, 3->2, 2->3, 1->4)
      node(
        1,
        0,
        attr({
          id: "com.demo:id/skip_ll",
          vid: "skip_ll",
          clickable: true,
          left: 800,
          top: 60,
          right: 1000,
          bottom: 160,
          childCount: 1,
        }),
      ),
      // overlay shade should be skipped
      node(
        2,
        1,
        attr({
          id: "com.demo:id/splash_skip_shade",
          vid: "splash_skip_shade",
          clickable: true,
          left: 800,
          top: 60,
          right: 1000,
          bottom: 160,
          childCount: 1,
        }),
      ),
      node(3, 2, attr({ left: 805, top: 65, right: 995, bottom: 155, childCount: 1 })),
      node(4, 3, attr({ left: 810, top: 70, right: 990, bottom: 150, childCount: 1 })),
      node(5, 4, attr({ left: 820, top: 80, right: 980, bottom: 140, childCount: 1 })),
      node(6, 5, attr({ text: "跳过", left: 830, top: 90, right: 970, bottom: 130 })),
    ]);

    expect(findSafeClickableAncestor(deepSafeSnap, deepSafeSnap.nodeById.get(6)!)?.id).toBe(1);

    // depth=6 超出 depth < 6 限制，应返回 null
    const tooDeepSnap = buildSnapshot([
      node(0, -1, attr({ childCount: 1 })),
      node(1, 0, attr({ vid: "skip_ll", clickable: true, left: 800, top: 60, right: 1000, bottom: 160, childCount: 1 })),
      node(2, 1, attr({ left: 805, top: 65, right: 995, bottom: 155, childCount: 1 })),
      node(3, 2, attr({ left: 810, top: 70, right: 990, bottom: 150, childCount: 1 })),
      node(4, 3, attr({ left: 815, top: 75, right: 985, bottom: 145, childCount: 1 })),
      node(5, 4, attr({ left: 820, top: 80, right: 980, bottom: 140, childCount: 1 })),
      node(6, 5, attr({ left: 825, top: 85, right: 975, bottom: 135, childCount: 1 })),
      node(7, 6, attr({ left: 830, top: 90, right: 970, bottom: 130, childCount: 1 })),
      node(8, 7, attr({ text: "跳过", left: 835, top: 95, right: 965, bottom: 125 })),
    ]);
    expect(findSafeClickableAncestor(tooDeepSnap, tooDeepSnap.nodeById.get(8)!)).toBeNull();

    // 正向危险 CTA（下载/立即打开/查看详情）祖先必须被过滤
    const dangerCtaSnap = buildSnapshot([
      node(0, -1, attr({ childCount: 1 })),
      node(
        1,
        0,
        attr({
          text: "立即下载",
          clickable: true,
          left: 800,
          top: 60,
          right: 1000,
          bottom: 160,
          childCount: 1,
        }),
      ),
      node(2, 1, attr({ left: 830, top: 90, right: 970, bottom: 130 })),
    ]);
    expect(findSafeClickableAncestor(dangerCtaSnap, dangerCtaSnap.nodeById.get(2)!)).toBeNull();
  });

  it("enforces 0.08 area cap for generic ancestors and allows up to 0.15 for explicit dismiss ancestors", () => {
    // screen = 1080 * 1920 = 2,073,600; 10% ≈ 207,360 (e.g. 520 * 400 = 208,000, ratio ≈ 0.1003)
    const genericSnap = buildSnapshot([
      node(0, -1, attr({ childCount: 1 })),
      node(1, 0, attr({ clickable: true, left: 0, top: 0, right: 520, bottom: 400, childCount: 1 })),
      node(2, 1, attr({ text: "跳过", left: 100, top: 100, right: 200, bottom: 150 })),
    ]);
    expect(findSafeClickableAncestor(genericSnap, genericSnap.nodeById.get(2)!)).toBeNull();

    const dismissSnap = buildSnapshot([
      node(0, -1, attr({ childCount: 1 })),
      node(
        1,
        0,
        attr({
          vid: "btn_skip",
          clickable: true,
          left: 0,
          top: 0,
          right: 520,
          bottom: 400,
          childCount: 1,
        }),
      ),
      node(2, 1, attr({ text: "跳过", left: 100, top: 100, right: 200, bottom: 150 })),
    ]);
    expect(findSafeClickableAncestor(dismissSnap, dismissSnap.nodeById.get(2)!)?.id).toBe(1);
  });

  it("rejects clickable containers holding multiple distinct action texts but accepts skip + countdown", () => {
    const multiActionSnap = buildSnapshot([
      node(0, -1, attr({ childCount: 1 })),
      node(1, 0, attr({ clickable: true, left: 100, top: 100, right: 400, bottom: 180, childCount: 2 })),
      node(2, 1, attr({ text: "取消", left: 110, top: 110, right: 220, bottom: 170, index: 0 })),
      node(3, 1, attr({ text: "确定", left: 260, top: 110, right: 390, bottom: 170, index: 1 })),
    ]);
    expect(findSafeClickableAncestor(multiActionSnap, multiActionSnap.nodeById.get(2)!)).toBeNull();

    const skipCountdownSnap = buildSnapshot([
      node(0, -1, attr({ childCount: 1 })),
      node(1, 0, attr({ vid: "skip_ll", clickable: true, left: 800, top: 60, right: 980, bottom: 130, childCount: 2 })),
      node(2, 1, attr({ text: "跳过", left: 810, top: 70, right: 900, bottom: 120, index: 0 })),
      node(3, 1, attr({ text: "3s", left: 910, top: 70, right: 970, bottom: 120, index: 1 })),
    ]);
    expect(findSafeClickableAncestor(skipCountdownSnap, skipCountdownSnap.nodeById.get(2)!)?.id).toBe(1);
  });

  it("returns diagnostics explaining why oversized generic or multi-action ancestors were rejected", () => {
    // 11% 无信号容器（1080 * 1920 = 2,073,600; 570 * 400 = 228,000 ≈ 11.0%）
    const oversizedGenericSnap = buildSnapshot([
      node(0, -1, attr({ childCount: 1 })),
      node(1, 0, attr({ clickable: true, left: 0, top: 0, right: 570, bottom: 400, childCount: 1 })),
      node(2, 1, attr({ text: "取消", left: 100, top: 100, right: 200, bottom: 150 })),
    ]);
    const oversizedDiag = findSafeClickableAncestorWithDiagnostics(
      oversizedGenericSnap,
      oversizedGenericSnap.nodeById.get(2)!,
    );
    expect(oversizedDiag.safeAncestor).toBeNull();
    expect(oversizedDiag.unsafeClickableAncestor?.id).toBe(1);
    expect(oversizedDiag.unsafeReason).toContain(">8%");

    // 6% 多动作按钮栏（“取消”+“立即下载”）
    const multiActionBarSnap = buildSnapshot([
      node(0, -1, attr({ childCount: 1 })),
      node(1, 0, attr({ clickable: true, left: 100, top: 100, right: 720, bottom: 300, childCount: 2 })),
      node(2, 1, attr({ text: "取消", left: 120, top: 140, right: 320, bottom: 260, index: 0 })),
      node(3, 1, attr({ text: "立即下载", left: 400, top: 140, right: 700, bottom: 260, index: 1 })),
    ]);
    const multiDiag = findSafeClickableAncestorWithDiagnostics(
      multiActionBarSnap,
      multiActionBarSnap.nodeById.get(2)!,
    );
    expect(multiDiag.safeAncestor).toBeNull();
    expect(multiDiag.unsafeClickableAncestor?.id).toBe(1);
    expect(multiDiag.unsafeReason).toContain("多个动作控件");
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
