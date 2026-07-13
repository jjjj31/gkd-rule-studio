import { describe, expect, it } from "vitest";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";
import { pickNodeAtPoint } from "./nodePicker";
import { generateRegionSelectorCandidates } from "./regionCandidates";
import { normalizeSnapshot } from "./snapshotZip";

describe("same-region selector candidates", () => {
  it("includes candidates from other nodes with the same selected bounds", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 2 })),
      node(
        1,
        0,
        attr({
          name: "android.view.View",
          left: 100,
          top: 200,
          right: 420,
          bottom: 320,
          width: 320,
          height: 120,
        }),
      ),
      node(
        2,
        0,
        attr({
          id: "com.demo:id/close",
          vid: "close",
          name: "android.widget.ImageButton",
          desc: "关闭",
          clickable: true,
          left: 100,
          top: 200,
          right: 420,
          bottom: 320,
          width: 320,
          height: 120,
          index: 1,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 180, y: 260 });
    expect(pick?.pickedNode.id).toBe(1);

    const candidates = generateRegionSelectorCandidates({
      snapshot,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      pickResult: pick!,
    });

    expect(
      candidates.some(
        (candidate) =>
          candidate.rule.matches[0] === "ImageButton[vid=\"close\"]" ||
          candidate.rule.matches[0] === "[vid=\"close\"]",
      ),
    ).toBe(true);
    expect(candidates.some((candidate) => candidate.id.startsWith("same-region-2-"))).toBe(true);
    expect(candidates[0].debugReasons[0]).toContain("同框节点 #2");
  });

  it("includes candidates from sibling nodes inside the same compact visual region", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          name: "android.widget.FrameLayout",
          clickable: true,
          left: 100,
          top: 100,
          right: 220,
          bottom: 220,
          width: 120,
          height: 120,
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
          right: 155,
          bottom: 220,
          width: 55,
          height: 120,
        }),
      ),
      node(
        3,
        1,
        attr({
          id: "com.demo:id/close_icon",
          vid: "close_icon",
          name: "android.widget.ImageView",
          desc: "关闭",
          left: 160,
          top: 130,
          right: 205,
          bottom: 175,
          width: 45,
          height: 45,
          index: 1,
        }),
      ),
    ]);

    const garbagePick = pickNodeAtPoint(snapshot, { x: 125, y: 160 });
    expect(garbagePick?.pickedNode.id).toBe(2);

    const candidates = generateRegionSelectorCandidates({
      snapshot,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      pickResult: garbagePick!,
    });

    expect(
      candidates.some(
        (candidate) =>
          candidate.id.startsWith("same-region-3-") &&
          candidate.rule.matches.some((match) => match.includes("close_icon")),
      ),
    ).toBe(true);
  });

  it("scores a candidate near the user's tap above a far-away stable-vid button", () => {
    // 屏幕左上角有个稳定 vid 跳过按钮，屏幕中部右侧是用户真正点中的普通按钮。
    // 修复前：到处扫 stableResourceSemantic 会把远处跳过按钮产成高 baseScore 候选，
    // 又因「唯一命中 +18」而压过真正命中的候选 → 绿框跑到左上角。
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 3 })),
      node(
        1,
        0,
        attr({
          id: "com.demo:id/splash_skip_ll",
          vid: "splash_skip_ll",
          name: "android.widget.ImageView",
          text: "跳过",
          clickable: true,
          left: 40,
          top: 40,
          right: 140,
          bottom: 100,
          width: 100,
          height: 60,
          index: 0,
        }),
      ),
      node(
        2,
        0,
        attr({
          id: "com.demo:id/apply",
          vid: "apply",
          name: "android.widget.Button",
          text: "应用",
          clickable: true,
          left: 800,
          top: 800,
          right: 980,
          bottom: 880,
          width: 180,
          height: 80,
          index: 1,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 890, y: 840 });
    expect(pick?.pickedNode.id).toBe(2);

    const candidates = generateRegionSelectorCandidates({
      snapshot,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      pickResult: pick!,
    });

    // 第一条候选（最高分）的命中节点必须落在用户点选的「应用」按钮上/附近，
    // 不能是屏幕左上角那个远离选点的 splash_skip_ll。
    const top = candidates[0];
    expect(top.validation.clickNodes.length).toBeGreaterThan(0);
    const topHit = top.validation.clickNodes[0];
    // 命中节点中心必须在右半屏（用户点的区域），不在左上角（x<200,y<150）
    const centerX = (topHit.attr.left + topHit.attr.right) / 2;
    const centerY = (topHit.attr.top + topHit.attr.bottom) / 2;
    expect(centerX).toBeGreaterThan(400);
    expect(centerY).toBeGreaterThan(400);

    // 而且远处那个 splash_skip_ll 候选即使存在，分数也应明显低于近处候选：
    // proximity −40 把它压到排序底部，再也排不到第一。
    if (candidates.length > 1) {
      expect(top.risk.finalScore).toBeGreaterThanOrEqual(
        candidates[candidates.length - 1].risk.finalScore,
      );
    }
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
