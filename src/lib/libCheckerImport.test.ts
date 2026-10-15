import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  APP_SDK_PROFILES_KEY,
  MAX_APP_SDK_PROFILES_BYTES,
  MAX_LCAPPS_FILE_BYTES,
  MAX_LCAPPS_JSON_BYTES,
  deleteAppSdkProfile,
  loadAppSdkProfiles,
  mergeAppSdkProfiles,
  parseLibCheckerAppsJson,
  parseLibCheckerArchive,
  readLibCheckerProfiles,
  saveAppSdkProfiles,
  serializeAppSdkProfiles,
} from "./libCheckerImport";
import type { AppSdkProfile } from "../types/appSdkProfile";

const IMPORTED_AT = "2026-10-14T02:00:00.000Z";

/**
 * 按上游 LcAppsExporter.kt（commit 625c4ecc）的结构构造一份脱敏导出。
 * 结构与字段名来自上游源码；SDK 类名是公开的广告 SDK 包名，不含真实设备数据。
 */
function component(type: string, section: string, name: string) {
  return {
    type,
    section,
    name,
    shortName: name.split(".").at(-1),
    exported: true,
    enabled: true,
    permission: null,
    process: null,
    authorities: null,
    targetActivity: null,
    label: null,
    labelRef: null,
    actions: [],
    metaData: [],
    sdk: null,
  };
}

interface ReportOverrides {
  appName?: string;
  versionCode?: unknown;
  versionName?: unknown;
  analyzedAt?: unknown;
  activities?: unknown[];
  services?: unknown[];
  receivers?: unknown[];
  providers?: unknown[];
  components?: unknown;
  apkInfo?: Record<string, unknown>;
}

function report(packageName: string, overrides: ReportOverrides = {}) {
  const apkInfo = {
    appName: overrides.appName ?? "示例应用",
    packageName,
    versionName: overrides.versionName ?? "3.2.1",
    versionCode: overrides.versionCode ?? "12345",
    minSdk: "23",
    targetSdk: "34",
    compileSdk: "34",
    icon: { path: `icons/${packageName}.png`, size: 1234, mimeType: "image/png", dataUri: "" },
    permissions: ["android.permission.INTERNET"],
    nativeLibraries: [{ abi: "arm64-v8a", name: "libx.so", path: "lib/arm64-v8a/libx.so", size: 10, sdk: null }],
    components: overrides.components ?? {
      activities: overrides.activities ?? [],
      services: overrides.services ?? [],
      receivers: overrides.receivers ?? [],
      providers: overrides.providers ?? [],
    },
    metaData: { application: [], components: [] },
    buildFeatures: {
      kotlinDetected: true,
      kotlinVersion: "1.9.0",
      gradleVersion: "8.0",
      composeDetected: false,
      composeVersion: null,
      agpVersion: "8.0",
      appMetadataVersion: null,
    },
    signatures: { schemes: ["v2"], certificates: [] },
    sdkSummary: { native: [], components: [] },
    ...overrides.apkInfo,
  };
  return {
    locale: "zh-CN",
    terminalSystem: { name: "Android", version: "14", sdkInt: 34, manufacturer: "X", model: "Y" },
    analysisProfile: { id: "libchecker-installed-app-exporter", ruleCount: 0, uniqueSdkCount: 0 },
    durationMs: 12,
    fileName: `${packageName}.apk`,
    fileSizeBytes: 2048,
    analyzedAt: overrides.analyzedAt ?? "2026-10-14T01:02:03.456Z",
    apkInfo,
  };
}

function appsJson(reports: unknown[]): string {
  return JSON.stringify(reports);
}

function archiveOf(json: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
  return zipSync({ "apps.json": strToU8(json), ...extra });
}

function storage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(APP_SDK_PROFILES_KEY, initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function readU32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** 找出条目名在本地头和中央目录头里的偏移，用于构造损坏/超限的 ZIP。 */
function findEntryHeaders(bytes: Uint8Array, name: string) {
  const needle = new TextEncoder().encode(name);
  const hits: Array<{ kind: "local" | "central"; header: number }> = [];
  for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (i >= 30 && readU32(bytes, i - 30) === 0x04034b50) hits.push({ kind: "local", header: i - 30 });
    if (i >= 46 && readU32(bytes, i - 46) === 0x02014b50) hits.push({ kind: "central", header: i - 46 });
  }
  return hits;
}

