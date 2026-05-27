import { describe, expect, it } from "vitest";
import { pickNodeAtPoint } from "./nodePicker";
import { normalizeSnapshot } from "./snapshotZip";
import { generateSelectorCandidates } from "./selectorStrategies";
import { diagnoseRuleRun } from "./actionPlan";
import { createAppRuleDraft, stringifyRuleDraft } from "./ruleDraft";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

describe("selector MVP flow", () => {
  it("generates exact and context candidates for a clicked action button", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 3 })),
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
      node(
        3,
        0,
        attr({
          name: "android.widget.Button",
          text: "立即升级",
          clickable: true,
          left: 300,
          top: 300,
          right: 520,
          bottom: 380,
          index: 2,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 160, y: 330 });
    expect(pick?.pickedNode.id).toBe(2);

    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      pickedNode: pick!.pickedNode,
      ancestors: pick!.ancestors,
      siblings: pick!.siblings,
      clickableAncestor: pick!.clickableAncestor,
      nearbyTextNodes: pick!.nearbyTextNodes,
    });

    expect(candidates.some((candidate) => candidate.strategyName === "exactVid")).toBe(true);
    expect(
      candidates.some(
        (candidate) => candidate.strategyName === "exactTextWithContext",
      ),
    ).toBe(true);
    expect(
      candidates.some(
        (candidate) => candidate.strategyName === "simpleSiblingCancelVsCTA",
      ),
    ).toBe(true);
    expect(candidates[0].validation.hitCount).toBeGreaterThanOrEqual(1);
  });

  it("generates a parent-click selector when child text is not clickable", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          name: "android.widget.FrameLayout",
          clickable: true,
          left: 700,
          top: 40,
          right: 900,
          bottom: 120,
          childCount: 1,
        }),
      ),
      node(
        2,
        1,
        attr({
          name: "android.widget.TextView",
          text: "跳过 3",
          left: 730,
          top: 58,
          right: 870,
          bottom: 104,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 760, y: 80 });
    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      pickedNode: pick!.pickedNode,
      ancestors: pick!.ancestors,
      siblings: pick!.siblings,
      clickableAncestor: pick!.clickableAncestor,
      nearbyTextNodes: pick!.nearbyTextNodes,
    });

    const parentClick = candidates.find(
      (candidate) => candidate.strategyName === "clickParentDirectChildText",
    );

    expect(parentClick?.rule.matches[0]).toContain("@[clickable=true] > TextView");
    expect(parentClick?.validation.clickNodes[0].id).toBe(1);
  });

  it("generates a fallback selector for an attribute-less child inside a clickable region", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          name: "android.widget.LinearLayout",
          clickable: true,
          left: 80,
          top: 200,
          right: 520,
          bottom: 360,
          width: 440,
          height: 160,
          childCount: 1,
        }),
      ),
      node(
        2,
        1,
        attr({
          name: "android.view.View",
          left: 120,
          top: 230,
          right: 480,
          bottom: 330,
          width: 360,
          height: 100,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 300, y: 280 });
    expect(pick?.pickedNode.id).toBe(2);

    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      pickedNode: pick!.pickedNode,
      ancestors: pick!.ancestors,
      siblings: pick!.siblings,
      clickableAncestor: pick!.clickableAncestor,
      nearbyTextNodes: pick!.nearbyTextNodes,
    });

    const fallback = candidates.find(
      (candidate) => candidate.strategyName === "clickableAncestorFallback",
    );

    expect(fallback).toBeDefined();
    expect(fallback?.validation.hitCount).toBeGreaterThanOrEqual(1);
    expect(fallback?.rule.matches[0]).toContain("clickable=true");
  });

  it("generates a fallback selector for an attribute-less clickable node", () => {
    const snapshot = buildSnapshot([
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          name: "android.widget.FrameLayout",
          clickable: true,
          left: 40,
          top: 80,
          right: 1040,
          bottom: 520,
          width: 1000,
          height: 440,
        }),
      ),
    ]);

    const pick = pickNodeAtPoint(snapshot, { x: 600, y: 200 });
    expect(pick?.pickedNode.id).toBe(1);

    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      pickedNode: pick!.pickedNode,
      ancestors: pick!.ancestors,
      siblings: pick!.siblings,
      clickableAncestor: pick!.clickableAncestor,
      nearbyTextNodes: pick!.nearbyTextNodes,
    });

    const fallback = candidates.find(
      (candidate) => candidate.strategyName === "visibleNodeFallback",
    );

    expect(fallback).toBeDefined();
    expect(fallback?.validation.clickNodes[0].id).toBe(1);
    expect(fallback?.rule.matches[0]).toContain("visibleToUser=true");
  });

  it("keeps stable skip resource and WebView fallback without exact countdown text", () => {
    const snapshot = buildCloudNotesSplashSnapshot();

    const pick = pickNodeAtPoint(snapshot, { x: 1900, y: 140 });
    expect(pick?.pickedNode.id).toBe(4);

    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: {
        ...DEFAULT_RULE_SETTINGS,
        activityIds: snapshot.activityId,
      },
      pickedNode: pick!.pickedNode,
      ancestors: pick!.ancestors,
      siblings: pick!.siblings,
      clickableAncestor: pick!.clickableAncestor,
      nearbyTextNodes: pick!.nearbyTextNodes,
    });

    expect(
      candidates.some(
        (candidate) =>
          candidate.rule.matches[0] ===
          '[vid="tv_ad_skip"][text^="跳过"][visibleToUser=true]',
      ),
    ).toBe(true);

    expect(
      candidates.some(
        (candidate) =>
          candidate.rule.matches[0] ===
          'FrameLayout[id="com.jideos.jnotes:id/ptgAdvertLayout"] TextView[text^="跳过"][text.length<10][visibleToUser=true]',
      ),
    ).toBe(true);

    expect(candidates[0].rule.matches[0]).not.toBe('TextView[text="跳过3"]');
    expect(
      candidates.find((candidate) => candidate.rule.matches[0] === 'TextView[text="跳过3"]'),
    ).toBeUndefined();
  });

  it("diagnoses matched-but-no-effect as action strategy and recommends delayed clickCenter retries", () => {
    const snapshot = buildCloudNotesSplashSnapshot();
    const pick = pickNodeAtPoint(snapshot, { x: 1900, y: 140 });
    expect(pick?.pickedNode.id).toBe(4);

    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: {
        ...DEFAULT_RULE_SETTINGS,
        activityIds: snapshot.activityId,
      },
      pickedNode: pick!.pickedNode,
      ancestors: pick!.ancestors,
      siblings: pick!.siblings,
      clickableAncestor: pick!.clickableAncestor,
      nearbyTextNodes: pick!.nearbyTextNodes,
    });

    expect(candidates[0].rule.matches[0]).toBe(
      'FrameLayout[id="com.jideos.jnotes:id/ptgAdvertLayout"] TextView[text^="跳过"][text.length<10][visibleToUser=true]',
    );
    expect(candidates[0].strategyName).toBe("adContainerSkipFallback");
    expect(candidates[0].actionPlan).toMatchObject({
      action: "clickCenter",
      actionDelay: 2500,
      actionMaximum: 3,
      actionCd: 1000,
      forcedTime: 10000,
      matchRoot: true,
      resetMatch: "app",
    });

    expect(
      candidates.some(
        (candidate) =>
          candidate.rule.matches[0] ===
          '[vid="tv_ad_skip"][text^="跳过"][visibleToUser=true]',
      ),
    ).toBe(true);

    const diagnosis = diagnoseRuleRun({
      selectorMatched: true,
      hasTriggerRecord: true,
      uiStateChanged: false,
    });

    expect(diagnosis.diagnosis).toBe("action_failed_or_too_early");
    expect(diagnosis.debugAdvice.join("\n")).toContain("actionDelay");
    expect(diagnosis.debugAdvice.join("\n")).toContain("clickCenter");

    const draft = createAppRuleDraft(snapshot, candidates[0], candidates);
    expect(draft.groups[0]).toMatchObject({
      name: "全屏广告",
      matchRoot: true,
      forcedTime: 10000,
      matchTime: 10000,
      actionMaximum: 3,
      actionCd: 1000,
      resetMatch: "app",
    });
    expect(draft.groups[0].activityIds).toBeUndefined();
    expect(draft.groups[0].rules[0]).toMatchObject({
      matches: [
        'FrameLayout[id="com.jideos.jnotes:id/ptgAdvertLayout"] TextView[text^="跳过"][text.length<10][visibleToUser=true]',
      ],
      activityIds: "com.jideos.module_start.pad.SplashActivity",
      action: "clickCenter",
      actionDelay: 2500,
    });
    expect(draft.groups[0].rules.map((rule) => rule.matches[0])).toEqual([
      'FrameLayout[id="com.jideos.jnotes:id/ptgAdvertLayout"] TextView[text^="跳过"][text.length<10][visibleToUser=true]',
    ]);
    const preview = stringifyRuleDraft(draft);
    expect(preview).toContain(
      'matches: \'FrameLayout[id="com.jideos.jnotes:id/ptgAdvertLayout"] TextView[text^="跳过"][text.length<10][visibleToUser=true]\'',
    );
    expect(preview).not.toContain("tv_ad_skip");
  });

  it("does not rank ad SDK skip shade overlays above real skip layout resources", () => {
    const snapshot = buildGuoguoSplashSnapshot();

    const pick = pickNodeAtPoint(snapshot, { x: 1015, y: 165 });
    expect(pick?.pickedNode.attr.vid).toBe("tobid_splash_skip_shade");

    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: {
        ...DEFAULT_RULE_SETTINGS,
        activityIds: snapshot.activityId,
      },
      pickedNode: pick!.pickedNode,
      ancestors: pick!.ancestors,
      siblings: pick!.siblings,
      clickableAncestor: pick!.clickableAncestor,
      nearbyTextNodes: pick!.nearbyTextNodes,
    });

    expect(candidates[0].rule.matches[0]).toContain("tobid_splash_skip_ll");
    expect(candidates[0].risk.finalScore).toBeGreaterThanOrEqual(85);

    const shadeCandidate = candidates.find((candidate) =>
      candidate.rule.matches[0].includes("tobid_splash_skip_shade"),
    );
    expect(shadeCandidate).toBeDefined();
    expect(shadeCandidate!.risk.finalScore).toBeLessThan(70);
    expect(shadeCandidate!.risk.items.map((item) => item.label)).toContain(
      "广告遮罩热区",
    );
  });

  it("keeps native splash skip layouts as node clicks without WebView action overrides", () => {
    const snapshot = buildGuoguoSplashShadeSnapshot();

    const pick = pickNodeAtPoint(snapshot, { x: 115, y: 115 });
    expect(pick?.pickedNode.attr.vid).toBe("tobid_splash_skip_shade");

    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: {
        ...DEFAULT_RULE_SETTINGS,
        groupName: "开屏广告",
        activityIds: "",
        matchTime: 30000,
        actionMaximum: 1,
        resetMatch: "app",
      },
      pickedNode: pick!.pickedNode,
      ancestors: pick!.ancestors,
      siblings: pick!.siblings,
      clickableAncestor: pick!.clickableAncestor,
      nearbyTextNodes: pick!.nearbyTextNodes,
    });

    expect(candidates[0].rule).toMatchObject({
      matches: ['[vid="tobid_splash_skip_ll"][visibleToUser=true]'],
      fastQuery: true,
      activityIds: ["app.video.guoguo.MainActivity"],
      matchTime: 30000,
      actionMaximum: 1,
      resetMatch: "app",
    });
    expect(candidates[0].rule.action).toBeUndefined();
    expect(candidates[0].rule.forcedTime).toBeUndefined();
    expect(candidates[0].rule.matchRoot).toBeUndefined();
  });

  it("generates a low-risk interstitial skip rule with rule-level activityIds", () => {
    const snapshot = buildGuoguoInterstitialSnapshot();

    const pick = pickNodeAtPoint(snapshot, { x: 380, y: 625 });
    expect(pick?.pickedNode.attr.vid).toBe("tobid_interstitial_skip_text");

    const candidates = generateSelectorCandidates({
      snapshot,
      ruleSettings: {
        ...DEFAULT_RULE_SETTINGS,
        groupName: "开屏广告",
        activityIds: "",
        matchTime: 30000,
        actionMaximum: 1,
        resetMatch: "app",
      },
      pickedNode: pick!.pickedNode,
      ancestors: pick!.ancestors,
      siblings: pick!.siblings,
      clickableAncestor: pick!.clickableAncestor,
      nearbyTextNodes: pick!.nearbyTextNodes,
    });

    expect(candidates[0].rule).toMatchObject({
      matches: ['[vid="tobid_interstitial_skip_ll"][visibleToUser=true]'],
      fastQuery: true,
      activityIds: ["com.windmill.sdk.widget.InterstitialView_4012003"],
      matchTime: 30000,
      actionMaximum: 1,
      resetMatch: "app",
    });
    expect(candidates[0].rule.action).toBeUndefined();
    expect(candidates[0].rule.forcedTime).toBeUndefined();
    expect(candidates[0].rule.matchRoot).toBeUndefined();

    const draft = createAppRuleDraft(snapshot, candidates[0], candidates);
    expect(draft.groups[0].activityIds).toBeUndefined();
    expect(draft.groups[0].rules[0].activityIds).toEqual([
      "com.windmill.sdk.widget.InterstitialView_4012003",
    ]);
  });
});

