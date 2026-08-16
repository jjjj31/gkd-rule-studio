import { describe, expect, it } from "vitest";
import { normalizeSnapshot } from "./snapshotNormalize";
import {
  buildSnapshotExport,
  buildSnapshotMarkdown,
  saveExportedFile,
  snapshotExportFileStem,
} from "./snapshotExport";
import type {
  RawGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

describe("snapshotExport", () => {
  it("builds a file stem from snapshot time and sanitized app id", () => {
    const date = new Date(2026, 7, 15, 22, 10, 33);
    expect(snapshotExportFileStem({ id: date.getTime(), appId: "com.demo.app" })).toBe(
      "gkd-snapshot-20260815-221033-com.demo.app",
    );
    expect(
      snapshotExportFileStem({ id: date.getTime(), appId: "com.奇怪/demo app" }),
    ).toBe("gkd-snapshot-20260815-221033-com._demo_app");
  });

  it("falls back to raw id when snapshot id is not a timestamp", () => {
    expect(snapshotExportFileStem({ id: 42, appId: "com.demo" })).toBe(
      "gkd-snapshot-42-com.demo",
    );
  });

  it("exports markdown with metadata, screenshot reference and nested node tree", () => {
    const snapshotId = new Date(2025, 7, 15, 22, 30, 30).getTime();
    const snapshot = buildSnapshot(snapshotId, {
      appId: "com.demo",
      appInfo: { id: "com.demo", name: "Demo 应用", versionName: "1.2.3", versionCode: 12 },
    });

    const now = new Date(2026, 7, 16, 16, 0, 0);
    const files = buildSnapshotExport(snapshot, now);

    expect(files.markdownName).toBe("gkd-snapshot-20250815-223030-com.demo.md");
    expect(files.screenshotName).toBe("gkd-snapshot-20250815-223030-com.demo.png");

    const md = files.markdownContent;
    expect(md).toContain("# GKD 快照导出 — Demo 应用");
    expect(md).toContain(`![截图](./${files.screenshotName})`);
    expect(md).toContain("| 包名 | com.demo |");
    expect(md).toContain("| 应用版本 | 1.2.3 (12) |");
    expect(md).toContain("| Activity | com.demo.MainActivity |");
    expect(md).toContain("| 分辨率 | 1080 × 1920（竖屏） |");
    expect(md).toContain("由 GKD Rule Studio 导出于 2026-08-16 16:00:00");

    // 根节点在前、子节点多一级缩进，文本与坐标完整保留。
    const rootLine = md.split("\n").find((line) => line.startsWith("- `android.widget.FrameLayout`"));
    const childLine = md
      .split("\n")
      .find((line) => line.includes("android.widget.Button"));
    expect(rootLine).toBeDefined();
    expect(childLine).toBeDefined();
    expect(childLine!.startsWith("  - ")).toBe(true);
    expect(childLine).toContain("text=`跳过`");
    expect(childLine).toContain("[可点击]");
    expect(childLine).toContain("`[100,300][260,380]`");
  });

  it("still exports orphan nodes whose parent id is missing", () => {
    const raw: RawGkdSnapshot = {
      id: 1755271833000,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 1920,
      isLandscape: false,
      nodes: [
        node(0, -1, attr({ name: "android.widget.FrameLayout" })),
        node(9, 404, attr({ name: "android.widget.TextView", text: "孤节点" })),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "blob://demo", "测试快照");

    const md = buildSnapshotMarkdown(snapshot, "shot.png");

    expect(md).toContain("_(未挂载节点)_");
    expect(md).toContain("text=`孤节点`");
  });

  it("escapes markdown-hostile characters in text values", () => {
    const raw: RawGkdSnapshot = {
      id: 1755271833000,
      appId: "com.demo",
      activityId: "com.demo.MainActivity",
      screenWidth: 1080,
      screenHeight: 1920,
      isLandscape: false,
      nodes: [
        node(
          0,
          -1,
          attr({ name: "android.widget.TextView", text: "带`反引号`\n换行" }),
        ),
      ],
    };
    const snapshot = normalizeSnapshot(raw, "blob://demo", "测试快照");

    const md = buildSnapshotMarkdown(snapshot, "shot.png");

    expect(md).toContain("text=`带'反引号' 换行`");
  });

  it("invokes the android bridge as a method call so this stays bound", async () => {
    const globalWithWindow = globalThis as { window?: unknown };
    const originalWindow = globalWithWindow.window;
    const calls: Array<{ thisValue: unknown; fileName: string; mime: string; base64: string }>= [];
    const bridge = {
      saveFile(this: unknown, fileName: string, mime: string, base64: string) {
        calls.push({ thisValue: this, fileName, mime, base64 });
      },
    };
    globalWithWindow.window = { GkdAndroidBridge: bridge };

    try {
      await saveExportedFile("a.md", new Blob(["hello"], { type: "text/markdown" }));
    } finally {
      globalWithWindow.window = originalWindow;
    }

    // WebView 的 Java 桥要求以注入对象为 this 调用，否则抛
    // "Java bridge method can't be invoked on a non-injected object"。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.thisValue).toBe(bridge);
    expect(calls[0]!.fileName).toBe("a.md");
    expect(calls[0]!.mime).toBe("text/markdown");
    expect(calls[0]!.base64).toBe(btoa("hello"));
  });
});

function buildSnapshot(id: number, extra: Partial<RawGkdSnapshot> = {}) {
  const raw: RawGkdSnapshot = {
    id,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 1080,
    screenHeight: 1920,
    isLandscape: false,
    nodes: [
      node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: 1 })),
      node(
        1,
        0,
        attr({
          id: "com.demo:id/skip",
          vid: "skip",
          name: "android.widget.Button",
          text: "跳过",
          clickable: true,
          left: 100,
          top: 300,
          right: 260,
          bottom: 380,
        }),
      ),
    ],
    ...extra,
  };
  return normalizeSnapshot(raw, "blob://demo", "测试快照");
}

function node(id: number, pid: number, nodeAttr: SnapshotNodeAttr): SnapshotNode {
  return { id, pid, idQf: null, textQf: null, attr: nodeAttr };
}

function attr(overrides: Partial<SnapshotNodeAttr>): SnapshotNodeAttr {
  return {
    id: null,
    vid: null,
    name: "android.view.View",
    text: null,
    desc: null,
    clickable: false,
    focusable: false,
    checkable: false,
    checked: false,
    editable: false,
    longClickable: false,
    visibleToUser: true,
    left: 0,
    top: 0,
    right: 1080,
    bottom: 1920,
    width: (overrides.right ?? 1080) - (overrides.left ?? 0),
    height: (overrides.bottom ?? 1920) - (overrides.top ?? 0),
    childCount: 0,
    index: 0,
    depth: 1,
    ...overrides,
  };
}
