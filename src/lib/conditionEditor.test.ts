import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConditionEditor } from "../components/ConditionEditor";
import type {
  ParsedGkdSnapshot,
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";
import type {
  AppRuleDraft,
  RuleDraft,
  SelectorCandidate,
  SelectorPlan,
} from "../types/ruleDraft";
import { normalizeSnapshot } from "./snapshotNormalize";
import { scoreCandidate } from "./riskScoring";
import { serializePlan, exactSelector } from "./selectorSerialize";
import { validateAppRuleAgainstSnapshot } from "./selectorMatcher";
import {
  applyConditionEditorDraft,
  createConditionEditorModel,
  selectorFromSnapshotNode,
  type ConditionEditorDraft,
} from "./conditionEditor";

describe("condition editor public behavior", () => {
  it("keeps an unrepresentable execution value in the complete advanced rule", () => {
    const candidate = makeCandidate(buildSnapshot(), {
      kind: "simple", selector: exactSelector("text", "确认"),
    });
    const malformed = { ...candidate,
      rule: { ...candidate.rule, fastQuery: "yes" as unknown as boolean },
    };
    expect(createConditionEditorModel(malformed)).toMatchObject({ supported: false });
    expect(malformed.rule.fastQuery).toBe("yes");
    const unknownAction = { ...candidate,
      rule: { ...candidate.rule, action: "bogus" },
      actionPlan: { ...candidate.actionPlan, action: "bogus" },
    };
    expect(createConditionEditorModel(unknownAction)).toMatchObject({ supported: false });
    expect(unknownAction.rule.action).toBe("bogus");
  });

  it("reverse-maps a representable typed plan and rebuilds the clicked target from a context condition", () => {
    const snapshot = buildSnapshot();
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "确认", "TextView"),
    });

    const model = createConditionEditorModel(candidate);
    expect(model.supported).toBe(true);
    if (!model.supported) return;
    expect(model.draft.target.conditions).toEqual([
      { attr: "text", op: "eq", value: "确认" },
    ]);

    const edited: ConditionEditorDraft = {
      ...model.draft,
      relation: {
        kind: "parentChild",
        contextRole: "parent",
        context: {
          typeName: "LinearLayout",
          conditions: [],
          clickable: false,
          visibleToUser: false,
        },
      },
    };
    const result = applyConditionEditorDraft({ snapshot, candidate, draft: edited });

    expect(result.error).toBeUndefined();
    expect(result.candidate?.plan).toMatchObject({
      kind: "parentChild",
      clickTarget: "child",
    });
    expect(result.candidate?.validation.clickNodes.map((node) => node.id)).toEqual([3]);
    expect(result.candidate?.rule.matches).toEqual([
      'LinearLayout > @TextView[text="确认"]',
    ]);
  });

  it("keeps quotes and backslashes literal through serialization and official matching", () => {
    const snapshot = buildSnapshot('确认 "清除"\\');
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "旧文本"),
    });
    const model = createConditionEditorModel(candidate);
    expect(model.supported).toBe(true);
    if (!model.supported) return;

    const edited = structuredClone(model.draft);
    edited.target.conditions = [
      { attr: "text", op: "eq", value: '确认 "清除"\\' },
    ];
    const result = applyConditionEditorDraft({ snapshot, candidate, draft: edited });

    expect(result.candidate?.rule.matches).toEqual(['[text="确认 \\"清除\\"\\\\"]']);
    expect(result.candidate?.validation.clickNodes.map((node) => node.id)).toEqual([3]);
    expect(result.validation?.status).toBe("satisfied");
  });

  it("round-trips the supported AND condition subset without dropping fields", () => {
    const snapshot = buildSnapshot();
    const plan: SelectorPlan = {
      kind: "simple",
      selector: {
        typeName: "TextView",
        conditions: [
          { attr: "text", op: "contains", value: "确" },
          { attr: "desc", op: "eq", value: "确认操作" },
          { attr: "id", op: "eq", value: "com.demo:id/confirm" },
          { attr: "vid", op: "eq", value: "confirm" },
          { attr: "clickable", op: "eq", value: true },
          { attr: "visibleToUser", op: "eq", value: true },
        ],
      },
    };
    const candidate = makeCandidate(snapshot, plan);
    const model = createConditionEditorModel(candidate);
    expect(model.supported).toBe(true);
    if (!model.supported) return;

    const result = applyConditionEditorDraft({
      snapshot,
      candidate,
      draft: model.draft,
    });
    expect(result.error).toBeUndefined();
    expect(result.candidate?.plan).toEqual(plan);
    expect(result.candidate?.rule.matches).toEqual(serializePlan(plan));
  });

  it("edits startsWith and endsWith conditions used by generated candidates", () => {
    const snapshot = buildSnapshot();
    const plan: SelectorPlan = {
      kind: "simple",
      selector: {
        typeName: "TextView",
        conditions: [
          { attr: "vid", op: "eq", value: "confirm" },
          { attr: "desc", op: "startsWith", value: "确认" },
          { attr: "visibleToUser", op: "eq", value: true },
        ],
      },
    };
    const candidate = makeCandidate(snapshot, plan);
    const model = createConditionEditorModel(candidate);

    expect(model.supported).toBe(true);
    if (!model.supported) return;
    expect(model.draft.target.conditions).toContainEqual({
      attr: "desc",
      op: "startsWith",
      value: "确认",
    });
    expect(model.draft.target.visibleToUser).toBe(true);

    const edited = structuredClone(model.draft);
    edited.target.conditions = edited.target.conditions.map((condition) =>
      condition.attr === "desc"
        ? { ...condition, op: "endsWith", value: "操作" }
        : condition,
    );
    const result = applyConditionEditorDraft({ snapshot, candidate, draft: edited });

    expect(result.error).toBeUndefined();
    expect(result.candidate?.rule.matches).toEqual([
      'TextView[vid="confirm"][desc$="操作"][visibleToUser=true]',
    ]);
    expect(result.candidate?.validation.hitCount).toBe(1);
  });

  it("rejects a type name that could inject selector syntax", () => {
    const snapshot = buildSnapshot();
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "确认", "TextView"),
    });
    const model = createConditionEditorModel(candidate);
    expect(model.supported).toBe(true);
    if (!model.supported) return;

    const edited = structuredClone(model.draft);
    edited.target.typeName = 'TextView[text="任意"] > *';
    const result = applyConditionEditorDraft({ snapshot, candidate, draft: edited });
    expect(result.candidate).toBeNull();
    expect(result.error).toContain("类型只能填写");
  });

  it("normalizes an edited countdown so the candidate does not lock one second value", () => {
    const snapshot = buildSnapshot("跳过 5s");
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "关闭"),
    });
    const model = createConditionEditorModel(candidate);
    expect(model.supported).toBe(true);
    if (!model.supported) return;

    const edited = structuredClone(model.draft);
    edited.target.conditions = [{ attr: "text", op: "eq", value: "跳过 5s" }];
    const result = applyConditionEditorDraft({ snapshot, candidate, draft: edited });

    expect(result.normalizations).toEqual([
      '倒计时文本已改为包含“跳过”，避免锁定秒数。',
    ]);
    expect(result.candidate?.rule.matches).toEqual(['[text*="跳过"]']);
    expect(result.candidate?.validation.hitCount).toBe(1);
  });

  it("derives an editable context selector from a selected snapshot node", () => {
    const snapshot = buildSnapshot();
    const context = snapshot.nodeById.get(2)!;
    expect(selectorFromSnapshotNode(context)).toEqual({
      typeName: "TextView",
      conditions: [{ attr: "text", op: "eq", value: "删除文件？" }],
      clickable: false,
      visibleToUser: false,
    });
  });

  it("rejects the whole plan instead of partially mapping unsupported conditions", () => {
    const snapshot = buildSnapshot();
    const complex = makeCandidate(snapshot, {
      kind: "simple",
      selector: {
        typeName: "TextView",
        conditions: [
          { attr: "text", op: "notStartsWith", value: "删除" },
          { attr: "visibleToUser", op: "eq", value: true },
        ],
      },
    });

    const model = createConditionEditorModel(complex);
    expect(model.supported).toBe(false);
    if (model.supported) return;
    expect(model.reason).toContain("notStartsWith");

    const markup = renderToStaticMarkup(
      createElement(ConditionEditor, {
        snapshot,
        candidate: complex,
        onApply: () => undefined,
      }),
    );
    expect(markup).toContain("高级 JSON");
    expect(markup).toContain("notStartsWith");
    expect(markup).toContain("只读");
  });

  it("rejects extra rule conditions and mismatched plan/rule text", () => {
    const snapshot = buildSnapshot();
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "确认"),
    });
    expect(
      createConditionEditorModel({
        ...candidate,
        rule: { ...candidate.rule, excludeMatches: ['[text="广告"]'] },
      }).supported,
    ).toBe(false);
    expect(
      createConditionEditorModel({
        ...candidate,
        rule: { ...candidate.rule, matches: ['[text="另一个"]'] },
      }).supported,
    ).toBe(false);
  });

  it("keeps unknown execution fields in JSON instead of pretending the whole rule is form-editable", () => {
    const snapshot = buildSnapshot();
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "确认"),
    });
    const ruleWithUnknownField = {
      ...candidate.rule,
      futureExecutionField: "keep-me",
    } as RuleDraft;
    const model = createConditionEditorModel({
      ...candidate,
      rule: ruleWithUnknownField,
    });
    expect(model.supported).toBe(false);
    if (model.supported) return;
    expect(model.reason).toContain("futureExecutionField");
    const markup = renderToStaticMarkup(
      createElement(ConditionEditor, {
        snapshot,
        candidate: { ...candidate, rule: ruleWithUnknownField },
        onApply: () => undefined,
      }),
    );
    expect(markup).toContain("futureExecutionField");
    expect(markup).toContain("只读");
  });

  it("rejects a plan that claims a rule action differs from the supplied action plan", () => {
    const snapshot = buildSnapshot();
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "确认"),
    });
    expect(
      createConditionEditorModel({
        ...candidate,
        rule: { ...candidate.rule, action: "longClick" },
      }).supported,
    ).toBe(false);
  });

  it("blocks zero-hit edits while returning the computed validation for clear feedback", () => {
    const snapshot = buildSnapshot();
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "确认"),
    });
    const model = createConditionEditorModel(candidate);
    expect(model.supported).toBe(true);
    if (!model.supported) return;

    const edited = structuredClone(model.draft);
    edited.target.conditions = [{ attr: "text", op: "eq", value: "不存在" }];
    const result = applyConditionEditorDraft({ snapshot, candidate, draft: edited });

    expect(result.candidate).toBeNull();
    expect(result.validation).toMatchObject({ status: "unsatisfied", hitCount: 0 });
    expect(result.error).toContain("点击目标未命中");
    expect(result.previewCandidate?.rule.matches).toEqual(['[text="不存在"]']);
    expect(result.previewCandidate?.validation.hitCount).toBe(0);
  });

  it("validates the final rule fields, so a mismatched Activity cannot be applied", () => {
    const snapshot = buildSnapshot();
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "确认"),
    });
    const model = createConditionEditorModel(candidate);
    expect(model.supported).toBe(true);
    if (!model.supported) return;

    const result = applyConditionEditorDraft({
      snapshot,
      candidate,
      draft: structuredClone(model.draft),
    });
    expect(result.candidate).not.toBeNull();
    if (!result.candidate) return;

    const rematched = createConditionEditorModel({
      ...result.candidate,
      rule: { ...result.candidate.rule, activityIds: ".AnotherActivity" },
      actionPlan: { ...result.candidate.actionPlan, activityIds: ".AnotherActivity" },
    });
    expect(rematched.supported).toBe(true);
    if (!rematched.supported) return;

    const mismatched = applyConditionEditorDraft({
      snapshot,
      candidate: {
        ...result.candidate,
        rule: { ...result.candidate.rule, activityIds: ".AnotherActivity" },
        actionPlan: { ...result.candidate.actionPlan, activityIds: ".AnotherActivity" },
      },
      draft: rematched.draft,
    });
    expect(mismatched.candidate).toBeNull();
    expect(mismatched.validation?.diagnostics?.[0]).toContain("Activity 不匹配");
  });

  it("gives changed content a different deterministic id and recalculates validation and risk", () => {
    const snapshot = buildSnapshot();
    const candidate = makeCandidate(snapshot, {
      kind: "simple",
      selector: exactSelector("text", "确认"),
    });
    const model = createConditionEditorModel(candidate);
    expect(model.supported).toBe(true);
    if (!model.supported) return;

    const contains = structuredClone(model.draft);
    contains.target.conditions = [{ attr: "text", op: "contains", value: "确" }];
    const equal = structuredClone(model.draft);
    equal.target.conditions = [{ attr: "text", op: "eq", value: "确认" }];

    const first = applyConditionEditorDraft({ snapshot, candidate, draft: contains });
    const sameAgain = applyConditionEditorDraft({ snapshot, candidate, draft: contains });
    const second = applyConditionEditorDraft({ snapshot, candidate, draft: equal });
    expect(first.candidate?.id).not.toBe(candidate.id);
    expect(first.candidate?.id).toBe(sameAgain.candidate?.id);
    expect(first.candidate?.id).not.toBe(second.candidate?.id);
    expect(first.candidate?.validation).not.toBe(candidate.validation);
    expect(first.candidate?.risk).not.toBe(candidate.risk);
  });
});

