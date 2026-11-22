import { describe, expect, it } from "vitest";
import {
  createRuleDraft,
  exactSelector,
  firstFastQueryAttr,
  formatSimpleSelector,
  serializePlan,
} from "./selectorSerialize";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import { matchGkdSelectorString } from "./selectorAdapter";
import { normalizeSnapshot } from "./snapshotNormalize";
import type { RawGkdSnapshot, SnapshotNode, SnapshotNodeAttr } from "../types/gkdSnapshot";

function attr(o: Partial<SnapshotNodeAttr>): SnapshotNodeAttr {
  return o as SnapshotNodeAttr;
}

function node(id: number, pid: number, a: SnapshotNodeAttr): SnapshotNode {
  return { id, pid, idQf: Boolean(a.id), textQf: Boolean(a.text), attr: a };
}

/** 单节点快照，节点文本可含控制字符，用来验证转义后的 selector 真能命中。 */
function snapshotWithText(text: string) {
  const raw: RawGkdSnapshot = {
    id: 1,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 1080,
    screenHeight: 2400,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes: [
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1, right: 1080, bottom: 2400 })),
      node(1, 0, attr({ name: "android.widget.TextView", text, right: 300, bottom: 60, width: 300, height: 60, depth: 1 })),
    ],
  };
  return normalizeSnapshot(raw, "blob:test", "test.zip");
}

describe("selectorSerialize 字符串转义", () => {
  it("换行文本转义成 \\n 后仍能命中节点", () => {
    const selector = exactSelector("text", "第一行\n第二行", "TextView");
    const [expr] = serializePlan({ kind: "simple", selector });
    expect(expr).toBe('TextView[text="第一行\\n第二行"]');

    const result = matchGkdSelectorString(snapshotWithText("第一行\n第二行"), expr);
    expect(result.unparsed).toBe(false);
    expect(result.clickIds).toHaveLength(1);
  });

  it("回车与制表符转义后仍能命中节点", () => {
    for (const text of ["a\rb", "a\tb"]) {
      const [expr] = serializePlan({ kind: "simple", selector: exactSelector("text", text, "TextView") });
      const result = matchGkdSelectorString(snapshotWithText(text), expr);
      expect(result.unparsed, expr).toBe(false);
      expect(result.clickIds, expr).toHaveLength(1);
    }
  });

  it("双引号与反斜杠仍按原语义转义", () => {
    expect(formatSimpleSelector(exactSelector("text", 'a"b'))).toBe('[text="a\\"b"]');
    expect(formatSimpleSelector(exactSelector("text", "a\\b"))).toBe('[text="a\\\\b"]');
  });

  it("裸控制字符不会漏进 selector 字符串", () => {
    const [expr] = serializePlan({
      kind: "simple",
      selector: exactSelector("text", "a\u0007b", "TextView"),
    });
    // 无可转义序列的 C0 控制字符被剔除，不残留裸控制字符
    expect(expr).toBe('TextView[text="ab"]');
    expect(/[\u0000-\u001f\u007f]/.test(expr)).toBe(false);
  });

  it("orEq 多值分支同样走转义", () => {
    const [expr] = serializePlan({
      kind: "simple",
      selector: {
        conditions: [{ attr: "text", op: "orEq", value: ["否", "暂\n不"] }],
      },
    });
    expect(expr).toBe('[text="否" || text="暂\\n不"]');
    expect(matchGkdSelectorString(snapshotWithText("暂\n不"), expr).unparsed).toBe(false);
  });
});

