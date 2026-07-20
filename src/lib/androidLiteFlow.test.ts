import { describe, expect, it } from "vitest";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import { pickNodeAtPoint } from "./nodePicker";
import { generateSelectorCandidates } from "./selectorStrategies";
import { normalizeSnapshot } from "./snapshotNormalize";
import {
  createAndroidFlowSteps,
  createAndroidSingleRulePreview,
  reassignAndroidFlowStepSnapshot,
  resolveAndroidFlowCanvasSnapshots,
  resolveAndroidSnapshotOpenMode,
  shouldShowSnapshotOpeningState,
} from "./androidLiteFlow";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

describe("android lite flow helpers", () => {
  it("opens a single snapshot for one selected id and flow for multiple ids", () => {
    expect(resolveAndroidSnapshotOpenMode(new Set())).toEqual({
      mode: "none",
      ids: [],
    });
    expect(resolveAndroidSnapshotOpenMode(new Set([10]))).toEqual({
      mode: "single",
      ids: [10],
    });
    expect(resolveAndroidSnapshotOpenMode(new Set([10, 11]))).toEqual({
      mode: "flow",
      ids: [10, 11],
    });
  });

  it("creates one editable flow step per selected snapshot", () => {
    const snapshots = [
      buildSnapshot(10, "com.demo.MainActivity", "展开"),
      buildSnapshot(11, "com.demo.PanelActivity", "关闭"),
    ];

    const steps = createAndroidFlowSteps(snapshots);

    expect(steps).toHaveLength(2);
    expect(steps.map((step) => step.title)).toEqual(["", ""]);
    expect(steps.map((step) => step.snapshot.id)).toEqual([10, 11]);
    expect(steps.every((step) => step.pickResult === null)).toBe(true);
  });

  it("reassigns a flow step to another snapshot and clears stale target data", () => {
    const sourceSnapshot = buildSnapshot(10, "com.demo.MainActivity", "展开");
    const targetSnapshot = buildSnapshot(11, "com.demo.PanelActivity", "关闭");
    const pickResult = pickNodeAtPoint(sourceSnapshot, { x: 150, y: 340 });
    expect(pickResult).not.toBeNull();
    const candidates = generateSelectorCandidates({
      snapshot: sourceSnapshot,
      ruleSettings: {
        ...DEFAULT_RULE_SETTINGS,
        activityIds: sourceSnapshot.activityId,
      },
      pickedNode: pickResult!.pickedNode,
      ancestors: pickResult!.ancestors,
      siblings: pickResult!.siblings,
      clickableAncestor: pickResult!.clickableAncestor,
      nearbyTextNodes: pickResult!.nearbyTextNodes,
    });
    const steps = createAndroidFlowSteps([sourceSnapshot]);
    const step = {
      ...steps[0]!,
      title: "关闭弹窗",
      note: "第二步",
      pickResult,
      candidates,
      selectedCandidate: candidates[0] ?? null,
    };

    const nextStep = reassignAndroidFlowStepSnapshot(step, targetSnapshot);

    expect(nextStep).toMatchObject({
      id: step.id,
      title: "关闭弹窗",
      note: "第二步",
      snapshot: targetSnapshot,
      pickResult: null,
      candidates: [],
      selectedCandidate: null,
    });
  });

  it("uses selected snapshots for flow arrows and falls back to all available snapshots", () => {
    const first = buildSnapshot(10, "com.demo.MainActivity", "展开");
    const second = buildSnapshot(11, "com.demo.PanelActivity", "关闭");
    const third = buildSnapshot(12, "com.demo.OtherActivity", "跳过");
    const steps = createAndroidFlowSteps([first]);

    expect(
      resolveAndroidFlowCanvasSnapshots({
        selectedSnapshots: [second, third],
        availableSnapshots: [first, second, third],
        steps,
      }).map((item) => item.id),
    ).toEqual([11, 12]);

    expect(
      resolveAndroidFlowCanvasSnapshots({
        selectedSnapshots: [],
        availableSnapshots: [first, second, third],
        steps,
      }).map((item) => item.id),
    ).toEqual([10, 11, 12]);
  });

  it("keeps flow canvas navigation out of the global opening state", () => {
    expect(shouldShowSnapshotOpeningState("snapshot-list")).toBe(true);
    expect(shouldShowSnapshotOpeningState("flow-canvas")).toBe(false);
  });

  it("creates a copyable JSON5 rule preview from the selected Android candidate", () => {
    const snapshot = buildSnapshot(10, "com.demo.MainActivity", "关闭");
    const pickResult = pickNodeAtPoint(snapshot, { x: 150, y: 340 });
    expect(pickResult).not.toBeNull();
    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: {
        ...DEFAULT_RULE_SETTINGS,
        activityIds: snapshot.activityId,
      },
      pickedNode: pickResult!.pickedNode,
      ancestors: pickResult!.ancestors,
      siblings: pickResult!.siblings,
      clickableAncestor: pickResult!.clickableAncestor,
      nearbyTextNodes: pickResult!.nearbyTextNodes,
    });

    const preview = createAndroidSingleRulePreview(
      snapshot,
      candidates[0],
      candidates,
    );

    expect(preview).toContain("id: 'com.demo'");
    expect(preview).toContain("groups:");
    expect(preview).toContain("rules:");
    expect(preview).toContain("matches:");
  });
});

function buildSnapshot(id: number, activityId: string, buttonText: string) {
  const raw: RawGkdSnapshot = {
    id,
    appId: "com.demo",
    activityId,
    screenWidth: 1080,
    screenHeight: 1920,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes: [
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          id: `com.demo:id/${buttonText}`,
          vid: buttonText,
          name: "android.widget.Button",
          text: buttonText,
          clickable: true,
          left: 100,
          top: 300,
          right: 260,
          bottom: 380,
        }),
      ),
    ],
  };

  return normalizeSnapshot(raw, "blob://demo", `${buttonText} snapshot`);
}

function node(id: number, pid: number, nodeAttr: SnapshotNodeAttr): SnapshotNode {
  return {
    id,
    pid,
    idQf: null,
    textQf: null,
    attr: nodeAttr,
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
    depth: overrides.name === "android.widget.FrameLayout" ? 0 : 1,
    ...overrides,
  };
}
