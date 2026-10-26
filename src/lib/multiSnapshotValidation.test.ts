import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MultiSnapshotValidationPanel } from "../components/MultiSnapshotValidationPanel";
import type { AppRuleDraft } from "../types/ruleDraft";
import type {
  ParsedGkdSnapshot,
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";
import { normalizeSnapshot } from "./snapshotNormalize";
import {
  evaluateMultiSnapshotSample,
  isCurrentMultiSnapshotValidation,
  releaseSnapshotResource,
  toMultiSnapshotSampleMetadata,
} from "./multiSnapshotValidation";

describe("multi-snapshot rule validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("reports positive and negative expectations independently from the shared matcher", () => {
    const app = demoApp(['[text="跳过"]']);
    const positive = snapshot(10, "跳过");
    const negative = snapshot(11, "广告详情");

    const positiveResult = evaluateMultiSnapshotSample({
      sample: sample(10, "positive"),
      snapshot: positive,
      app,
      run: { token: 1, appKey: "same-rule" },
    });
    const negativeResult = evaluateMultiSnapshotSample({
      sample: sample(11, "negative"),
      snapshot: negative,
      app,
      run: { token: 1, appKey: "same-rule" },
    });

    expect(positiveResult.validation).toMatchObject({ status: "satisfied", hitCount: 1 });
    expect(positiveResult.verdict).toBe("pass");
    expect(positiveResult.targets.map((node) => node.id)).toEqual([1]);
    expect(negativeResult.validation).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(negativeResult.verdict).toBe("pass");
  });

  it("treats app rules independently: one rule may match while another does not", () => {
    const app: AppRuleDraft = {
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "多条独立规则",
        rules: [
          { key: 0, matches: ['[text="关闭"]'] },
          { key: 1, matches: ['[text="跳过"]'] },
        ],
      }],
    };
    const matchingRule = evaluateMultiSnapshotSample({
      sample: sample(14, "positive"),
      snapshot: snapshot(14, "跳过"),
      app,
      run: { token: 1, appKey: "same-rule" },
    });
    const negativeSample = evaluateMultiSnapshotSample({
      sample: sample(15, "negative"),
      snapshot: snapshot(15, "跳过"),
      app,
      run: { token: 1, appKey: "same-rule" },
    });

    expect(matchingRule.validation).toMatchObject({
      status: "satisfied",
      hitCount: 1,
    });
    expect(matchingRule.targets.map((node) => node.id)).toEqual([1]);
    expect(matchingRule.verdict).toBe("pass");
    expect(negativeSample.verdict).toBe("fail");
    expect(negativeSample.message).toContain("反例存在已知误命中");
    expect(negativeSample.targets.map((node) => node.id)).toEqual([1]);
  });

  it("keeps known negative-rule targets when another rule is partial, but a partial positive is unknown", () => {
    const app: AppRuleDraft = {
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "已知误触与未知规则",
        rules: [
          { key: 0, matches: ['[text="跳过"]'] },
          {
            key: 1,
            matches: ['[text="关闭"]'],
            versionName: { include: "9.9" },
          } as AppRuleDraft["groups"][number]["rules"][number],
        ],
      }],
    };
    const negative = evaluateMultiSnapshotSample({
      sample: sample(18, "negative"),
      snapshot: snapshot(18, "跳过"),
      app,
      run: { token: 1, appKey: "same-rule" },
    });
    const positive = evaluateMultiSnapshotSample({
      sample: sample(18, "positive"),
      snapshot: snapshot(18, "跳过"),
      app,
      run: { token: 1, appKey: "same-rule" },
    });

    expect(negative.verdict).toBe("fail");
    expect(negative.validation?.status).toBe("partial");
    expect(negative.message).toContain("反例存在已知误命中");
    expect(negative.message).toContain("其他规则未完整验证");
    expect(negative.targets.map((node) => node.id)).toEqual([1]);
    expect(positive.verdict).toBe("unknown");
    expect(positive.validation?.status).toBe("partial");
  });

  it("deduplicates rule targets and only lets partial make an all-unmatched app unknown", () => {
    const duplicateTargets: AppRuleDraft = {
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "两条都命中",
        rules: [
          { key: 0, matches: ['[text="跳过"]'] },
          { key: 1, matches: ['[clickable=true]'] },
        ],
      }],
    };
    const positive = snapshot(16, "跳过");
    const deduped = evaluateMultiSnapshotSample({
      sample: sample(16, "positive"),
      snapshot: positive,
      app: duplicateTargets,
      run: { token: 1, appKey: "same-rule" },
    });
    expect(deduped.targets.map((node) => node.id)).toEqual([1]);
    expect(deduped.validation).toMatchObject({ status: "satisfied", hitCount: 1 });

    const unknownGate: AppRuleDraft = {
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "未知与未命中",
        rules: [
          { key: 0, matches: ['[text="关闭"]'] },
          {
            key: 1,
            matches: ['[text="跳过"]'],
            versionName: { include: "9.9" },
          } as AppRuleDraft["groups"][number]["rules"][number],
        ],
      }],
    };
    const conservative = evaluateMultiSnapshotSample({
      sample: sample(17, "negative"),
      snapshot: snapshot(17, "跳过"),
      app: unknownGate,
      run: { token: 1, appKey: "same-rule" },
    });
    expect(conservative.validation).toMatchObject({ status: "partial", hitCount: 0 });
    expect(conservative.verdict).toBe("unknown");
  });

  it("flags a negative sample that would trigger and keeps partial results unknown", () => {
    const app = demoApp(['[text="跳过"]']);
    const triggered = evaluateMultiSnapshotSample({
      sample: sample(12, "negative"),
      snapshot: snapshot(12, "跳过"),
      app,
      run: { token: 1, appKey: "same-rule" },
    });
    const partialApp = demoApp(['[text="跳过"]']);
    partialApp.groups[0]!.rules[0] = {
      ...partialApp.groups[0]!.rules[0]!,
      versionName: { include: "9.9" },
    } as AppRuleDraft["groups"][number]["rules"][number];
    const unknown = evaluateMultiSnapshotSample({
      sample: sample(13, "positive"),
      snapshot: snapshot(13, "跳过"),
      app: partialApp,
      run: { token: 1, appKey: "same-rule" },
    });

    expect(triggered.verdict).toBe("fail");
    expect(triggered.message).toContain("反例存在已知误命中");
    expect(unknown.validation?.status).toBe("partial");
    expect(unknown.verdict).toBe("unknown");
    expect(unknown.message).toContain("无法完整确认");

    const satisfiedWins: AppRuleDraft = {
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "已满足与未知",
        rules: [
          { key: 0, matches: ['[text="跳过"]'] },
          {
            key: 1,
            matches: ['[text="关闭"]'],
            versionName: { include: "9.9" },
          } as AppRuleDraft["groups"][number]["rules"][number],
        ],
      }],
    };
    const satisfied = evaluateMultiSnapshotSample({
      sample: sample(12, "positive"),
      snapshot: snapshot(12, "跳过"),
      app: satisfiedWins,
      run: { token: 1, appKey: "same-rule" },
    });
    expect(satisfied.validation).toMatchObject({ status: "partial", hitCount: 0 });
    expect(satisfied.verdict).toBe("unknown");
    expect(satisfied.targets).toEqual([]);
    expect(satisfied.rules.find((rule) => rule.status === "satisfied")?.hitCount).toBe(1);
  });

  it("recalculates from current rule content and rejects a response for another rule or older run", () => {
    const loaded = snapshot(20, "跳过");
    const firstApp = demoApp(['[text="跳过"]']);
    const editedApp = demoApp(['[text="关闭"]']);
    const input = {
      sample: sample(20, "positive"),
      snapshot: loaded,
      app: firstApp,
      run: { token: 3, appKey: "current" },
    };

    expect(evaluateMultiSnapshotSample(input).verdict).toBe("pass");
    const edited = evaluateMultiSnapshotSample({
      ...input,
      app: editedApp,
      run: { token: 4, appKey: "current" },
    });
    expect(edited.validation?.status).toBe("unsatisfied");
    expect(edited.verdict).toBe("fail");

    expect(
      isCurrentMultiSnapshotValidation(
        { token: 3, appKey: "current" },
        { token: 4, appKey: "current" },
      ),
    ).toBe(false);
    expect(
      isCurrentMultiSnapshotValidation(
        { token: 4, appKey: "current" },
        { token: 4, appKey: "other-rule" },
      ),
    ).toBe(false);

    const otherApp = { ...demoApp(['[text="跳过"]']), id: "com.other" };
    const wrongAppResult = evaluateMultiSnapshotSample({
      ...input,
      app: otherApp,
    });
    expect(wrongAppResult.validation).toBeNull();
    expect(wrongAppResult.verdict).toBe("unknown");
  });

  it("keeps session metadata free of blob URLs", () => {
    const parentSnapshot = snapshot(30, "跳过");
    const metadata = toMultiSnapshotSampleMetadata(
      parentSnapshot,
      "negative",
      "当前快照",
    );

    expect(metadata).toEqual({
      id: 30,
      appId: "com.demo",
      expectation: "negative",
      sourceLabel: "当前快照",
      nodeCount: 2,
    });
    expect(JSON.stringify(metadata)).not.toContain("blob:");
    expect(parentSnapshot.screenshotUrl).toBe("blob:parent-30");
  });

  it("renders the current snapshot as a local sample and exposes the device loader boundary", () => {
    const markup = renderToStaticMarkup(
      createElement(MultiSnapshotValidationPanel, {
        app: demoApp(['[text="跳过"]']),
        snapshot: snapshot(40, "跳过"),
        availableSnapshots: [{
          id: 41,
          appId: "com.demo",
          activityId: "com.demo.MainActivity",
          screenWidth: 500,
          screenHeight: 200,
          isLandscape: false,
          appName: "Demo",
        }],
        loadSnapshot: async (id) => snapshot(id, "广告详情"),
      }),
    );

    expect(markup).toContain("添加当前快照为正例");
    expect(markup).toContain("添加当前快照为反例");
    expect(markup).toContain("当前快照不会被自动计入");
  });

  it("revokes only the screenshot URL created by this panel", () => {
    const revoked: string[] = [];
    const parent = snapshot(50, "跳过");
    const owned = snapshot(51, "广告详情");
    releaseSnapshotResource(
      { screenshotUrl: parent.screenshotUrl, ownedUrl: false },
      (url) => revoked.push(url),
    );
    releaseSnapshotResource(
      { screenshotUrl: owned.screenshotUrl, ownedUrl: true },
      (url) => revoked.push(url),
    );
    expect(revoked).toEqual([owned.screenshotUrl]);
  });
});

function demoApp(matches: string[]): AppRuleDraft {
  return {
    id: "com.demo",
    name: "Demo",
    groups: [{ key: 0, name: "广告", rules: [{ key: 0, matches }] }],
  };
}

function sample(id: number, expectation: "positive" | "negative") {
  return {
    id,
    appId: "com.demo",
    expectation,
    sourceLabel: `样例 ${id}`,
    nodeCount: 2,
  };
}

function snapshot(id: number, text: string): ParsedGkdSnapshot {
  const raw: RawGkdSnapshot = {
    id,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 500,
    screenHeight: 200,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes: [
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(1, 0, attr({
        name: "android.widget.Button",
        text,
        clickable: true,
        left: 20,
        top: 20,
        right: 120,
        bottom: 70,
      })),
    ],
  };
  return normalizeSnapshot(raw, `blob:${id === 31 ? "owned" : "parent"}-${id}`, `${id}.zip`);
}

function node(id: number, pid: number, value: SnapshotNodeAttr): SnapshotNode {
  return { id, pid, idQf: false, textQf: Boolean(value.text), attr: value };
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
    right: 500,
    bottom: 200,
    width: 500,
    height: 200,
    childCount: 0,
    index: 0,
    depth: 0,
    ...overrides,
  };
}
