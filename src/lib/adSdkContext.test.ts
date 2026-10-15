import { describe, expect, it } from "vitest";
import {
  findAppSdkProfile,
  formatAdSdkContextLines,
  resolveAdSdkContext,
} from "./adSdkContext";
import { buildFlowHelpPrompt } from "./flowDraft";
import { buildHelpPrompt } from "./helpPrompt";
import { scoreCandidate } from "./riskScoring";
import { exactSelector } from "./selectorSerialize";
import { normalizeSnapshot } from "./snapshotNormalize";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import type { AppSdkEvidence, AppSdkProfile } from "../types/appSdkProfile";
import type { FlowRuleStep } from "../types/flowDraft";
import type {
  NormalizedSnapshotNode,
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

function attr(o: Partial<SnapshotNodeAttr>): SnapshotNodeAttr {
  return o as SnapshotNodeAttr;
}

function node(id: number, pid: number, a: SnapshotNodeAttr): SnapshotNode {
  return { id, pid, idQf: Boolean(a.id), textQf: Boolean(a.text), attr: a };
}

function buildSnapshot(options: {
  appId?: string;
  activityId?: string | null;
  versionCode?: number;
  versionName?: string;
  nodes?: SnapshotNode[];
}) {
  const {
    appId = "com.demo",
    activityId = "com.demo.MainActivity",
    versionCode,
    versionName,
    nodes = [],
  } = options;
  const raw: RawGkdSnapshot = {
    id: 1,
    appId,
    activityId,
    screenWidth: 1080,
    screenHeight: 2400,
    isLandscape: false,
    appInfo: {
      id: appId,
      name: "Demo",
      ...(versionCode === undefined ? {} : { versionCode }),
      ...(versionName === undefined ? {} : { versionName }),
    },
    nodes: [
      node(
        0,
        -1,
        attr({
          name: "android.widget.FrameLayout",
          childCount: nodes.length,
          right: 1080,
          bottom: 2400,
        }),
      ),
      ...nodes,
    ],
  };
  return normalizeSnapshot(raw, "blob:test", "test.zip");
}

function evidence(
  name: string,
  matchedPrefix: string,
  componentType: AppSdkEvidence["componentType"] = "activity",
): AppSdkEvidence {
  return { componentType, name, matchedPrefix };
}

function profile(input: Partial<AppSdkProfile> & { appId: string }): AppSdkProfile {
  return {
    importedAt: "2026-10-14T00:00:00.000Z",
    sdks: [],
    ...input,
  };
}

const pangleManifest = profile({
  appId: "com.demo",
  appName: "Demo",
  versionCode: "123",
  sdks: [
    {
      sdkId: "pangle",
      evidence: [evidence("com.byted.pangle.SplashActivity", "com.byted.pangle")],
    },
  ],
});

describe("resolveAdSdkContext 关联与版本", () => {
  it("只关联精确包名，同名不同包名不进入清单", () => {
    const snapshot = buildSnapshot({ appId: "com.demo", versionCode: 123 });
    const other = profile({
      appId: "com.other",
      appName: "Demo",
      versionCode: "123",
      sdks: [
        {
          sdkId: "pangle",
          evidence: [evidence("com.byted.pangle.SplashActivity", "com.byted.pangle")],
        },
      ],
    });

    const context = resolveAdSdkContext(snapshot, other);
    expect(context.profileAppId).toBeNull();
    expect(context.manifest).toEqual([]);
    expect(context.versionStatus).toBe("unverified");
    expect(findAppSdkProfile([other], "com.demo")).toBeNull();
  });

  it("版本码相符、字符串前缀零与超安全整数比较正确", () => {
    const snapshot = buildSnapshot({ versionCode: 7 });
    const matched = resolveAdSdkContext(
      snapshot,
      profile({ appId: "com.demo", versionCode: "007", sdks: [] }),
    );
    expect(matched.versionStatus).toBe("matched");

    const big = resolveAdSdkContext(
      buildSnapshot({ versionCode: 1 }),
      profile({ appId: "com.demo", versionCode: "9007199254740993", sdks: [] }),
    );
    expect(big.versionStatus).toBe("mismatched");
    expect(big.versionNote).toContain("9007199254740993");
  });

  it("版本失配时保留名单供详情查看，但 prompt 省略名单", () => {
    const snapshot = buildSnapshot({ versionCode: 200 });
    const context = resolveAdSdkContext(
      snapshot,
      profile({ appId: "com.demo", versionCode: "100", sdks: pangleManifest.sdks }),
    );

    expect(context.versionStatus).toBe("mismatched");
    expect(context.manifest.map((group) => group.sdkId)).toEqual(["pangle"]);

    const lines = formatAdSdkContextLines(context).join("\n");
    expect(lines).toContain("版本失配");
    expect(lines).not.toContain("pangle");
    expect(lines).not.toContain("穿山甲");
    expect(lines).not.toContain("com.byted.pangle");
  });

  it("无法比较时标记版本未核对，并按版本名兜底比较", () => {
    const unverified = resolveAdSdkContext(
      buildSnapshot({}),
      profile({ appId: "com.demo", sdks: [] }),
    );
    expect(unverified.versionStatus).toBe("unverified");
    expect(unverified.versionNote).toContain("版本未核对");

    const byName = resolveAdSdkContext(
      buildSnapshot({ versionName: "1.2.3" }),
      profile({ appId: "com.demo", versionName: "1.2.3", sdks: [] }),
    );
    expect(byName.versionStatus).toBe("matched");
    expect(byName.versionNote).toContain("versionName");
  });

  it("不修改传入的档案与快照", () => {
    const snapshot = buildSnapshot({
      versionCode: 123,
      nodes: [node(1, 0, attr({ name: "TextView", vid: "tt_splash_skip_btn" }))],
    });
    const before = JSON.stringify(pangleManifest);
    const nodeCountBefore = snapshot.nodes.length;

    resolveAdSdkContext(snapshot, pangleManifest);

    expect(JSON.stringify(pangleManifest)).toBe(before);
    expect(snapshot.nodes.length).toBe(nodeCountBefore);
  });
});

describe("resolveAdSdkContext 页面证据", () => {
  it("清单含穿山甲和优量汇、页面只有穿山甲时分别呈现", () => {
    const snapshot = buildSnapshot({
      versionCode: 123,
      nodes: [node(1, 0, attr({ name: "TextView", vid: "tt_splash_skip_btn" }))],
    });
    const both = profile({
      appId: "com.demo",
      versionCode: "123",
      sdks: [
        {
          sdkId: "pangle",
          evidence: [evidence("com.byted.pangle.SplashActivity", "com.byted.pangle")],
        },
        {
          sdkId: "gdt",
          evidence: [evidence("com.qq.e.ads.ADActivity", "com.qq.e")],
        },
      ],
    });

    const context = resolveAdSdkContext(snapshot, both);
    expect(context.manifest.map((group) => group.sdkId)).toEqual(["pangle", "gdt"]);
    expect(context.page.map((group) => group.sdkId)).toEqual(["pangle"]);
    expect(context.page[0]?.evidence[0]).toMatchObject({
      source: "nodeVid",
      signal: "tt_splash_skip_btn",
      value: "tt_splash_skip_btn",
      nodeId: 1,
    });
  });

  it("页面出现清单外的 SDK 时仍保留", () => {
    const snapshot = buildSnapshot({
      versionCode: 123,
      nodes: [node(1, 0, attr({ name: "View", vid: "ksad_skip" }))],
    });
    const context = resolveAdSdkContext(snapshot, pangleManifest);

    expect(context.manifest.map((group) => group.sdkId)).toEqual(["pangle"]);
    expect(context.page.map((group) => group.sdkId)).toEqual(["kwad"]);
  });

  it("Activity 可单独贡献页面特征", () => {
    const snapshot = buildSnapshot({
      appId: "com.demo",
      activityId: "com.byted.pangle.SplashActivity",
    });
    const context = resolveAdSdkContext(snapshot, null);

    expect(context.page.map((group) => group.sdkId)).toEqual(["pangle"]);
    expect(context.page[0]?.evidence[0]).toMatchObject({
      source: "activityId",
      signal: "com.byted.pangle",
      nodeId: null,
    });
  });

  it("一页多个 SDK 全部保留", () => {
    const snapshot = buildSnapshot({
      activityId: "com.byted.pangle.SplashActivity",
      nodes: [node(1, 0, attr({ name: "View", vid: "ksad_skip" }))],
    });
    const context = resolveAdSdkContext(snapshot, null);

    expect(context.page.map((group) => group.sdkId)).toEqual(["pangle", "kwad"]);
  });

  it("ad_area／hotarea 等泛化资源词不能单独确认 SDK", () => {
    const snapshot = buildSnapshot({
      activityId: "com.demo.MainActivity",
      nodes: [
        node(1, 0, attr({ name: "FrameLayout", vid: "ad_area" })),
        node(2, 0, attr({ name: "FrameLayout", vid: "hotarea" })),
        node(3, 0, attr({ name: "FrameLayout", vid: "splashhotarea" })),
      ],
    });
    const context = resolveAdSdkContext(snapshot, null);

    expect(context.page).toEqual([]);
    expect(formatAdSdkContextLines(context)).toEqual([]);
  });

  it("页面证据与清单证据分开收集，未导入也能得到页面证据", () => {
    const snapshot = buildSnapshot({
      nodes: [node(1, 0, attr({ name: "TextView", vid: "tt_splash_skip_btn" }))],
    });
    const context = resolveAdSdkContext(snapshot, null);

    expect(context.profileAppId).toBeNull();
    expect(context.manifest).toEqual([]);
    expect(context.page.map((group) => group.sdkId)).toEqual(["pangle"]);
  });
});

describe("formatAdSdkContextLines", () => {
  it("两类证据都缺失时不输出任何行", () => {
    const snapshot = buildSnapshot({});
    expect(formatAdSdkContextLines(resolveAdSdkContext(snapshot, null))).toEqual([]);
  });

  it("每个 SDK 最多展示两条证据并标注省略数量", () => {
    const snapshot = buildSnapshot({ versionCode: 123 });
    const many = profile({
      appId: "com.demo",
      versionCode: "123",
      sdks: [
        {
          sdkId: "pangle",
          evidence: [
            evidence("com.byted.pangle.A", "com.byted.pangle", "activity"),
            evidence("com.byted.pangle.B", "com.byted.pangle", "service"),
            evidence("com.byted.pangle.C", "com.byted.pangle", "receiver"),
          ],
        },
      ],
    });

    const lines = formatAdSdkContextLines(resolveAdSdkContext(snapshot, many));
    const body = lines.join("\n");
    expect(body).toContain("activity com.byted.pangle.A");
    expect(body).toContain("service com.byted.pangle.B");
    expect(body).not.toContain("com.byted.pangle.C");
    expect(body).toContain("…等 3 条");
  });

  it("未识别到受支持 SDK 时给出明确状态", () => {
    const snapshot = buildSnapshot({ versionCode: 123 });
    const empty = profile({ appId: "com.demo", versionCode: "123", sdks: [] });
    const lines = formatAdSdkContextLines(resolveAdSdkContext(snapshot, empty));

    expect(lines.join("\n")).toContain("未识别到受支持的 SDK");
  });
});

describe("prompt 接入", () => {
  it("单步 prompt 分开表达静态名单与页面特征，且位于节点树之前", () => {
    const snapshot = buildSnapshot({
      versionCode: 123,
      nodes: [node(1, 0, attr({ name: "TextView", vid: "tt_splash_skip_btn" }))],
    });
    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: null,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      adSdkProfiles: [pangleManifest],
    });

    expect(prompt).toContain("应用 SDK 上下文");
    expect(prompt).toContain("导入清单（只代表应用包含该 SDK，不代表当前页面）");
    expect(prompt).toContain("pangle / 穿山甲");
    expect(prompt).toContain("当前页面命中");
    expect(prompt).toContain("不要仅凭 SDK 名单编造选择器");
    expect(prompt.indexOf("应用 SDK 上下文")).toBeLessThan(
      prompt.indexOf("节点树摘要："),
    );
  });

  it("不传档案且页面无 SDK 特征时 prompt 保持原样", () => {
    const snapshot = buildSnapshot({});
    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: null,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });

    expect(prompt).not.toContain("应用 SDK 上下文");
  });

  it("省略节点树的复制路径仍带 SDK 上下文", () => {
    const snapshot = buildSnapshot({
      versionCode: 123,
      nodes: [node(1, 0, attr({ name: "TextView", vid: "tt_splash_skip_btn" }))],
    });
    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: null,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      includeNodeTree: false,
      adSdkProfiles: [pangleManifest],
    });

    expect(prompt).not.toContain("节点树摘要：");
    expect(prompt).toContain("应用 SDK 上下文");
    expect(prompt).toContain("本 prompt 不再内嵌节点树");
  });

  it("多步流程逐步隔离应用背景", () => {
    const stepA = buildFlowStep(
      "step-a",
      buildSnapshot({ appId: "com.a", versionCode: 1 }),
    );
    const stepB = buildFlowStep(
      "step-b",
      buildSnapshot({ appId: "com.b", versionCode: 1 }),
    );
    const prompt = buildFlowHelpPrompt({
      flowName: "跨应用流程",
      steps: [stepA, stepB],
      adSdkProfiles: [
        profile({
          appId: "com.a",
          versionCode: "1",
          sdks: [
            {
              sdkId: "pangle",
              evidence: [evidence("com.byted.pangle.A", "com.byted.pangle")],
            },
          ],
        }),
        profile({
          appId: "com.b",
          versionCode: "1",
          sdks: [
            {
              sdkId: "kwad",
              evidence: [evidence("com.kwad.sdk.B", "com.kwad.sdk")],
            },
          ],
        }),
      ],
    });

    const [beforeB, afterB] = prompt.split("步骤 2：");
    expect(beforeB).toContain("- pangle / 穿山甲");
    expect(beforeB).not.toContain("kwad");
    expect(afterB).toContain("- kwad / 快手");
    expect(afterB).not.toContain("pangle");
  });
});

