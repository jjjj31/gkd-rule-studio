import { describe, expect, it } from "vitest";
import {
  canSelectorFastQuery,
  matchGkdSelectorString,
} from "./selectorAdapter";
import { normalizeSnapshot } from "./snapshotNormalize";
import {
  validateAiCandidateAgainstSnapshot,
  validateAppRuleAgainstSnapshot,
} from "./selectorMatcher";
import type { AiRuleCandidate } from "./aiModel";
import type { AppRuleDraft } from "../types/ruleDraft";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

/**
 * 测试 fixture：手搭一棵小树，覆盖 GKD selector 各种关系/运算符写法。
 *
 *   0: FrameLayout root (width=1080)
 *     1: FrameLayout (width=200)
 *       2: TextView "跳过" (width=80)
 *       3: Button "关闭" (width=120, clickable)
 *       4: View "广告" (width=160)
 *     5: FrameLayout (width=300)
 *       6: TextView "A" (index 0)
 *       7: TextView "X" (index 1)
 *       8: TextView "Y" (index 2)
 *       9: TextView "B" (index 3)
 *     10: FrameLayout (width=400)
 *       11: TextView "P" (index 0)
 *       12: TextView "Q" (index 1)
 *     13: LinearLayout (width=200)
 *       14: Button "取消" (id=.../_skip, width=100, clickable)
 *     15: LinearLayout (width=200)
 *       16: FrameLayout (width=100)
 *         17: TextView "ChainEnd" (width=50)
 */
function buildFixture(): ParsedGkdSnapshot {
  const nodes: SnapshotNode[] = [
    node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 5, right: 1080, bottom: 2400 })),
    node(1, 0, attr({ name: "android.widget.FrameLayout", childCount: 3, right: 200, bottom: 100, width: 200, height: 100, index: 0 })),
    node(2, 1, attr({ name: "android.widget.TextView", text: "跳过", right: 80, bottom: 40, width: 80, height: 40, depth: 2 })),
    node(3, 1, attr({ name: "android.widget.Button", text: "关闭", clickable: true, right: 200, bottom: 100, width: 120, height: 60, index: 0, depth: 2 })),
    node(4, 1, attr({ name: "android.view.View", text: "广告", right: 160, bottom: 80, width: 160, height: 80, index: 1, depth: 2 })),
    node(5, 0, attr({ name: "android.widget.FrameLayout", childCount: 4, right: 300, bottom: 200, width: 300, height: 200, index: 1 })),
    node(6, 5, attr({ name: "android.widget.TextView", text: "A", right: 50, bottom: 50, width: 50, height: 50, index: 0, depth: 2 })),
    node(7, 5, attr({ name: "android.widget.TextView", text: "X", right: 50, bottom: 50, width: 50, height: 50, index: 1, depth: 2 })),
    node(8, 5, attr({ name: "android.widget.TextView", text: "Y", right: 50, bottom: 50, width: 50, height: 50, index: 2, depth: 2 })),
    node(9, 5, attr({ name: "android.widget.TextView", text: "B", right: 50, bottom: 50, width: 50, height: 50, index: 3, depth: 2 })),
    node(10, 0, attr({ name: "android.widget.FrameLayout", childCount: 2, right: 400, bottom: 200, width: 400, height: 200, index: 2 })),
    node(11, 10, attr({ name: "android.widget.TextView", text: "P", right: 50, bottom: 50, width: 50, height: 50, index: 0, depth: 2 })),
    node(12, 10, attr({ name: "android.widget.TextView", text: "Q", right: 50, bottom: 50, width: 50, height: 50, index: 1, depth: 2 })),
    node(13, 0, attr({ name: "android.widget.LinearLayout", childCount: 1, right: 200, bottom: 100, width: 200, height: 100, index: 3 })),
    node(14, 13, attr({ name: "android.widget.Button", id: "com.demo:id/btn_skip", text: "取消", clickable: true, right: 100, bottom: 50, width: 100, height: 50, depth: 2 })),
    node(15, 0, attr({ name: "android.widget.LinearLayout", childCount: 1, right: 200, bottom: 100, width: 200, height: 100, index: 4 })),
    node(16, 15, attr({ name: "android.widget.FrameLayout", childCount: 1, right: 100, bottom: 50, width: 100, height: 50, depth: 2 })),
    node(17, 16, attr({ name: "android.widget.TextView", text: "ChainEnd", right: 50, bottom: 25, width: 50, height: 25, depth: 3 })),
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