function buildSnapshot(
  nodes: SnapshotNode[],
  overrides: Partial<
    Pick<RawGkdSnapshot, "appId" | "activityId" | "screenWidth" | "screenHeight">
  > = {},
) {
  const raw: RawGkdSnapshot = {
    id: 1,
    appId: overrides.appId ?? "com.demo",
    activityId: overrides.activityId ?? "com.demo.MainActivity",
    screenWidth: overrides.screenWidth ?? 1080,
    screenHeight: overrides.screenHeight ?? 2400,
    isLandscape: false,
    appInfo: {
      id: overrides.appId ?? "com.demo",
      name: "Demo",
    },
    nodes,
  };

  return normalizeSnapshot(raw, "blob:test", "test.zip");
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
    bottom: 2400,
    width: (overrides.right ?? 1080) - (overrides.left ?? 0),
    height: (overrides.bottom ?? 2400) - (overrides.top ?? 0),
    childCount: 0,
    index: 0,
    depth: 0,
    ...overrides,
  };
}

function buildCloudNotesSplashSnapshot() {
  return buildSnapshot(
    [
      node(
        0,
        -1,
        attr({
          name: "android.widget.FrameLayout",
          right: 2000,
          bottom: 2800,
          width: 2000,
          height: 2800,
          childCount: 5,
        }),
      ),
      node(
        1,
        0,
        attr({
          id: "com.jideos.jnotes:id/ptgAdvertLayout",
          vid: "ptgAdvertLayout",
          name: "android.widget.FrameLayout",
          clickable: true,
          right: 2000,
          bottom: 2800,
          width: 2000,
          height: 2800,
          childCount: 4,
          index: 0,
        }),
      ),
      node(
        2,
        0,
        attr({
          id: "com.jideos.jnotes:id/tv_ad_skip",
          vid: "tv_ad_skip",
          name: "android.widget.TextView",
          text: "跳过",
          clickable: true,
          left: 1737,
          top: 63,
          right: 1937,
          bottom: 180,
          width: 200,
          height: 117,
          index: 1,
        }),
      ),
      node(
        3,
        1,
        attr({
          name: "android.webkit.WebView",
          right: 2000,
          bottom: 2800,
          width: 2000,
          height: 2800,
          childCount: 4,
        }),
      ),
      node(
        4,
        3,
        attr({
          name: "android.widget.TextView",
          text: "跳过3",
          left: 1845,
          top: 110,
          right: 1975,
          bottom: 172,
          width: 130,
          height: 62,
        }),
      ),
      node(
        5,
        3,
        attr({
          name: "android.widget.TextView",
          text: "点击跳转至详情页或第三方应用",
          clickable: true,
          left: 500,
          top: 2400,
          right: 1500,
          bottom: 2520,
          width: 1000,
          height: 120,
        }),
      ),
      node(
        6,
        3,
        attr({
          name: "android.widget.TextView",
          text: "摇动手机 了解更多",
          clickable: true,
          left: 700,
          top: 2200,
          right: 1300,
          bottom: 2300,
          width: 600,
          height: 100,
        }),
      ),
      node(
        7,
        3,
        attr({
          name: "android.widget.TextView",
          text: "oppo软件商店 >",
          clickable: true,
          left: 700,
          top: 2050,
          right: 1300,
          bottom: 2140,
          width: 600,
          height: 90,
        }),
      ),
      node(
        8,
        1,
        attr({
          id: "com.jideos.jnotes:id/ptgSplashHotArea",
          vid: "ptgSplashHotArea",
          name: "android.widget.FrameLayout",
          clickable: true,
          right: 2000,
          bottom: 2800,
          width: 2000,
          height: 2800,
          index: 4,
        }),
      ),
    ],
    {
      appId: "com.jideos.jnotes",
      activityId: "com.jideos.module_start.pad.SplashActivity",
      screenWidth: 2000,
      screenHeight: 2800,
    },
  );
}

