/**
 * LibChecker 应用信息导入与本地档案存储。
 *
 * 上游基线：LibChecker commit 625c4ecc（`LcAppsExporter.kt`）——导出是 ZIP，
 * 根目录唯一 `apps.json`，内容是报告数组，应用身份在 `apkInfo.packageName`，
 * 组件在 `apkInfo.components.{activities,services,receivers,providers}`。
 * 该版本写出的 `sdkSummary` 和组件 `sdk` 都可能是空的，所以这里只用原始组件
 * 类名匹配项目已有的 `AD_SDK_SIGNATURES.packagePrefixes`，不依赖导出文件带 SDK 名称。
 *
 * 解析、校验、匹配全部是纯函数（除 `readLibCheckerProfiles` 读取文件内容）；
 * 存储函数接受可替换的 Storage，便于验证"失败不覆盖旧值"。
 */
import { strFromU8, unzipSync, type UnzipFileInfo } from "fflate";
import { AD_SDK_SIGNATURES } from "../data/adSdkSignatures";
import type {
  AppSdkComponentType,
  AppSdkEvidence,
  AppSdkMatch,
  AppSdkProfile,
} from "../types/appSdkProfile";

/** 本地档案存储 key；与订阅库、快照记忆、AI session 存储分开。 */
export const APP_SDK_PROFILES_KEY = "gkd-rule-studio-app-sdk-profiles";
/** 本地档案 schema 版本。 */
export const APP_SDK_PROFILES_SCHEMA_VERSION = 1;

/** 导入上限：文件 32 MiB。 */
export const MAX_LCAPPS_FILE_BYTES = 32 * 1024 * 1024;
/** 导入上限：apps.json 实际解压后 64 MiB。 */
export const MAX_LCAPPS_JSON_BYTES = 64 * 1024 * 1024;
/** 导入上限：报告 5000 条。 */
export const MAX_LCAPPS_REPORTS = 5000;
/** 导入上限：每应用组件 10000 条。 */
export const MAX_LCAPPS_COMPONENTS_PER_APP = 10000;
/** 本地规范化存储内容上限：UTF-8 2 MiB。 */
export const MAX_APP_SDK_PROFILES_BYTES = 2 * 1024 * 1024;

/** 与 subscriptionLibrary 一致：只依赖 getItem/setItem，便于测试替换。 */
export type AppSdkProfileStorage = Pick<Storage, "getItem" | "setItem">;

/** 导入失败一律抛这个类型，便于和 fflate 的底层错误区分。 */
class LibCheckerImportError extends Error {}
function fail(message: string): never {
  throw new LibCheckerImportError(message);
}

const COMPONENT_SECTIONS: ReadonlyArray<{ key: string; type: AppSdkComponentType }> = [
  { key: "activities", type: "activity" },
  { key: "services", type: "service" },
  { key: "receivers", type: "receiver" },
  { key: "providers", type: "provider" },
];

/**
 * 读取 LibChecker 导出文件（.lcapps/ZIP 或解压后的 apps.json），返回按包名组织的档案。
 *
 * 以内容判断格式：以 `PK` 开头按 ZIP 处理，否则按 JSON 文本处理。
 * 任一环节失败都会抛错，调用方据此保留原有档案。
 */
