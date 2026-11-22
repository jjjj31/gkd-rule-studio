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

  it("rejects empty activityIds strings and arrays containing empty strings", () => {
    const emptyString = validateAppRuleDraft({
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "g",
        activityIds: "",
        rules: [{ key: 0, matches: ['[vid="skip"]'] }],
      }],
    }, { strict: true, validateSelectors: false });

    expect(emptyString.valid).toBe(false);
    expect(emptyString.issues.some((item) => item.path === "app.groups[0].activityIds" && item.code === "value")).toBe(true);

    const arrayWithEmpty = validateAppRuleDraft({
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "g",
        rules: [{ key: 0, matches: ['[vid="skip"]'], activityIds: ["com.demo.Main", "  "] }],
      }],
    }, { strict: true, validateSelectors: false });

    expect(arrayWithEmpty.valid).toBe(false);
    expect(arrayWithEmpty.issues.some((item) => item.path === "app.groups[0].rules[0].activityIds[1]" && item.code === "value")).toBe(true);

    const emptyArrayOverride = validateAppRuleDraft({
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "g",
        activityIds: ".Other",
        rules: [{ key: 0, matches: ['[vid="skip"]'], activityIds: [] }],
      }],
    }, { strict: true, validateSelectors: false });

    expect(emptyArrayOverride.valid).toBe(true);
  });

  it("validates non-negative integer timing fields and actionMaximum >= 1", () => {
    const badTiming = validateAppRuleDraft({
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "g",
        matchTime: -1,
        actionDelay: -10,
        delay: 1.5,
        actionCd: -5,
        cd: -2,
        forcedTime: -100,
        actionMaximum: 0,
        rules: [{
          key: 0,
          matches: ['[vid="skip"]'],
          matchTime: 100.5,
          actionDelay: -1,
          actionCd: -1,
          forcedTime: -1,
          actionMaximum: 0,
        }],
      }],
    }, { strict: true, validateSelectors: false });

    expect(badTiming.valid).toBe(false);
    const paths = badTiming.issues.map((item) => item.path);
    expect(paths).toContain("app.groups[0].matchTime");
    expect(paths).toContain("app.groups[0].actionDelay");
    expect(paths).toContain("app.groups[0].delay");
    expect(paths).toContain("app.groups[0].actionCd");
    expect(paths).toContain("app.groups[0].cd");
    expect(paths).toContain("app.groups[0].forcedTime");
    expect(paths).toContain("app.groups[0].actionMaximum");
    expect(paths).toContain("app.groups[0].rules[0].matchTime");
    expect(paths).toContain("app.groups[0].rules[0].actionDelay");
    expect(paths).toContain("app.groups[0].rules[0].actionCd");
    expect(paths).toContain("app.groups[0].rules[0].forcedTime");
    expect(paths).toContain("app.groups[0].rules[0].actionMaximum");

    const zeroAllowed = validateAppRuleDraft({
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "g",
        matchTime: 0,
        actionDelay: 0,
        actionCd: 0,
        forcedTime: 0,
        actionMaximum: 1,
        rules: [{ key: 0, matches: ['[vid="skip"]'] }],
      }],
    }, { strict: true, validateSelectors: false });

    expect(zeroAllowed.valid).toBe(true);
  });

  it("emits a single issue when action is not a string", () => {
    const validation = validateAppRuleDraft({
      id: "com.demo",
      name: "Demo",
      groups: [{
        key: 0,
        name: "g",
        rules: [{ key: 0, matches: ['[vid="skip"]'], action: 123 }],
      }],
    }, { strict: true, validateSelectors: false });

    expect(validation.valid).toBe(false);
    const actionIssues = validation.issues.filter(
      (item) => item.path === "app.groups[0].rules[0].action",
    );
    expect(actionIssues).toHaveLength(1);
    expect(actionIssues[0].code).toBe("type");
  });
});
