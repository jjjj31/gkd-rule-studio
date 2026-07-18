import { describe, expect, it } from "vitest";
import type { AppRuleDraft } from "../types/ruleDraft";
import type { AiRuleCandidate } from "./aiModel";
import {
  addAiSession,
  aiCandidateSourceKey,
  buildActiveTestSubscription,
  createEmptyInlineRuleTestingState,
  deleteAiSession,
  deleteInlineTestItem,
  filterAiSessionsByMode,
  markInlineTestItemResult,
  prunePersistentInlineRuleTestingState,
  removeInlineTestItem,
  setAiSessionCandidates,
  startAiCandidateTest,
  startOfflineCandidateTest,
} from "./inlineRuleTesting";

describe("inline rule testing state", () => {
  it("keeps multiple candidates testing and exports them as one GKD memory subscription", () => {
    const first = startOfflineCandidateTest(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-a",
        title: "资源 id",
        summary: "稳定资源",
        app: appDraft("[vid=\"skip_a\"]"),
      },
      100,
    );
    const second = startOfflineCandidateTest(
      first,
      {
        mode: "single",
        snapshotId: 2,
        controlKey: "snapshot-2-node-20",
        sourceKey: "selector-b",
        title: "父节点",
        summary: "点击父节点",
        app: appDraft("[vid=\"skip_b\"]"),
      },
      200,
    );

    expect(second.items).toHaveLength(2);
    expect(second.items.map((item) => item.status)).toEqual(["testing", "testing"]);

    const subscription = buildActiveTestSubscription(second);
    expect(subscription.apps[0].groups[0].rules.map((rule) => rule.matches[0])).toEqual([
      "[vid=\"skip_a\"]",
      "[vid=\"skip_b\"]",
    ]);
  });

  it("removes ended candidates from the active memory subscription", () => {
    const state = startOfflineCandidateTest(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-a",
        title: "资源 id",
        summary: "",
        app: appDraft("[vid=\"skip\"]"),
      },
      100,
    );

    const ended = removeInlineTestItem(state, state.items[0].id, 200);

    expect(ended.items[0].status).toBe("tested");
    expect(buildActiveTestSubscription(ended).apps).toHaveLength(0);
  });

  it("keeps offline selector display index and can delete test records", () => {
    const state = startOfflineCandidateTest(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-a",
        title: "资源 id",
        summary: "",
        appName: "Demo",
        nodeId: 20,
        selectorIndex: 3,
        thumbnailUrl: "data:image/jpeg;base64,thumb",
        app: appDraft("[vid=\"skip\"]"),
      },
      100,
    );

    expect(state.items[0]).toMatchObject({
      appName: "Demo",
      nodeId: 20,
      selectorIndex: 3,
      thumbnailUrl: "data:image/jpeg;base64,thumb",
    });

    const deleted = deleteInlineTestItem(state, state.items[0].id, 200);

    expect(deleted.items).toHaveLength(0);
    expect(buildActiveTestSubscription(deleted).apps).toHaveLength(0);
    expect(deleted.updatedAt).toBe(200);
  });

  it("marks successful candidates as importable", () => {
    const state = startOfflineCandidateTest(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-a",
        title: "资源 id",
        summary: "",
        app: appDraft("[vid=\"skip\"]"),
      },
      100,
    );

    const valid = markInlineTestItemResult(state, state.items[0].id, "valid", 200);

    expect(valid.items[0].status).toBe("valid");
    expect(valid.items[0].canImport).toBe(true);
    expect(buildActiveTestSubscription(valid).apps).toHaveLength(0);
  });

  it("freezes AI session context and tests AI candidates through the same state", () => {
    const withSession = addAiSession(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        title: "跳过按钮",
        originalPrompt: "prompt for snapshot 1",
        contextSummary: "node 20",
        appName: "Demo",
        nodeId: 20,
        thumbnailUrl: "data:image/jpeg;base64,thumb",
      },
      100,
    );
    const sessionId = withSession.aiSessions[0].id;
    const withAiTest = startAiCandidateTest(
      withSession,
      sessionId,
      aiCandidate("ai-a", "[vid=\"skip\"]"),
      200,
    );

    expect(withAiTest.aiSessions[0].originalPrompt).toBe("prompt for snapshot 1");
    expect(withAiTest.aiSessions[0]).toMatchObject({
      appName: "Demo",
      nodeId: 20,
      thumbnailUrl: "data:image/jpeg;base64,thumb",
    });
    expect(withAiTest.items[0]).toMatchObject({
      source: "ai-candidate",
      aiSessionId: sessionId,
      status: "testing",
      appName: "Demo",
      nodeId: 20,
      thumbnailUrl: "data:image/jpeg;base64,thumb",
    });
  });

  it("isolates AI candidate test status by session even when candidate ids match", () => {
    const firstSessionState = addAiSession(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        title: "外部 AI",
        originalPrompt: "prompt a",
        contextSummary: "node 20",
      },
      100,
    );
    const secondSessionState = addAiSession(
      firstSessionState,
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        title: "内置 AI",
        originalPrompt: "prompt b",
        contextSummary: "node 20",
      },
      200,
    );
    const secondSessionId = secondSessionState.aiSessions[0].id;
    const firstSessionId = secondSessionState.aiSessions[1].id;
    const withFirstCandidate = startAiCandidateTest(
      secondSessionState,
      firstSessionId,
      aiCandidate("candidate-a", "[vid=\"skip_a\"]"),
      300,
    );
    const firstItemId = withFirstCandidate.items[0].id;
    const firstInvalid = markInlineTestItemResult(
      withFirstCandidate,
      firstItemId,
      "invalid",
      400,
    );
    const withSecondCandidate = startAiCandidateTest(
      firstInvalid,
      secondSessionId,
      aiCandidate("candidate-a", "[vid=\"skip_b\"]"),
      500,
    );

    expect(withSecondCandidate.items).toHaveLength(2);
    expect(withSecondCandidate.items.map((item) => item.sourceKey)).toEqual([
      aiCandidateSourceKey(firstSessionId, "candidate-a", 0),
      aiCandidateSourceKey(secondSessionId, "candidate-a", 0),
    ]);
    expect(withSecondCandidate.items.map((item) => item.status)).toEqual([
      "invalid",
      "testing",
    ]);
  });

  it("resets AI candidate test status after a feedback generation round", () => {
    const state = addAiSession(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        title: "AI session",
        originalPrompt: "prompt",
        contextSummary: "node 20",
      },
      100,
    );
    const sessionId = state.aiSessions[0].id;

    // 第一轮候选
    const firstRound = setAiSessionCandidates(
      state,
      sessionId,
      [aiCandidate("candidate-a", "[vid=\"skip_a\"]")],
      200,
    );
    const firstTest = startAiCandidateTest(firstRound, sessionId, firstRound.aiSessions[0].candidates[0], 300);
    const firstItemId = firstTest.items[0].id;
    const firstInvalid = markInlineTestItemResult(firstTest, firstItemId, "invalid", 400);

    // 反馈后第二轮候选，同名 ID 但不同 generation
    const secondRound = setAiSessionCandidates(
      firstInvalid,
      sessionId,
      [aiCandidate("candidate-a", "[vid=\"skip_b\"]")],
      500,
    );
    const secondTest = startAiCandidateTest(secondRound, sessionId, secondRound.aiSessions[0].candidates[0], 600);

    expect(secondRound.aiSessions[0].generation).toBe(2);
    expect(secondTest.items).toHaveLength(2);
    expect(secondTest.items.map((item) => item.status)).toEqual(["invalid", "testing"]);
    expect(secondTest.items[1].sourceKey).toBe(
      aiCandidateSourceKey(sessionId, "candidate-a", 2),
    );
  });

  it("filters AI sessions by current workspace mode", () => {
    const single = addAiSession(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        title: "单步按钮",
        originalPrompt: "single prompt",
        contextSummary: "node 20",
      },
      100,
    );
    const flow = addAiSession(
      single,
      {
        mode: "flow",
        snapshotId: 2,
        controlKey: "flow:1,2",
        title: "流程规则",
        originalPrompt: "flow prompt",
        contextSummary: "2 steps",
      },
      200,
    );

    expect(filterAiSessionsByMode(flow, "single").map((item) => item.title)).toEqual([
      "单步按钮",
    ]);
    expect(filterAiSessionsByMode(flow, "flow").map((item) => item.title)).toEqual([
      "流程规则",
    ]);
  });

  it("deletes an AI session and its candidate test records", () => {
    const withSession = addAiSession(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        title: "跳过按钮",
        originalPrompt: "prompt",
        contextSummary: "node 20",
      },
      100,
    );
    const sessionId = withSession.aiSessions[0].id;
    const withCandidate = startAiCandidateTest(
      withSession,
      sessionId,
      aiCandidate("ai-a", "[vid=\"skip\"]"),
      200,
    );

    const deleted = deleteAiSession(withCandidate, sessionId, 300);

    expect(deleted.aiSessions).toHaveLength(0);
    expect(deleted.items.some((item) => item.aiSessionId === sessionId)).toBe(false);
    expect(deleted.updatedAt).toBe(300);
  });

  it("persists only offline selector status and AI session-linked candidate status", () => {
    const withOffline = startOfflineCandidateTest(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-a",
        title: "资源 id",
        summary: "",
        app: appDraft("[vid=\"skip_a\"]"),
      },
      100,
    );
    const withSession = addAiSession(
      withOffline,
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        title: "跳过按钮",
        originalPrompt: "prompt",
        contextSummary: "node 20",
        thumbnailUrl: "blob://snapshot-1",
      },
      200,
    );
    const withAi = startAiCandidateTest(
      withSession,
      withSession.aiSessions[0].id,
      aiCandidate("ai-a", "[vid=\"skip_ai\"]"),
      300,
    );
    const noisy = {
      ...withAi,
      items: [
        ...withAi.items,
        {
          id: "flow|flow|1|flow:1|selector-flow",
          source: "flow" as const,
          mode: "flow" as const,
          snapshotId: 1,
          controlKey: "flow:1",
          sourceKey: "selector-flow",
          title: "临时流程",
          summary: "",
          app: appDraft("[vid=\"flow\"]"),
          status: "testing" as const,
          canImport: false,
          createdAt: 400,
          updatedAt: 400,
        },
        {
          id: "ai-candidate|single|1|snapshot-1-node-20|orphan",
          source: "ai-candidate" as const,
          mode: "single" as const,
          snapshotId: 1,
          controlKey: "snapshot-1-node-20",
          sourceKey: "orphan",
          title: "孤立 AI",
          summary: "",
          app: appDraft("[vid=\"orphan\"]"),
          status: "testing" as const,
          canImport: false,
          createdAt: 500,
          updatedAt: 500,
          aiSessionId: "missing-session",
        },
      ],
    };

    const persisted = prunePersistentInlineRuleTestingState(noisy);

    expect(persisted.aiSessions[0].thumbnailUrl).toBe("blob://snapshot-1");
    expect(persisted.items.map((item) => [item.source, item.sourceKey])).toEqual([
      ["offline-selector", "selector-a"],
      ["ai-candidate", aiCandidateSourceKey(withSession.aiSessions[0].id, "ai-a", 0)],
    ]);
  });

  it("keeps only one active test for the same control while preserving tested history", () => {
    const first = startOfflineCandidateTest(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-a",
        title: "资源 id",
        summary: "",
        app: appDraft("[vid=\"skip_a\"]"),
      },
      100,
    );
    const second = startOfflineCandidateTest(
      first,
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-b",
        title: "父节点",
        summary: "",
        app: appDraft("[vid=\"skip_b\"]"),
      },
      200,
    );

    expect(second.items.map((item) => [item.sourceKey, item.status])).toEqual([
      ["selector-a", "tested"],
      ["selector-b", "testing"],
    ]);
    expect(buildActiveTestSubscription(second).apps[0].groups[0].rules[0].matches).toEqual([
      "[vid=\"skip_b\"]",
    ]);
  });

  it("can restart a previously ended selector test", () => {
    const started = startOfflineCandidateTest(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-a",
        title: "资源 id",
        summary: "",
        app: appDraft("[vid=\"skip\"]"),
      },
      100,
    );
    const ended = removeInlineTestItem(started, started.items[0].id, 200);
    const restarted = startOfflineCandidateTest(
      ended,
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-a",
        title: "资源 id",
        summary: "",
        app: appDraft("[vid=\"skip\"]"),
      },
      300,
    );

    expect(restarted.items).toHaveLength(1);
    expect(ended.items[0].status).toBe("tested");
    expect(ended.items[0].canImport).toBe(true);
    expect(restarted.items[0].status).toBe("testing");
  });
});

function appDraft(selector: string): AppRuleDraft {
  return {
    id: "com.demo",
    name: "Demo",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        matchTime: 30000,
        actionMaximum: 1,
        resetMatch: "app",
        rules: [
          {
            key: 0,
            name: "点击跳过",
            matches: [selector],
            fastQuery: true,
          },
        ],
      },
    ],
  };
}

function aiCandidate(id: string, selector: string): AiRuleCandidate {
  return {
    id,
    title: "AI 候选",
    summary: "验证资源 id",
    risk: "低误触",
    app: appDraft(selector),
  };
}