export async function readLibCheckerProfiles(
  file: File,
  importedAt: string = new Date().toISOString(),
): Promise<AppSdkProfile[]> {
  if (file.size > MAX_LCAPPS_FILE_BYTES) {
    fail(`文件超过 ${formatMiB(MAX_LCAPPS_FILE_BYTES)} MiB 上限，已拒绝导入`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_LCAPPS_FILE_BYTES) {
    fail(`文件超过 ${formatMiB(MAX_LCAPPS_FILE_BYTES)} MiB 上限，已拒绝导入`);
  }
  return looksLikeZip(bytes)
    ? parseLibCheckerArchive(bytes, importedAt)
    : parseLibCheckerAppsJson(strFromU8(bytes), importedAt);
}

/** 从 ZIP 字节里取出根目录 apps.json 并解析；不解压图标等其他条目。 */
export function parseLibCheckerArchive(
  bytes: Uint8Array,
  importedAt: string,
): AppSdkProfile[] {
  if (bytes.length > MAX_LCAPPS_FILE_BYTES) {
    fail(`文件超过 ${formatMiB(MAX_LCAPPS_FILE_BYTES)} MiB 上限，已拒绝导入`);
  }

  let declaredSize = -1;
  let appsJsonCount = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      // 只解根目录的 apps.json；图标等条目直接跳过。
      filter: (entry: UnzipFileInfo) => {
        if (entry.name !== "apps.json") return false;
        appsJsonCount += 1;
        if (appsJsonCount > 1) {
          fail("导出文件里有多个 apps.json，无法确定使用哪一份");
        }
        if (entry.compression !== 0 && entry.compression !== 8) {
          fail(`不支持的 ZIP 压缩方式（${entry.compression}），请重新导出后再试`);
        }
        // fflate 按声明的原始大小分配输出缓冲，超出部分会被截断而不是继续膨胀，
        // 所以先按声明拒绝超限输入，再在解压后核对实际长度。
        if (entry.originalSize > MAX_LCAPPS_JSON_BYTES) {
          fail(`apps.json 解压后超过 ${formatMiB(MAX_LCAPPS_JSON_BYTES)} MiB 上限，已拒绝导入`);
        }
        declaredSize = entry.originalSize;
        return true;
      },
    });
  } catch (cause) {
    if (cause instanceof LibCheckerImportError) throw cause;
    fail("无法读取导出文件：ZIP 已损坏，或使用了加密/不支持的压缩方式");
  }

  const appsJson = files["apps.json"];
  if (!appsJson) {
    fail("导出文件里没有根目录的 apps.json，请选择 LibChecker 应用信息导出文件");
  }
  if (appsJson.length !== declaredSize) {
    // 声明比实际大（数据被截断或损坏）时会走到这里；声明比实际小则会被 fflate
    // 截断成声明长度，交给后续 JSON 解析失败兜底。
    fail("apps.json 解压结果与声明大小不一致，文件可能已损坏");
  }
  if (appsJson.length > MAX_LCAPPS_JSON_BYTES) {
    fail(`apps.json 解压后超过 ${formatMiB(MAX_LCAPPS_JSON_BYTES)} MiB 上限，已拒绝导入`);
  }
  return parseLibCheckerAppsJson(strFromU8(appsJson), importedAt);
}

/** 解析解压后的 apps.json 文本（允许 UTF-8 BOM）。 */
export function parseLibCheckerAppsJson(
  text: string,
  importedAt: string,
): AppSdkProfile[] {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    fail("文件内容为空，请选择 LibChecker 应用信息导出文件");
  }
  if (new TextEncoder().encode(trimmed).length > MAX_LCAPPS_JSON_BYTES) {
    fail(`apps.json 超过 ${formatMiB(MAX_LCAPPS_JSON_BYTES)} MiB 上限，已拒绝导入`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    fail("无法解析为 LibChecker 应用信息导出，请选择 .lcapps 或其中的 apps.json");
  }
  if (!Array.isArray(parsed)) {
    fail("这不是 LibChecker 应用信息导出：顶层必须是报告数组，请选择 LibChecker 应用信息导出文件");
  }
  if (parsed.length === 0) {
    fail("文件中没有应用，已保留原有记录");
  }
  if (parsed.length > MAX_LCAPPS_REPORTS) {
    fail(`报告数量超过 ${MAX_LCAPPS_REPORTS} 条上限，已拒绝导入`);
  }

  const seenPackages = new Set<string>();
  return parsed.map((report, index) =>
    parseReport(report, index, importedAt, seenPackages),
  );
}

