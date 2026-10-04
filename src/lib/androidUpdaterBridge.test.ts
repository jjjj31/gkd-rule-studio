import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadApk, getAppVersionInfo, installApk } from "./androidUpdater";

/**
 * 回归测试：Android 注入对象（addJavascriptInterface）的方法**必须以该对象为接收者**调用。
 * 一旦把方法取出来解绑调用（`const f = bridge.m; f(...)`），真机 WebView 会抛
 * "Java bridge method can't be invoked on a non-injected object"。
 * 这里用同样会抛错的假桥复现该行为。
 */
function createAndroidBridge(): Record<string, unknown> {
  const bridge: Record<string, unknown> = {};

  function assertInjected(this: unknown, name: string): void {
    if (this !== bridge) {
      throw new Error(
        `Error invoking ${name}: Java bridge method can't be invoked on a non-injected object`,
      );
    }
  }

  bridge.getAppUpdateInfo = function (this: unknown, requestId: string) {
    assertInjected.call(this, "getAppUpdateInfo");
    queueMicrotask(() =>
      window.__GkdAndroidBridgeResult?.(requestId, {
        ok: true,
        versionName: "9.9.9",
        versionCode: 999,
      }),
    );
  };

  bridge.installApk = function (this: unknown, requestId: string) {
    assertInjected.call(this, "installApk");
    queueMicrotask(() => window.__GkdAndroidBridgeResult?.(requestId, { ok: true }));
  };

  bridge.downloadApk = function (this: unknown, requestId: string) {
    assertInjected.call(this, "downloadApk");
    queueMicrotask(() =>
      window.__GkdAndroidBridgeResult?.(requestId, { ok: true, path: "/data/x.apk" }),
    );
  };

  return bridge;
}

beforeEach(() => {
  (globalThis as unknown as { window: unknown }).window = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    GkdAndroidBridge: createAndroidBridge(),
  };
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("androidUpdater 桥调用必须以注入对象为接收者", () => {
  it("getAppVersionInfo 能拿到版本", async () => {
    await expect(getAppVersionInfo()).resolves.toEqual({
      versionName: "9.9.9",
      versionCode: 999,
    });
  });

  it("installApk 能完成调用", async () => {
    await expect(installApk("/data/x.apk")).resolves.toBeUndefined();
  });

  it("downloadApk 能完成调用并拿到路径", async () => {
    await expect(
      downloadApk(
        {
          versionCode: 2,
          versionName: "1.0.0",
          forced: false,
          apkUrl: "https://example.com/a.apk",
          sha256: "a".repeat(64),
        },
        () => {},
      ),
    ).resolves.toBe("/data/x.apk");
  });
});
