import { describe, expect, it } from "vitest";
import type { AiCandidateVerification } from "../src/lib/aiCandidateVerification";
import type { AiRuleCandidate } from "../src/lib/aiModel";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../src/types/gkdSnapshot";
import {
  classifyRequestError,
  classifyVerificationFailure,
  extractSelectorLiterals,
  selectorHasStructure,
} from "./llmEvidence";

const target = node(1, {
  name: "android.widget.TextView",
  text: "跳过",
  clickable: true,
});

const snapshot = makeSnapshot([
  target,
  node(2, {
    name: "android.widget.Button",
    text: "关闭",
    vid: "btn_close",
  }),
]);

const candidate = {
  id: "candidate-a",
  title: "测试版 A",
  summary: "",
  risk: "",
  app: { id: snapshot.appId, name: "test", groups: [] },
} satisfies AiRuleCandidate;

describe("LLM evidence classification", () => {
  it("把选择器语法错误从 JSON5 格式错误里拆出来", () => {
    const result = classifyRequestError(
      "AI 返回规则不是有效 JSON5：选择器语法错误：Expect WHITESPACE, got > at index 13",
    );
    expect(result.category).toBe("selector_syntax");
  });

  it("把普通结构解析失败归到格式解析失败", () => {
    const result = classifyRequestError("Unexpected token } in JSON5");
    expect(result.category).toBe("format_parse");
  });

  it("文字不存在时归为文字不匹配", () => {
    const result = classifyVerificationFailure({
      snapshot,
      candidate,
      targetNode: target,
      verification: verification(["[text=\"继续\"]"], ["zero_hit"]),
    });
    expect(result?.category).toBe("text_mismatch");
    expect(result?.confidence).toBe("high");
  });

  it("vid 不存在时归为属性名/值错", () => {
    const result = classifyVerificationFailure({
      snapshot,
      candidate,
      targetNode: target,
      verification: verification(["[vid=\"missing\"]"], ["zero_hit"]),
    });
    expect(result?.category).toBe("attribute_value");
  });

  it("字面值存在但层级不命中时归为结构条件错", () => {
    const result = classifyVerificationFailure({
      snapshot,
      candidate,
      targetNode: target,
      verification: verification(
        ["[text=\"跳过\"] > TextView"],
        ["zero_hit"],
      ),
    });
    expect(result?.category).toBe("structure_condition");
  });

  it("布尔属性存在时不应误报属性值错", () => {
    const result = classifyVerificationFailure({
      snapshot,
      candidate,
      targetNode: target,
      verification: verification(
        ["[clickable=true] > TextView"],
        ["zero_hit"],
      ),
    });
    expect(result?.category).toBe("structure_condition");
  });

  it("命中别的节点时归为选错节点", () => {
    const result = classifyVerificationFailure({
      snapshot,
      candidate,
      targetNode: target,
      verification: verification(["[text=\"关闭\"]"], ["wrong_target"]),
    });
    expect(result?.category).toBe("wrong_target");
  });

  it("能提取属性和结构符", () => {
    expect(extractSelectorLiterals("[text='跳过'][vid=\"btn_close\"]")).toEqual([
      {
        attr: "text",
        operator: "=",
        value: "跳过",
        raw: "[text='跳过']",
      },
      {
        attr: "vid",
        operator: "=",
        value: "btn_close",
        raw: "[vid=\"btn_close\"]",
      },
    ]);
    expect(selectorHasStructure("[text=\"跳过\"] > TextView")).toBe(true);
    expect(selectorHasStructure("[text=\"跳过\"]")).toBe(false);
  });
});

function verification(
  matches: string[],
  failureCodes: string[],
): AiCandidateVerification {
  return {
    candidateId: "candidate-a",
    title: "测试版 A",
    status: "fail",
    allRulesPass: false,
    rules: [
      {
        groupIndex: 0,
        ruleIndex: 0,
        matches,
        status: "fail",
        hitCount: 0,
        hitNodes: [],
        hitNodeIds: [],
        extraNodeIds: [],
        hitPickedNode: false,
        failureCodes: failureCodes as AiCandidateVerification["failureCodes"],
        diagnostics: [],
      },
    ],
    matchedNodeIds: [],
    extraNodeIds: [],
    hitPickedNode: false,
    failureCodes: failureCodes as AiCandidateVerification["failureCodes"],
    diagnostics: [],
  };
}

function makeSnapshot(nodes: NormalizedSnapshotNode[]): ParsedGkdSnapshot {
  return {
    id: 1,
    appId: "com.example.test",
    activityId: "com.example.test.MainActivity",
    screenWidth: 1080,
    screenHeight: 2400,
    isLandscape: false,
    nodes,
    nodeById: new Map(nodes.map((item) => [item.id, item])),
    screenshotUrl: "",
    sourceName: "test",
  };
}

function node(
  id: number,
  overrides: Partial<NormalizedSnapshotNode["attr"]> = {},
): NormalizedSnapshotNode {
  return {
    id,
    pid: -1,
    idQf: null,
    textQf: null,
    children: [],
    attr: {
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
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      childCount: 0,
      index: 0,
      depth: 0,
      ...overrides,
    },
  };
}