/** 按包名整条替换：本次文件里的应用覆盖旧档案，文件外的应用保留原样。 */
export function mergeAppSdkProfiles(
  previous: readonly AppSdkProfile[],
  incoming: readonly AppSdkProfile[],
): AppSdkProfile[] {
  const byId = new Map<string, AppSdkProfile>();
  for (const profile of previous) byId.set(profile.appId, profile);
  for (const profile of incoming) byId.set(profile.appId, profile);
  return [...byId.values()];
}

/** 序列化本地存储内容（含 schema 版本），同时用于容量校验。 */
export function serializeAppSdkProfiles(profiles: readonly AppSdkProfile[]): string {
  return JSON.stringify({
    version: APP_SDK_PROFILES_SCHEMA_VERSION,
    profiles: profiles.map(toStoredProfile),
  });
}

/**
 * 整批保存档案。容量超限或写入失败都抛错，且不改变已写入的旧值
 * （写入失败时由 Storage 实现保证原子性；容量校验在写入前完成）。
 */
export function saveAppSdkProfiles(
  profiles: readonly AppSdkProfile[],
  storage: AppSdkProfileStorage = localStorage,
): void {
  const payload = serializeAppSdkProfiles(profiles);
  if (new TextEncoder().encode(payload).length > MAX_APP_SDK_PROFILES_BYTES) {
    fail(`档案内容超过 ${formatMiB(MAX_APP_SDK_PROFILES_BYTES)} MiB 上限，已保留原有记录`);
  }
  try {
    storage.setItem(APP_SDK_PROFILES_KEY, payload);
  } catch {
    fail("本地保存失败，原记录已保留；可删除不需要的应用后重试");
  }
}

/**
 * 读取本地档案。缓存损坏时返回空列表和错误说明，不覆盖存储里的原值；
 * 单条损坏只跳过该条，其他应用仍可使用。
 */
export function loadAppSdkProfiles(
  storage: AppSdkProfileStorage = localStorage,
): { profiles: AppSdkProfile[]; error?: string } {
  try {
    const raw = storage.getItem(APP_SDK_PROFILES_KEY);
    if (!raw) return { profiles: [] };
    const stored: unknown = JSON.parse(raw);
    if (
      !isRecord(stored) ||
      stored.version !== APP_SDK_PROFILES_SCHEMA_VERSION ||
      !Array.isArray(stored.profiles)
    ) {
      throw new Error("缓存结构错误");
    }
    const profiles: AppSdkProfile[] = [];
    let error: string | undefined;
    for (const item of stored.profiles) {
      try {
        profiles.push(normalizeStoredProfile(item));
      } catch {
        error = "部分应用 SDK 档案损坏，已跳过；可重新导入覆盖";
      }
    }
    return { profiles, error };
  } catch {
    return { profiles: [], error: "读取本地应用 SDK 档案失败，原记录未被覆盖；可重新导入" };
  }
}

/**
 * 按包名删除档案，返回删除后的列表。
 * 缓存损坏时拒绝删除，避免用空列表覆盖原值；写入失败同样保留原记录。
 */
export function deleteAppSdkProfile(
  appId: string,
  storage: AppSdkProfileStorage = localStorage,
): AppSdkProfile[] {
  const loaded = loadAppSdkProfiles(storage);
  if (loaded.error) fail(`${loaded.error}；删除已取消`);
  const next = loaded.profiles.filter((profile) => profile.appId !== appId);
  if (next.length === loaded.profiles.length) return loaded.profiles;
  saveAppSdkProfiles(next, storage);
  return next;
}

