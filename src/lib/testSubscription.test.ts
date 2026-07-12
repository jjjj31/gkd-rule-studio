import { describe, expect, it } from "vitest";
import {
  addAppDraftToTestSubscription,
  createEmptyTestSubscription,
  exportRawSubscription,
  importJson5ToTestSubscription,
  markTestSubscriptionImported,
  markImportedAndClearBuffer,
  removeImportedRule,
  clearImportedRules,
  wasSelectorImported,
} from "./testSubscription";
import type { AppRuleDraft } from "../types/ruleDraft";

describe("test subscription draft", () => {
  it("adds app drafts and de-duplicates identical selectors", () => {
    const draft = addAppDraftToTestSubscription(
      createEmptyTestSubscription(),
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip\"]"),
    );
    const duplicate = addAppDraftToTestSubscription(
      draft,
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip\"]"),
    );

    expect(duplicate.apps).toHaveLength(1);
    expect(duplicate.apps[0].groups).toHaveLength(1);
    expect(duplicate.apps[0].groups[0].rules).toHaveLength(1);
    expect(duplicate.dirty).toBe(true);
  });

  it("keeps multiple rules in one app group with stable keys", () => {
    const first = addAppDraftToTestSubscription(
      createEmptyTestSubscription(),
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip_a\"]"),
    );
    const second = addAppDraftToTestSubscription(
      first,
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip_b\"]"),
    );

    expect(second.apps).toHaveLength(1);
    expect(second.apps[0].groups).toHaveLength(1);
    expect(second.apps[0].groups[0].rules.map((rule) => rule.key)).toEqual([0, 1]);
    expect(second.apps[0].groups[0].rules.map((rule) => rule.matches[0])).toEqual([
      "[vid=\"skip_a\"]",
      "[vid=\"skip_b\"]",
    ]);
  });

  it("imports AI JSON5 app, group, and subscription shapes", () => {
    const appImported = importJson5ToTestSubscription(
      createEmptyTestSubscription(),
      "{ id: 'com.demo', name: 'Demo', groups: [{ key: 0, name: '开屏广告', rules: [{ key: 0, matches: ['[vid=\"skip\"]'] }] }] }",
    );
    const groupImported = importJson5ToTestSubscription(
      appImported,
      "{ key: 1, name: '弹窗广告', rules: [{ key: 0, matches: ['[vid=\"close\"]'] }] }",
      { id: "com.demo", name: "Demo" },
    );
    const subscriptionImported = importJson5ToTestSubscription(
      groupImported,
      "{ id: 1, name: 'Sub', version: 1, apps: [{ id: 'com.other', name: 'Other', groups: [{ key: 0, name: '开屏广告', rules: [{ key: 0, matches: '[vid=\"skip2\"]' }] }] }] }",
    );

    expect(subscriptionImported.apps.map((app) => app.id)).toEqual([
      "com.demo",
      "com.other",
    ]);
    expect(subscriptionImported.apps[0].groups.map((group) => group.name)).toEqual([
      "开屏广告",
      "弹窗广告",
    ]);
    expect(subscriptionImported.apps[1].groups[0].rules[0].matches).toEqual([
      "[vid=\"skip2\"]",
    ]);
  });

  it("exports strict raw subscription json for GKD memory subscription import", () => {
    const draft = addAppDraftToTestSubscription(
      createEmptyTestSubscription(),
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip\"]"),
    );
    const raw = exportRawSubscription(draft);

    expect(raw).toMatchObject({
      id: 0,
      name: "GKD Rule Studio 测试订阅",
      version: 1,
      author: "local",
    });
    expect(raw.apps[0].groups[0].rules[0].matches).toEqual(["[vid=\"skip\"]"]);
    expect(JSON.stringify(raw)).toContain("\"apps\"");
    expect(JSON.stringify(raw)).not.toContain("undefined");
  });

  it("keeps buffered rules after memory import so they can still be saved locally", () => {
    const draft = addAppDraftToTestSubscription(
      createEmptyTestSubscription(),
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip\"]"),
    );
    const imported = markTestSubscriptionImported(draft, 123);

    expect(imported.apps).toHaveLength(1);
    expect(imported.dirty).toBe(false);
    expect(imported.lastImportedAt).toBe(123);
    expect(imported.lastImportedSummary).toEqual({
      appCount: 1,
      groupCount: 1,
      ruleCount: 1,
    });
    expect(wasSelectorImported(imported, ["[vid=\"skip\"]"])).toBe(false);
  });

  it("clears buffered rules after local save and remembers imported selectors", () => {
    const draft = addAppDraftToTestSubscription(
      createEmptyTestSubscription(),
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip\"]"),
    );
    const imported = markImportedAndClearBuffer(draft, 123);

    expect(imported.apps).toHaveLength(0);
    expect(imported.dirty).toBe(false);
    expect(imported.lastImportedAt).toBe(123);
    expect(imported.lastImportedSummary).toEqual({
      appCount: 1,
      groupCount: 1,
      ruleCount: 1,
    });
    expect(wasSelectorImported(imported, ["[vid=\"skip\"]"])).toBe(true);
    expect(wasSelectorImported(imported, ["[vid=\"other\"]"])).toBe(false);
  });

  it("keeps manageable imported rule records after import", () => {
    const draft = addAppDraftToTestSubscription(
      createEmptyTestSubscription(),
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip\"]"),
    );
    const imported = markImportedAndClearBuffer(draft, 123);

    expect(imported.importedRules).toEqual([
      {
        id: "com.demo|0|0|[vid=\"skip\"]",
        importedAt: 123,
        appId: "com.demo",
        appName: "Demo",
        groupName: "开屏广告",
        ruleName: "点击跳过",
        activityIds: undefined,
        matches: ["[vid=\"skip\"]"],
      },
    ]);

    const removed = removeImportedRule(imported, imported.importedRules[0].id);
    expect(removed.importedRules).toHaveLength(0);
    expect(wasSelectorImported(removed, ["[vid=\"skip\"]"])).toBe(false);

    const cleared = clearImportedRules(imported);
    expect(cleared.importedRules).toHaveLength(0);
    expect(cleared.importedSelectors).toHaveLength(0);
    expect(cleared.lastImportedSummary).toBeUndefined();
  });
});

function appDraft(
  id: string,
  name: string,
  groupName: string,
  selector: string,
): AppRuleDraft {
  return {
    id,
    name,
    groups: [
      {
        key: 0,
        name: groupName,
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
