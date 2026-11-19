import { describe, expect, it } from "vitest";
import {
  parseCustomScenario,
  resolveCustomScenarioSettings,
} from "./customScenario";
import { buildHelpPrompt } from "./helpPrompt";
import { formatAuthoringFeedbackPrompt, classifyAuthoringFeedback } from "./authoringFeedback";
import { pickNodeAtPoint } from "./nodePicker";
import { normalizeSnapshot } from "./snapshotNormalize";
import type { FewShotHit } from "./fewShotRetrieval";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

describe("prompt generation", () => {
  it("separates UI-observed failure from static evidence in the public AI feedback prompt", () => {
    const prompt = formatAuthoringFeedbackPrompt({
      description: classifyAuthoringFeedback({
      result: "scope-or-timing-pending",
      note: "我看到页面没有变化",
      snapshotId: 9,
      appId: "com.demo",
      staticValidation: "unsatisfied",
      diagnostics: ["当前 Activity 不匹配"],
      knownLimitations: ["没有设备运行日志"],
      }),
      staticValidation: "unsatisfied",
    });
    expect(prompt).toContain('"staticValidation": "unsatisfied"');
    expect(prompt).toContain("当前 Activity 不匹配");
    expect(prompt).toContain("没有设备运行日志");
    expect(prompt).toContain("user 备注");
    expect(prompt).not.toContain("根因是");
  });

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
    // 默认必须内嵌节点树摘要（首页导出文件是补充，不替代 prompt 里的快照信息）
    expect(prompt).toContain("节点树摘要：");
    expect(prompt).not.toContain("本 prompt 不再内嵌节点树");
    expect(prompt).toContain("流氓广告");
    expect(prompt).toContain("shade/mask/hotArea/click_area");
    expect(prompt).toContain("candidates 数量 2-4 个");
    expect(prompt).toContain("测试版 A");
    expect(prompt).toContain("测试反馈格式");
    expect(prompt).toContain("是否误触");
    expect(prompt).toContain("pickedNode 是用户选中的目标区域");
    expect(prompt).toContain("与它矩形重合的视觉摞");
    expect(prompt).toContain("第一条候选必须命中 pickedNode 本身");
    expect(prompt).toContain("禁止用同屏标题、兄弟 CTA、无关关闭图标代替目标");
    expect(prompt).toContain("属性名和值必须原样照抄节点树");
    expect(prompt).toContain("@[clickable=true] > [text=\"...\"]");
    expect(prompt).toContain("Parent > Child");
    expect(prompt).toContain("> 只匹配直接子节点");
    expect(prompt).toContain("禁止 [bounds=...]");
    expect(prompt).toContain("多分支请用 anyMatches 数组");
    expect(prompt).toContain("输出前自检");
  });

  it("omits the embedded node tree when includeNodeTree is false but keeps pick context", () => {
    const snapshot = buildSnapshot("com.demo.MainActivity");
    const pick = pickNodeAtPoint(snapshot, { x: 150, y: 340 });
    expect(pick).not.toBeNull();

    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      includeNodeTree: false,
    });

    // 不再内嵌节点树，改为指引读导出文件
    expect(prompt).not.toContain("节点树摘要：");
    expect(prompt).toContain("本 prompt 不再内嵌节点树");
    expect(prompt).toContain("导出文件");
    // 选点上下文保留
    expect(prompt).toContain("用户点击的目标节点：");
    expect(prompt).toContain("祖先链（从近到远）：");
    expect(prompt).toContain("同级节点：");
  });

  it("adds retrieved official examples without replacing current snapshot context", () => {
    const snapshot = buildSnapshot("com.demo.MainActivity");
    const pick = pickNodeAtPoint(snapshot, { x: 150, y: 340 });
    expect(pick).not.toBeNull();

    const example: FewShotHit = {
      score: 0.93,
      record: {
        id: "other:1",
        appId: "com.other",
        appName: "Other",
        groupName: "全屏广告",
        selector: "@[vid=\"iv_close\"] - [vid=\"rl_ad\"][visibleToUser=true]",
        selectorShape: {
          kind: "sibling",
          hasAt: true,
          hasUnion: false,
          hasHierarchy: false,
          hasSibling: true,
          attrs: ["vid", "visibleToUser"],
        },
        target: {
          id: 1,
          name: "android.widget.ImageView",
          vid: "iv_close",
          text: null,
          desc: null,
          clickable: true,
          childCount: 0,
          depth: 4,
          bounds: [858, 1887, 953, 1982],
        },
        context: {
          ancestors: [],
          siblings: [
            {
              id: 2,
              name: "android.widget.RelativeLayout",
              vid: "rl_ad",
              text: null,
              desc: null,
              clickable: false,
              visible: true,
            },
          ],
          anchors: [],
          targetPath: "FrameLayout > ImageView",
        },
        features: ["cls:ImageView", "vid:yes"],
      },
    };

    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      fewShotExamples: [example],
    });

    expect(prompt).toContain("相似历史案例");
    expect(prompt).toContain("案例 1");
    expect(prompt).toContain("形态 sibling");
    expect(prompt).toContain(example.record.selector);
    expect(prompt).toContain("用户点击的目标节点：");
    expect(prompt).toContain("节点树摘要：");
  });

  it("carries scenario label and description alongside run settings", () => {
    const snapshot = buildSnapshot("com.demo.MainActivity");
    const pick = pickNodeAtPoint(snapshot, { x: 150, y: 340 });

    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      scenario: { label: "开屏广告", description: "打开应用后一段时间内出现" },
    });

    expect(prompt).toContain("场景：");
    expect(prompt).toContain("- 场景名称: 开屏广告");
    expect(prompt).toContain("- 场景说明: 打开应用后一段时间内出现");
    expect(prompt).toContain("期望运行参数：");
    expect(prompt).toContain("- matchTime:");
  });

  it("injects clickability warning and real attribute whitelist when target is unclickable", () => {
    const raw: RawGkdSnapshot = {
      id: 2,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
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
            name: "android.widget.LinearLayout",
            clickable: true,
            left: 200,
            top: 200,
            right: 400,
            bottom: 280,
            childCount: 1,
          }),
        ),
        node(
          2,
          1,
          attr({
            name: "android.widget.TextView",
            text: "跳过广告",
            clickable: false,
            left: 200,
            top: 200,
            right: 400,
            bottom: 280,
            id: "com.demo:id/skip_tv",
          }),
        ),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "blob://demo2", "test");
    const pick = pickNodeAtPoint(snapshot, { x: 250, y: 240 });
    expect(pick).not.toBeNull();

    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });

    expect(prompt).toContain("目标区域与可点击性事实：");
    expect(prompt).toContain("【关键警示】当前选中的 pickedNode (#2) clickable=false");
    expect(prompt).toContain("可响应点击的父容器/同层节点为 #1 LinearLayout (clickable=true)");
    expect(prompt).toContain("@[clickable=true] > [text=");
    expect(prompt).toContain("局部节点真实属性白名单");
    expect(prompt).toContain('id="com.demo:id/skip_tv"');
  });

  it("preserves title and anchor nodes during tree pruning on large snapshots", () => {
    const nodes: SnapshotNode[] = [
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 250 })),
    ];
    // 创建一个包含 250 个节点的假快照
    for (let i = 1; i <= 240; i++) {
      nodes.push(
        node(
          i,
          0,
          attr({
            name: "android.view.View",
            left: 0,
            top: i * 5,
            right: 100,
            bottom: i * 5 + 4,
          }),
        ),
      );
    }
    // 关键标题锚点（远离 0 号，但有重要 text）
    nodes.push(
      node(
        245,
        0,
        attr({
          name: "android.widget.TextView",
          text: "青少年模式提醒",
          id: "com.demo:id/dialog_title",
          left: 100,
          top: 100,
          right: 300,
          bottom: 150,
        }),
      ),
    );
    // 目标关闭按钮
    nodes.push(
      node(
        246,
        0,
        attr({
          name: "android.widget.Button",
          text: "我知道了",
          clickable: true,
          left: 100,
          top: 200,
          right: 300,
          bottom: 260,
        }),
      ),
    );

    const raw: RawGkdSnapshot = {
      id: 3,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 1920,
      isLandscape: false,
      nodes,
    };
    const snapshot = normalizeSnapshot(raw, "blob://demo3", "test");
    const pick = pickNodeAtPoint(snapshot, { x: 150, y: 230 });
    expect(pick).not.toBeNull();

    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });

    expect(prompt).toContain("展示目标节点相关子树（含关键文本/组件锚点）：");
    // 保锚裁剪成功保留了青少年模式提醒与目标按钮
    expect(prompt).toContain("青少年模式提醒");
    expect(prompt).toContain("我知道了");
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
