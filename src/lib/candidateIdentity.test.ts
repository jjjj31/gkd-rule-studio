import { describe, expect, it } from "vitest";
import { candidateDedupeKey, ruleContentKey } from "./candidateIdentity";
import { createEmptyInlineRuleTestingState, findInlineTestItem,
  markInlineTestItemResult, startOfflineCandidateTest } from "./inlineRuleTesting";
import type { AppRuleDraft, SelectorCandidate } from "../types/ruleDraft";

describe("candidate content and device-test evidence", () => {
  it("keeps candidates with different official rule fields distinct", () => {
    const base = {
      rule: { key: 0, matches: ['[text="关闭"]'] },
      actionPlan: { rankAdjustment: 0, riskNotes: [], debugAdvice: [] },
    } as unknown as SelectorCandidate;
    const withBranch = {
      ...base,
      rule: { ...base.rule, anyMatches: ['[text="通知"]'] },
    };

    expect(candidateDedupeKey(withBranch)).not.toBe(candidateDedupeKey(base));
  });

  it("does not reuse a successful result when action or scope changes on the same selector", () => {
    const app: AppRuleDraft = { id: "com.demo", name: "Demo", groups: [{
      key: 0, name: "popup", rules: [{ key: 0, matches: ['[text="关闭"]'], action: "click" }],
    }] };
    const key = ruleContentKey(app);
    let state = startOfflineCandidateTest(createEmptyInlineRuleTestingState(), {
      mode: "single", snapshotId: 1, controlKey: "node-2", sourceKey: key,
      title: "关闭", summary: "fixture", app,
    });
    state = markInlineTestItemResult(state, state.items[0].id, "valid");
    const changed = structuredClone(app);
    changed.groups[0].rules[0].action = "longClick";
    changed.groups[0].rules[0].activityIds = ".OtherActivity";
    expect(findInlineTestItem(state, "offline-selector", "single", 1,
      "node-2", ruleContentKey(changed))).toBeNull();
    expect(findInlineTestItem(state, "offline-selector", "single", 1,
      "node-2", key)?.status).toBe("valid");
  });
});
