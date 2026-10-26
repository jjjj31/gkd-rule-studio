import { describe, expect, it } from "vitest";
import { describeRulePreview } from "./authoringPreview";
import { normalizeSnapshot } from "./snapshotNormalize";
import type { RawGkdSnapshot } from "../types/gkdSnapshot";
import type { AppRuleDraft, SelectorValidation } from "../types/ruleDraft";

const snapshot = normalizeSnapshot({
  id: 1, appId: "com.demo", activityId: "com.demo.MainActivity",
  screenWidth: 100, screenHeight: 200, isLandscape: false, nodes: [],
} satisfies RawGkdSnapshot, "", "fixture");
const validation: SelectorValidation = { hitCount: 1, clickNodes: [], supportNodes: [] };

describe("rule preview shown before device testing", () => {
  it("describes inherited limits and rule overrides from the delivered app rule", () => {
    const app: AppRuleDraft = {
      id: "com.demo", name: "Demo", groups: [{
        key: 0, name: "弹窗", matchTime: 10000, actionMaximum: 1, resetMatch: "app",
        rules: [{ key: 0, matches: ['[text="关闭"]'], action: "longClick", actionMaximum: 2,
          activityIds: ".MainActivity" }],
      }],
    };
    const preview = describeRulePreview(app, snapshot, validation);
    expect(preview.summaries[0]).toContain("长按");
    expect(preview.summaries[0]).toContain("最多 2 次");
    expect(preview.summaries[0]).toContain("重新进入应用后 10 秒内");
    expect(preview.summaries[0]).toContain("MainActivity");
    expect(preview.unknowns.join(" ")).toContain("时间");
    expect(preview.status).toBe("当前快照命中 1 个点击目标");
  });

  it("does not invent a time window for a periodic scenario or claim device success", () => {
    const app: AppRuleDraft = { id: "com.demo", name: "Demo", groups: [{
      key: 0, name: "周期弹窗", actionCd: 3000, resetMatch: "match", rules: [{ key: 0, matches: ['[text="关闭"]'] }],
    }] };
    const preview = describeRulePreview(app, snapshot, validation);
    expect(preview.summaries[0]).toContain("间隔至少 3 秒");
    expect(preview.summaries[0]).not.toContain("秒内");
    expect(preview.unknowns.join(" ")).toContain("事件节点");
    expect(preview.snapshotLabel).toContain("快照 #1");
    expect(preview.status).not.toContain("有效");
  });

  it("reports partial and unsatisfied rule conditions instead of implying a complete validation", () => {
    const app: AppRuleDraft = { id: "com.demo", name: "Demo", groups: [] };
    const partial = describeRulePreview(app, snapshot, {
      ...validation, status: "partial", diagnostics: ["版本范围信息不足"],
    });
    expect(partial.status).toContain("未完整验证");
    expect(partial.diagnostics).toContain("版本范围信息不足");
    const failed = describeRulePreview(app, snapshot, {
      ...validation, hitCount: 0, status: "unsatisfied", diagnostics: ["当前 Activity 不匹配"],
    });
    expect(failed.status).toBe("当前快照不满足规则条件");
  });
});
