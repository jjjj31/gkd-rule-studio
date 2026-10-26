import { describe, expect, it } from "vitest";
import {
  classifyAuthoringFeedback,
  formatAuthoringFeedbackEvidence,
  normalizeAuthoringFeedbackResult,
} from "./authoringFeedback";

describe("authoring feedback", () => {
  it("keeps legacy results and maps new categories without inventing a root cause", () => {
    expect(classifyAuthoringFeedback({ result: "not-triggered" })).toMatchObject({
      legacyResult: "not-triggered",
      category: "not-triggered",
      evidence: "user-observation",
      confidence: "unknown",
    });
    expect(classifyAuthoringFeedback({ result: "triggered-no-close" })).toMatchObject({
      category: "triggered-no-close",
      evidence: "user-observation",
      confidence: "observed",
    });
    expect(normalizeAuthoringFeedbackResult("node-unavailable")).toBe(
      "node-unavailable",
    );
    expect(normalizeAuthoringFeedbackResult("legacy-invalid-value")).toBe("other");
  });

  it("distinguishes static mismatch from runtime scope and timing uncertainty", () => {
    const staticMismatch = classifyAuthoringFeedback({
      result: "static-unsatisfied",
      staticValidation: "unsatisfied",
      diagnostics: ["当前 Activity 不匹配"],
    });
    expect(staticMismatch).toMatchObject({
      category: "static-unsatisfied",
      evidence: "static-validation",
      confidence: "observed",
    });
    expect(staticMismatch.reasons).toContain("当前 Activity 不匹配");

    const scope = classifyAuthoringFeedback({
      result: "scope-or-timing-pending",
      limitations: ["设备只在匹配窗口内执行规则"],
    });
    expect(scope).toMatchObject({
      category: "scope-or-timing-pending",
      evidence: "unknown",
      confidence: "unknown",
    });
    expect(scope.reasons).toContain("设备只在匹配窗口内执行规则");
  });

  it("only treats static-unsatisfied as objective evidence when validation is unsatisfied", () => {
    for (const staticValidation of ["satisfied", "partial", "unknown", undefined] as const) {
      expect(classifyAuthoringFeedback({
        result: "static-unsatisfied",
        staticValidation,
        note: "用户认为静态条件不满足",
      })).toMatchObject({
        category: "static-unsatisfied",
        evidence: "unknown",
        confidence: "unknown",
      });
    }
  });

  it("provides one short repair action for each category and preserves user notes", () => {
    const cases = [
      ["node-unavailable", "节点不可用", "重新抓取快照"],
      ["static-unsatisfied", "静态条件不满足", "检查页面和 App 版本"],
      ["scope-or-timing-pending", "范围或时机待核对", "核对 Activity"],
      ["triggered-no-close", "触发但未关闭（用户观察）", "检查动作和目标"],
      ["mistouch", "误触（用户观察）", "缩窄 selector"],
      ["not-triggered", "未触发（用户观察）", "重新测试"],
      ["other", "其他问题", "补充症状"],
    ] as const;

    for (const [result, label, repair] of cases) {
      const feedback = classifyAuthoringFeedback({
        result,
        note: "用户备注必须保留",
      });
      expect(feedback.label).toContain(label);
      expect(feedback.repairHint).toContain(repair);
      expect(feedback.note).toBe("用户备注必须保留");
      expect(feedback.repairHint.length).toBeLessThanOrEqual(80);
    }
  });

  it("uses short user-facing evidence labels", () => {
    expect(formatAuthoringFeedbackEvidence("user-observation")).toBe("用户反馈");
    expect(formatAuthoringFeedbackEvidence("static-validation")).toBe("快照验证");
    expect(formatAuthoringFeedbackEvidence("unknown")).toBe("待核对");
  });
});
