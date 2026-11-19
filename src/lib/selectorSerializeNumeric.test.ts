import { describe, expect, it } from "vitest";
import { formatSimpleSelector, serializePlan } from "./selectorSerialize";
import { matchGkdSelectorString } from "./selectorAdapter";
import { normalizeSnapshot } from "./snapshotNormalize";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

describe("numeric selector conditions", () => {
  it("keeps eq and notEq numbers unquoted", () => {
    const selector = {
      typeName: "TextView",
      conditions: [
        { attr: "text" as const, op: "eq" as const, value: "x" },
        { attr: "childCount" as const, op: "eq" as const, value: 0 },
      ],
    };

    expect(formatSimpleSelector(selector)).toBe(
      'TextView[text="x"][childCount=0]',
    );

    const [expr] = serializePlan({ kind: "simple", selector });
    const result = matchGkdSelectorString(snapshot(), expr);
    expect(result.unparsed).toBe(false);
    expect(result.clickIds).toHaveLength(1);
  });
});

function snapshot() {
  const root = node(0, -1, {
    name: "android.view.ViewGroup",
    childCount: 1,
    depth: 0,
    right: 1080,
    bottom: 2400,
    width: 1080,
    height: 2400,
  });
  const child = node(1, 0, {
    name: "android.widget.TextView",
    text: "x",
    childCount: 0,
    depth: 1,
    left: 10,
    top: 10,
    right: 110,
    bottom: 60,
    width: 100,
    height: 50,
  });
  const raw: RawGkdSnapshot = {
    id: 1,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 1080,
    screenHeight: 2400,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes: [root, child],
  };
  return normalizeSnapshot(raw, "blob:test", "test.zip");
}

function node(
  id: number,
  pid: number,
  overrides: Partial<SnapshotNodeAttr>,
): SnapshotNode {
  const attr: SnapshotNodeAttr = {
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
    ...overrides,
  };
  return { id, pid, idQf: Boolean(attr.id), textQf: Boolean(attr.text), attr };
}
