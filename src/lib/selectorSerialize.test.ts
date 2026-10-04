import { describe, expect, it } from "vitest";
import { exactSelector, formatSimpleSelector, serializePlan } from "./selectorSerialize";
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
