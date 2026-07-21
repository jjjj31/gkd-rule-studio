import { describe, expect, it } from "vitest";
import { normalizeSnapshot } from "./snapshotNormalize";
import { parseGkdSelectorExpression, validateAiCandidateAgainstSnapshot } from "./selectorMatcher";
import type { AiRuleCandidate } from "./aiModel";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

/**
 * 测试 fixture：手搭一棵小树，覆盖 AI 各种关系/运算符写法。
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

describe("selectorMatcher AI 路径", () => {
  it("*[text=...] 通配符按任意类型命中（回归 bug 1：* 被字面比较）", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`*[text="跳过"]`);
    expect(expr).not.toBeNull();
    expect(ids(matchExpr(snap, expr!))).toEqual([2]);
  });

  it("TextView[text=...] 只命中指定类型", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`TextView[text="跳过"]`);
    expect(expr).not.toBeNull();
    expect(ids(matchExpr(snap, expr!))).toEqual([2]);
  });

  it("TextView[text^=...] 命中以指定串开头", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`TextView[text^="跳过"]`);
    expect(ids(matchExpr(snap, expr!))).toEqual([2]);
  });

  it("[id$='_skip'] 命中以 _skip 结尾（回归 bug 6：$= 条件丢失）", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`[id$="_skip"]`);
    expect(ids(matchExpr(snap, expr!))).toEqual([14]);
  });

  it("[text!='广告'] 命中 text 不是广告的节点（回归 bug 7：!= 条件丢失）", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`[text!="广告"]`);
    const hitIds = ids(matchExpr(snap, expr!));
    // 唯一 text=广告 的节点是 id 4，应被排除
    expect(hitIds).not.toContain(4);
    expect(hitIds).toContain(2);
    expect(hitIds).toContain(6);
  });

  it("[width>=100] 命中 width 不小于 100（回归 bug 8：>= 被解析成 =100]）", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`[width>=100]`);
    const hitIds = ids(matchExpr(snap, expr!));
    // fixture 里 width>=100 的节点：0(1080),1(200),3(120),4(160),5(300),10(400),13(200),14(100),15(200),16(100)
    expect(hitIds).toEqual([0, 1, 3, 4, 5, 10, 13, 14, 15, 16]);
  });

  it("[text='A'] +3 [text='B'] 兄弟距离 3 命中 B（回归 bug 3：被 AND 合并成同一 selector）", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`[text="A"] +3 [text="B"]`);
    // 默认点击目标是末段 = B
    expect(ids(matchExpr(snap, expr!))).toEqual([9]);
  });

  it("[text='P'] + [text='Q'] 单独 + 等价 +1 命中相邻兄弟", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`[text="P"] + [text="Q"]`);
    expect(ids(matchExpr(snap, expr!))).toEqual([12]);
  });

  it("FrameLayout > Button[text='关闭'] 直系父-子命中（取末段 = Button）", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`FrameLayout > Button[text="关闭"]`);
    // id 3 是 Button text=关闭, pid=1=FrameLayout
    expect(ids(matchExpr(snap, expr!))).toEqual([3]);
  });

  it("@[text='取消'] < * 父-子反向，点击目标是左段 [text='取消']（回归 bug 4：< 关系未实现 + * 不匹配）", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(`@[text="取消"] < *`);
    // 点击目标是带 @ 的段 = [text="取消"]，任何节点都有 * 祖先，故 [text="取消"] 全部命中
    expect(ids(matchExpr(snap, expr!))).toEqual([14]);
  });

  it("*(garbage) 非法类型名，parseGkdSelectorExpression 返回 null（不画框、进入 unparsedMatches）", () => {
    const parsed = parseGkdSelectorExpression(`*(text 乱码垃圾字符串)`);
    expect(parsed).toBeNull();
  });

  it("多段链无 @ 时默认点击末段：LinearLayout > FrameLayout > TextView[text='ChainEnd']", () => {
    const snap = buildFixture();
    const expr = parseGkdSelectorExpression(
      `LinearLayout > FrameLayout > TextView[text="ChainEnd"]`,
    );
    // 15(LinearLayout) → 16(FrameLayout) → 17(TextView "ChainEnd")
    expect(ids(matchExpr(snap, expr!))).toEqual([17]);
  });

  it("validateAiCandidateAgainstSnapshot 端到端：合法 match 命中节点、非法 match 进 unparsedMatches", () => {
    const snap = buildFixture();
    const candidate: AiRuleCandidate = makeCandidate([
      `TextView[text="跳过"]`,
      `*(text 乱码垃圾字符串)`,
    ]);
    const validation = validateAiCandidateAgainstSnapshot(candidate, snap);
    expect(validation.clickNodes.length).toBeGreaterThan(0);
    expect(ids(validation.clickNodes)).toEqual([2]);
    expect(validation.unparsedMatches).toEqual([`*(text 乱码垃圾字符串)`]);
  });
});

// 仅暴露给测试内部使用的小工具：parser 配 matchGkdExpr。
function matchExpr(snap: ParsedGkdSnapshot, expr: { segments: unknown[] }): NormalizedSnapshotNode[] {
  // parseGkdSelectorExpression 返回的 segments 内部是 GkdSegment，TS 类型私有；
  // 这里直接走 validateAiCandidateAgainstSnapshot 的等价路径：单条 match 构造一个 candidate。
  const candidate: AiRuleCandidate = {
    id: "t",
    title: "t",
    summary: "",
    risk: "",
    app: { id: "x", name: "x", groups: [{ key: 1, name: "g", rules: [{ key: 1, matches: serializeBack(expr) }] }] },
  };
  return validateAiCandidateAgainstSnapshot(candidate, snap).clickNodes;
}

function serializeBack(expr: { segments: unknown[] }): string[] {
  // 把 segments 还原成 GKD selector 字符串，方便喂给 validateAiCandidate。
  // 简单实现：导出 GkdSegment 的可序列化字段。
  const segs = expr.segments as Array<{
    relation: string;
    selector: { typeName?: string; conditions: Array<{ attr: string; op: string; value: unknown }> };
    isClickTarget: boolean;
    distance?: number | number[] | "n";
  }>;
  const parts: string[] = [];
  segs.forEach((seg, i) => {
    if (i > 0) {
      if (seg.relation === "child") parts.push(">");
      else if (seg.relation === "parent") parts.push("<");
      else if (seg.relation === "next") {
        if (seg.distance === "n") parts.push("+n");
        else if (Array.isArray(seg.distance)) parts.push(`+(${seg.distance.join(",")})`);
        else if (seg.distance === 1 || seg.distance === undefined) parts.push("+");
        else parts.push(`+${seg.distance}`);
      } else if (seg.relation === "previous") {
        if (seg.distance === "n") parts.push("-n");
        else if (Array.isArray(seg.distance)) parts.push(`-(${seg.distance.join(",")})`);
        else if (seg.distance === 1 || seg.distance === undefined) parts.push("-");
        else parts.push(`-${seg.distance}`);
      }
    }
    if (seg.isClickTarget) parts.push("@");
    const tn = seg.selector.typeName;
    const conds = seg.selector.conditions
      .map((c) => {
        const v = typeof c.value === "string" ? `"${c.value}"` : String(c.value);
        const opMap: Record<string, string> = {
          eq: "=",
          notEq: "!=",
          contains: "*=",
          startsWith: "^=",
          endsWith: "$=",
          notStartsWith: "!^=",
          notEndsWith: "!$=",
          lt: "<",
          lte: "<=",
          gt: ">",
          gte: ">=",
        };
        return `[${c.attr}${opMap[c.op] ?? c.op}${v}]`;
      })
      .join("");
    parts.push(tn ? `${tn}${conds}` : conds);
  });
  return [parts.join(" ")];
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
