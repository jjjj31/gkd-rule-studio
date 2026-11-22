import { describe, expect, it } from "vitest";
import { normalizeSnapshot } from "./snapshotNormalize";
import {
  assessAiAutoRepairNeed,
  verifyAiCandidates,
  repairAiCandidateSelector,
  repairAiCandidate,
  rerankAiCandidates,
  runAiAutoRepairLoop,
  buildAiStaticFailurePrompt,
} from "./aiCandidateVerification";
import type { AiRuleCandidate } from "./aiModel";
import type { AppRuleDraft, RuleDraft } from "../types/ruleDraft";
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
    // picked_node_missing 下禁止 bestPassed 为 true
    expect(reranked.bestPassed).toBe(false);
  });

  it("P0-1 & P1-8: 自动纠偏不兼容的 fastQuery: true 并为多段/WebView 补充 matchRoot: true", () => {
    const raw: RawGkdSnapshot = {
      id: 20,
      appId: "com.demo",
      activityId: "com.demo.AdActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout", childCount: 2 }),
        node(1, 0, {
          name: "android.webkit.WebView",
          childCount: 1,
          depth: 1,
        }),
        node(2, 1, {
          name: "android.widget.TextView",
          text: "跳过广告",
          vid: "wv_skip",
          clickable: true,
          left: 880,
          top: 80,
          right: 1040,
          bottom: 140,
          width: 160,
          height: 60,
          depth: 2,
        }),
        node(3, 0, {
          name: "android.widget.ImageView",
          desc: "关闭弹窗",
          clickable: true,
          left: 900,
          top: 200,
          right: 980,
          bottom: 280,
          width: 80,
          height: 80,
          depth: 1,
          index: 1,
        }),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "blob:wv", "wv.zip");

    // 1. desc 选择器不满足 fastQuery -> 自动设为 false（单 rule group 级同步处理）
    const descCand: AiRuleCandidate = {
      id: "desc-fq",
      title: "测试版 A",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [
          {
            key: 0,
            name: "g",
            fastQuery: true,
            rules: [{ key: 0, matches: ['[desc="关闭弹窗"]'] }],
          },
        ],
      },
    };
    const repairedDesc = repairAiCandidate(descCand, snapshot);
    expect(repairedDesc.repaired).toBe(true);
    expect(repairedDesc.candidate.app.groups[0].fastQuery).toBe(false);
    expect(repairedDesc.candidate.app.groups[0].rules[0].fastQuery).toBe(false);

    // 2. WebView 下的 vid 选择器：fastQuery: true 纠正为 false，并自动补 matchRoot: true
    const wvCand: AiRuleCandidate = {
      id: "wv-fq",
      title: "测试版 B",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [
          {
            key: 0,
            name: "g",
            rules: [{ key: 0, fastQuery: true, matches: ['[vid="wv_skip"]'] }],
          },
        ],
      },
    };
    const repairedWv = repairAiCandidate(wvCand, snapshot);
    expect(repairedWv.repaired).toBe(true);
    expect(repairedWv.candidate.app.groups[0].rules[0].fastQuery).toBe(false);
    expect(repairedWv.candidate.app.groups[0].rules[0].matchRoot).toBe(true);

    // 3. 多段 matches 自动补 matchRoot: true；若显式设了 matchRoot: false 则保留原值
    const multiCand = candidate(['[text="跳过广告"]', '[desc="关闭弹窗"]']);
    const repairedMulti = repairAiCandidate(multiCand, snapshot);
    expect(repairedMulti.repaired).toBe(true);
    expect(repairedMulti.candidate.app.groups[0].rules[0].matchRoot).toBe(true);

    const explicitFalseMulti = candidate(['[text="跳过广告"]', '[desc="关闭弹窗"]'], {
      matchRoot: false,
    });
    const repairedExplicit = repairAiCandidate(explicitFalseMulti, snapshot);
    expect(repairedExplicit.candidate.app.groups[0].rules[0].matchRoot).toBe(false);
  });

  it("P1-5: repairAiCandidateSelector 支持复合括号并按视觉摞优先级匹配 id", () => {
    const raw: RawGkdSnapshot = {
      id: 21,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout", childCount: 2 }),
        node(1, 0, {
          name: "android.widget.Button",
          id: "android:id/skip",
          clickable: true,
          left: 10,
          top: 10,
          right: 90,
          bottom: 70,
          width: 80,
          height: 60,
        }),
        node(2, 0, {
          name: "android.widget.Button",
          id: "com.demo:id/skip",
          clickable: true,
          left: 880,
          top: 80,
          right: 1000,
          bottom: 140,
          width: 120,
          height: 60,
          index: 1,
        }),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "blob:comp", "comp.zip");
    const picked = snapshot.nodeById.get(2)!;

    const res = repairAiCandidateSelector(
      '[clickable=true && vid="skip" && visibleToUser=true]',
      snapshot,
      picked,
    );
    expect(res.repaired).toBe(true);
    expect(res.selector).toBe(
      '[clickable=true && id="com.demo:id/skip" && visibleToUser=true]',
    );
  });

  it("P0-3, P0-4, P1-3, P1-7: enable=false 判 fail，精确 activityMatches，纯 anyMatches 与 failureReason 精确归类", () => {
    const snap = buildSnapshot();
    const picked = snap.nodeById.get(1)!;

    // P0-3: group.enable === false / rule.enable === false 直接判 fail
    const disabledRule = verifyAiCandidates(
      snap,
      [candidate(['[text="跳过"]'], { enable: false })],
      picked,
    )[0];
    expect(disabledRule.status).toBe("fail");
    expect(disabledRule.diagnostics.join("\n")).toContain("enable=false");

    const disabledGroupCand = candidate(['[text="跳过"]']);
    disabledGroupCand.app.groups[0].enable = false;
    const disabledGroup = verifyAiCandidates(snap, [disabledGroupCand], picked)[0];
    expect(disabledGroup.status).toBe("fail");
    expect(disabledGroup.diagnostics.join("\n")).toContain("enable=false");

    // P0-4: activityMatches 精确匹配，拒绝前缀和空串
    const prefixMismatch = verify(snap, ['[text="跳过"]'], {
      activityIds: "com.demo.Main",
    });
    expect(prefixMismatch.status).toBe("fail");
    expect(prefixMismatch.failureCodes).toContain("activity_mismatch");

    const emptyActivity = verify(snap, ['[text="跳过"]'], {
      activityIds: "",
    });
    expect(emptyActivity.status).toBe("fail");
    expect(emptyActivity.failureCodes).toContain("activity_mismatch");

    const dotShortMatch = verify(snap, ['[text="跳过"]'], {
      activityIds: ".MainActivity",
    });
    expect(dotShortMatch.status).toBe("pass");

    // P1-3: anyMatches-only 规则正常验靶通过
    const anyOnlyCand: AiRuleCandidate = {
      id: "any-only",
      title: "纯 anyMatches",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [
          {
            key: 0,
            name: "g",
            rules: [
              {
                key: 0,
                anyMatches: ['[text="不存在"]', '[text="跳过"]'],
              } as unknown as RuleDraft,
            ],
          },
        ],
      },
    };
    const anyOnlyResult = verifyAiCandidates(snap, [anyOnlyCand], picked)[0];
    expect(anyOnlyResult.status).toBe("pass");
    expect(anyOnlyResult.hitPickedNode).toBe(true);

    // P1-7: anyMatches 命中但 matches 末项未命中时归类为 zero_hit，而非 unsatisfied_condition
    const bothResult = verify(snap, ['[text="不存在目标"]'], {
      anyMatches: ['[text="下一页"]'],
    });
    expect(bothResult.status).toBe("fail");
    expect(bothResult.failureCodes).toContain("zero_hit");
    expect(bothResult.failureCodes).not.toContain("unsatisfied_condition");
  });

  it("P0-5: 多 rule 候选若含任一错靶/无效/多命中规则，整候选不得为 pass", () => {
    const snap = buildSnapshot();
    const picked = snap.nodeById.get(1)!;
    const mixedCand: AiRuleCandidate = {
      id: "mixed",
      title: "混合候选",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [
          {
            key: 0,
            name: "g",
            rules: [
              { key: 0, matches: ['[text="跳过"]'] },
              { key: 1, matches: ['[text="下一页"]'] }, // wrong_target
            ],
          },
        ],
      },
    };
    const result = verifyAiCandidates(snap, [mixedCand], picked)[0];
    expect(result.status).toBe("fail");
    expect(result.failureCodes).toContain("wrong_target");
    expect(result.diagnostics.join("\n")).toContain("高危失败");
  });

  it("P0-5 & P1-3: executionReadinessAdjustment 与 assessAiAutoRepairNeed 覆盖复合括号坐标/倒计时/CTA/热区/继承延迟与 action 豁免", () => {
    const raw: RawGkdSnapshot = {
      id: 22,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout", childCount: 4 }),
        node(1, 0, {
          name: "android.widget.TextView",
          text: "跳过 3s",
          clickable: false,
          left: 880,
          top: 80,
          right: 1040,
          bottom: 140,
          width: 160,
          height: 60,
        }),
        node(2, 0, {
          name: "android.widget.TextView",
          text: "广告",
          left: 100,
          top: 80,
          right: 200,
          bottom: 140,
          width: 100,
          height: 60,
          index: 1,
        }),
        node(3, 0, {
          name: "android.widget.Button",
          text: "立即下载",
          clickable: true,
          left: 100,
          top: 600,
          right: 980,
          bottom: 720,
          width: 880,
          height: 120,
          index: 2,
        }),
        node(4, 0, {
          name: "android.widget.FrameLayout",
          vid: "ad_hot_area",
          clickable: true,
          left: 0,
          top: 0,
          right: 1080,
          bottom: 1200,
          width: 1080,
          height: 1200,
          index: 3,
        }),
      ],
    };
    const snap = normalizeSnapshot(raw, "blob:risk", "risk.zip");
    const picked = snap.nodeById.get(1)!;

    // 复合括号坐标 + 倒计时（第二位置）+ group 级 delay
    const riskyCand: AiRuleCandidate = {
      id: "risky",
      title: "风险版",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [
          {
            key: 0,
            name: "g",
            actionDelay: 1500,
            rules: [
              {
                key: 0,
                action: "clickCenter",
                matches: ['[text="广告"] - [top<300 && text="跳过 3s"]'],
              },
            ],
          } as AppRuleDraft["groups"][number],
        ],
      },
    };
    const reranked = rerankAiCandidates(snap, [riskyCand], picked);
    const assessment = assessAiAutoRepairNeed(snap, reranked, picked);
    expect(assessment.needsRepair).toBe(true);
    expect(assessment.reasons.some((r) => r.includes("像素坐标"))).toBe(true);
    expect(assessment.reasons.some((r) => r.includes("倒计时"))).toBe(true);

    // action: "back" 豁免 clickable=false 检查
    const backCand = candidate(['[text="广告"]', '[text^="跳过"]'], {
      action: "back",
    });
    const backReranked = rerankAiCandidates(snap, [backCand], picked);
    const backAssess = assessAiAutoRepairNeed(snap, backReranked, picked);
    expect(backAssess.reasons.some((r) => r.includes("clickable=false"))).toBe(false);

    // 命中正向危险 CTA（立即下载）触发自动返修
    const ctaPicked = snap.nodeById.get(3)!;
    const ctaCand = candidate(['[text="立即下载"]']);
    const ctaAssess = assessAiAutoRepairNeed(
      snap,
      rerankAiCandidates(snap, [ctaCand], ctaPicked),
      ctaPicked,
    );
    expect(ctaAssess.needsRepair).toBe(true);
    expect(ctaAssess.reasons.some((r) => r.includes("正向危险 CTA"))).toBe(true);

    // 命中 >35% 面积热区触发自动返修
    const hotPicked = snap.nodeById.get(4)!;
    const hotCand = candidate(['[vid="ad_hot_area"]']);
    const hotAssess = assessAiAutoRepairNeed(
      snap,
      rerankAiCandidates(snap, [hotCand], hotPicked),
      hotPicked,
    );
    expect(hotAssess.needsRepair).toBe(true);
    expect(hotAssess.reasons.some((r) => r.includes(">35%"))).toBe(true);
  });

  it("P1-2: runAiAutoRepairLoop 支持 2 轮返修、早停、语义去重、防 ID 冲突且修复 autoRepairSucceeded 假阳性", async () => {
    const raw: RawGkdSnapshot = {
      id: 23,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout", childCount: 2 }),
        node(1, 0, {
          name: "android.widget.TextView",
          text: "会员限时特惠弹窗",
          left: 100,
          top: 500,
          right: 800,
          bottom: 580,
          width: 700,
          height: 80,
        }),
        node(2, 0, {
          name: "android.widget.Button",
          text: "关闭",
          clickable: true,
          left: 880,
          top: 500,
          right: 1000,
          bottom: 580,
          width: 120,
          height: 80,
          index: 1,
        }),
      ],
    };
    const snap = normalizeSnapshot(raw, "blob:loop", "loop.zip");
    const picked = snap.nodeById.get(2)!;

    // 1. 假阳性修复：返修返回同样 0 命中的候选 -> autoRepairSucceeded 必须为 false
    const zeroHitInitial = candidate(['[vid="missing_1"]']);
    let falsePositiveCalls = 0;
    const noImprove = await runAiAutoRepairLoop({
      snapshot: snap,
      pickedNode: picked,
      initialCandidates: [zeroHitInitial],
      maxRepairRounds: 2,
      requestRepairCandidates: async () => {
        falsePositiveCalls += 1;
        return [candidate(['[vid="missing_2"]'])];
      },
    });
    expect(falsePositiveCalls).toBe(2);
    expect(noImprove.autoRepairTriggered).toBe(true);
    expect(noImprove.autoRepairSucceeded).toBe(false);
    // ID 全局唯一，无冲突
    expect(new Set(noImprove.rankedCandidates.map((c) => c.id)).size).toBe(
      noImprove.rankedCandidates.length,
    );

    // 2. 第 1 轮返修仍带坐标（不通过体检），第 2 轮返回稳定锚点版 -> 自动跑满 2 轮并成功
    let multiRoundCalls = 0;
    const twoRound = await runAiAutoRepairLoop({
      snapshot: snap,
      pickedNode: picked,
      initialCandidates: [candidate(['[vid="missing_1"]'])],
      maxRepairRounds: 2,
      requestRepairCandidates: async (prompt) => {
        multiRoundCalls += 1;
        // 内置返修 prompt 要求单一 JSON5 对象，无测试反馈格式
        expect(prompt).toContain("只返回一个单一 JSON5 对象");
        if (multiRoundCalls === 1) {
          return [candidate(['[left=880][text="关闭"]'])];
        }
        return [candidate(['[text="会员限时特惠弹窗"]', '[text="关闭"]'])];
      },
    });
    expect(multiRoundCalls).toBe(2);
    expect(twoRound.autoRepairTriggered).toBe(true);
    expect(twoRound.autoRepairSucceeded).toBe(true);
    expect(twoRound.rankedCandidates[0].app.groups[0].rules[0].matches).toEqual([
      '[text="会员限时特惠弹窗"]',
      '[text="关闭"]',
    ]);
  });

  it("fastQuery 纠偏覆盖 excludeMatches/excludeAllMatches、WebView supportNodes 与多 rule 降级", () => {
    const raw: RawGkdSnapshot = {
      id: 24,
      appId: "com.demo",
      activityId: "com.demo.AdActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout", childCount: 2 }),
        node(1, 0, {
          name: "android.webkit.WebView",
          childCount: 1,
          depth: 1,
        }),
        node(2, 1, {
          name: "android.widget.TextView",
          text: "网页广告标题",
          depth: 2,
        }),
        node(3, 0, {
          name: "android.widget.TextView",
          text: "跳过",
          vid: "native_skip",
          clickable: true,
          left: 900,
          top: 80,
          right: 1040,
          bottom: 140,
          width: 140,
          height: 60,
          depth: 1,
          index: 1,
        }),
      ],
    };
    const snap = normalizeSnapshot(raw, "blob:fq2", "fq2.zip");
    const picked = snap.nodeById.get(3)!;

    // 1. excludeMatches 含不兼容 fastQuery 的 desc 选择器 -> 自动关闭 fastQuery
    const exclCand = candidate(['[vid="native_skip"]'], {
      fastQuery: true,
      excludeMatches: ['[desc="勿关闭"]'],
    });
    const exclRepaired = repairAiCandidate(exclCand, snap, picked);
    expect(exclRepaired.repaired).toBe(true);
    expect(exclRepaired.candidate.app.groups[0].rules[0].fastQuery).toBe(false);

    // 2. excludeAllMatches 含不兼容 fastQuery 的选择器 -> 同样关闭 fastQuery
    const exclAllCand = candidate(['[vid="native_skip"]'], {
      fastQuery: true,
      excludeAllMatches: ['ImageView[width<100]'],
    });
    const exclAllRepaired = repairAiCandidate(exclAllCand, snap, picked);
    expect(exclAllRepaired.repaired).toBe(true);
    expect(exclAllRepaired.candidate.app.groups[0].rules[0].fastQuery).toBe(false);

    // 3. 前置锚点（supportNodes）位于 WebView 内、点击节点在外部 -> 同样关闭 fastQuery 并补 matchRoot: true
    const wvSupportCand = candidate(['[text="网页广告标题"]', '[vid="native_skip"]'], {
      fastQuery: true,
    });
    const wvSupportRepaired = repairAiCandidate(wvSupportCand, snap, picked);
    expect(wvSupportRepaired.repaired).toBe(true);
    expect(wvSupportRepaired.candidate.app.groups[0].rules[0].fastQuery).toBe(false);
    expect(wvSupportRepaired.candidate.app.groups[0].rules[0].matchRoot).toBe(true);

    // 4. 多 rule 场景：所有 rule 均降级为 fastQuery: false 时，同步将 group.fastQuery 降级为 false
    const multiRuleGroupCand: AiRuleCandidate = {
      id: "multi-rule-fq",
      title: "多规则组",
      summary: "",
      risk: "",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [
          {
            key: 0,
            name: "g",
            fastQuery: true,
            rules: [
              { key: 0, matches: ['[vid="native_skip"]'], excludeMatches: ['[desc="排除1"]'] },
              { key: 1, matches: ['[text="网页广告标题"]', '[vid="native_skip"]'] },
            ],
          },
        ],
      },
    };
    const multiRepaired = repairAiCandidate(multiRuleGroupCand, snap, picked);
    expect(multiRepaired.repaired).toBe(true);
    expect(multiRepaired.candidate.app.groups[0].fastQuery).toBe(false);
    expect(multiRepaired.candidate.app.groups[0].rules.every((r) => r.fastQuery === false)).toBe(true);

    // 5. 未经 repairAiCandidate 直接调用 assessAiAutoRepairNeed 时，hasIncompatibleFastQuery 同样能检出 excludeMatches
    const unRepairedVerif = verifyAiCandidates(snap, [exclCand], picked);
    const manualAssess = assessAiAutoRepairNeed(
      snap,
      {
        rankedCandidates: [exclCand],
        verifications: unRepairedVerif,
        bestPassed: true,
        repairedCount: 0,
      },
      picked,
    );
    expect(manualAssess.needsRepair).toBe(true);
    expect(manualAssess.reasons.some((r) => r.includes("fastQuery"))).toBe(true);
  });

  it("allowActionDelay 选项允许合法延迟且 zero_hit -> wrong_target 不得误报 autoRepairSucceeded", async () => {
    const raw: RawGkdSnapshot = {
      id: 25,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, { name: "android.widget.FrameLayout", childCount: 2 }),
        node(1, 0, {
          name: "android.widget.TextView",
          text: "会员限时特惠弹窗",
          left: 100,
          top: 500,
          right: 800,
          bottom: 580,
          width: 700,
          height: 80,
        }),
        node(2, 0, {
          name: "android.widget.Button",
          vid: "btn_close",
          text: "关闭",
          clickable: true,
          left: 880,
          top: 500,
          right: 1000,
          bottom: 580,
          width: 120,
          height: 80,
          index: 1,
        }),
        node(3, 0, {
          name: "android.widget.Button",
          vid: "btn_other",
          text: "其他按钮",
          clickable: true,
          left: 100,
          top: 900,
          right: 300,
          bottom: 980,
          width: 200,
          height: 80,
          index: 2,
        }),
      ],
    };
    const snap = normalizeSnapshot(raw, "blob:delay", "delay.zip");
    const picked = snap.nodeById.get(2)!;

    const delayedCand = candidate(['[text="会员限时特惠弹窗"]', '[vid="btn_close"]'], {
      actionDelay: 2500,
    });

    // 默认（allowActionDelay=false）：actionDelay >= 2000 扣分并触发自动返修
    const defaultReranked = rerankAiCandidates(snap, [delayedCand], picked);
    const defaultAssess = assessAiAutoRepairNeed(snap, defaultReranked, picked);
    expect(defaultAssess.needsRepair).toBe(true);
    expect(defaultAssess.reasons.some((r) => r.includes("actionDelay"))).toBe(true);
    const defaultPrompt = buildAiStaticFailurePrompt({
      snapshot: snap,
      candidates: defaultReranked.rankedCandidates,
      verifications: defaultReranked.verifications,
      pickedNode: picked,
    });
    expect(defaultPrompt).toContain("延迟纠偏");

    // allowActionDelay=true：跳过扣分、不触发返修、诊断不报延迟纠偏
    const allowedReranked = rerankAiCandidates(snap, [delayedCand], picked, {
      allowActionDelay: true,
    });
    expect(allowedReranked.bestPassed).toBe(true);
    const allowedAssess = assessAiAutoRepairNeed(snap, allowedReranked, picked, {
      allowActionDelay: true,
    });
    expect(allowedAssess.needsRepair).toBe(false);
    const allowedPrompt = buildAiStaticFailurePrompt({
      snapshot: snap,
      candidates: allowedReranked.rankedCandidates,
      verifications: allowedReranked.verifications,
      pickedNode: picked,
      options: { allowActionDelay: true },
    });
    expect(allowedPrompt).not.toContain("延迟纠偏");

    let loopCalled = false;
    const allowedLoop = await runAiAutoRepairLoop({
      snapshot: snap,
      pickedNode: picked,
      initialCandidates: [delayedCand],
      options: { allowActionDelay: true },
      requestRepairCandidates: async () => {
        loopCalled = true;
        return [];
      },
    });
    expect(loopCalled).toBe(false);
    expect(allowedLoop.autoRepairTriggered).toBe(false);

    // zero_hit (10分) -> wrong_target (30分)：分数提高但仍失败，autoRepairSucceeded 必须为 false
    const wrongTargetLoop = await runAiAutoRepairLoop({
      snapshot: snap,
      pickedNode: picked,
      initialCandidates: [candidate(['[vid="not_found"]'])],
      maxRepairRounds: 1,
      requestRepairCandidates: async () => [candidate(['[vid="btn_other"]'])],
    });
    expect(wrongTargetLoop.autoRepairTriggered).toBe(true);
    expect(wrongTargetLoop.bestPassed).toBe(false);
    expect(wrongTargetLoop.autoRepairSucceeded).toBe(false);
  });
});
