import { describe, expect, it } from "vitest";
import {
  describeClicked,
  formatBytes,
  formatCapturedAt,
  outcomeLabel,
  reasonLabel,
  summarizeSnapshot,
  type SkipCaptureSummary,
} from "./skipCapture";

const summary: SkipCaptureSummary = {
  id: 1,
  createdAt: new Date(2026, 10, 14, 9, 5, 7).getTime(),
  packageName: "com.demo",
  appLabel: "Demo",
  activityId: "com.demo.MainActivity",
  outcome: "success",
  reason: "node-gone",
  clickedKey: "vid:close_button",
  clickedClass: "android.widget.ImageButton",
  clickedText: "",
  durationMs: 1500,
  nodeCount: 120,
  beforeSource: "buffer",
  outcomeBasis: "node_absent_after_1500ms",
};

describe("skip capture formatting", () => {
  it("labels outcomes and reasons in Chinese", () => {
    expect(outcomeLabel("success")).toBe("成功");
    expect(outcomeLabel("failure")).toBe("未消失");
    expect(outcomeLabel("unknown")).toBe("不确定");
    expect(reasonLabel("node-gone")).toBe("点击后控件消失");
    expect(reasonLabel("ambiguous-window-change")).toBe("页面切换，结果不确定");
    expect(reasonLabel("custom")).toBe("custom");
    expect(reasonLabel("")).toBe("-");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("formats capture timestamps", () => {
    expect(formatCapturedAt(summary.createdAt)).toBe("11-14 09:05:07");
    expect(formatCapturedAt(Number.NaN)).toBe("-");
  });

  it("summarizes snapshots and clicked controls", () => {
    expect(summarizeSnapshot(null)).toBe("无");
    expect(
      summarizeSnapshot({
        id: 1,
        appId: "com.demo",
        activityId: null,
        screenWidth: 1080,
        screenHeight: 2400,
        isLandscape: false,
        nodes: [],
      }),
    ).toBe("0 个节点 · 1080×2400");
    expect(describeClicked(summary)).toBe("ImageButton");
    expect(describeClicked({ ...summary, clickedText: "关闭" })).toBe("关闭");
  });
});