function ids(nodes: NormalizedSnapshotNode[]): number[] {
  return nodes.map((n) => n.id);
}

function makeCandidate(matches: string[]): AiRuleCandidate {
  return {
    id: "test",
    title: "test",
    summary: "",
    risk: "",
    app: {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 1,
          name: "g",
          rules: [{ key: 1, matches }],
        },
      ],
    },
  };
}

function run(snap: ParsedGkdSnapshot, matches: string[]) {
  return validateAiCandidateAgainstSnapshot(makeCandidate(matches), snap);
}

function makeApp(matches: string[], extra: Partial<AppRuleDraft["groups"][number]> = {}): AppRuleDraft {
  return {
    id: "com.demo",
    name: "Demo",
    groups: [{ key: 1, name: "g", rules: [{ key: 1, matches }], ...extra }],
  };
}

function appWithRule(
  rule: Partial<AppRuleDraft["groups"][number]["rules"][number]>,
  group: Partial<AppRuleDraft["groups"][number]> = {},
): AppRuleDraft {
  return {
    id: "com.demo",
    name: "Demo",
    groups: [
      {
        key: 1,
        name: "g",
        ...group,
        rules: [{ key: 1, matches: [], ...rule }],
      },
    ],
  };
}

describe("official GKD 1.13+ selector engine", () => {
  it.each([
    ['[text="A"]', [6]],
    ['[text~="跳.*"]', [2]],
    ['[text.length=2][text="跳过"]', [2]],
    ['[getChild(0).text="跳过"]', [1]],
    ['[text="跳过"][parent.childCount=3]', [2]],
    ['[text.indexOf("跳")=0]', [2]],
    ['LinearLayout @FrameLayout TextView[text="ChainEnd"]', [16]],
  ])("matches %s using the 0.6.x engine", (expression, expected) => {
    const snapshot = buildFixture();
    const result = matchGkdSelectorString(snapshot, expression as string);
    expect(result, result.unparsedReason).toMatchObject({ unparsed: false, clickIds: expected });
  });

  it("retains trace support nodes and rejects invalid selectors", () => {
    const snapshot = buildFixture();
    const trace = matchGkdSelectorString(snapshot, 'LinearLayout @FrameLayout TextView[text="ChainEnd"]');
    expect(trace.supportIds.sort()).toEqual([15, 17]);
    expect(matchGkdSelectorString(snapshot, "not a selector ???")).toMatchObject({ unparsed: true, clickIds: [] });
    const [rule] = validateAppRuleAgainstSnapshot(snapshot, makeApp(['[text="P"]', '[text="A"]']));
    expect(ids(rule.clickNodes)).toEqual([6]);
    expect(ids(rule.supportNodes)).toEqual([11]);
  });
});

