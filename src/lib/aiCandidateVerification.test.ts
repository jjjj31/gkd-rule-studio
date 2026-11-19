import { describe, expect, it } from "vitest";
import { normalizeSnapshot } from "./snapshotNormalize";
import {
  verifyAiCandidates,
  repairAiCandidateSelector,
  repairAiCandidate,
  rerankAiCandidates,
  buildAiStaticFailurePrompt,
} from "./aiCandidateVerification";
import type { AiRuleCandidate } from "./aiModel";
import type { RuleDraft } from "../types/ruleDraft";
import type {
  ParsedGkdSnapshot,
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

function buildSnapshot(): ParsedGkdSnapshot {
  const nodes: SnapshotNode[] = [
    node(0, -1, {
      name: "android.widget.FrameLayout",
      childCount: 5,
      right: 1080,
      bottom: 2400,
    }),
    node(1, 0, {
      name: "android.widget.TextView",
      text: "跳过",
      clickable: true,
      right: 200,
      bottom: 80,
      width: 200,
      height: 80,
      depth: 1,
    }),
    node(2, 0, {
      name: "android.widget.Button",
      text: "关闭",
      clickable: true,
      right: 200,
      bottom: 160,
      width: 200,
      height: 80,
      depth: 1,
      index: 1,
    }),
    node(3, 0, {
      name: "android.widget.Button",
      text: "关闭",
      clickable: true,
      right: 200,
      bottom: 240,
      width: 200,
      height: 80,
      depth: 1,
      index: 2,
    }),
    node(4, 0, {
      name: "android.widget.TextView",
      text: "下一页",
      clickable: true,
      right: 200,
      bottom: 320,
      width: 200,
      height: 80,
      depth: 1,
      index: 3,
    }),
  ];
  const raw: RawGkdSnapshot = {
    id: 1,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 1080,
    screenHeight: 2400,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes,
  };
  return normalizeSnapshot(raw, "blob:test", "test.zip");
}

function node(id: number, pid: number, attrValue: Partial<SnapshotNodeAttr>): SnapshotNode {
  return {
    id,
    pid,
    idQf: Boolean(attrValue.id),
    textQf: Boolean(attrValue.text),
    attr: {
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
      bottom: 2400,
      width: 1080,
      height: 2400,
      childCount: 0,
      index: 0,
      depth: 0,
      ...attrValue,
    },
  };
}

/** 同一个按钮的文字层和容器层，矩形完全重合。 */
function buildStackedSnapshot(): ParsedGkdSnapshot {
  const nodes: SnapshotNode[] = [
    node(0, -1, {
      name: "android.widget.FrameLayout",
      childCount: 1,
      right: 1080,
      bottom: 2400,
    }),
    node(1, 0, {
      name: "android.widget.FrameLayout",
      text: "关闭",
      clickable: true,
      left: 800,
      top: 100,
      right: 1000,
      bottom: 200,
      width: 200,
      height: 100,
      depth: 1,
    }),
    node(2, 1, {
      name: "android.widget.TextView",
      text: "关闭",
      clickable: true,
      left: 800,
      top: 100,
      right: 1000,
      bottom: 200,
      width: 200,
      height: 100,
      depth: 2,
    }),
  ];
  const raw: RawGkdSnapshot = {
    id: 2,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 1080,
    screenHeight: 2400,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes,
  };
  return normalizeSnapshot(raw, "blob:stacked", "stacked.zip");
}

function candidate(
  matches: string[],
  rule: Partial<RuleDraft> = {},
  appId = "com.demo",
): AiRuleCandidate {
  return {
    id: "candidate-a",
    title: "测试版 A",
    summary: "",
    risk: "",
    app: {
      id: appId,
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "测试",
          rules: [{ key: 0, matches, ...rule }],
        },
      ],
    },
  };
}

function verify(
  snapshot: ParsedGkdSnapshot,
  matches: string[],
  rule: Partial<RuleDraft> = {},
) {
  return verifyAiCandidates(
    snapshot,
    [candidate(matches, rule)],
    snapshot.nodeById.get(1) ?? null,
  )[0];
}