describe("riskScoring 不受静态清单影响", () => {
  function scoreTarget(targetNode: SnapshotNode) {
    const snapshot = buildSnapshot({
      versionCode: 123,
      nodes: [targetNode],
    });
    const target = snapshot.nodeById.get(targetNode.id) as NormalizedSnapshotNode;
    const plan = {
      kind: "simple" as const,
      selector: exactSelector("vid", targetNode.attr.vid ?? "", "TextView"),
    };
    const risk = scoreCandidate({
      baseScore: 50,
      snapshot,
      plan,
      rule: { key: 0, matches: [`TextView[vid="${targetNode.attr.vid}"]`] },
      validation: { hitCount: 1, clickNodes: [target], supportNodes: [] },
    });
    return { snapshot, risk };
  }

  it("只有静态 SDK 名单的普通页面，分数与无档案时相同", () => {
    const target = node(
      1,
      0,
      attr({
        name: "android.widget.TextView",
        vid: "tv_skip",
        text: "跳过",
        clickable: true,
        right: 100,
        bottom: 50,
        width: 100,
        height: 50,
      }),
    );
    const { snapshot, risk } = scoreTarget(target);

    // 档案确实关联上了，但评分函数完全不读档案。
    const context = resolveAdSdkContext(snapshot, pangleManifest);
    expect(context.manifest.map((group) => group.sdkId)).toEqual(["pangle"]);
    expect(risk.items.map((item) => item.label)).not.toContain("穿山甲跳过控件");

    const withoutProfile = scoreTarget(target).risk;
    expect(risk.finalScore).toBe(withoutProfile.finalScore);
    expect(risk.items).toEqual(withoutProfile.items);
  });

  it("档案存在时广告遮罩扣分仍然生效", () => {
    const target = node(
      1,
      0,
      attr({
        name: "android.widget.FrameLayout",
        vid: "tt_splash_click_shade",
        text: "跳过",
        clickable: true,
        right: 1080,
        bottom: 2000,
        width: 1080,
        height: 2000,
      }),
    );
    const { risk } = scoreTarget(target);
    const overlay = risk.items.find((item) => item.label === "广告遮罩热区");

    expect(overlay?.value).toBe(-90);
  });
});

function buildFlowStep(id: string, snapshot: ReturnType<typeof buildSnapshot>): FlowRuleStep {
  return {
    id,
    title: id,
    note: "",
    delayNote: "",
    ruleSettings: DEFAULT_RULE_SETTINGS,
    scenarioId: "splash",
    snapshot,
    pickResult: null,
    candidates: [],
    selectedCandidate: null,
  };
}
