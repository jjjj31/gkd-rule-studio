import { describe, expect, it } from "vitest";
import type { AppRuleDraft } from "../types/ruleDraft";
import type { AiRuleCandidate } from "./aiModel";
import {
  addAiSession,
  aiCandidateSourceKey,
  appendAiSessionFeedback,
  buildActiveTestSubscription,
  clearFinishedInlineTestItems,
  createEmptyInlineRuleTestingState,
  deleteAiSession,
  deleteInlineTestItem,
  endAllInlineTests,
  filterAiSessionsByMode,
  markInlineTestItemImported,
  markInlineTestItemResult,
  prunePersistentInlineRuleTestingState,
  removeInlineTestItem,
  restartInlineTestItem,
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

  it("automatically ends round 1 active testing items and records feedback history when round 2 arrives", () => {
    const withSession = addAiSession(
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
    const sessionId = withSession.aiSessions[0].id;

    // 第一轮候选加入测试但用户未手动点结束就直接发了第二轮反馈
    const round1 = setAiSessionCandidates(
      withSession,
      sessionId,
      [aiCandidate("candidate-a", "[vid=\"skip_round1\"]")],
      200,
    );
    const round1Testing = startAiCandidateTest(
      round1,
      sessionId,
      round1.aiSessions[0].candidates[0],
      300,
    );
    expect(round1Testing.items[0].status).toBe("testing");
    expect(round1Testing.items[0].generation).toBe(1);

    // 第二轮反馈返回同名 candidate-a
    const round2 = setAiSessionCandidates(
      round1Testing,
      sessionId,
      [aiCandidate("candidate-a", "[vid=\"skip_round2\"]")],
      400,
      {
        at: 400,
        generation: 1,
        note: "测试版 A: 未触发",
        items: [
          {
            candidateId: "candidate-a",
            title: "AI 候选",
            result: "not-triggered",
            note: "未触发",
            selectors: ["[vid=\"skip_round1\"]"],
          },
        ],
      },
    );

    // 第一轮仍在 testing 的项必须自动结束，不再留在 GKD 活跃测试订阅里与第二轮混淆
    expect(round2.items[0].status).toBe("ended");
    expect(round2.items[0].canImport).toBe(false);
    expect(buildActiveTestSubscription(round2).apps).toHaveLength(0);
    expect(round2.aiSessions[0].generation).toBe(2);
    expect(round2.aiSessions[0].feedbackHistory).toHaveLength(1);
    expect(round2.aiSessions[0].feedbackHistory[0].generation).toBe(1);

    // 第二轮加入测试后，活跃订阅只包含第二轮规则
    const round2Testing = startAiCandidateTest(
      round2,
      sessionId,
      round2.aiSessions[0].candidates[0],
      500,
    );
    expect(round2Testing.items[1].generation).toBe(2);
    expect(
      buildActiveTestSubscription(round2Testing).apps[0].groups[0].rules[0].matches,
    ).toEqual(["[vid=\"skip_round2\"]"]);
  });

  it("supports restarting, marking imported, ending all active tests, and clearing finished items", () => {
    const first = startOfflineCandidateTest(
      createEmptyInlineRuleTestingState(),
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        sourceKey: "selector-a",
        title: "资源 A",
        summary: "",
        app: appDraft("[vid=\"skip_a\"]"),
      },
      100,
    );
    const second = startOfflineCandidateTest(
      first,
      {
        mode: "single",
        snapshotId: 2,
        controlKey: "snapshot-2-node-30",
        sourceKey: "selector-b",
        title: "资源 B",
        summary: "",
        app: appDraft("[vid=\"skip_b\"]"),
      },
      200,
    );

    const endedAll = endAllInlineTests(second, 300);
    expect(endedAll.items.map((item) => item.status)).toEqual(["tested", "tested"]);
    expect(buildActiveTestSubscription(endedAll).apps).toHaveLength(0);

    const importedFirst = markInlineTestItemImported(endedAll, endedAll.items[0].id, 350);
    expect(importedFirst.items[0].importedAt).toBe(350);

    const restartedSecond = restartInlineTestItem(
      importedFirst,
      importedFirst.items[1].id,
      400,
    );
    expect(restartedSecond.items[1].status).toBe("testing");

    const clearedFinished = clearFinishedInlineTestItems(restartedSecond, 500);
    expect(clearedFinished.items).toHaveLength(1);
    expect(clearedFinished.items[0].sourceKey).toBe("selector-b");

    const withSession = addAiSession(
      clearedFinished,
      {
        mode: "single",
        snapshotId: 1,
        controlKey: "snapshot-1-node-20",
        title: "外部 AI",
        originalPrompt: "p",
        contextSummary: "c",
      },
      600,
    );
    const withAppendedFeedback = appendAiSessionFeedback(
      withSession,
      withSession.aiSessions[0].id,
      { at: 650, generation: 1, note: "外部反馈记录" },
      650,
    );
    expect(withAppendedFeedback.aiSessions[0].feedbackHistory).toEqual([
      { at: 650, generation: 1, note: "外部反馈记录" },
    ]);
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
