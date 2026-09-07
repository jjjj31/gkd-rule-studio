import { describe, expect, it } from "vitest";
import {
  loadSnapshotNames,
  persistSnapshotNames,
  sanitizeSnapshotFileName,
  snapshotOptionLabel,
} from "./snapshotNames";
import { formatSnapshotOption } from "./deviceApi";
import type { DeviceSnapshotSummary } from "../types/gkdSnapshot";

describe("snapshotNames", () => {
  it("sanitizes illegal filename characters and keeps chinese names", () => {
    expect(sanitizeSnapshotFileName("微信/开屏:广告*?")).toBe("微信 开屏 广告");
    expect(sanitizeSnapshotFileName("  多个   空格\t换行  ")).toBe("多个 空格 换行");
    expect(sanitizeSnapshotFileName("结尾点... ")).toBe("结尾点");
    expect(sanitizeSnapshotFileName("名字.")).toBe("名字");
    expect(sanitizeSnapshotFileName("a".repeat(80)).length).toBe(60);
    expect(sanitizeSnapshotFileName("   ")).toBe("");
    expect(sanitizeSnapshotFileName("微信开屏")).toBe("微信开屏");
  });

  it("labels renamed snapshots with the custom name first", () => {
    const snapshot = summary();
    const auto = snapshotOptionLabel(snapshot, null);
    expect(auto).toBe(snapshotOptionLabel(snapshot));
    expect(snapshotOptionLabel(snapshot, " 微信开屏 ")).toBe(
      `微信开屏（${auto}）`,
    );
  });

  // 回归：#1 黑屏。GKD 在桌面/系统界面抓的快照 activityId 为 null，
  // 首页列表渲染 shortActivity 丢异常会把整棵 React 树卸载成黑屏。
  it("renders snapshot labels when activityId is null", () => {
    const snapshot: DeviceSnapshotSummary = {
      ...summary(),
      id: 1786809355900,
      activityId: null,
    };
    const label = snapshotOptionLabel(snapshot, null);
    expect(label).toContain("未知页面");
    expect(formatSnapshotOption(snapshot)).toContain("未知页面");
    expect(snapshotOptionLabel(snapshot, "桌面截图")).toContain("桌面截图");
  });

  it("persists and reloads names through localStorage", () => {
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    const store = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      length: 0,
      clear: () => store.clear(),
      getItem: (key) => store.get(key) ?? null,
      key: () => null,
      removeItem: (key) => void store.delete(key),
      setItem: (key, value) => void store.set(key, value),
    };

    try {
      persistSnapshotNames({ "1786809355977": "微信开屏" });
      expect(loadSnapshotNames()).toEqual({ "1786809355977": "微信开屏" });

      // 空名条目视为删除，损坏 JSON 回退空表。
      persistSnapshotNames({ "1": "  " });
      expect(loadSnapshotNames()).toEqual({});
      store.set("gkd-rule-studio-snapshot-names", "{not json");
      expect(loadSnapshotNames()).toEqual({});
    } finally {
      (globalThis as { localStorage?: Storage }).localStorage = original;
    }
  });
});

function summary(): DeviceSnapshotSummary {
  return {
    id: 1786809355977,
    appId: "com.demo.app",
    activityId: "com.demo.app.MainActivity",
    screenWidth: 1080,
    screenHeight: 1920,
    isLandscape: false,
    appInfo: { id: "com.demo.app", name: "演示应用" },
  };
}