function buildSnapshot(targetText = "确认"): ParsedGkdSnapshot {
  const nodes: SnapshotNode[] = [
    snapshotNode(
      0,
      -1,
      attr({
        name: "android.widget.FrameLayout",
        childCount: 1,
        width: 500,
        height: 200,
        right: 500,
        bottom: 200,
      }),
    ),
    snapshotNode(
      1,
      0,
      attr({
        name: "android.widget.LinearLayout",
        childCount: 2,
        width: 500,
        height: 200,
        right: 500,
        bottom: 200,
        depth: 1,
      }),
    ),
    snapshotNode(
      2,
      1,
      attr({
        name: "android.widget.TextView",
        text: "删除文件？",
        width: 250,
        height: 80,
        right: 250,
        bottom: 80,
        index: 0,
        depth: 2,
      }),
    ),
    snapshotNode(
      3,
      1,
      attr({
        name: "android.widget.TextView",
        text: targetText,
        desc: "确认操作",
        id: "com.demo:id/confirm",
        vid: "confirm",
        clickable: true,
        width: 100,
        height: 50,
        left: 250,
        right: 350,
        bottom: 50,
        index: 1,
        depth: 2,
      }),
    ),
  ];
  const raw: RawGkdSnapshot = {
    id: 1,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 500,
    screenHeight: 200,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes,
  };
  return normalizeSnapshot(raw, "blob:test", "condition-editor.zip");
}