function parseReport(
  raw: unknown,
  index: number,
  importedAt: string,
  seenPackages: Set<string>,
): AppSdkProfile {
  const where = `报告 #${index + 1}`;
  if (!isRecord(raw)) fail(`${where} 不是对象`);
  const apkInfo = raw.apkInfo;
  if (!isRecord(apkInfo)) fail(`${where} 缺少 apkInfo`);

  const packageName =
    typeof apkInfo.packageName === "string" ? apkInfo.packageName.trim() : "";
  if (!packageName) fail(`${where} 缺少有效的 apkInfo.packageName`);
  if (seenPackages.has(packageName)) {
    fail(`文件中存在重复应用包名：${packageName}`);
  }
  seenPackages.add(packageName);
  const label = `${where}（${packageName}）`;

  const components = apkInfo.components;
  if (!isRecord(components)) fail(`${label} 缺少 apkInfo.components`);
  const componentNames = readComponentNames(components, label);

  const versionCode = readVersionCode(apkInfo.versionCode, label);
  const appName = readOptionalText(apkInfo.appName);
  const versionName = readOptionalText(apkInfo.versionName);
  const analyzedAt = readOptionalText(raw.analyzedAt);

  return {
    appId: packageName,
    ...(appName ? { appName } : {}),
    ...(versionCode ? { versionCode } : {}),
    ...(versionName ? { versionName } : {}),
    ...(analyzedAt ? { analyzedAt } : {}),
    importedAt,
    sdks: matchAdSdks(componentNames),
  };
}

/** 校验四类组件并返回"类别 + 完整类名"列表（顺序固定：activity→service→receiver→provider）。 */
function readComponentNames(
  components: Record<string, unknown>,
  label: string,
): Array<{ type: AppSdkComponentType; name: string }> {
  const present = COMPONENT_SECTIONS.filter(
    (section) => components[section.key] !== undefined,
  );
  if (present.length === 0) {
    fail(`${label} 的 components 里没有 activities/services/receivers/providers`);
  }

  const names: Array<{ type: AppSdkComponentType; name: string }> = [];
  for (const section of present) {
    const value = components[section.key];
    if (!Array.isArray(value)) {
      fail(`${label} 的 components.${section.key} 必须是数组`);
    }
    if (names.length + value.length > MAX_LCAPPS_COMPONENTS_PER_APP) {
      fail(`${label} 的组件数量超过 ${MAX_LCAPPS_COMPONENTS_PER_APP} 条上限，已拒绝导入`);
    }
    value.forEach((entry, index) => {
      const name =
        isRecord(entry) && typeof entry.name === "string" ? entry.name.trim() : "";
      if (!name) {
        fail(`${label} 的 components.${section.key}[${index}] 缺少有效的类名 name`);
      }
      names.push({ type: section.type, name });
    });
  }
  return names;
}

/**
 * 用现有签名表的前缀匹配组件类名。
 * 前缀必须位于类名开头且以 `.` 分隔：`com.qq.e.ads.ADActivity` 命中 `com.qq.e`，
 * `com.qq.evil.AdActivity` 不命中。一个应用可有零个、一个或多个 SDK。
 */
function matchAdSdks(
  names: ReadonlyArray<{ type: AppSdkComponentType; name: string }>,
): AppSdkMatch[] {
  const bySdkId = new Map<string, AppSdkEvidence[]>();
  for (const { type, name } of names) {
    for (const { sdkId, prefix } of matchPrefixes(name)) {
      const evidence = bySdkId.get(sdkId) ?? [];
      const duplicate = evidence.some(
        (item) => item.componentType === type && item.name === name,
      );
      if (!duplicate) evidence.push({ componentType: type, name, matchedPrefix: prefix });
      bySdkId.set(sdkId, evidence);
    }
  }
  // 按签名表顺序输出，保证同一个应用多次导入结果稳定。
  return AD_SDK_SIGNATURES.filter((sdk) => bySdkId.has(sdk.id)).map((sdk) => ({
    sdkId: sdk.id,
    evidence: bySdkId.get(sdk.id) as AppSdkEvidence[],
  }));
}

