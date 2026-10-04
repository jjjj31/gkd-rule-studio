import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  downloadApk,
  fetchUpdateManifest,
  getAppVersionInfo,
  installApk,
} from "./androidUpdater";

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

describe("fetchUpdateManifest 多源兜底（国内连不上 GitHub）", () => {
  const body = JSON.stringify({
    versionCode: 2,
    versionName: "1.0.0",
    apkUrl: "https://example.com/a.apk",
    sha256: "a".repeat(64),
  });
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const okResponse = () => ({ ok: true, status: 200, text: async () => body });
  const statusResponse = (status: number) => ({ ok: false, status, text: async () => "" });

  it("直连成功即返回，不再试镜像", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return okResponse();
    }) as unknown as typeof fetch;
    const manifest = await fetchUpdateManifest();
    expect(manifest.versionName).toBe("1.0.0");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("ghproxy");
  });

  it("直连网络失败时回退到镜像", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("ghproxy.net")) return okResponse();
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const manifest = await fetchUpdateManifest();
    expect(manifest.versionCode).toBe(2);
    expect(calls.some((u) => u.includes("ghproxy.net"))).toBe(true);
  });

  it("全部网络失败时报网络错误", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(fetchUpdateManifest()).rejects.toThrow(/无法连接更新服务/);
  });

  it("全部返回 404 时报 HTTP 状态", async () => {
    globalThis.fetch = (async () => statusResponse(404)) as unknown as typeof fetch;
    await expect(fetchUpdateManifest()).rejects.toThrow(/HTTP 404/);
  });
});
