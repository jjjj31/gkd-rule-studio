import { describe, expect, it } from "vitest";
import JSON5 from "json5";
import { AI_RULE_OUTPUT_CONTRACT, AI_RULE_OUTPUT_EXAMPLE } from "./aiRuleContract";
import {
  buildCustomScenarioPrompt,
  parseCustomScenario,
  resolveCustomScenarioSettings,
} from "./customScenario";
import { buildFlowHelpPrompt } from "./flowDraft";
import { analyzeClickableTarget, buildHelpPrompt } from "./helpPrompt";
import { validateGkdSelectorSyntax } from "./selectorAdapter";
import { validateAppRuleAgainstSnapshot } from "./selectorMatcher";
import { createRuleDraft, exactSelector } from "./selectorSerialize";
import { findSafeClickableAncestor } from "./visualTarget";
import { formatAuthoringFeedbackPrompt, classifyAuthoringFeedback } from "./authoringFeedback";
import { pickExistingNode, pickNodeAtPoint } from "./nodePicker";
import { normalizeSnapshot } from "./snapshotNormalize";
import type { FewShotHit } from "./fewShotRetrieval";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import type { FlowRuleStep } from "../types/flowDraft";
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

  it("publishes strict fastQuery contract and a valid two-candidate contrasting example", () => {
    expect(AI_RULE_OUTPUT_CONTRACT).toContain("均为非负整数（其中 actionMaximum >= 1）");
    expect(AI_RULE_OUTPUT_CONTRACT).toContain("fastQuery: true 严苛适用条件");
    expect(AI_RULE_OUTPUT_CONTRACT).toContain("WebView");

    const parsed = JSON5.parse(AI_RULE_OUTPUT_EXAMPLE) as {
      candidates: Array<{
        id: string;
        title: string;
        summary: string;
        risk: string;
        app: {
          id: string;
          name: string;
          groups: Array<{
            key: number;
            name: string;
            rules: Array<{
              key: number;
              matches: string[];
              fastQuery?: boolean;
              action?: string;
              actionDelay?: number;
            }>;
          }>;
        };
      }>;
    };
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0].id).toBe("candidate-a");
    expect(parsed.candidates[1].id).toBe("candidate-b");

    for (const candidate of parsed.candidates) {
      expect(candidate.app.id).toBeTruthy();
      expect(candidate.app.groups.length).toBeGreaterThan(0);
      for (const group of candidate.app.groups) {
        expect(Number.isInteger(group.key)).toBe(true);
        expect(group.rules.length).toBeGreaterThan(0);
        for (const rule of group.rules) {
          expect(rule.matches.length).toBeGreaterThan(0);
          expect(rule.actionDelay).toBeUndefined();
          for (const selector of rule.matches) {
            expect(validateGkdSelectorSyntax(selector)).toBeNull();
          }
        }
      }
    }

    expect(parsed.candidates[0].app.groups[0].rules[0].fastQuery).toBe(true);
    expect(parsed.candidates[1].app.groups[0].rules[0].fastQuery).toBeUndefined();
    expect(parsed.candidates[1].app.groups[0].rules[0].action).toBe("clickCenter");
    expect(parsed.candidates[1].app.groups[0].rules[0].matches.length).toBeGreaterThanOrEqual(2);
  });

  it("supports builtin audience trimming, removes coordinate attributes from allowlist, and keeps deep hierarchy metadata", () => {
    const nodes: SnapshotNode[] = [];
    for (let d = 0; d <= 14; d += 1) {
      nodes.push(
        node(
          d,
          d === 0 ? -1 : d - 1,
          attr({
            name: d === 14 ? "android.widget.ImageView" : "android.widget.FrameLayout",
            clickable: d === 14,
            depth: d,
            index: d === 14 ? 2 : 0,
            left: d === 14 ? 920 : 0,
            top: d === 14 ? 100 : 0,
            right: d === 14 ? 1000 : 1080,
            bottom: d === 14 ? 180 : 1920,
            childCount: d === 14 ? 0 : 1,
            desc: d === 14 ? "关闭弹窗" : null,
          }),
        ),
      );
    }
    const snapshot = normalizeSnapshot(
      {
        id: 10,
        appId: "com.deep.demo",
        activityId: "com.deep.demo.MainActivity",
        screenWidth: 1080,
        screenHeight: 1920,
        isLandscape: false,
        nodes,
      },
      "",
      "deep",
    );
    const pick = pickExistingNode(snapshot, snapshot.nodeById.get(14)!);

    const builtinPrompt = buildHelpPrompt({
      snapshot,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
      audience: "builtin",
    });

    expect(builtinPrompt).not.toContain("字段类型硬约束");
    expect(builtinPrompt).not.toContain("完整 JSON5 示例");
    expect(builtinPrompt).not.toContain("测试反馈格式");
    expect(builtinPrompt).toContain("5 步规则排查思路");
    expect(builtinPrompt).toContain("d=14 p=#13 idx=2 80x80");
    // 属性白名单不再列出 left/top/right/bottom
    expect(builtinPrompt).not.toContain("index、depth、left、top、right、bottom");
    expect(builtinPrompt).toContain("width、height（width/height 仅作次级尺寸过滤）");
  });

  it("warns against lifting to oversized/hot-area clickable ancestors and emits desc hint without fastQuery", () => {
    // 场景 A：外层可点击容器是全屏广告热区，严禁 @ 抬升，要求 clickCenter
    const hotAreaSnapshot = normalizeSnapshot(
      {
        id: 11,
        appId: "com.ad.demo",
        activityId: "com.ad.demo.SplashActivity",
        screenWidth: 1080,
        screenHeight: 1920,
        isLandscape: false,
        nodes: [
          node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
          node(
            1,
            0,
            attr({
              name: "android.widget.FrameLayout",
              vid: "ad_click_hotArea",
              clickable: true,
              left: 0,
              top: 0,
              right: 1080,
              bottom: 1920,
              childCount: 1,
              depth: 1,
            }),
          ),
          node(
            2,
            1,
            attr({
              name: "android.widget.TextView",
              text: "跳过 3s",
              clickable: false,
              left: 900,
              top: 100,
              right: 1040,
              bottom: 160,
              depth: 2,
            }),
          ),
        ],
      },
      "",
      "hot-area",
    );
    const hotPick = pickExistingNode(hotAreaSnapshot, hotAreaSnapshot.nodeById.get(2)!);
    const hotPrompt = buildHelpPrompt({
      snapshot: hotAreaSnapshot,
      pickResult: hotPick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });
    expect(hotPrompt).toContain("严禁使用 @ 抬升点击该外层容器");
    expect(hotPrompt).toContain('action: "clickCenter"');
    expect(hotPrompt).toContain("同屏属性冲突与全屏遮罩告警：");
    expect(hotPrompt).toContain("全屏遮罩/热区层：#1 FrameLayout");

    // 场景 B：安全可点击父容器 + 无 text 仅有 desc 的不可点击子节点
    const descSnapshot = normalizeSnapshot(
      {
        id: 12,
        appId: "com.desc.demo",
        activityId: "com.desc.demo.MainActivity",
        screenWidth: 1080,
        screenHeight: 1920,
        isLandscape: false,
        nodes: [
          node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 2 })),
          node(
            1,
            0,
            attr({
              name: "android.widget.LinearLayout",
              clickable: true,
              left: 900,
              top: 120,
              right: 1020,
              bottom: 200,
              childCount: 1,
              depth: 1,
            }),
          ),
          node(
            2,
            1,
            attr({
              name: "android.widget.ImageView",
              text: null,
              desc: "关闭广告",
              clickable: false,
              left: 920,
              top: 130,
              right: 1000,
              bottom: 190,
              depth: 2,
            }),
          ),
          node(
            3,
            0,
            attr({
              name: "android.widget.ImageView",
              text: null,
              desc: "关闭广告",
              clickable: true,
              left: 920,
              top: 800,
              right: 1000,
              bottom: 860,
              depth: 1,
            }),
          ),
        ],
      },
      "",
      "desc-only",
    );
    const descPick = pickExistingNode(descSnapshot, descSnapshot.nodeById.get(2)!);
    const descPrompt = buildHelpPrompt({
      snapshot: descSnapshot,
      pickResult: descPick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });
    expect(descPrompt).toContain('[desc="关闭广告"]');
    expect(descPrompt).toContain("禁止开启 fastQuery: true");
    expect(descPrompt).toContain("同屏属性冲突：[desc=\"关闭广告\"]");
    expect(descPrompt).toContain("#3 ImageView");
  });

  it("prioritizes same-popup business text anchors over bottom navigation labels", () => {
    const raw: RawGkdSnapshot = {
      id: 13,
      appId: "com.popup.demo",
      activityId: "com.popup.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      nodes: [
        node(0, -1, attr({ name: "android.widget.FrameLayout", bottom: 2400, childCount: 2 })),
        node(
          1,
          0,
          attr({
            name: "android.widget.LinearLayout",
            left: 0,
            top: 2220,
            right: 1080,
            bottom: 2400,
            depth: 1,
            childCount: 2,
          }),
        ),
        node(
          2,
          1,
          attr({
            name: "android.widget.TextView",
            text: "首页推荐",
            left: 40,
            top: 2240,
            right: 200,
            bottom: 2360,
            depth: 2,
          }),
        ),
        node(
          3,
          1,
          attr({
            name: "android.widget.TextView",
            text: "我的空间",
            left: 840,
            top: 2240,
            right: 1020,
            bottom: 2360,
            depth: 2,
          }),
        ),
        node(
          4,
          0,
          attr({
            name: "android.widget.FrameLayout",
            left: 100,
            top: 600,
            right: 980,
            bottom: 1400,
            depth: 1,
            childCount: 2,
          }),
        ),
        node(
          5,
          4,
          attr({
            name: "android.widget.TextView",
            text: "升级会员立享免广告",
            left: 200,
            top: 700,
            right: 880,
            bottom: 780,
            depth: 2,
          }),
        ),
        node(
          6,
          4,
          attr({
            name: "android.widget.ImageView",
            clickable: true,
            left: 900,
            top: 620,
            right: 960,
            bottom: 680,
            depth: 2,
          }),
        ),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "", "popup");
    const pick = pickExistingNode(snapshot, snapshot.nodeById.get(6)!);
    const prompt = buildHelpPrompt({
      snapshot,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });
    const anchorSection = prompt.split("同屏业务文案锚点参考")[1]?.split("\n\n")[0] ?? "";
    const popupIdx = anchorSection.indexOf("升级会员立享免广告");
    const navIdx = anchorSection.indexOf("首页推荐");
    expect(popupIdx).toBeGreaterThan(-1);
    expect(navIdx === -1 || popupIdx < navIdx).toBe(true);
  });

  it("fixes flowDraft tree pruning, builtin audience rules, dynamic activity warning, and clickCenter fallback", () => {
    const nodes: SnapshotNode[] = [
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 160 })),
    ];
    for (let i = 1; i <= 150; i += 1) {
      nodes.push(
        node(
          i,
          0,
          attr({
            name: "android.view.View",
            left: 0,
            top: i * 8,
            right: 100,
            bottom: i * 8 + 6,
            depth: 1,
            index: i - 1,
          }),
        ),
      );
    }
    // 目标在后段节点中，其父节点 #151 有叔节点 #155
    nodes.push(
      node(
        151,
        0,
        attr({
          name: "android.widget.LinearLayout",
          vid: "popup_box",
          left: 100,
          top: 300,
          right: 900,
          bottom: 700,
          depth: 1,
          index: 150,
          childCount: 2,
        }),
      ),
      node(
        152,
        151,
        attr({
          name: "android.widget.TextView",
          text: "关闭按钮",
          clickable: false,
          left: 800,
          top: 320,
          right: 880,
          bottom: 380,
          depth: 2,
          index: 0,
        }),
      ),
      node(
        153,
        151,
        attr({
          name: "android.widget.TextView",
          text: "广告弹窗标题",
          clickable: false,
          left: 140,
          top: 320,
          right: 500,
          bottom: 380,
          depth: 2,
          index: 1,
        }),
      ),
    );

    const snapshot = normalizeSnapshot(
      {
        id: 20,
        appId: "com.flow.demo",
        activityId: "com.flow.demo.InterstitialView_4012003",
        screenWidth: 1080,
        screenHeight: 1920,
        isLandscape: false,
        nodes,
      },
      "",
      "flow-large",
    );
    const pick = pickExistingNode(snapshot, snapshot.nodeById.get(152)!);
    const step: FlowRuleStep = {
      id: "step-1",
      title: "关广告",
      note: "",
      delayNote: "",
      ruleSettings: DEFAULT_RULE_SETTINGS,
      scenarioId: "fullscreen",
      snapshot,
      pickResult: pick,
      candidates: [],
      selectedCandidate: null,
    };

    const prompt = buildFlowHelpPrompt({
      flowName: "大树多步测试",
      steps: [step],
      audience: "builtin",
    });

    expect(prompt).not.toContain("先向用户追问");
    expect(prompt).not.toContain("测试反馈格式");
    expect(prompt).toContain("带动态数字/匿名后缀，严禁写死进 activityIds");
    expect(prompt).toContain('action: "clickCenter"');
    expect(prompt).toContain('本步真实 vid 白名单: vid="popup_box"');
    expect(prompt).toContain("fastQuery: true 严苛约束");
    expect(prompt).toContain("严禁默认添加 actionDelay");
    // 关键：树裁剪后不能因为全树灌入把目标 #152 挤掉
    expect(prompt).toContain("#152 TextView");
    expect(prompt).toContain("#153 TextView");
    expect(prompt).toContain("已省略");
  });

  it("updates customScenario prompt defaults, rejects dynamic current activity, and validates action/fences/array activityIds", () => {
    const dynamicSnapshot = buildSnapshot("com.demo.InterstitialView_4012003");
    const prompt = buildCustomScenarioPrompt(dynamicSnapshot);
    expect(prompt).toContain("actionDelay: null");
    expect(prompt).toContain("forcedTime: null");
    expect(prompt).toContain("matchRoot: null");
    expect(prompt).not.toContain("actionDelay: 2500");
    expect(prompt).toContain("带有动态后缀");

    const parsed = parseCustomScenario(
      `\`\`\`javascript
      {
        name: '动态页弹窗',
        groupName: '全屏广告',
        activityIds: ['current'],
        action: 'notARealAction',
        actionDelay: null,
        forcedTime: null,
        matchRoot: null,
      }
      \`\`\``,
      dynamicSnapshot,
      "",
    );
    expect(parsed.activityIdsMode).toBe("current");
    expect(parsed.settings.action).toBeUndefined();

    const resolvedDynamic = resolveCustomScenarioSettings(parsed, dynamicSnapshot);
    expect(resolvedDynamic.activityIds).toBe("");

    const parsedArrayLiteral = parseCustomScenario(
      `\`\`\`js
      {
        name: '多页面弹窗',
        groupName: '局部广告',
        activityIds: ['com.demo.PageA', 'com.demo.PageB'],
        action: 'clickCenter',
      }
      \`\`\``,
      null,
      "",
    );
    expect(parsedArrayLiteral.activityIdsMode).toBe("literal");
    expect(parsedArrayLiteral.settings.activityIds).toBe(
      "com.demo.PageA, com.demo.PageB",
    );
    expect(parsedArrayLiteral.settings.action).toBe("clickCenter");
  });

  it("publishes first-block fastQuery rule across contract, single prompt, and external flow prompt with full contract/self-check", () => {
    const fastQueryClause = "位于最右侧节点首个独立 [...] 中，不与其它属性用 && 混写";
    expect(AI_RULE_OUTPUT_CONTRACT).toContain(fastQueryClause);

    const snapshot = buildSnapshot("com.demo.MainActivity");
    const pick = pickNodeAtPoint(snapshot, { x: 150, y: 340 })!;

    const singlePrompt = buildHelpPrompt({
      snapshot,
      pickResult: pick,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });
    expect(singlePrompt).toContain(fastQueryClause);

    const step: FlowRuleStep = {
      id: "step-1",
      title: "点取消",
      note: "",
      delayNote: "",
      ruleSettings: DEFAULT_RULE_SETTINGS,
      scenarioId: "function",
      snapshot,
      pickResult: pick,
      candidates: [],
      selectedCandidate: null,
    };
    const externalFlowPrompt = buildFlowHelpPrompt({
      flowName: "外部多步流程",
      steps: [step],
      audience: "external",
    });
    expect(externalFlowPrompt).toContain(fastQueryClause);
    expect(externalFlowPrompt).toContain("- 用户点击的目标节点：");
    expect(externalFlowPrompt).toContain(AI_RULE_OUTPUT_CONTRACT);
    expect(externalFlowPrompt).toContain(AI_RULE_OUTPUT_EXAMPLE);
    expect(externalFlowPrompt).toContain("输出前自检");
  });

  it("keeps analyzeClickableTarget and findSafeClickableAncestor aligned on 11% generic and 6% multi-action containers", () => {
    // 场景 1：11% 无信号容器（1080 * 1920 = 2,073,600; 570 * 400 = 228,000 ≈ 11.0%）
    const elevenPercentSnap = normalizeSnapshot(
      {
        id: 30,
        appId: "com.demo",
        activityId: "com.demo.MainActivity",
        screenWidth: 1080,
        screenHeight: 1920,
        isLandscape: false,
        nodes: [
          node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
          node(
            1,
            0,
            attr({
              name: "android.widget.LinearLayout",
              clickable: true,
              left: 0,
              top: 0,
              right: 570,
              bottom: 400,
              childCount: 1,
              depth: 1,
            }),
          ),
          node(
            2,
            1,
            attr({
              name: "android.widget.TextView",
              text: "关闭",
              clickable: false,
              left: 100,
              top: 100,
              right: 200,
              bottom: 160,
              depth: 2,
            }),
          ),
        ],
      },
      "",
      "eleven-percent",
    );
    const pick1 = pickExistingNode(elevenPercentSnap, elevenPercentSnap.nodeById.get(2)!);
    expect(findSafeClickableAncestor(elevenPercentSnap, pick1.pickedNode)).toBeNull();
    const analysis1 = analyzeClickableTarget(elevenPercentSnap, pick1);
    expect(analysis1.safeClickableTarget).toBeNull();
    expect(analysis1.unsafeClickableCandidate?.node.id).toBe(1);
    const prompt1 = buildHelpPrompt({
      snapshot: elevenPercentSnap,
      pickResult: pick1,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });
    expect(prompt1).toContain("严禁使用 @ 抬升点击该外层容器");
    expect(prompt1).toContain('action: "clickCenter"');

    // 场景 2：6% 多动作按钮栏（“取消”+“立即下载”，620 * 200 = 124,000 ≈ 6.0%）
    const multiActionSnap = normalizeSnapshot(
      {
        id: 31,
        appId: "com.demo",
        activityId: "com.demo.MainActivity",
        screenWidth: 1080,
        screenHeight: 1920,
        isLandscape: false,
        nodes: [
          node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
          node(
            1,
            0,
            attr({
              name: "android.widget.LinearLayout",
              clickable: true,
              left: 100,
              top: 500,
              right: 720,
              bottom: 700,
              childCount: 2,
              depth: 1,
            }),
          ),
          node(
            2,
            1,
            attr({
              name: "android.widget.TextView",
              text: "取消",
              clickable: false,
              left: 120,
              top: 540,
              right: 300,
              bottom: 660,
              index: 0,
              depth: 2,
            }),
          ),
          node(
            3,
            1,
            attr({
              name: "android.widget.TextView",
              text: "立即下载",
              clickable: false,
              left: 400,
              top: 540,
              right: 700,
              bottom: 660,
              index: 1,
              depth: 2,
            }),
          ),
        ],
      },
      "",
      "multi-action-bar",
    );
    const pick2 = pickExistingNode(multiActionSnap, multiActionSnap.nodeById.get(2)!);
    expect(findSafeClickableAncestor(multiActionSnap, pick2.pickedNode)).toBeNull();
    const analysis2 = analyzeClickableTarget(multiActionSnap, pick2);
    expect(analysis2.safeClickableTarget).toBeNull();
    expect(analysis2.unsafeClickableCandidate?.node.id).toBe(1);
    const prompt2 = buildHelpPrompt({
      snapshot: multiActionSnap,
      pickResult: pick2,
      ruleSettings: DEFAULT_RULE_SETTINGS,
    });
    expect(prompt2).toContain("严禁使用 @ 抬升点击该外层容器");
    expect(prompt2).toContain('action: "clickCenter"');
  });

  it("flows multi-activity custom scenario through createRuleDraft into validateAppRuleAgainstSnapshot", () => {
    const scenario = parseCustomScenario(
      `{
        name: '多页面弹窗',
        groupName: '局部广告',
        activityIds: ['com.demo.PageA', 'com.demo.PageB'],
      }`,
      null,
      "",
    );
    const settings = resolveCustomScenarioSettings(scenario, null);
    const rule = createRuleDraft(
      { kind: "simple", selector: exactSelector("vid", "cancel") },
      settings,
    );
    expect(rule.activityIds).toEqual(["com.demo.PageA", "com.demo.PageB"]);

    const app = {
      id: "com.demo",
      name: "Demo",
      groups: [{ key: 0, name: settings.groupName, rules: [rule] }],
    };

    const [hitB] = validateAppRuleAgainstSnapshot(buildSnapshot("com.demo.PageB"), app);
    expect(hitB).toMatchObject({ status: "satisfied", hitCount: 1 });

    const [missOther] = validateAppRuleAgainstSnapshot(
      buildSnapshot("com.demo.OtherActivity"),
      app,
    );
    expect(missOther).toMatchObject({
      status: "unsatisfied",
      hitCount: 0,
      failureReason: "activity_mismatch",
    });
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