describe("verifyAiCandidates", () => {
  it("唯一命中用户选点时通过", () => {
    const result = verify(buildSnapshot(), ['[text="跳过"]']);

    expect(result.status).toBe("pass");
    expect(result.allRulesPass).toBe(true);
    expect(result.hitPickedNode).toBe(true);
    expect(result.matchedNodeIds).toEqual([1]);
    expect(result.rules[0]).toMatchObject({
      status: "pass",
      hitCount: 1,
      hitNodeIds: [1],
      failureCodes: [],
    });
  });

  it("0 命中时报告 zero_hit", () => {
    const result = verify(buildSnapshot(), ['[text="不存在"]']);

    expect(result.status).toBe("fail");
    expect(result.rules[0]).toMatchObject({
      status: "fail",
      hitCount: 0,
      hitNodeIds: [],
    });
    expect(result.failureCodes).toContain("zero_hit");
  });

  it("多命中时附命中节点和额外节点", () => {
    const result = verify(buildSnapshot(), ['[text="关闭"]']);

    expect(result.status).toBe("fail");
    expect(result.rules[0]).toMatchObject({
      status: "fail",
      hitCount: 2,
      hitNodeIds: [2, 3],
      extraNodeIds: [2, 3],
    });
    expect(result.failureCodes).toContain("multi_hit");
    expect(result.diagnostics.join("\n")).toContain("#2 Button");
  });

  it("命中同一视觉摞的多个节点不算多命中", () => {
    const snapshot = buildStackedSnapshot();
    const result = verifyAiCandidates(
      snapshot,
      [candidate(['[text="关闭"]'])],
      snapshot.nodeById.get(1) ?? null,
    )[0];

    expect(result.status).toBe("pass");
    expect(result.rules[0].hitNodeIds).toEqual([1, 2]);
    expect(result.rules[0].failureCodes).not.toContain("multi_hit");
    expect(result.rules[0].extraNodeIds).toEqual([]);
    expect(result.rules[0].diagnostics.join("\n")).toContain("视觉摞");
  });

  it("只命中视觉摞里的文字层不算点错", () => {
    const snapshot = buildStackedSnapshot();
    const result = verifyAiCandidates(
      snapshot,
      [candidate(['[name="android.widget.TextView"][text="关闭"]'])],
      snapshot.nodeById.get(1) ?? null,
    )[0];

    expect(result.status).toBe("pass");
    expect(result.rules[0].hitNodeIds).toEqual([2]);
    expect(result.failureCodes).not.toContain("wrong_target");
  });

  it("excludeMatches 否决时报告 unsatisfied_condition，而不是多命中", () => {
    const result = verify(buildSnapshot(), ['[text="关闭"]'], {
      excludeMatches: ['[text="下一页"]'],
    });

    expect(result.status).toBe("fail");
    expect(result.failureCodes).toContain("unsatisfied_condition");
    expect(result.failureCodes).not.toContain("multi_hit");
    expect(result.rules[0].hitCount).toBe(0);
  });

  it("命中别的节点时报告 wrong_target", () => {
    const result = verify(buildSnapshot(), ['[text="下一页"]']);

    expect(result.status).toBe("fail");
    expect(result.rules[0]).toMatchObject({
      hitCount: 1,
      hitNodeIds: [4],
      hitPickedNode: false,
    });
    expect(result.failureCodes).toContain("wrong_target");
    expect(result.diagnostics.join("\n")).toContain("用户选的是 #1 TextView");
  });

  it("activity 不一致单独报告，不把 selector 误判成 0 命中", () => {
    const result = verify(buildSnapshot(), ['[text="跳过"]'], {
      activityIds: ["com.demo.OtherActivity"],
    });

    expect(result.rules[0]).toMatchObject({
      status: "fail",
      hitCount: 1,
      hitNodeIds: [1],
      hitPickedNode: true,
    });
    expect(result.failureCodes).toContain("activity_mismatch");
    expect(result.diagnostics.join("\n")).toContain("com.demo.OtherActivity");
  });

  it("无法解析的 selector 报告 invalid_selector", () => {
    const result = verify(buildSnapshot(), ["*(text 乱码垃圾字符串)"]);

    expect(result.status).toBe("fail");
    expect(result.failureCodes).toContain("invalid_selector");
    expect(result.rules[0].hitCount).toBe(0);
  });

  it("appId 不一致时明确失败", () => {
    const result = verifyAiCandidates(
      buildSnapshot(),
      [candidate(['[text="跳过"]'], {}, "com.other")],
      buildSnapshot().nodeById.get(1) ?? null,
    )[0];

    expect(result.status).toBe("fail");
    expect(result.failureCodes).toContain("app_mismatch");
  });

  it("没有用户选点时保留命中信息但状态为 unknown", () => {
    const result = verifyAiCandidates(
      buildSnapshot(),
      [candidate(['[text="跳过"]'])],
      null,
    )[0];

    expect(result.status).toBe("unknown");
    expect(result.matchedNodeIds).toEqual([1]);
    expect(result.failureCodes).toContain("picked_node_missing");
  });

  it("自动将不存在的 vid 纠正为真实存在的 id", () => {
    const raw: RawGkdSnapshot = {
      id: 10,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout" }),
        node(1, 0, {
          name: "android.widget.Button",
          id: "com.demo:id/btn_skip",
          vid: null,
          text: "跳过",
          clickable: true,
        }),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "blob:test", "test.zip");

    const repaired = repairAiCandidateSelector('[vid="btn_skip"]', snapshot);
    expect(repaired.repaired).toBe(true);
    expect(repaired.selector).toBe('[id="com.demo:id/btn_skip"]');

    const cand = candidate(['[vid="btn_skip"]']);
    const candResult = repairAiCandidate(cand, snapshot);
    expect(candResult.repaired).toBe(true);
    expect(candResult.candidate.app.groups[0].rules[0].matches[0]).toBe(
      '[id="com.demo:id/btn_skip"]',
    );
  });

  it("rerankAiCandidates 将静态验证通过的候选提升到首位", () => {
    const raw: RawGkdSnapshot = {
      id: 11,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout" }),
        node(1, 0, {
          name: "android.widget.TextView",
          text: "跳过",
          clickable: true,
          left: 100,
          top: 100,
          right: 300,
          bottom: 200,
        }),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "blob:test", "test.zip");
    const pickedNode = snapshot.nodeById.get(1) ?? null;

    // 候选 1 (原本排在第一位，但写了编造的 vid，0 命中)
    const cand1: AiRuleCandidate = {
      id: "candidate-a",
      title: "测试版 A",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [{ key: 0, name: "g", rules: [{ key: 0, matches: ['[vid="non_existent"]'] }] }],
      },
    };

    // 候选 2 (原本排在第二位，但精确命中目标)
    const cand2: AiRuleCandidate = {
      id: "candidate-b",
      title: "测试版 B",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [{ key: 0, name: "g", rules: [{ key: 0, matches: ['[text="跳过"]'] }] }],
      },
    };

    const reranked = rerankAiCandidates(snapshot, [cand1, cand2], pickedNode);
    expect(reranked.bestPassed).toBe(true);
    // 候选 2 应该被重排到首位！
    expect(reranked.rankedCandidates[0].id).toBe("candidate-b");
    expect(reranked.rankedCandidates[1].id).toBe("candidate-a");
  });

  it("buildAiStaticFailurePrompt 生成结构化诊断信息", () => {
    const raw: RawGkdSnapshot = {
      id: 12,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout" }),
        node(1, 0, {
          name: "android.widget.TextView",
          text: "跳过",
          id: "com.demo:id/real_skip",
          clickable: true,
        }),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "blob:test", "test.zip");
    const pickedNode = snapshot.nodeById.get(1) ?? null;

    const cand: AiRuleCandidate = {
      id: "candidate-a",
      title: "测试版 A",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [{ key: 0, name: "g", rules: [{ key: 0, matches: ['[vid="fake_btn"]'] }] }],
      },
    };

    const reranked = rerankAiCandidates(snapshot, [cand], pickedNode);
    const failurePrompt = buildAiStaticFailurePrompt({
      snapshot,
      candidates: reranked.rankedCandidates,
      verifications: reranked.verifications,
      pickedNode,
    });

    expect(failurePrompt).toContain("未能通过本地静态快照验证");
    expect(failurePrompt).toContain("测试版 A");
    expect(failurePrompt).toContain("0 命中");
    expect(failurePrompt).toContain("com.demo:id/real_skip");
  });

  it("未选点（pickedNode === null）时有效命中候选排在 0 命中候选前面", () => {
    const raw: RawGkdSnapshot = {
      id: 13,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout" }),
        node(1, 0, {
          name: "android.widget.TextView",
          text: "跳过",
          clickable: true,
        }),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "blob:test", "test.zip");

    // candZero: 0 命中
    const candZero: AiRuleCandidate = {
      id: "candidate-zero",
      title: "0 命中版",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [{ key: 0, name: "g", rules: [{ key: 0, matches: ['[vid="not_exist"]'] }] }],
      },
    };

    // candHit: 单节点有效命中
    const candHit: AiRuleCandidate = {
      id: "candidate-hit",
      title: "命中版",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [{ key: 0, name: "g", rules: [{ key: 0, matches: ['[text="跳过"]'] }] }],
      },
    };

    // 故意将 0 命中排在首位传入
    const reranked = rerankAiCandidates(snapshot, [candZero, candHit], null);
    expect(reranked.rankedCandidates[0].id).toBe("candidate-hit");
    expect(reranked.rankedCandidates[1].id).toBe("candidate-zero");
  });
});
