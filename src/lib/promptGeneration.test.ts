import { describe, expect, it } from "vitest";
import {
  parseCustomScenario,
  resolveCustomScenarioSettings,
} from "./customScenario";
import { buildHelpPrompt } from "./helpPrompt";
import { pickNodeAtPoint } from "./nodePicker";
import { normalizeSnapshot } from "./snapshotNormalize";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

describe("prompt generation", () => {
  it("keeps custom scenario current activity dynamic and imports action fields", () => {
    const oldSnapshot = buildSnapshot("com.demo.OldActivity");
    const nextSnapshot = buildSnapshot("com.demo.NewActivity");

    const scenario = parseCustomScenario(
      `{
        name: '回到应用广告',
        groupName: '全屏广告',
        activityIds: 'current',
        matchTime: 10000,
        actionMaximum: 3,
        actionCd: 1000,
        resetMatch: 'app',
        action: 'clickCenter',
        actionDelay: 2500,
        forcedTime: 10000,
        matchRoot: true,
        description: '离开应用后回来出现',
        detail: 'WebView 倒计时广告需要延迟和重试',
      }`,
      oldSnapshot,
      "",
    );

    expect(scenario.activityIdsMode).toBe("current");
    expect(scenario.settings.activityIds).not.toBe(oldSnapshot.activityId);

    const resolved = resolveCustomScenarioSettings(scenario, nextSnapshot);
    expect(resolved).toMatchObject({
      activityIds: nextSnapshot.activityId ?? "",
      action: "clickCenter",
      actionDelay: 2500,
      forcedTime: 10000,
      matchRoot: true,
    });
  });

  it("keeps node context and strict output contract in the final help prompt, without leaking tool candidates", () => {
    const snapshot = buildSnapshot("com.demo.MainActivity");
    const pick = pickNodeAtPoint(snapshot, { x: 150, y: 340 });
    expect(pick).not.toBeNull();

    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });

    // 不应再注入工具自己的候选 selector / JSON5 草稿——AI 要独立判断
    expect(prompt).not.toContain("当前 JSON5 草稿");
    expect(prompt).not.toContain("当前工具推荐候选");
    expect(prompt).not.toContain("候选 selector 列表");

    expect(prompt).toContain("输出格式");
    expect(prompt).toContain("流氓广告");
    expect(prompt).toContain("shade/mask/hotArea/click_area");
    expect(prompt).toContain("candidates 数量 2-4 个");
    expect(prompt).toContain("测试版 A");
    expect(prompt).toContain("测试反馈格式");
    expect(prompt).toContain("是否误触");
    expect(prompt).toContain("用户点击只是手指常点的大概区域");
    expect(prompt).toContain("同一可视区域可能有多个节点");
    expect(prompt).toContain("不要把当前 pickedNode 当成唯一正确目标");
  });

});

function buildSnapshot(activityId: string) {
  const raw: RawGkdSnapshot = {
    id: 1,
    appId: "com.demo",
    activityId,
    screenWidth: 1080,
    screenHeight: 1920,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes: [
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 2 })),
      node(
        1,
        0,
        attr({
          name: "android.widget.TextView",
          text: "更新提示",
          left: 100,
          top: 100,
          right: 400,
          bottom: 160,
          index: 0,
        }),
      ),
      node(
        2,
        0,
        attr({
          id: "com.demo:id/cancel",
          vid: "cancel",
          name: "android.widget.Button",
          text: "取消",
          clickable: true,
          left: 100,
          top: 300,
          right: 260,
          bottom: 380,
          index: 1,
        }),
      ),
    ],
  };

  return normalizeSnapshot(raw, "blob://demo", "test snapshot");
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
