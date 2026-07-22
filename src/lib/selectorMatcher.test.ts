import { describe, expect, it } from "vitest";
import { normalizeSnapshot } from "./snapshotNormalize";
import { validateAiCandidateAgainstSnapshot } from "./selectorMatcher";
import type { AiRuleCandidate } from "./aiModel";
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

describe("selectorMatcher AI 路径（@gkd-kit/selector）", () => {
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

  it("E2E：合法 + 非法混合，合法命中、非法进 unparsedMatches", () => {
    const snap = buildFixture();
    const v = run(snap, [`TextView[text="跳过"]`, `*(text 乱码垃圾字符串)`]);
    expect(ids(v.clickNodes)).toEqual([2]);
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
});