function snapshotNode(id: number, pid: number, value: SnapshotNodeAttr): SnapshotNode {
  return {
    id,
    pid,
    idQf: Boolean(value.id),
    textQf: Boolean(value.text),
    attr: value,
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
    right: 500,
    bottom: 200,
    width: 500,
    height: 200,
    childCount: 0,
    index: 0,
    depth: 0,
    ...overrides,
  };
}

function makeCandidate(snapshot: ParsedGkdSnapshot, plan: SelectorPlan): SelectorCandidate {
  const rule: RuleDraft = {
    key: 0,
    name: "测试候选",
    matches: serializePlan(plan),
    activityIds: ".MainActivity",
    action: "clickCenter",
    matchTime: 10000,
    actionMaximum: 1,
  };
  const app: AppRuleDraft = {
    id: snapshot.appId,
    name: "Demo",
    groups: [{ key: 0, name: "测试", rules: [rule] }],
  };
  const validation = validateAppRuleAgainstSnapshot(snapshot, app)[0];
  const baseScore = 80;
  return {
    id: "exactTextWithContext-0",
    strategyName: "exactTextWithContext",
    title: "测试候选",
    plan,
    rule,
    actionPlan: {
      activityIds: ".MainActivity",
      action: "clickCenter",
      matchTime: 10000,
      actionMaximum: 1,
      rankAdjustment: 0,
      riskNotes: [],
      debugAdvice: [],
    },
    groupName: "测试",
    baseScore,
    validation,
    risk: scoreCandidate({ baseScore, snapshot, plan, rule, validation }),
    riskNotes: [],
    debugAdvice: [],
    debugReasons: [],
  };
}