/** 一个类名命中的全部 SDK；同一 SDK 命中多个前缀时取最长（最具体）的那个。 */
function matchPrefixes(name: string): Array<{ sdkId: string; prefix: string }> {
  const value = name.toLowerCase();
  const matches: Array<{ sdkId: string; prefix: string }> = [];
  for (const sdk of AD_SDK_SIGNATURES) {
    let best: string | null = null;
    for (const prefix of sdk.packagePrefixes) {
      if (value !== prefix && !value.startsWith(`${prefix}.`)) continue;
      if (best === null || prefix.length > best.length) best = prefix;
    }
    if (best) matches.push({ sdkId: sdk.id, prefix: best });
  }
  return matches;
}

/** 版本码保持字符串语义；数字只接受非负安全整数，不静默舍入。 */
function readVersionCode(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`${label} 的 versionCode 不是可安全保存的非负整数，已拒绝导入`);
    }
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!/^\d+$/.test(trimmed)) {
      fail(`${label} 的 versionCode 不是十进制非负整数字符串`);
    }
    return trimmed;
  }
  fail(`${label} 的 versionCode 格式不支持`);
}

/** 可选文本元数据：不是非空字符串时省略。 */
function readOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** 只保留 spec 允许落盘的字段，顺带丢掉历史缓存里的多余字段。 */
function toStoredProfile(profile: AppSdkProfile): AppSdkProfile {
  return {
    appId: profile.appId,
    ...(profile.appName ? { appName: profile.appName } : {}),
    ...(profile.versionCode ? { versionCode: profile.versionCode } : {}),
    ...(profile.versionName ? { versionName: profile.versionName } : {}),
    ...(profile.analyzedAt ? { analyzedAt: profile.analyzedAt } : {}),
    importedAt: profile.importedAt,
    sdks: profile.sdks.map((match) => ({
      sdkId: match.sdkId,
      evidence: match.evidence.map((item) => ({
        componentType: item.componentType,
        name: item.name,
        matchedPrefix: item.matchedPrefix,
      })),
    })),
  };
}

/** 读取本地缓存时的严格校验；结构不符就抛错，由调用方跳过或整体报错。 */
function normalizeStoredProfile(value: unknown): AppSdkProfile {
  if (!isRecord(value)) throw new Error("档案不是对象");
  const appId = typeof value.appId === "string" ? value.appId.trim() : "";
  const importedAt = typeof value.importedAt === "string" ? value.importedAt.trim() : "";
  if (!appId || !importedAt) throw new Error("档案缺少 appId 或 importedAt");
  if (!Array.isArray(value.sdks)) throw new Error("档案缺少 sdks 数组");

  const sdks = value.sdks.map((match): AppSdkMatch => {
    if (!isRecord(match) || typeof match.sdkId !== "string" || !match.sdkId.trim()) {
      throw new Error("SDK 记录缺少 sdkId");
    }
    if (!Array.isArray(match.evidence)) throw new Error("SDK 记录缺少 evidence 数组");
    const evidence = match.evidence.map((item): AppSdkEvidence => {
      if (
        !isRecord(item) ||
        !isComponentType(item.componentType) ||
        typeof item.name !== "string" ||
        !item.name.trim() ||
        typeof item.matchedPrefix !== "string" ||
        !item.matchedPrefix.trim()
      ) {
        throw new Error("证据结构错误");
      }
      return {
        componentType: item.componentType,
        name: item.name,
        matchedPrefix: item.matchedPrefix,
      };
    });
    return { sdkId: match.sdkId, evidence };
  });

  const appName = readOptionalText(value.appName);
  const versionCode = readOptionalText(value.versionCode);
  const versionName = readOptionalText(value.versionName);
  const analyzedAt = readOptionalText(value.analyzedAt);
  return {
    appId,
    ...(appName ? { appName } : {}),
    ...(versionCode ? { versionCode } : {}),
    ...(versionName ? { versionName } : {}),
    ...(analyzedAt ? { analyzedAt } : {}),
    importedAt,
    sdks,
  };
}

function isComponentType(value: unknown): value is AppSdkComponentType {
  return COMPONENT_SECTIONS.some((section) => section.type === value);
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatMiB(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