function writeU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

/** 只改中央目录/本地头字段，不动数据，用于测试库行为与上限拒绝。 */
function patchArchive(bytes: Uint8Array, name: string, patch: {
  method?: number;
  originalSize?: number;
  rename?: { from: string; to: string };
}): Uint8Array {
  const copy = bytes.slice();
  for (const hit of findEntryHeaders(copy, patch.rename?.from ?? name)) {
    const methodOffset = hit.kind === "local" ? hit.header + 8 : hit.header + 10;
    const sizeOffset = hit.kind === "local" ? hit.header + 22 : hit.header + 24;
    if (patch.method !== undefined) writeU32(copy, methodOffset, patch.method);
    if (patch.originalSize !== undefined) writeU32(copy, sizeOffset, patch.originalSize);
    if (patch.rename) {
      const replacement = new TextEncoder().encode(patch.rename.to);
      copy.set(replacement, hit.header + (hit.kind === "local" ? 30 : 46));
    }
  }
  return copy;
}

describe("LibChecker 导出解析", () => {
  it("同一个 apps.json：ZIP 与 JSON 得到相同档案", () => {
    const json = appsJson([
      report("com.example.app", {
        activities: [
          component("activity", "activities", "com.qq.e.ads.ADActivity"),
          component("activity", "activities", "com.bytedance.sdk.openadsdk.core.AdActivity"),
        ],
      }),
    ]);
    const fromJson = parseLibCheckerAppsJson(json, IMPORTED_AT);
    const fromZip = parseLibCheckerArchive(archiveOf(json, { "icons/a.png": strToU8("png") }), IMPORTED_AT);
    expect(fromZip).toEqual(fromJson);
    expect(fromZip[0].sdks.map((sdk) => sdk.sdkId)).toEqual(["pangle", "gdt"]);
  });

  it("支持单/多应用、空组件、零/多 SDK", () => {
    const profiles = parseLibCheckerAppsJson(
      appsJson([
        report("com.one.app", { activities: [component("activity", "activities", "com.kwad.sdk.SplashActivity")] }),
        report("com.two.app", { activities: [component("activity", "activities", "com.example.MainActivity")] }),
        report("com.three.app"),
      ]),
      IMPORTED_AT,
    );
    expect(profiles.map((profile) => profile.appId)).toEqual([
      "com.one.app",
      "com.two.app",
      "com.three.app",
    ]);
    expect(profiles[0].sdks.map((sdk) => sdk.sdkId)).toEqual(["kwad"]);
    expect(profiles[1].sdks).toEqual([]);
    expect(profiles[2].sdks).toEqual([]);
  });

  it("sdkSummary 为空、组件 sdk 为 null 时仍按类名匹配，并按签名表顺序去重", () => {
    const [profile] = parseLibCheckerAppsJson(
      appsJson([
        report("com.example.app", {
          activities: [component("activity", "activities", "com.qq.e.ads.ADActivity")],
          services: [
            component("service", "services", "com.bytedance.sdk.openadsdk.core.AdService"),
            component("service", "services", "com.qq.e.comm.managers.GDTADManager"),
          ],
          receivers: [component("receiver", "receivers", "com.qq.e.ads.ADReceiver")],
        }),
      ]),
      IMPORTED_AT,
    );
    expect(profile.sdks.map((sdk) => sdk.sdkId)).toEqual(["pangle", "gdt"]);
    expect(profile.sdks[1].evidence.map((item) => item.componentType)).toEqual([
      "activity",
      "service",
      "receiver",
    ]);
    expect(profile.sdks[1].evidence[0]).toEqual({
      componentType: "activity",
      name: "com.qq.e.ads.ADActivity",
      matchedPrefix: "com.qq.e",
    });
  });

  it("前缀必须后接点号：com.qq.e.ads.ADActivity 命中，com.qq.evil.AdActivity 不命中", () => {
    const [profile] = parseLibCheckerAppsJson(
      appsJson([
        report("com.example.app", {
          activities: [
            component("activity", "activities", "com.qq.evil.AdActivity"),
            component("activity", "activities", "com.example.app.ui.AdAreaView"),
          ],
          providers: [component("provider", "providers", "com.qq.e.ads.ADProvider")],
        }),
      ]),
      IMPORTED_AT,
    );
    expect(profile.sdks).toHaveLength(1);
    expect(profile.sdks[0].evidence).toHaveLength(1);
    expect(profile.sdks[0].evidence[0].name).toBe("com.qq.e.ads.ADProvider");
  });

  it("版本码保持字符串语义，不安全数字被拒绝", () => {
    const [profile] = parseLibCheckerAppsJson(
      appsJson([report("com.example.app", { versionCode: "9007199254740993" })]),
      IMPORTED_AT,
    );
    expect(profile.versionCode).toBe("9007199254740993");

    const [numeric] = parseLibCheckerAppsJson(
      appsJson([report("com.example.app", { versionCode: 42 })]),
      IMPORTED_AT,
    );
    expect(numeric.versionCode).toBe("42");

    expect(() =>
      parseLibCheckerAppsJson(
        appsJson([report("com.example.app", { versionCode: 9007199254740993 })]),
        IMPORTED_AT,
      ),
    ).toThrow(/versionCode/);
    expect(() =>
      parseLibCheckerAppsJson(
        appsJson([report("com.example.app", { versionCode: "1.2.3" })]),
        IMPORTED_AT,
      ),
    ).toThrow(/versionCode/);
  });

  it("重复包名、缺字段、非法组件都整批失败并定位到报告", () => {
    expect(() =>
      parseLibCheckerAppsJson(
        appsJson([report("com.example.app"), report("com.example.app")]),
        IMPORTED_AT,
      ),
    ).toThrow(/重复应用包名：com\.example\.app/);

    expect(() =>
      parseLibCheckerAppsJson(appsJson([{ apkInfo: { packageName: "" } }]), IMPORTED_AT),
    ).toThrow(/报告 #1/);

    expect(() =>
      parseLibCheckerAppsJson(
        appsJson([report("com.example.app", { components: { activities: [{ name: "" }] } })]),
        IMPORTED_AT,
      ),
    ).toThrow(/components\.activities\[0\]/);

    expect(() =>
      parseLibCheckerAppsJson(
        appsJson([report("com.example.app", { components: { activities: "nope" } })]),
        IMPORTED_AT,
      ),
    ).toThrow(/必须是数组/);

    expect(() =>
      parseLibCheckerAppsJson(
        appsJson([report("com.example.app", { components: { instrumentation: [] } })]),
        IMPORTED_AT,
      ),
    ).toThrow(/没有 activities\/services\/receivers\/providers/);
  });

  it("空数组提示没有应用，不返回空档案", () => {
    expect(() => parseLibCheckerAppsJson("[]", IMPORTED_AT)).toThrow(/没有应用/);
    expect(() => parseLibCheckerAppsJson("  ", IMPORTED_AT)).toThrow(/为空/);
    expect(() => parseLibCheckerAppsJson("<html></html>", IMPORTED_AT)).toThrow(/apps\.json/);
    expect(() => parseLibCheckerAppsJson('{"apps":[]}', IMPORTED_AT)).toThrow(/顶层必须是报告数组/);
  });

  it("接受 UTF-8 BOM", () => {
    const profiles = parseLibCheckerAppsJson(
      `\uFEFF${appsJson([report("com.example.app")])}`,
      IMPORTED_AT,
    );
    expect(profiles).toHaveLength(1);
  });

  it("只保留 spec 规定的字段，不落盘权限、证书、图标和未命中组件", () => {
    const [profile] = parseLibCheckerAppsJson(
      appsJson([
        report("com.example.app", {
          activities: [
            component("activity", "activities", "com.example.app.MainActivity"),
            component("activity", "activities", "com.bytedance.sdk.openadsdk.core.AdActivity"),
          ],
        }),
      ]),
      IMPORTED_AT,
    );
    const payload = serializeAppSdkProfiles([profile]);
    expect(payload).toContain("com.bytedance.sdk.openadsdk");
    for (const leaked of [
      "permissions",
      "certificates",
      "icons/",
      "nativeLibraries",
      "sdkSummary",
      "minSdk",
      "com.example.app.MainActivity",
      "libx.so",
    ]) {
      expect(payload).not.toContain(leaked);
    }
    expect(Object.keys(JSON.parse(payload).profiles[0]).sort()).toEqual([
      "analyzedAt",
      "appId",
      "appName",
      "importedAt",
      "sdks",
      "versionCode",
      "versionName",
    ]);
  });
});

describe("LibChecker 导出文件读取与上限", () => {
  it("readLibCheckerProfiles 同时支持 ZIP 与 JSON 文件", async () => {
    const json = appsJson([
      report("com.example.app", {
        activities: [component("activity", "activities", "com.mbridge.msdk.MBridgeActivity")],
      }),
    ]);
    const fromZip = await readLibCheckerProfiles(
      new File([archiveOf(json) as BlobPart], "export.lcapps"),
      IMPORTED_AT,
    );
    const fromJson = await readLibCheckerProfiles(
      new File([json], "apps.json"),
      IMPORTED_AT,
    );
    expect(fromZip).toEqual(fromJson);
    expect(fromZip[0].sdks.map((sdk) => sdk.sdkId)).toEqual(["mbridge"]);
  });

  it("超过 32 MiB 的文件在读取前就被拒绝", async () => {
    const fake = {
      size: MAX_LCAPPS_FILE_BYTES + 1,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as File;
    await expect(readLibCheckerProfiles(fake, IMPORTED_AT)).rejects.toThrow(/32 MiB/);
  });

  it("缺失、重复、损坏的 apps.json 与不支持的压缩方式都有可理解的错误", () => {
    expect(() => parseLibCheckerArchive(zipSync({ "icons/a.png": strToU8("x") }), IMPORTED_AT)).toThrow(
      /没有根目录的 apps\.json/,
    );

    const json = appsJson([report("com.example.app")]);
    const renamed = patchArchive(archiveOf(json, { "appsXjson": strToU8(json) }), "appsXjson", {
      rename: { from: "appsXjson", to: "apps.json" },
    });
    expect(() => parseLibCheckerArchive(renamed, IMPORTED_AT)).toThrow(/多个 apps\.json/);

    // 截断丢掉了中央目录和 EOCD：库直接判为无效 ZIP。
    expect(() => parseLibCheckerArchive(archiveOf(json).slice(0, 40), IMPORTED_AT)).toThrow(
      /无法读取导出文件/,
    );
    // 压缩数据被改动：要么解压失败，要么解压结果与声明大小不一致，都不会被接受。
    const corrupted = archiveOf(json);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    expect(() => parseLibCheckerArchive(corrupted, IMPORTED_AT)).toThrow(
      /无法读取导出文件|声明大小不一致/,
    );

    const unsupported = patchArchive(archiveOf(json), "apps.json", { method: 14 });
    expect(() => parseLibCheckerArchive(unsupported, IMPORTED_AT)).toThrow(/不支持的 ZIP 压缩方式/);

    const huge = patchArchive(archiveOf(json), "apps.json", {
      originalSize: MAX_LCAPPS_JSON_BYTES + 1,
    });
    expect(() => parseLibCheckerArchive(huge, IMPORTED_AT)).toThrow(/64 MiB/);
  });

  it("声明大小被改小时解压结果会被截断并被拒绝", () => {
    const json = appsJson([report("com.example.app")]);
    const lying = patchArchive(archiveOf(json), "apps.json", { originalSize: 4 });
    // fflate 按声明分配输出缓冲，声明变小只会截断数据，最终由 JSON 解析拒绝。
    expect(() => parseLibCheckerArchive(lying, IMPORTED_AT)).toThrow(
      /无法解析|声明大小不一致|无法读取导出文件/,
    );
  });
});

describe("应用 SDK 档案合并与本地保存", () => {
  function profile(appId: string, sdkIds: string[], importedAt = IMPORTED_AT): AppSdkProfile {
    return {
      appId,
      appName: appId,
      importedAt,
      sdks: sdkIds.map((sdkId) => ({
        sdkId,
        evidence: [{ componentType: "activity", name: `${appId}.Ad`, matchedPrefix: sdkId }],
      })),
    };
  }

  it("按包名整条替换，包括清空旧 SDK；文件外应用保留且不产生重复", () => {
    const previous = [profile("com.one.app", ["pangle"]), profile("com.two.app", ["kwad"])];
    const merged = mergeAppSdkProfiles(previous, [profile("com.one.app", [])]);
    expect(merged.map((item) => item.appId)).toEqual(["com.one.app", "com.two.app"]);
    expect(merged[0].sdks).toEqual([]);
    expect(merged[1].sdks.map((sdk) => sdk.sdkId)).toEqual(["kwad"]);

    const again = mergeAppSdkProfiles(merged, [profile("com.one.app", ["gdt"])]);
    expect(again).toHaveLength(2);
    expect(again[0].sdks.map((sdk) => sdk.sdkId)).toEqual(["gdt"]);
  });

  it("保存后可回读，且只写入带 schema 版本的规范化内容", () => {
    const store = storage();
    const profiles = [profile("com.one.app", ["pangle"])];
    saveAppSdkProfiles(profiles, store);
    const raw = store.getItem(APP_SDK_PROFILES_KEY) as string;
    expect(JSON.parse(raw).version).toBe(1);
    const loaded = loadAppSdkProfiles(store);
    expect(loaded.error).toBeUndefined();
    expect(loaded.profiles).toEqual(profiles);
  });

  it("容量超限或写入失败时抛错并保留旧记录", () => {
    const store = storage();
    saveAppSdkProfiles([profile("com.one.app", ["pangle"])], store);
    const before = store.getItem(APP_SDK_PROFILES_KEY);

    const fat: AppSdkProfile = {
      appId: "com.fat.app",
      importedAt: IMPORTED_AT,
      sdks: [
        {
          sdkId: "pangle",
          evidence: Array.from({ length: 20000 }, (_unused, index) => ({
            componentType: "activity" as const,
            name: `com.byted.pangle.ads.Activity${index}${"x".repeat(80)}`,
            matchedPrefix: "com.byted.pangle",
          })),
        },
      ],
    };
    expect(serializeAppSdkProfiles([fat]).length).toBeGreaterThan(MAX_APP_SDK_PROFILES_BYTES);
    expect(() => saveAppSdkProfiles([fat], store)).toThrow(/上限/);
    expect(store.getItem(APP_SDK_PROFILES_KEY)).toBe(before);

    const failing = {
      getItem: store.getItem,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    expect(() => saveAppSdkProfiles([profile("com.two.app", ["kwad"])], failing)).toThrow(/本地保存失败/);
    expect(store.getItem(APP_SDK_PROFILES_KEY)).toBe(before);
  });

  it("损坏缓存报错且不覆盖原值，删除损坏缓存时拒绝执行", () => {
    const store = storage("{ not json");
    const loaded = loadAppSdkProfiles(store);
    expect(loaded.profiles).toEqual([]);
    expect(loaded.error).toMatch(/未被覆盖/);
    expect(store.getItem(APP_SDK_PROFILES_KEY)).toBe("{ not json");
    expect(() => deleteAppSdkProfile("com.one.app", store)).toThrow(/删除已取消/);
    expect(store.getItem(APP_SDK_PROFILES_KEY)).toBe("{ not json");

    const mixed = storage(
      JSON.stringify({
        version: 1,
        profiles: [
          profile("com.one.app", ["pangle"]),
          { appId: "com.broken.app", importedAt: IMPORTED_AT, sdks: [{ sdkId: "" }] },
        ],
      }),
    );
    const partial = loadAppSdkProfiles(mixed);
    expect(partial.profiles.map((item) => item.appId)).toEqual(["com.one.app"]);
    expect(partial.error).toMatch(/部分/);
  });

  it("按包名删除只移除该应用，写入失败保留旧记录", () => {
    const store = storage();
    saveAppSdkProfiles([profile("com.one.app", ["pangle"]), profile("com.two.app", ["kwad"])], store);
    const next = deleteAppSdkProfile("com.one.app", store);
    expect(next.map((item) => item.appId)).toEqual(["com.two.app"]);
    expect(loadAppSdkProfiles(store).profiles.map((item) => item.appId)).toEqual(["com.two.app"]);

    const before = store.getItem(APP_SDK_PROFILES_KEY);
    const failing = {
      getItem: store.getItem,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    expect(() => deleteAppSdkProfile("com.two.app", failing)).toThrow();
    expect(store.getItem(APP_SDK_PROFILES_KEY)).toBe(before);
  });
});