describe("selectorMatcher AI 路径（@gkd-kit/selector）", () => {
  it("matches 全部成立时只点击最后一项，前项作为支持节点", () => {
    const values = validateAppRuleAgainstSnapshot(
      buildFixture(),
      makeApp([`[text="P"]`, `[text="A"]`]),
    );

    expect(values).toHaveLength(1);
    expect(ids(values[0].clickNodes)).toEqual([6]);
    expect(ids(values[0].supportNodes)).toEqual([11]);
    expect(values[0]).toMatchObject({ status: "satisfied", hitCount: 1 });
  });

  it("显式 @ 决定点击目标，同一选择器链的其他节点作为支持节点", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      makeApp([`LinearLayout @FrameLayout TextView[text="ChainEnd"]`]),
    );

    expect(value).toMatchObject({ status: "satisfied", hitCount: 1 });
    expect(ids(value.clickNodes)).toEqual([16]);
    expect(ids(value.supportNodes).sort()).toEqual([15, 17]);
  });

  it("非法必需表达式不会由其他合法表达式部分成功", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      makeApp([`TextView[text="跳过"]`, `not a selector ???`]),
    );

    expect(value).toMatchObject({ status: "invalid", hitCount: 0 });
    expect(value.clickNodes).toEqual([]);
    expect(value.unparsedMatches).toEqual([`not a selector ???`]);
  });

  it("无法确认的版本条件明确标记为 partial", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      appWithRule({
        matches: [`[text="A"]`],
        versionName: { include: "1.2" },
      } as Partial<AppRuleDraft["groups"][number]["rules"][number]>),
    );

    expect(value).toMatchObject({ status: "partial", hitCount: 0 });
    expect(value.diagnostics?.[0]).toContain("版本范围条件");
  });

  it("继承的组版本码范围保留原文并标记 partial", () => {
    const app = appWithRule(
      { matches: [`[text="A"]`] },
      { versionCodes: [1, 2, 3] },
    );
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      app,
    );

    expect(value).toMatchObject({ status: "partial", hitCount: 0 });
    expect(value.diagnostics?.[0]).toContain("版本范围条件");
    expect(app.groups[0].versionCodes).toEqual([1, 2, 3]);
  });

  it("规则级排除版本名保留原文并标记 partial", () => {
    const app = appWithRule({
      matches: [`[text="A"]`],
      excludeVersionNames: ["1.0", "1.1"],
    });
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      app,
    );

    expect(value).toMatchObject({ status: "partial", hitCount: 0 });
    expect(value.diagnostics?.[0]).toContain("版本范围条件");
    expect(app.groups[0].rules[0].excludeVersionNames).toEqual(["1.0", "1.1"]);
  });

  it("禁用组和规则不贡献可执行目标", () => {
    const disabledGroup = appWithRule(
      { matches: [`[text="A"]`] },
      { enable: false },
    );
    const disabledRule = appWithRule({ matches: [`[text="A"]`], enable: false });

    const [groupValue] = validateAppRuleAgainstSnapshot(buildFixture(), disabledGroup);
    const [ruleValue] = validateAppRuleAgainstSnapshot(buildFixture(), disabledRule);

    expect(groupValue).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(ruleValue).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(ruleValue.diagnostics?.[0]).toContain("enable");
  });

  it("无法识别的 enable 值明确标记 partial，不当作启用", () => {
    const app = appWithRule({ matches: [`[text="A"]`] });
    (app.groups[0] as unknown as Record<string, unknown>).enable = "false";

    const [value] = validateAppRuleAgainstSnapshot(buildFixture(), app);

    expect(value).toMatchObject({ status: "partial", hitCount: 0 });
    expect(value.diagnostics?.[0]).toContain("enable");
  });

  it("AI 多规则聚合时 partial 不暴露部分点击目标", () => {
    const app = appWithRule({ matches: [`[text="A"]`] });
    app.groups[0].rules.push({
      key: 2,
      matches: [`[text="P"]`],
      versionName: { include: "1.2" },
    } as AppRuleDraft["groups"][number]["rules"][number]);

    const value = validateAiCandidateAgainstSnapshot(
      { ...makeCandidate([]), app },
      buildFixture(),
    );

    expect(value).toMatchObject({ status: "partial", hitCount: 0 });
    expect(value.clickNodes).toEqual([]);
  });

  it("独立规则 A 命中、B 不命中时保留 A 的点击目标", () => {
    const app = appWithRule({ matches: [`[text="A"]`] });
    app.groups[0].rules.push({ key: 2, matches: [`[text="不存在"]`] });

    const value = validateAiCandidateAgainstSnapshot(
      { ...makeCandidate([]), app },
      buildFixture(),
    );

    expect(value).toMatchObject({ status: "satisfied", hitCount: 1 });
    expect(ids(value.clickNodes)).toEqual([6]);
  });

  it("同一规则的 matches 没有全部成立时不能借独立规则聚合绕过 AND", () => {
    const app = appWithRule({ matches: [`[text="A"]`, `[text="不存在"]`] });

    const value = validateAiCandidateAgainstSnapshot(
      { ...makeCandidate([]), app },
      buildFixture(),
    );

    expect(value).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(value.clickNodes).toEqual([]);
  });

  it("规则组 key 不参与规则去重，每条规则都有独立验证结果", () => {
    const app = appWithRule({ matches: [`[text="A"]`] });
    app.groups.push({
      key: 1,
      name: "another",
      rules: [{ key: 0, matches: [`[text="P"]`] }],
    });

    const values = validateAppRuleAgainstSnapshot(buildFixture(), app);

    expect(values.map((value) => ids(value.clickNodes))).toEqual([[6], [11]]);
    expect(values.every((value) => value.status === "satisfied")).toBe(true);
  });

  it("空 App 规则给出明确的 invalid 结果", () => {
    const [value] = validateAppRuleAgainstSnapshot(buildFixture(), {
      id: "com.demo",
      name: "Demo",
      groups: [],
    });

    expect(value).toMatchObject({ status: "invalid", hitCount: 0 });
    expect(value.diagnostics?.[0]).toContain("不包含任何规则");
  });

  it("缺少任一必需上下文时不把末项目标显示为可执行", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      makeApp([`[text="不存在"]`, `[text="A"]`]),
    );

    expect(value).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(ids(value.clickNodes)).toEqual([]);
    expect(value.diagnostics?.[0]).toContain("必需上下文未命中");
  });

  it("末项目标缺失时即使上下文存在也不可执行", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      makeApp([`[text="P"]`, `[text="不存在"]`]),
    );

    expect(value).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(ids(value.clickNodes)).toEqual([]);
    expect(ids(value.supportNodes)).toEqual([11]);
  });

  it("anyMatches 任一分支命中即可，但点击目标仍是 matches 末项", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      appWithRule({ matches: [`[text="A"]`], anyMatches: [`[text="P"]`, `[text="不存在"]`] }),
    );

    expect(value).toMatchObject({ status: "satisfied", hitCount: 1 });
    expect(ids(value.clickNodes)).toEqual([6]);
  });

  it("anyMatches 全部不命中时否决规则", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      appWithRule({ matches: [`[text="A"]`], anyMatches: [`[text="不存在"]`] }),
    );

    expect(value).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(ids(value.clickNodes)).toEqual([]);
  });

  it("anyMatches 同时有合法命中与非法分支时不暴露可执行目标", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      appWithRule({
        matches: [`[text="A"]`],
        anyMatches: [`[text="P"]`, `not a selector ???`],
      }),
    );

    expect(value).toMatchObject({ status: "partial", hitCount: 0 });
    expect(value.clickNodes).toEqual([]);
    expect(value.unparsedMatches).toEqual([`not a selector ???`]);
  });

  it("excludeMatches 任一命中即否决规则", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      appWithRule({ matches: [`[text="A"]`], excludeMatches: [`[text="P"]`] }),
    );

    expect(value).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(value.excludedMatches).toEqual([`[text="P"]`]);
  });

  it("排除条件无法完整验证时不暴露可执行目标", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      appWithRule({
        matches: [`[text="A"]`],
        excludeMatches: [`not a selector ???`],
      }),
    );

    expect(value).toMatchObject({ status: "partial", hitCount: 0 });
    expect(value.clickNodes).toEqual([]);
  });

  it("excludeAllMatches 只有全部命中时才否决规则", () => {
    const snap = buildFixture();
    const [partialHit] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({
        matches: [`[text="A"]`],
        excludeAllMatches: [`[text="P"]`, `[text="不存在"]`],
      }),
    );
    const [allHit] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({
        matches: [`[text="A"]`],
        excludeAllMatches: [`[text="P"]`, `[text="Q"]`],
      }),
    );

    expect(partialHit).toMatchObject({ status: "satisfied", hitCount: 1 });
    expect(allHit).toMatchObject({ status: "unsatisfied", hitCount: 0 });
  });

  it("规则组 activityIds 被继承，规则空数组可覆盖为全部界面", () => {
    const snap = buildFixture();
    const [inherited] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="A"]`] }, { activityIds: ".OtherActivity" }),
    );
    const [overridden] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule(
        { matches: [`[text="A"]`], activityIds: [] },
        { activityIds: ".OtherActivity" },
      ),
    );

    expect(inherited.status).toBe("unsatisfied");
    expect(overridden).toMatchObject({ status: "satisfied", hitCount: 1 });
  });

  it("excludeActivityIds 从规则组继承并优先于 activityIds", () => {
    const [value] = validateAppRuleAgainstSnapshot(
      buildFixture(),
      appWithRule(
        { matches: [`[text="A"]`], activityIds: ".MainActivity" },
        { excludeActivityIds: ".MainActivity" },
      ),
    );

    expect(value).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(value.diagnostics?.[0]).toContain("Activity 被排除");
  });
  it("*[text=...] 通配符按任意类型命中", () => {
    const snap = buildFixture();
    const v = run(snap, [`*[text="跳过"]`]);
    expect(ids(v.clickNodes)).toEqual([2]);
    expect(v.unparsedMatches).toBeUndefined();
  });

  it("TextView[text=...] 只命中指定类型", () => {
    const snap = buildFixture();
    const v = run(snap, [`TextView[text="跳过"]`]);
    expect(ids(v.clickNodes)).toEqual([2]);
  });

  it("TextView[text^=...] 命中以指定串开头", () => {
    const snap = buildFixture();
    const v = run(snap, [`TextView[text^="跳过"]`]);
    expect(ids(v.clickNodes)).toEqual([2]);
  });

  it("[id$='_skip'] 命中以 _skip 结尾", () => {
    const snap = buildFixture();
    const v = run(snap, [`[id$="_skip"]`]);
    expect(ids(v.clickNodes)).toEqual([14]);
  });

  it("[text!='广告'] 命中 text 不是广告的节点", () => {
    const snap = buildFixture();
    const v = run(snap, [`[text!="广告"]`]);
    const hitIds = ids(v.clickNodes);
    expect(hitIds).not.toContain(4);
    expect(hitIds).toContain(2);
    expect(hitIds).toContain(6);
  });

  it("[width>=100] 命中 width 不小于 100", () => {
    const snap = buildFixture();
    const v = run(snap, [`[width>=100]`]);
    // KMP 的 querySelectorAllContextArray 不含根节点（标准 CSS 行为）；
    // 手写解析器之前多算 0 是 bug，这里与 gkd-kit/inspect 行为一致
    expect(ids(v.clickNodes)).toEqual([1, 3, 4, 5, 10, 13, 14, 15, 16]);
  });

  it("[text='A'] +3 [text='B'] 兄弟距离 3 命中 B（默认末段 = 点击目标）", () => {
    const snap = buildFixture();
    const v = run(snap, [`[text="A"] +3 [text="B"]`]);
    expect(ids(v.clickNodes)).toEqual([9]);
  });

  it("[text='P'] + [text='Q'] 单独 + 等价 +1 命中相邻兄弟 Q", () => {
    const snap = buildFixture();
    const v = run(snap, [`[text="P"] + [text="Q"]`]);
    expect(ids(v.clickNodes)).toEqual([12]);
  });

  it("FrameLayout > Button[text='关闭'] 直系父-子命中（默认末段 = Button）", () => {
    const snap = buildFixture();
    const v = run(snap, [`FrameLayout > Button[text="关闭"]`]);
    expect(ids(v.clickNodes)).toEqual([3]);
  });

  it("@[text='取消'] < * 父-子反向，点击目标是 @ 段 [text='取消']", () => {
    const snap = buildFixture();
    const v = run(snap, [`@[text="取消"] < *`]);
    expect(ids(v.clickNodes)).toEqual([14]);
  });

  it("非法 selector 进入 unparsedMatches，不画框", () => {
    const snap = buildFixture();
    const v = run(snap, [`*(text 乱码垃圾字符串)`]);
    expect(v.clickNodes).toEqual([]);
    expect(v.unparsedMatches).toEqual([`*(text 乱码垃圾字符串)`]);
  });

  it("多段链无 @ 时默认点击末段", () => {
    const snap = buildFixture();
    const v = run(snap, [`LinearLayout > FrameLayout > TextView[text="ChainEnd"]`]);
    // 15(LinearLayout) → 16(FrameLayout) → 17(TextView)
    expect(ids(v.clickNodes)).toEqual([17]);
  });

  it("E2E：合法 + 非法混合时整条规则不可执行", () => {
    const snap = buildFixture();
    const v = run(snap, [`TextView[text="跳过"]`, `*(text 乱码垃圾字符串)`]);
    expect(v.clickNodes).toEqual([]);
    expect(v.status).toBe("invalid");
    expect(v.unparsedMatches).toEqual([`*(text 乱码垃圾字符串)`]);
  });

  // ─── 以下是 KMP 包带来的新能力，手写解析器做不到的语法 ───

  it("<< Descendant（任意深度后代）", () => {
    const snap = buildFixture();
    // Button[text="关闭"](3) << LinearLayout(15) = LinearLayout 在 Button 任意上方祖先
    // 但我们的 fixture 里 Button 3 的祖先链：3 ← 1 ← 0，没有 LinearLayout 13 或 15
    // 用 FrameLayout(16) << LinearLayout(15) 反向：LinearLayout(15) 是 16 的父亲
    const v = run(snap, [`FrameLayout[childCount=1] << LinearLayout[childCount=1]`]);
    // 16 是 FrameLayout childCount=1，15 是其 LinearLayout 父
    // 关系 "16 << 15" 意味着 15 是 16 的祖先（Descendant 反向）
    // 等价写法是 15 FrameLayout[childCount=1] —— 但我们要测的是 <<
    // 换成简单场景：LinearLayout[childCount=1] << Button[id$='_skip'] 意味着
    // LinearLayout 在 Button 的祖先链上 → 15 → 16 → 17? Button 14 的祖先是 13, 0，没有 15
    // 改用：TextView[text="ChainEnd"] << LinearLayout[childCount=1]
    // 17 的祖先链：17 ← 16 ← 15，15 是 LinearLayout
    expect(ids(v.clickNodes)).toEqual([15]);
  });

  it("-> Previous（前一个兄弟）", () => {
    const snap = buildFixture();
    // A(6) -> B(9) 表示 B 在 A 前面 = "前面"语义
    // 实际上 GKD 的 - 和 -> 都是"前兄弟"，A -> B 表示 A 在 B 的前面
    // 即 "B -> A" = "B 的后一个兄弟是 A"
    // 这里 [text="B"] -> [text="A"] 表示 A 在 B 后面，B 在 A 前面
    // fixture 里 6=A index 0, 9=B index 3，所以 A 在 B 前面（A->B 是 next 3）
    // 改成测 [text="X"] -> [text="A"] = A 的前一个兄弟是 X，即 A 在 X 后面
    // 6=A(index 0) 没有前兄弟；7=X(index 1) 的前兄弟不是 A
    // 实际：8=Y(index 2) -> [text="A"]? Y 的前兄弟是 X(7)，不匹配
    // 用 [text="Y"] - [text="A"] (直接 -) 也表示 A 是 Y 的前兄弟 → 不匹配
    // 用 [text="A"] - [text="X"]: A 的后兄弟 = X → 即 X 是 A 的后一个 → 匹配
    const v = run(snap, [`[text="X"] - [text="A"]`]);
    // 默认末段是 A = 节点 6
    expect(ids(v.clickNodes)).toEqual([6]);
  });

  it("@ 在链中间：点击目标是被 @ 标记的段", () => {
    const snap = buildFixture();
    // LinearLayout @FrameLayout TextView[text="ChainEnd"]
    // 链：15 → 16 → 17，@ 在 16 → target = 16
    const v = run(snap, [`LinearLayout @FrameLayout TextView[text="ChainEnd"]`]);
    expect(ids(v.clickNodes)).toEqual([16]);
  });

  it("裸空格链 = 隐式 Ancestor(1)（KMP 官方行为）", () => {
    const snap = buildFixture();
    // LinearLayout TextView[text="ChainEnd"] = "TextView 是 LinearLayout 的后代"
    // 17 的祖先链：17 ← 16 ← 15，15 是 LinearLayout
    const v = run(snap, [`LinearLayout TextView[text="ChainEnd"]`]);
    expect(ids(v.clickNodes)).toEqual([17]);
  });

  it("canSelectorFastQuery 与 matchGkdSelectorString.canFastQuery 正确识别 fastQuery 能力", () => {
    const snap = buildFixture();
    expect(canSelectorFastQuery('[vid="btn_skip"]')).toBe(true);
    expect(canSelectorFastQuery('[id="com.demo:id/btn_skip"]')).toBe(true);
    expect(canSelectorFastQuery('[text^="跳过"]')).toBe(true);
    expect(canSelectorFastQuery('[desc="关闭"]')).toBe(false);
    expect(canSelectorFastQuery('[text~="跳.*"]')).toBe(false);
    expect(canSelectorFastQuery('[id$="_skip"]')).toBe(false);
    expect(canSelectorFastQuery("not a selector ???")).toBe(false);

    expect(matchGkdSelectorString(snap, '[text^="跳过"]').canFastQuery).toBe(true);
    expect(matchGkdSelectorString(snap, '[id$="_skip"]').canFastQuery).toBe(false);
    expect(matchGkdSelectorString(snap, "not a selector ???").canFastQuery).toBe(false);
  });

  it("getChild 负数索引安全从末尾取值，越界时安全返回空命中", () => {
    const snap = buildFixture();
    // 节点 5 有 4 个子项：6(A), 7(X), 8(Y), 9(B)，getChild(-1) 应取最后一个子节点 B
    const lastChild = matchGkdSelectorString(snap, '[getChild(-1).text="B"]');
    expect(lastChild).toMatchObject({ unparsed: false, clickIds: [5] });

    const outOfRange = matchGkdSelectorString(snap, '[getChild(-99).text="B"]');
    expect(outOfRange).toMatchObject({ unparsed: false, clickIds: [] });
  });

  it("anyMatches-only 规则命中时收集 clickNodes 并返回 satisfied", () => {
    const snap = buildFixture();
    const [satisfied] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({
        matches: [],
        anyMatches: [`[text="不存在"]`, `[text="跳过"]`],
      }),
    );
    expect(satisfied).toMatchObject({ status: "satisfied", hitCount: 1 });
    expect(ids(satisfied.clickNodes)).toEqual([2]);

    const [missed] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({
        matches: [],
        anyMatches: [`[text="不存在1"]`, `[text="不存在2"]`],
      }),
    );
    expect(missed).toMatchObject({
      status: "unsatisfied",
      hitCount: 0,
      failureReason: "any_matches_miss",
    });
  });

  it("activityMatches 严格精确匹配并拒绝空字符串与截断前缀", () => {
    const snap = buildFixture();

    const [exactShort] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="A"]`], activityIds: ".MainActivity" }),
    );
    expect(exactShort).toMatchObject({ status: "satisfied", hitCount: 1 });

    const [prefixOnly] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="A"]`], activityIds: "com.demo.Main" }),
    );
    expect(prefixOnly).toMatchObject({
      status: "unsatisfied",
      hitCount: 0,
      failureReason: "activity_mismatch",
    });

    const [emptyString] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="A"]`], activityIds: "" }),
    );
    expect(emptyString).toMatchObject({
      status: "unsatisfied",
      hitCount: 0,
      failureReason: "activity_mismatch",
    });

    const [emptyItemArray] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="A"]`], activityIds: [""] }),
    );
    expect(emptyItemArray).toMatchObject({
      status: "unsatisfied",
      hitCount: 0,
      failureReason: "activity_mismatch",
    });

    const [emptyExclude] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="A"]`], excludeActivityIds: [] }),
    );
    expect(emptyExclude).toMatchObject({ status: "satisfied", hitCount: 1 });
  });

  it("输出结构化 failureReason 区分 disabled / excluded / context_miss / target_miss / invalid / partial", () => {
    const snap = buildFixture();

    const [disabled] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="A"]`], enable: false }),
    );
    expect(disabled.failureReason).toBe("disabled");

    const [excluded] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="A"]`], excludeMatches: [`[text="P"]`] }),
    );
    expect(excluded.failureReason).toBe("excluded");

    const [contextMiss] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="不存在"]`, `[text="A"]`] }),
    );
    expect(contextMiss.failureReason).toBe("context_miss");

    const [targetMiss] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="P"]`, `[text="不存在"]`] }),
    );
    expect(targetMiss.failureReason).toBe("target_miss");

    const [invalid] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`not a selector ???`] }),
    );
    expect(invalid.failureReason).toBe("invalid");

    const [partial] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({ matches: [`[text="A"]`], versionCodes: [1] }),
    );
    expect(partial.failureReason).toBe("partial");
  });

  it("anyMatches 与必需 matches 同时含不可解析表达式时优先判定为 invalid", () => {
    const snap = buildFixture();
    const [value] = validateAppRuleAgainstSnapshot(
      snap,
      appWithRule({
        anyMatches: [`[text="P"]`, `not valid any ???`],
        matches: [`not valid match ???`],
      }),
    );

    expect(value).toMatchObject({
      status: "invalid",
      hitCount: 0,
      failureReason: "invalid",
    });
    expect(value.clickNodes).toEqual([]);
    expect(value.unparsedMatches).toEqual([`not valid any ???`, `not valid match ???`]);
  });
});
