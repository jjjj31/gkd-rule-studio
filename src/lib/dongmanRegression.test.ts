import { describe, expect, it } from "vitest";
import { detectAdSdkForNode, matchAdSdkSkipSignal } from "../data/adSdkSignatures";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";
import type { RuleSettings } from "../types/ruleDraft";
import {
  assessAiAutoRepairNeed,
  buildAiStaticFailurePrompt,
  repairAiCandidate,
  rerankAiCandidates,
  runAiAutoRepairLoop,
  verifyAiCandidates,
} from "./aiCandidateVerification";
import { buildAiGenerateMessages, compactPromptForAi, type AiRuleCandidate } from "./aiModel";
import {
  isDynamicActivityId,
  isDynamicCountdownText,
  isSkipLikeText,
} from "./countdownText";
import { buildHelpPrompt } from "./helpPrompt";
import { pickNodeAtPoint } from "./nodePicker";
import { generateRegionSelectorCandidates } from "./regionCandidates";
import { generateSelectorCandidates } from "./selectorStrategies";
import { normalizeSnapshot } from "./snapshotNormalize";

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
    right: 1264,
    bottom: 2780,
    width: 1264,
    height: 2780,
    childCount: 0,
    index: 0,
    depth: 0,
    ...overrides,
  };
}

function node(id: number, pid: number, a: Partial<SnapshotNodeAttr>): SnapshotNode {
  return {
    id,
    pid,
    idQf: Boolean(a.id),
    textQf: Boolean(a.text),
    attr: attr(a),
  };
}

function makeSnapshot(
  nodes: SnapshotNode[],
  activityId = "app.video.guoguo.MainActivity",
) {
  const raw: RawGkdSnapshot = {
    id: 99,
    appId: "com.shizi.tool.p3",
    activityId,
    screenWidth: 1264,
    screenHeight: 2780,
    isLandscape: false,
    appInfo: { id: "com.shizi.tool.p3", name: "动漫共和国" },
    nodes,
  };
  return normalizeSnapshot(raw, "blob:test", "test.zip");
}

