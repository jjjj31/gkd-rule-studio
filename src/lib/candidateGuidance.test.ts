import { describe, expect, it } from "vitest";
import { getCandidateGuidance } from "./candidateGuidance";
import type { SelectorCandidate } from "../types/ruleDraft";

describe("candidate guidance", () => {
  it("marks the top low-risk unique skip parent as the default choice", () => {
    const guidance = getCandidateGuidance(
      candidate({
        strategyName: "stableResourceSemantic",
        match: '[vid="tobid_interstitial_skip_ll"][visibleToUser=true]',
      }),
      0,
    );

    expect(guidance.tone).toBe("recommend");
    expect(guidance.label).toBe("建议选这个");
    expect(guidance.reason).toContain("小白用户");
  });

  it("warns users away from ad overlays and click hot areas", () => {
    const guidance = getCandidateGuidance(
      candidate({
        strategyName: "exactVid",
        match: '[vid="tobid_interstitial_skip_shade"][visibleToUser=true]',
      }),
      1,
    );

    expect(guidance.tone).toBe("danger");
    expect(guidance.label).toBe("不要优先选");
    expect(guidance.reason).toContain("遮罩或广告热区");
  });

  it("warns when the selector targets countdown text instead of the clickable parent", () => {
    const guidance = getCandidateGuidance(
      candidate({
        strategyName: "textSkipGuarded",
        match: 'TextView[text^="跳过"][text.length<10][width<=500][height<=300][visibleToUser=true]',
      }),
      2,
    );

    expect(guidance.tone).toBe("caution");
    expect(guidance.label).toBe("先看父节点");
    expect(guidance.reason).toContain("倒计时文字");
  });
});

function candidate(input: {
  strategyName: SelectorCandidate["strategyName"];
  match: string;
  hitCount?: number;
  riskLevel?: SelectorCandidate["risk"]["level"];
  finalScore?: number;
}): SelectorCandidate {
  return {
    id: `${input.strategyName}-${input.match}`,
    strategyName: input.strategyName,
    title: input.strategyName,
    plan: {
      kind: "simple",
      selector: { conditions: [] },
    },
    rule: {
      key: 0,
      matches: [input.match],
    },
    actionPlan: {
      rankAdjustment: 0,
      riskNotes: [],
      debugAdvice: [],
    },
    groupName: "开屏广告",
    baseScore: input.finalScore ?? 100,
    validation: {
      hitCount: input.hitCount ?? 1,
      clickNodes: [],
      supportNodes: [],
    },
    risk: {
      finalScore: input.finalScore ?? 100,
      level: input.riskLevel ?? "low",
      items: [],
      positiveScore: input.finalScore ?? 100,
      cappedPositiveScore: input.finalScore ?? 100,
      penaltyScore: 0,
    },
    riskNotes: [],
    debugAdvice: [],
    debugReasons: [],
  };
}
