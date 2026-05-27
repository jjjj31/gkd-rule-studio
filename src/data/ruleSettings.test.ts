import { describe, expect, it } from "vitest";
import { RULE_SETTINGS_PRESETS } from "./ruleSettings";
import { normalizeSnapshot } from "../lib/snapshotZip";
import type { RawGkdSnapshot } from "../types/gkdSnapshot";

describe("rule settings presets", () => {
  it("includes a random interstitial preset for popups that may appear anytime", () => {
    const snapshot = normalizeSnapshot(buildRawSnapshot(), "blob://demo", "demo");
    const preset = RULE_SETTINGS_PRESETS.find(
      (item) => item.id === "random-interstitial",
    );

    expect(preset).toBeDefined();
    expect(preset?.label).toContain("插屏广告");
    expect(preset?.description).toContain("不知道什么时候");
    expect(preset?.detail).toContain("不要填 matchTime");
    expect(preset?.build(snapshot)).toEqual({
      groupName: "插屏广告",
      activityIds: "com.demo.MainActivity",
      matchTime: null,
      actionMaximum: 1,
      actionCd: 3000,
      resetMatch: "match",
    });
  });
});

function buildRawSnapshot(): RawGkdSnapshot {
  return {
    id: 1,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 1080,
    screenHeight: 1920,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes: [],
  };
}
