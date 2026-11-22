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

  it("does not merge groups with different names or differing group-level runtime fields", () => {
    const first = addAppDraftToTestSubscription(
      createEmptyTestSubscription(),
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip\"]"),
    );

    // 同 key=0 但不同组名：必须新建独立 group
    const differentName = addAppDraftToTestSubscription(first, {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "弹窗广告",
          matchTime: 30000,
          actionMaximum: 1,
          resetMatch: "app",
          rules: [{ key: 0, matches: ['[vid="close"]'] }],
        },
      ],
    });
    expect(differentName.apps[0].groups).toHaveLength(2);
    expect(differentName.apps[0].groups.map((g) => g.key)).toEqual([0, 1]);
    expect(differentName.apps[0].groups.map((g) => g.name)).toEqual(["开屏广告", "弹窗广告"]);

    // 同组名但 group 级运行字段（matchRoot/forcedTime）不同：不能静默丢字段，应新建独立 group
    const differentRuntime = addAppDraftToTestSubscription(first, {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "开屏广告",
          matchTime: 10000,
          forcedTime: 10000,
          matchRoot: true,
          actionMaximum: 3,
          actionCd: 1000,
          resetMatch: "app",
          rules: [{ key: 0, matches: ['[text^="跳过"]'], action: "clickCenter" }],
        },
      ],
    });
    expect(differentRuntime.apps[0].groups).toHaveLength(2);
    expect(differentRuntime.apps[0].groups[1]).toMatchObject({
      key: 1,
      matchRoot: true,
      forcedTime: 10000,
      matchTime: 10000,
    });
  });

  it("does not merge groups with preKeys/actionCdKey/actionMaximumKey and preserves original rule keys", () => {
    const first = addAppDraftToTestSubscription(
      createEmptyTestSubscription(),
      appDraft("com.demo", "Demo", "开屏广告", "[vid=\"skip\"]"),
    );

    const withPreKeys = addAppDraftToTestSubscription(first, {
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
            { key: 10, matches: ['[text="第一步"]'] },
            { key: 20, preKeys: [10], matches: ['[text="第二步"]'] },
          ],
        },
      ],
    });

    expect(withPreKeys.apps[0].groups).toHaveLength(2);
    expect(withPreKeys.apps[0].groups[1].rules.map((r) => r.key)).toEqual([10, 20]);
    expect(withPreKeys.apps[0].groups[1].rules[1].preKeys).toEqual([10]);
  });

  it("distinguishes rules with identical matches but different runtime/selector fields", () => {
    const first = addAppDraftToTestSubscription(
      createEmptyTestSubscription(),
      {
        id: "com.demo",
        name: "Demo",
        groups: [
          {
            key: 0,
            name: "开屏广告",
            rules: [{ key: 0, matches: ['[vid="skip"]'], action: "clickNode" }],
          },
        ],
      },
    );
    const second = addAppDraftToTestSubscription(first, {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "开屏广告",
          rules: [
            { key: 0, matches: ['[vid="skip"]'], action: "clickCenter", actionDelay: 1500 },
          ],
        },
      ],
    });
    const third = addAppDraftToTestSubscription(second, {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "开屏广告",
          rules: [
            {
              key: 0,
              matches: ['[vid="skip"]'],
              action: "clickNode",
              excludeMatches: ['[text="广告详情"]'],
            },
          ],
        },
      ],
    });

    expect(third.apps[0].groups).toHaveLength(1);
    expect(third.apps[0].groups[0].rules).toHaveLength(3);
  });

  it("does not swallow rules sharing selector when actionMaximum/actionCd/forcedTime differ", () => {
    const base = addAppDraftToTestSubscription(createEmptyTestSubscription(), {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "开屏广告",
          rules: [{ key: 0, matches: ['[vid="skip"]'], actionMaximum: 1 }],
        },
      ],
    });
    const withDiffMax = addAppDraftToTestSubscription(base, {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "开屏广告",
          rules: [{ key: 0, matches: ['[vid="skip"]'], actionMaximum: 3 }],
        },
      ],
    });
    const withDiffCd = addAppDraftToTestSubscription(withDiffMax, {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "开屏广告",
          rules: [
            { key: 0, matches: ['[vid="skip"]'], actionMaximum: 1, actionCd: 1500 },
          ],
        },
      ],
    });
    const withDiffForcedTime = addAppDraftToTestSubscription(withDiffCd, {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "开屏广告",
          rules: [
            { key: 0, matches: ['[vid="skip"]'], actionMaximum: 1, forcedTime: 10000 },
          ],
        },
      ],
    });

    expect(withDiffForcedTime.apps[0].groups).toHaveLength(1);
    expect(withDiffForcedTime.apps[0].groups[0].rules).toHaveLength(4);
  });

  it("does not merge same-name groups when delay or versionCodes differ", () => {
    const first = addAppDraftToTestSubscription(createEmptyTestSubscription(), {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "局部广告",
          rules: [{ key: 0, matches: ['[vid="close_a"]'] }],
        },
      ],
    });
    const withDelay = addAppDraftToTestSubscription(first, {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "局部广告",
          delay: 800,
          rules: [{ key: 0, matches: ['[vid="close_b"]'] }],
        } as AppRuleDraft["groups"][number],
      ],
    });
    const withVersionCodes = addAppDraftToTestSubscription(withDelay, {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "局部广告",
          versionCodes: [100, 101],
          rules: [{ key: 0, matches: ['[vid="close_c"]'] }],
        },
      ],
    });

    expect(withVersionCodes.apps[0].groups).toHaveLength(3);
    expect((withVersionCodes.apps[0].groups[1] as Record<string, unknown>).delay).toBe(800);
    expect(withVersionCodes.apps[0].groups[2].versionCodes).toEqual([100, 101]);
  });

  it("supports anyMatches-only rules without emitting empty matches array", () => {
    const imported = importJson5ToTestSubscription(
      createEmptyTestSubscription(),
      "{ id: 'com.demo', name: 'Demo', groups: [{ key: 0, name: '开屏广告', rules: [{ key: 0, anyMatches: ['[vid=\"skip\"]', '[text^=\"跳过\"]'] }] }] }",
    );

    const raw = exportRawSubscription(imported);
    const exportedRule = raw.apps[0].groups[0].rules[0] as unknown as Record<string, unknown>;
    expect("matches" in exportedRule).toBe(false);
    expect(exportedRule.anyMatches).toEqual(['[vid="skip"]', '[text^="跳过"]']);

    const cleared = markImportedAndClearBuffer(imported, 456);
    expect(cleared.importedRules).toHaveLength(1);
    expect(cleared.importedRules[0].matches).toEqual(['[vid="skip"]', '[text^="跳过"]']);
    expect(wasSelectorImported(cleared, ['[vid="skip"]', '[text^="跳过"]'])).toBe(true);
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
