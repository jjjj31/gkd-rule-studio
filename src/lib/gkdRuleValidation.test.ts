import { describe, expect, it } from "vitest";
import {
  formatGkdRuleValidationIssues,
  validateAppRuleDraft,
} from "./gkdRuleValidation";

describe("gkd rule runtime validation", () => {
  it("rejects the Issue #12 matchRoot-as-selector shape", () => {
    const validation = validateAppRuleDraft({
      id: "com.copymanga.app",
      name: "拷貝漫畫",
      groups: [{
        key: 0,
        name: "开屏广告",
        rules: [{
          key: 0,
          matches: ['[vid="ad_close"][desc^="关闭"][visibleToUser=true]'],
          matchRoot: "content_container",
        }],
      }],
    }, { strict: true });

    expect(validation.valid).toBe(false);
    expect(formatGkdRuleValidationIssues(validation)).toContain(
      "app.groups[0].rules[0].matchRoot",
    );
    expect(formatGkdRuleValidationIssues(validation)).toContain("布尔值");
  });

  it("rejects an unparsable selector before it reaches the test zone", () => {
    const validation = validateAppRuleDraft({
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "g",
        rules: [{ key: 0, matches: ["not a selector ???"] }],
      }],
    }, { strict: true, validateSelectors: true });

    expect(validation.valid).toBe(false);
    expect(validation.issues.some((item) => item.code === "selector-syntax")).toBe(true);
  });

  it("allows string shorthand when validating imported subscriptions", () => {
    const validation = validateAppRuleDraft({
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "g",
        rules: [{ matches: '[vid="skip"]', matchRoot: true }],
        customGroupField: true,
      }],
      customAppField: true,
    }, { strict: false, validateSelectors: false });

    expect(validation.valid).toBe(true);
  });
});