function buildGuoguoSplashSnapshot() {
  return buildSnapshot(
    [
      node(
        0,
        -1,
        attr({
          name: "android.widget.FrameLayout",
          right: 1080,
          bottom: 2400,
          width: 1080,
          height: 2400,
          childCount: 4,
        }),
      ),
      node(
        1,
        0,
        attr({
          id: "com.shizi.tool.p3:id/tobid_splash_skip_ll",
          vid: "tobid_splash_skip_ll",
          name: "android.widget.LinearLayout",
          clickable: true,
          left: 830,
          top: 70,
          right: 1010,
          bottom: 160,
          width: 180,
          height: 90,
          childCount: 1,
          index: 0,
        }),
      ),
      node(
        2,
        1,
        attr({
          name: "android.widget.TextView",
          text: "跳过",
          left: 860,
          top: 92,
          right: 980,
          bottom: 138,
          width: 120,
          height: 46,
          index: 0,
        }),
      ),
      node(
        3,
        0,
        attr({
          id: "com.shizi.tool.p3:id/tobid_splash_skip_shade",
          vid: "tobid_splash_skip_shade",
          name: "android.view.View",
          clickable: true,
          left: 820,
          top: 60,
          right: 1020,
          bottom: 170,
          width: 200,
          height: 110,
          index: 1,
        }),
      ),
      node(
        4,
        0,
        attr({
          id: "com.shizi.tool.p3:id/tobid_splash_ad_click_area",
          vid: "tobid_splash_ad_click_area",
          name: "android.widget.FrameLayout",
          clickable: true,
          left: 0,
          top: 0,
          right: 1080,
          bottom: 2400,
          width: 1080,
          height: 2400,
          index: 2,
        }),
      ),
    ],
    {
      appId: "com.shizi.tool.p3",
      activityId: "app.video.guoguo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
    },
  );
}