describe("selectorSerialize fastQuery 判定", () => {
  it("严格校验 id/vid 仅 eq、text 仅 eq/startsWith/contains/endsWith 支持 fastQuery", () => {
    expect(firstFastQueryAttr({ conditions: [{ attr: "id", op: "eq", value: "a:id/b" }] })).toBe(true);
    expect(firstFastQueryAttr({ conditions: [{ attr: "vid", op: "eq", value: "skip" }] })).toBe(true);
    expect(firstFastQueryAttr({ conditions: [{ attr: "id", op: "endsWith", value: "_skip" }] })).toBe(false);
    expect(firstFastQueryAttr({ conditions: [{ attr: "vid", op: "startsWith", value: "skip" }] })).toBe(false);
    expect(firstFastQueryAttr({ conditions: [{ attr: "vid", op: "contains", value: "skip" }] })).toBe(false);
    expect(firstFastQueryAttr({ conditions: [{ attr: "vid", op: "notEq", value: "ad" }] })).toBe(false);

    expect(firstFastQueryAttr({ conditions: [{ attr: "text", op: "eq", value: "跳过" }] })).toBe(true);
    expect(firstFastQueryAttr({ conditions: [{ attr: "text", op: "startsWith", value: "跳过" }] })).toBe(true);
    expect(firstFastQueryAttr({ conditions: [{ attr: "text", op: "contains", value: "跳过" }] })).toBe(true);
    expect(firstFastQueryAttr({ conditions: [{ attr: "text", op: "endsWith", value: "跳过" }] })).toBe(true);
    expect(firstFastQueryAttr({ conditions: [{ attr: "text", op: "notEq", value: "广告" }] })).toBe(false);
    expect(firstFastQueryAttr({ conditions: [{ attr: "text", op: "notStartsWith", value: "广告" }] })).toBe(false);
    expect(firstFastQueryAttr({ conditions: [{ attr: "text", op: "orEq", value: ["否", "暂不"] }] })).toBe(true);

    expect(firstFastQueryAttr({ conditions: [{ attr: "desc", op: "eq", value: "关闭" }] })).toBe(false);
  });

  it("createRuleDraft 基于官方 canSelectorFastQuery 判定 sibling 与 orEq 的 fastQuery", () => {
    const siblingDescRight = createRuleDraft(
      {
        kind: "sibling",
        target: exactSelector("vid", "close"),
        neighbor: exactSelector("desc", "广告"),
        relation: "next",
        distance: 1,
      },
      DEFAULT_RULE_SETTINGS,
    );
    expect(siblingDescRight.matches).toEqual(['@[vid="close"] + [desc="广告"]']);
    expect(siblingDescRight.fastQuery).toBeUndefined();

    const siblingTextRight = createRuleDraft(
      {
        kind: "sibling",
        target: { typeName: "ImageView", conditions: [] },
        neighbor: exactSelector("text", "广告"),
        relation: "previous",
        distance: 1,
      },
      DEFAULT_RULE_SETTINGS,
    );
    expect(siblingTextRight.matches).toEqual(['@ImageView - [text="广告"]']);
    expect(siblingTextRight.fastQuery).toBe(true);

    const orEqRule = createRuleDraft(
      {
        kind: "simple",
        selector: {
          conditions: [{ attr: "text", op: "orEq", value: ["否", "暂不"] }],
        },
      },
      DEFAULT_RULE_SETTINGS,
    );
    expect(orEqRule.matches).toEqual(['[text="否" || text="暂不"]']);
    expect(orEqRule.fastQuery).toBe(true);
  });

  it("createRuleDraft 按逗号/换行拆分多元素 activityIds 并兼容单元素字符串", () => {
    const single = createRuleDraft(
      { kind: "simple", selector: exactSelector("vid", "close") },
      { ...DEFAULT_RULE_SETTINGS, activityIds: "com.demo.A" },
    );
    expect(single.activityIds).toBe("com.demo.A");

    const multiple = createRuleDraft(
      { kind: "simple", selector: exactSelector("vid", "close") },
      { ...DEFAULT_RULE_SETTINGS, activityIds: "com.demo.A, com.demo.B\ncom.demo.C" },
    );
    expect(multiple.activityIds).toEqual(["com.demo.A", "com.demo.B", "com.demo.C"]);
  });

  it("matchesChain 仅在所有链段均支持 fastQuery 时才设 fastQuery: true", () => {
    const bothFast = createRuleDraft(
      {
        kind: "matchesChain",
        context: exactSelector("text", "更新提示", "TextView"),
        target: exactSelector("text", "取消", "Button"),
      },
      DEFAULT_RULE_SETTINGS,
    );
    expect(bothFast.fastQuery).toBe(true);

    const descContext = createRuleDraft(
      {
        kind: "matchesChain",
        context: exactSelector("desc", "广告弹窗"),
        target: exactSelector("text", "关闭", "Button"),
      },
      DEFAULT_RULE_SETTINGS,
    );
    expect(descContext.fastQuery).toBeUndefined();
  });
});
