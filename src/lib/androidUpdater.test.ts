import { describe, expect, it } from "vitest";
import {
  buildDownloadUrls,
  isUpdateAvailable,
  parseUpdateManifest,
} from "./androidUpdater";

describe("parseUpdateManifest", () => {
  it("解析完整清单", () => {
    const manifest = parseUpdateManifest(
      JSON.stringify({
        versionCode: 2,
        versionName: "0.2.0",
        forced: 1,
        apkUrl: "https://example.com/a.apk",
        mirrors: ["https://mirror.example.com/a.apk"],
        sha256: "abc123",
        notes: "修复了 bug",
      }),
    );
    expect(manifest.versionCode).toBe(2);
    expect(manifest.versionName).toBe("0.2.0");
    expect(manifest.forced).toBe(true);
    expect(manifest.apkUrl).toBe("https://example.com/a.apk");
    expect(manifest.mirrors).toEqual(["https://mirror.example.com/a.apk"]);
    expect(manifest.sha256).toBe("abc123");
    expect(manifest.notes).toBe("修复了 bug");
  });

  it("forced 缺省视为可选更新", () => {
    const manifest = parseUpdateManifest(
      JSON.stringify({
        versionCode: 3,
        versionName: "0.3.0",
        apkUrl: "https://example.com/a.apk",
      }),
    );
    expect(manifest.forced).toBe(false);
  });

  it("缺少 apkUrl 时抛错", () => {
    expect(() =>
      parseUpdateManifest(
        JSON.stringify({ versionCode: 1, versionName: "0.1.0" }),
      ),
    ).toThrow(/版本清单/);
  });

  it("非法 JSON 抛错", () => {
    expect(() => parseUpdateManifest("not json")).toThrow();
  });

  it("mirrors 只保留字符串项", () => {
    const manifest = parseUpdateManifest(
      JSON.stringify({
        versionCode: 1,
        versionName: "0.1.0",
        apkUrl: "u",
        mirrors: ["a", 123, null, "b"],
      }),
    );
    expect(manifest.mirrors).toEqual(["a", "b"]);
  });
});

describe("isUpdateAvailable", () => {
  const current = { versionName: "0.1.0", versionCode: 1 };
  const manifest = {
    versionCode: 2,
    versionName: "0.2.0",
    forced: false,
    apkUrl: "u",
  };

  it("新版本号更大时返回 true", () => {
    expect(isUpdateAvailable(manifest, current)).toBe(true);
  });

  it("同版本号不视为可更新", () => {
    expect(
      isUpdateAvailable({ ...manifest, versionCode: 1 }, current),
    ).toBe(false);
  });

  it("远端版本号更小不视为可更新", () => {
    expect(
      isUpdateAvailable({ ...manifest, versionCode: 0 }, current),
    ).toBe(false);
  });
});

describe("buildDownloadUrls", () => {
  it("直链在前,镜像在后", () => {
    const urls = buildDownloadUrls({
      versionCode: 2,
      versionName: "0.2.0",
      forced: false,
      apkUrl: "https://github.com/a.apk",
      mirrors: ["https://mirror/a.apk"],
    });
    expect(urls).toEqual([
      "https://github.com/a.apk",
      "https://mirror/a.apk",
    ]);
  });

  it("去重直链与镜像相同的地址", () => {
    const urls = buildDownloadUrls({
      versionCode: 2,
      versionName: "0.2.0",
      forced: false,
      apkUrl: "https://github.com/a.apk",
      mirrors: ["https://github.com/a.apk"],
    });
    expect(urls).toEqual(["https://github.com/a.apk"]);
  });

  it("无镜像时只有直链", () => {
    const urls = buildDownloadUrls({
      versionCode: 2,
      versionName: "0.2.0",
      forced: false,
      apkUrl: "https://github.com/a.apk",
    });
    expect(urls).toEqual(["https://github.com/a.apk"]);
  });
});