describe("dongman-ad regressions", () => {
  it("recognizes delimited countdowns and dynamic activity suffixes", () => {
    expect(isDynamicCountdownText("跳过｜4")).toBe(true);
    expect(isDynamicCountdownText("跳过 | 3s")).toBe(true);
    expect(isDynamicCountdownText("5秒后跳过")).toBe(true);
    expect(isSkipLikeText("跳过｜4")).toBe(true);
    expect(isDynamicActivityId("com.windmill.sdk.widget.InterstitialView_4012003")).toBe(true);
    expect(isDynamicActivityId("app.video.guoguo.MainActivity")).toBe(false);

    const snap = makeSnapshot([
      node(0, -1, { name: "android.widget.FrameLayout", childCount: 1 }),
      node(1, 0, {
        name: "android.widget.TextView",
        text: "5秒后跳过",
        clickable: true,
        left: 900,
        top: 100,
        right: 1120,
        bottom: 180,
        width: 220,
        height: 80,
      }),
    ]);
    const pick = pickNodeAtPoint(snap, { x: 1000, y: 140 })!;
    const candidates = generateSelectorCandidates({
      snapshot: snap,
      ruleSettings: { ...DEFAULT_RULE_SETTINGS, groupName: "开屏广告", activityIds: "" },
      pickedNode: pick.pickedNode,
      ancestors: pick.ancestors,
      siblings: pick.siblings,
      clickableAncestor: pick.clickableAncestor,
      nearbyTextNodes: pick.nearbyTextNodes,
    });
    const skipGuarded = candidates.find((c) => c.strategyName === "textSkipGuarded");
    expect(skipGuarded?.rule.matches[0]).toContain('text$="跳过"');
    expect(skipGuarded?.validation.hitCount).toBe(1);
  });

  it("identifies ToBid and Meishu SDKs without crediting shades", () => {
    expect(
      detectAdSdkForNode({
        attr: { id: null, vid: "tobid_splash_skip_ll", name: "LinearLayout" },
      })?.id,
    ).toBe("tobid");
    expect(
      matchAdSdkSkipSignal({
        attr: {
          id: null,
          vid: "tobid_interstitial_skip_ll",
          name: "LinearLayout",
          text: null,
          desc: null,
        },
      })?.sdk.id,
    ).toBe("tobid");
    expect(
      matchAdSdkSkipSignal({
        attr: {
          id: null,
          vid: "tobid_interstitial_skip_shade",
          name: "View",
          text: null,
          desc: null,
        },
      }),
    ).toBeNull();
    expect(
      matchAdSdkSkipSignal({
        attr: {
          id: null,
          vid: "ms_skipView",
          name: "android.view.View",
          text: null,
          desc: null,
        },
      })?.sdk.id,
    ).toBe("meishu");
  });

  it("assigns clickCenter for non-clickable Meishu ms_skipView", () => {
    const snap = makeSnapshot([
      node(0, -1, { name: "android.widget.FrameLayout", childCount: 1 }),
      node(1, 0, { name: "android.widget.RelativeLayout", childCount: 2 }),
      node(2, 1, {
        id: "com.shizi.tool.p3:id/ms_splash_image",
        vid: "ms_splash_image",
        name: "android.widget.ImageView",
      }),
      node(3, 1, {
        id: "com.shizi.tool.p3:id/ms_skipView",
        vid: "ms_skipView",
        name: "android.view.View",
        clickable: false,
        left: 1093,
        top: 59,
        right: 1219,
        bottom: 185,
        width: 126,
        height: 126,
        index: 1,
      }),
    ]);
    const pick = pickNodeAtPoint(snap, { x: 1150, y: 120 })!;
    const settings: RuleSettings = { ...DEFAULT_RULE_SETTINGS, groupName: "开屏广告", activityIds: "" };
    const candidates = generateRegionSelectorCandidates({
      snapshot: snap,
      ruleSettings: settings,
      pickResult: pick,
    });
    expect(candidates[0].rule.matches[0]).toContain("ms_skipView");
    expect(candidates[0].rule.action).toBe("clickCenter");
  });

  it("lifts ToBid skip_text click target to clickable skip_ll parent", () => {
    const snap = makeSnapshot(
      [
        node(0, -1, { name: "android.widget.FrameLayout", childCount: 1 }),
        node(1, 0, {
          id: "com.shizi.tool.p3:id/tobid_interstitial_skip_shade",
          vid: "tobid_interstitial_skip_shade",
          clickable: true,
          left: 852,
          top: 589,
          right: 1049,
          bottom: 672,
          width: 197,
          height: 83,
        }),
        node(2, 0, {
          id: "com.shizi.tool.p3:id/tobid_interstitial_skip_ll",
          vid: "tobid_interstitial_skip_ll",
          name: "android.widget.LinearLayout",
          clickable: true,
          left: 852,
          top: 589,
          right: 1049,
          bottom: 672,
          width: 197,
          height: 83,
          childCount: 1,
          index: 1,
        }),
        node(3, 2, {
          id: "com.shizi.tool.p3:id/tobid_interstitial_skip_text",
          vid: "tobid_interstitial_skip_text",
          name: "android.widget.TextView",
          text: "跳过｜4",
          clickable: false,
          left: 887,
          top: 607,
          right: 1014,
          bottom: 654,
          width: 127,
          height: 47,
        }),
      ],
      "com.windmill.sdk.widget.InterstitialView_4012003",
    );
    const pick = pickNodeAtPoint(snap, { x: 950, y: 630 })!;
    expect(pick.pickedNode.id).toBe(3);
    const candidates = generateRegionSelectorCandidates({
      snapshot: snap,
      ruleSettings: { ...DEFAULT_RULE_SETTINGS, groupName: "弹窗广告", activityIds: "" },
      pickResult: pick,
    });
    expect(candidates[0].rule.matches[0]).toContain("tobid_interstitial_skip_ll");
    expect(candidates[0].validation.clickNodes[0].id).toBe(2);

    // AI verification also accepts clicking skip_ll when user picked skip_text
    const aiCand: AiRuleCandidate = {
      id: "cand-ll",
      title: "测试版 A",
      summary: "点容器",
      risk: "低",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [
          {
            key: 0,
            name: "弹窗广告",
            rules: [{ key: 0, matches: ['[vid="tobid_interstitial_skip_ll"][visibleToUser=true]'] }],
          },
        ],
      },
    };
    const verif = verifyAiCandidates(snap, [aiCand], pick.pickedNode)[0];
    expect(verif.status).toBe("pass");
    expect(verif.hitPickedNode).toBe(true);
  });

  it("generates context-anchored rule for Flutter desc dialog and penalizes fullscreen barrier", () => {
    const snap = makeSnapshot([
      node(0, -1, { name: "android.widget.FrameLayout", childCount: 1 }),
      node(1, 0, {
        name: "android.view.View",
        desc: "关闭",
        clickable: true,
        childCount: 1,
      }),
      node(2, 1, {
        name: "android.view.View",
        desc: "请尽快更新到最新版本",
        clickable: true,
        left: 84,
        top: 651,
        right: 1180,
        bottom: 2269,
        width: 1096,
        height: 1618,
        childCount: 2,
      }),
      node(3, 2, {
        name: "android.widget.Button",
        desc: "关闭",
        clickable: true,
        left: 641,
        top: 2101,
        right: 865,
        bottom: 2269,
        width: 224,
        height: 168,
      }),
      node(4, 2, {
        name: "android.widget.Button",
        desc: "不再显示",
        clickable: true,
        left: 881,
        top: 2101,
        right: 1163,
        bottom: 2269,
        width: 282,
        height: 168,
        index: 1,
      }),
    ]);
    const pick = pickNodeAtPoint(snap, { x: 750, y: 2180 })!;
    const candidates = generateRegionSelectorCandidates({
      snapshot: snap,
      ruleSettings: { ...DEFAULT_RULE_SETTINGS, groupName: "弹窗广告", activityIds: "app.video.guoguo.MainActivity" },
      pickResult: pick,
    });
    const contextCand = candidates.find((c) => c.strategyName === "exactTextWithContext");
    expect(contextCand?.rule.matches).toEqual([
      '[desc="请尽快更新到最新版本"]',
      'Button[desc="关闭"]',
    ]);
    expect(contextCand?.risk.finalScore).toBeGreaterThanOrEqual(90);
    const bareDesc = candidates.find((c) => c.rule.matches[0] === '[desc="关闭"]');
    expect(bareDesc?.risk.finalScore).toBeLessThan(30);
  });

  it("anchors anonymous popup close icon to popup text and penalizes bare structural rule", () => {
    const snap = makeSnapshot([
      node(0, -1, { name: "android.widget.FrameLayout", childCount: 1 }),
      node(1, 0, {
        name: "android.widget.FrameLayout",
        left: 42,
        top: 411,
        right: 1222,
        bottom: 2508,
        width: 1180,
        height: 2097,
        childCount: 2,
      }),
      node(2, 1, {
        name: "android.widget.ImageView",
        clickable: false,
        left: 1128,
        top: 438,
        right: 1195,
        bottom: 505,
        width: 67,
        height: 67,
      }),
      node(3, 1, {
        name: "android.widget.TextView",
        text: "跳转微信",
        left: 548,
        top: 2267,
        right: 716,
        bottom: 2316,
        width: 168,
        height: 49,
        index: 1,
      }),
    ]);
    const pick = pickNodeAtPoint(snap, { x: 1160, y: 470 })!;
    const candidates = generateRegionSelectorCandidates({
      snapshot: snap,
      ruleSettings: { ...DEFAULT_RULE_SETTINGS, groupName: "弹窗广告", activityIds: "app.video.guoguo.MainActivity" },
      pickResult: pick,
    });
    expect(candidates[0].rule.matches[0]).toContain("跳转微信");
    expect(candidates[0].rule.action).toBe("clickCenter");
    const bareStructural = candidates.find((c) => c.strategyName === "structuralTargetFallback");
    expect(bareStructural?.risk.finalScore).toBeLessThan(70);
  });

  it("keeps picked node subtree and self-check inside compactPromptForAi", () => {
    const nodes: SnapshotNode[] = [
      node(0, -1, { name: "android.widget.FrameLayout", childCount: 40 }),
    ];
    for (let i = 1; i <= 42; i++) {
      nodes.push(
        node(i, 0, {
          name: i === 42 ? "android.widget.TextView" : "android.widget.FrameLayout",
          vid: i === 42 ? "tobid_interstitial_skip_text" : undefined,
          text: i === 42 ? "跳过｜4" : undefined,
          left: i === 42 ? 887 : 0,
          top: i === 42 ? 607 : 0,
          right: i === 42 ? 1014 : 1264,
          bottom: i === 42 ? 654 : 2780,
          width: i === 42 ? 127 : 1264,
          height: i === 42 ? 47 : 2780,
          index: i - 1,
          depth: 1,
        }),
      );
    }
    const snap = makeSnapshot(nodes, "com.windmill.sdk.widget.InterstitialView_4012003");
    const pick = pickNodeAtPoint(snap, { x: 950, y: 630 })!;
    const prompt = buildHelpPrompt({
      snapshot: snap,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });
    const compacted = compactPromptForAi(prompt);
    expect(compacted).toContain("#42 TextView");
    expect(compacted).toContain("输出前自检");
    expect(compacted.length).toBeLessThanOrEqual(9000);

    const msgs = buildAiGenerateMessages({ mode: "single", prompt });
    expect(typeof msgs[1].content === "string" && msgs[1].content.includes("#42 TextView")).toBe(true);
  });

  it("penalizes non-clickable AI rules without clickCenter and repairs excludeMatches", () => {
    const snap = makeSnapshot([
      node(0, -1, { name: "android.widget.FrameLayout", childCount: 1 }),
      node(1, 0, {
        id: "com.shizi.tool.p3:id/ms_skipView",
        vid: null,
        name: "android.view.View",
        clickable: false,
        left: 1093,
        top: 59,
        right: 1219,
        bottom: 185,
        width: 126,
        height: 126,
      }),
      node(2, 0, {
        id: "com.shizi.tool.p3:id/ms_other",
        vid: null,
        name: "android.view.View",
        clickable: false,
        visibleToUser: false,
        index: 1,
      }),
    ]);
    const pickedNode = snap.nodeById.get(1)!;
    const noClickCenter: AiRuleCandidate = {
      id: "no-cc",
      title: "测试版 A",
      summary: "",
      risk: "",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [
          {
            key: 0,
            name: "开屏",
            rules: [{ key: 0, matches: ['[id="com.shizi.tool.p3:id/ms_skipView"]'] }],
          },
        ],
      },
    };
    const withClickCenter: AiRuleCandidate = {
      id: "with-cc",
      title: "测试版 B",
      summary: "",
      risk: "",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [
          {
            key: 0,
            name: "开屏",
            rules: [
              {
                key: 0,
                action: "clickCenter",
                matches: ['[id="com.shizi.tool.p3:id/ms_skipView"]'],
                excludeMatches: ['[vid="ms_other"][visibleToUser=true]'],
              },
            ],
          },
        ],
      },
    };
    const reranked = rerankAiCandidates(snap, [noClickCenter, withClickCenter], pickedNode);
    expect(reranked.rankedCandidates[0].id).toBe("with-cc");

    const repaired = repairAiCandidate(withClickCenter, snap);
    expect(repaired.repaired).toBe(true);
    expect(repaired.candidate.app.groups[0].rules[0].excludeMatches?.[0]).toBe(
      '[id="com.shizi.tool.p3:id/ms_other"][visibleToUser=true]',
    );
  });

  it("prefers contextual anchors over bare dismiss/coord rules and triggers auto-repair loop", async () => {
    const snap = makeSnapshot([
      node(0, -1, { name: "android.widget.FrameLayout", childCount: 1 }),
      node(1, 0, {
        id: "android:id/content",
        name: "android.widget.FrameLayout",
        childCount: 2,
      }),
      node(2, 1, {
        name: "android.widget.ImageView",
        clickable: false,
        left: 1128,
        top: 438,
        right: 1195,
        bottom: 505,
        width: 67,
        height: 67,
      }),
      node(3, 1, {
        name: "android.widget.TextView",
        text: "跳转微信",
        left: 548,
        top: 2267,
        right: 716,
        bottom: 2316,
        width: 168,
        height: 49,
        index: 1,
      }),
    ]);
    const pickedNode = snap.nodeById.get(2)!;
    const coordCand: AiRuleCandidate = {
      id: "cand-coord",
      title: "测试版 A",
      summary: "硬编码坐标",
      risk: "",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [
          {
            key: 0,
            name: "弹窗",
            rules: [
              {
                key: 0,
                action: "clickCenter",
                matches: ['[id="android:id/content"] [childCount=0][left=1128][top=438]'],
              },
            ],
          },
        ],
      },
    };
    const chainedZeroHit: AiRuleCandidate = {
      id: "cand-chained",
      title: "测试版 B",
      summary: "错误串联",
      risk: "",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [
          {
            key: 0,
            name: "弹窗",
            rules: [
              {
                key: 0,
                action: "clickCenter",
                matches: ['@ImageView < FrameLayout [text="点击了解更多内容"] [text="跳转微信"]'],
              },
            ],
          },
        ],
      },
    };

    const reranked = rerankAiCandidates(snap, [coordCand, chainedZeroHit], pickedNode);
    const need = assessAiAutoRepairNeed(snap, reranked, pickedNode);
    expect(need.needsRepair).toBe(true);
    expect(need.reasons.some((r) => r.includes("像素坐标"))).toBe(true);

    const failurePrompt = buildAiStaticFailurePrompt({
      snapshot: snap,
      candidates: reranked.rankedCandidates,
      verifications: reranked.verifications,
      pickedNode,
      qualityReasons: need.reasons,
      machineHint: {
        matches: ['[text="跳转微信"]', 'ImageView[width<120 && height<120]'],
        action: "clickCenter",
      },
    });
    expect(failurePrompt).toContain("连续空格串联");
    expect(failurePrompt).toContain("坐标禁忌");
    expect(failurePrompt).toContain("跳转微信");

    const anchoredRepair: AiRuleCandidate = {
      id: "cand-a",
      title: "测试版 A",
      summary: "锚点版",
      risk: "",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [
          {
            key: 0,
            name: "弹窗",
            rules: [
              {
                key: 0,
                action: "clickCenter",
                matches: ['[text="跳转微信"]', "ImageView[width<120 && height<120]"],
              },
            ],
          },
        ],
      },
    };
    const loopResult = await runAiAutoRepairLoop({
      snapshot: snap,
      pickedNode,
      initialCandidates: [coordCand],
      requestRepairCandidates: async () => [anchoredRepair],
    });
    expect(loopResult.autoRepairTriggered).toBe(true);
    expect(loopResult.autoRepairSucceeded).toBe(true);
    expect(loopResult.rankedCandidates[0]?.app.groups[0]?.rules[0]?.matches).toEqual([
      '[text="跳转微信"]',
      "ImageView[width<120 && height<120]",
    ]);

    // Flutter contextual desc beats bare desc="关闭"
    const flutterSnap = makeSnapshot([
      node(0, -1, { name: "android.widget.FrameLayout", childCount: 1 }),
      node(1, 0, { name: "android.view.View", desc: "请尽快更新到最新版本", clickable: true, childCount: 1 }),
      node(2, 1, {
        name: "android.widget.Button",
        desc: "关闭",
        clickable: true,
        left: 641,
        top: 2101,
        right: 865,
        bottom: 2269,
        width: 224,
        height: 168,
      }),
    ]);
    const flutterPicked = flutterSnap.nodeById.get(2)!;
    const bareClose: AiRuleCandidate = {
      id: "bare",
      title: "测试版 A",
      summary: "",
      risk: "",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [{ key: 0, name: "弹窗", rules: [{ key: 0, matches: ['[desc="关闭"][clickable=true]'] }] }],
      },
    };
    const ctxClose: AiRuleCandidate = {
      id: "ctx",
      title: "测试版 B",
      summary: "",
      risk: "",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [
          {
            key: 0,
            name: "弹窗",
            rules: [{ key: 0, matches: ['[desc="请尽快更新到最新版本"] > Button[desc="关闭"][clickable=true]'] }],
          },
        ],
      },
    };
    const flutterRanked = rerankAiCandidates(flutterSnap, [bareClose, ctxClose], flutterPicked);
    expect(flutterRanked.rankedCandidates[0].id).toBe("ctx");

    // Immediate-click outranks delayed splash rules, and all-delayed triggers auto-repair
    const splashSnap = makeSnapshot([
      node(0, -1, { name: "android.widget.FrameLayout", childCount: 1 }),
      node(1, 0, {
        id: "com.shizi.tool.p3:id/tobid_splash_skip_ll",
        vid: "tobid_splash_skip_ll",
        name: "android.widget.LinearLayout",
        clickable: true,
        left: 928,
        top: 105,
        right: 1159,
        bottom: 203,
        width: 231,
        height: 98,
      }),
    ]);
    const splashPicked = splashSnap.nodeById.get(1)!;
    const delayedCand: AiRuleCandidate = {
      id: "delayed",
      title: "测试版 A",
      summary: "",
      risk: "",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [
          {
            key: 0,
            name: "开屏广告",
            rules: [{ key: 0, actionDelay: 2500, matches: ['[vid="tobid_splash_skip_ll"]'] }],
          },
        ],
      },
    };
    const immediateCand: AiRuleCandidate = {
      id: "immediate",
      title: "测试版 B",
      summary: "",
      risk: "",
      app: {
        id: "com.shizi.tool.p3",
        name: "动漫共和国",
        groups: [
          {
            key: 0,
            name: "开屏广告",
            rules: [{ key: 0, matches: ['[vid="tobid_splash_skip_ll"]'] }],
          },
        ],
      },
    };
    expect(rerankAiCandidates(splashSnap, [delayedCand, immediateCand], splashPicked).rankedCandidates[0].id).toBe("immediate");
    expect(
      assessAiAutoRepairNeed(
        splashSnap,
        rerankAiCandidates(splashSnap, [delayedCand], splashPicked),
        splashPicked,
      ).reasons.some((r) => r.includes("actionDelay")),
    ).toBe(true);
  });
});
