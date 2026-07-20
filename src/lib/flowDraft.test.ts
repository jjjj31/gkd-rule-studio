import { describe, expect, it } from "vitest";
import {
  buildFlowHelpPrompt,
  createFlowAppRuleDraft,
} from "./flowDraft";
import { pickNodeAtPoint } from "./nodePicker";
import { generateSelectorCandidates } from "./selectorStrategies";
import { normalizeSnapshot } from "./snapshotNormalize";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";
import type { FlowRuleStep } from "../types/flowDraft";

describe("flow draft generation", () => {
  it("generates one local multi-step group with preKeys", () => {
    const first = buildSnapshot("com.demo.MainActivity", "展开");
    const second = buildSnapshot("com.demo.PanelActivity", "关闭");
    const third = buildSnapshot("com.demo.ResultActivity", "返回");
    const steps = [
      buildStep("step-1", "点展开", first, { x: 160, y: 330 }),
      buildStep("step-2", "点关闭", second, { x: 160, y: 330 }),
      buildStep("step-3", "点返回", third, { x: 160, y: 330 }),
    ];

    const draft = createFlowAppRuleDraft({
      flowName: "展开后关闭",
      flowDesc: "测试多步骤本地规则拼接",
      steps,
    });

    expect(draft).not.toBeNull();
    expect(draft?.groups).toHaveLength(1);
    expect(draft?.groups[0]).toMatchObject({
      name: "展开后关闭",
      desc: "测试多步骤本地规则拼接",
    });
    expect(draft?.groups[0].rules).toHaveLength(3);
    expect(draft?.groups[0].rules.map((rule) => rule.key)).toEqual([1, 2, 3]);
    expect(draft?.groups[0].rules.map((rule) => rule.name)).toEqual([
      "点展开",
      "点关闭",
      "点返回",
    ]);
    expect(draft?.groups[0].rules[0].preKeys).toBeUndefined();
    expect(draft?.groups[0].rules[1].preKeys).toEqual([1]);
    expect(draft?.groups[0].rules[2].preKeys).toEqual([1, 2]);
    expect(draft?.groups[0].rules.map((rule) => rule.activityIds)).toEqual([
      "com.demo.MainActivity",
      "com.demo.PanelActivity",
      "com.demo.ResultActivity",
    ]);
  });

  it("builds a flow help prompt that asks AI to generate a complete rule", () => {
    const steps = [
      buildStep(
        "step-1",
        "点展开",
        buildSnapshot("com.demo.MainActivity", "展开"),
        { x: 160, y: 330 },
      ),
      buildStep(
        "step-2",
        "点关闭",
        buildSnapshot("com.demo.PanelActivity", "关闭"),
        { x: 160, y: 330 },
      ),
    ];

    const prompt = buildFlowHelpPrompt({
      flowName: "展开后关闭",
      flowDesc: "用多个快照生成一组连续操作规则",
      steps,
    });

    expect(prompt).toContain("请根据下面的多快照流程信息生成完整的多步骤 GKD 规则");
    expect(prompt).toContain("这是一份求助 prompt");
    expect(prompt).toContain("preKeys");
    expect(prompt).toContain("步骤 1：点展开");
    expect(prompt).toContain("步骤 2：点关闭");
    expect(prompt).toContain("com.demo.PanelActivity");
    expect(prompt).not.toContain("本地生成的 JSON5 草稿仅作为参考");
    expect(prompt).not.toContain("当前步骤推荐候选");
    expect(prompt).not.toContain("当前步骤候选 selector");
    expect(prompt).toContain("流氓广告");
    expect(prompt).toContain("shade/mask/hotArea/click_area");
    expect(prompt).toContain("candidates 数量 2-4 个");
    expect(prompt).toContain("测试版 A");
    expect(prompt).toContain("测试反馈格式");
    expect(prompt).toContain("是否误触");
    expect(prompt).toContain("用户点击只是手指常点的大概区域");
    expect(prompt).toContain("同一可视区域可能有多个节点");
    expect(prompt).toContain("不要把当前 pickedNode 当成唯一正确目标");
    expect(prompt).toContain("- 当前步骤节点树摘要：");
    expect(prompt).toContain("#0 FrameLayout");
    expect(prompt).toContain("#1 Button");
    expect(prompt).not.toContain("请审查下面这个本地生成的多步骤 GKD 规则草稿");
  });
});

function buildStep(
  id: string,
  title: string,
  snapshot: ReturnType<typeof normalizeSnapshot>,
  point: { x: number; y: number },
): FlowRuleStep {
  const pickResult = pickNodeAtPoint(snapshot, point);
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

  return {
    id,
    title,
    note: `${title} 后等待界面自然变化`,
    delayNote: "仅作为 prompt 上下文，不保证强流程顺序",
    snapshot,
    pickResult,
    candidates,
    selectedCandidate: candidates[0],
  };
}

function buildSnapshot(activityId: string, buttonText: string) {
  const raw: RawGkdSnapshot = {
    id: 1,
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