function buildGuoguoSplashShadeSnapshot() {
  return buildSnapshot(
    [
      node(
        0,
        -1,
        attr({
          name: "android.widget.FrameLayout",
          right: 1264,
          bottom: 2780,
          width: 1264,
          height: 2780,
          childCount: 2,
        }),
      ),
      node(
        13,
        0,
        attr({
          name: "android.widget.RelativeLayout",
          right: 1264,
          bottom: 2780,
          width: 1264,
          height: 2780,
          childCount: 4,
          depth: 3,
        }),
      ),
      node(
        15,
        13,
        attr({
          id: "com.shizi.tool.p3:id/tobid_splash_bg_shade",
          vid: "tobid_splash_bg_shade",
          name: "android.view.View",
          clickable: true,
          right: 1264,
          bottom: 2780,
          width: 1264,
          height: 2780,
          index: 1,
          depth: 4,
        }),
      ),
      node(
        16,
        13,
        attr({
          id: "com.shizi.tool.p3:id/tobid_splash_sound_and_skip_layout",
          vid: "tobid_splash_sound_and_skip_layout",
          name: "android.widget.LinearLayout",
          left: 105,
          top: 105,
          right: 298,
          bottom: 188,
          width: 193,
          height: 83,
          childCount: 1,
          index: 2,
          depth: 5,
        }),
      ),
      node(
        17,
        16,
        attr({
          name: "android.widget.FrameLayout",
          left: 105,
          top: 105,
          right: 298,
          bottom: 188,
          width: 193,
          height: 83,
          childCount: 2,
          depth: 6,
        }),
      ),
      node(
        18,
        17,
        attr({
          id: "com.shizi.tool.p3:id/tobid_splash_skip_shade",
          vid: "tobid_splash_skip_shade",
          name: "android.view.View",
          clickable: true,
          left: 105,
          top: 105,
          right: 298,
          bottom: 188,
          width: 193,
          height: 83,
          index: 0,
          depth: 7,
        }),
      ),
      node(
        19,
        17,
        attr({
          id: "com.shizi.tool.p3:id/tobid_splash_skip_ll",
          vid: "tobid_splash_skip_ll",
          name: "android.widget.LinearLayout",
          clickable: true,
          left: 105,
          top: 105,
          right: 298,
          bottom: 188,
          width: 193,
          height: 83,
          childCount: 1,
          index: 1,
          depth: 7,
        }),
      ),
      node(
        20,
        19,
        attr({
          id: "com.shizi.tool.p3:id/tobid_splash_skip_text",
          vid: "tobid_splash_skip_text",
          name: "android.widget.TextView",
          text: "跳过｜1",
          left: 140,
          top: 123,
          right: 263,
          bottom: 170,
          width: 123,
          height: 47,
          depth: 8,
        }),
      ),
      node(
        30,
        13,
        attr({
          id: "com.shizi.tool.p3:id/tobid_splash_cta_bt",
          vid: "tobid_splash_cta_bt",
          name: "android.widget.TextView",
          text: "浏览",
          clickable: true,
          left: 70,
          top: 2535,
          right: 1194,
          bottom: 2675,
          width: 1124,
          height: 140,
          index: 3,
          depth: 5,
        }),
      ),
    ],
    {
      appId: "com.shizi.tool.p3",
      activityId: "app.video.guoguo.MainActivity",
      screenWidth: 1264,
      screenHeight: 2780,
    },
  );
}

function buildGuoguoInterstitialSnapshot() {
  return buildSnapshot(
    [
      node(
        0,
        -1,
        attr({
          name: "android.widget.FrameLayout",
          left: 152,
          top: 524,
          right: 1112,
          bottom: 2395,
          width: 960,
          height: 1871,
          childCount: 1,
        }),
      ),
      node(
        8,
        0,
        attr({
          id: "com.shizi.tool.p3:id/tobid_interstitial_click_group",
          vid: "tobid_interstitial_click_group",
          name: "android.widget.FrameLayout",
          clickable: true,
          left: 152,
          top: 524,
          right: 1112,
          bottom: 2220,
          width: 960,
          height: 1696,
          childCount: 1,
          depth: 6,
        }),
      ),
      node(
        15,
        8,
        attr({
          id: "com.shizi.tool.p3:id/tobid_interstitial_sound_and_skip_layout",
          vid: "tobid_interstitial_sound_and_skip_layout",
          name: "android.widget.LinearLayout",
          left: 215,
          top: 587,
          right: 478,
          bottom: 664,
          width: 263,
          height: 77,
          childCount: 2,
          depth: 11,
        }),
      ),
      node(
        17,
        15,
        attr({
          id: "com.shizi.tool.p3:id/tobid_interstitial_skip_shade",
          vid: "tobid_interstitial_skip_shade",
          name: "android.view.View",
          clickable: true,
          left: 310,
          top: 588,
          right: 478,
          bottom: 662,
          width: 168,
          height: 74,
          index: 0,
          depth: 12,
        }),
      ),
      node(
        18,
        15,
        attr({
          id: "com.shizi.tool.p3:id/tobid_interstitial_skip_ll",
          vid: "tobid_interstitial_skip_ll",
          name: "android.widget.LinearLayout",
          clickable: true,
          left: 310,
          top: 588,
          right: 478,
          bottom: 662,
          width: 168,
          height: 74,
          childCount: 1,
          index: 1,
          depth: 12,
        }),
      ),
      node(
        19,
        18,
        attr({
          id: "com.shizi.tool.p3:id/tobid_interstitial_skip_text",
          vid: "tobid_interstitial_skip_text",
          name: "android.widget.TextView",
          text: "跳过｜2",
          left: 345,
          top: 606,
          right: 443,
          bottom: 644,
          width: 98,
          height: 38,
          index: 0,
          depth: 14,
        }),
      ),
      node(
        27,
        0,
        attr({
          id: "com.shizi.tool.p3:id/tobid_interstitial_cta_bt",
          vid: "tobid_interstitial_cta_bt",
          name: "android.widget.TextView",
          text: "浏览",
          clickable: true,
          left: 152,
          top: 2255,
          right: 1112,
          bottom: 2395,
          width: 960,
          height: 140,
          index: 2,
          depth: 7,
        }),
      ),
    ],
    {
      appId: "com.shizi.tool.p3",
      activityId: "com.windmill.sdk.widget.InterstitialView_4012003",
      screenWidth: 1264,
      screenHeight: 2780,
    },
  );
}
