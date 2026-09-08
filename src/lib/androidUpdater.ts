/**
 * Android 软件内更新:版本清单检查 + 原生下载/安装桥封装。
 * update.json 发布在 GitHub Releases(latest/download 固定地址),
 * 与发版脚本 scripts/publish-update.mjs 的输出格式对应。
 */

/** 固定检查地址:永远指向最新 Release 的 update.json。 */
export const UPDATE_MANIFEST_URL =
  "https://github.com/jjjj31/gkd-rule-studio/releases/latest/download/update.json";

/** 版本清单/权限等轻量桥请求的超时(毫秒);APK 下载不限时。 */
export const UPDATE_CHECK_TIMEOUT_MS = 15000;

/** 下载 APK 时的本地文件名(写入应用外部私有目录)。 */
export const UPDATE_APK_FILE_NAME = "gkd-rule-studio-update.apk";

export interface UpdateManifest {
  versionCode: number;
  versionName: string;
  /** true = 强制更新(不可跳过)。 */
  forced: boolean;
  /** 默认下载地址(GitHub 直链)。 */
  apkUrl: string;
  /** 备用镜像,下载失败时依次尝试。 */
  mirrors?: string[];
  /** APK sha256,不匹配即拒绝安装。 */
  sha256?: string;
  /** 发版说明。 */
  notes?: string;
}

export interface AppVersionInfo {
  versionName: string;
  versionCode: number;
}

export interface DownloadProgress {
  /** 0-100;远端不提供大小时 -1。 */
  percent: number;
  received: number;
  total: number;
}

export class UpdateBridgeError extends Error {
  needPermission: boolean;

  constructor(message: string, needPermission = false) {
    super(message);
    this.name = "UpdateBridgeError";
    this.needPermission = needPermission;
  }
}

/** 解析远端 update.json;结构非法时抛 UpdateBridgeError。 */
export function parseUpdateManifest(text: string): UpdateManifest {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) {
    throw new UpdateBridgeError("版本清单格式错误");
  }
  const obj = raw as Record<string, unknown>;
  const versionCode = typeof obj.versionCode === "number" ? obj.versionCode : NaN;
  const versionName = typeof obj.versionName === "string" ? obj.versionName : "";
  const apkUrl = typeof obj.apkUrl === "string" ? obj.apkUrl : "";
  if (!Number.isInteger(versionCode) || versionCode <= 0 || !versionName || !apkUrl) {
    throw new UpdateBridgeError("版本清单缺少必要字段(versionCode/versionName/apkUrl)");
  }
  const mirrors = Array.isArray(obj.mirrors)
    ? obj.mirrors.filter((item): item is string => typeof item === "string")
    : [];
  return {
    versionCode,
    versionName,
    forced: obj.forced === 1 || obj.forced === true,
    apkUrl,
    mirrors: mirrors.length > 0 ? mirrors : undefined,
    sha256: typeof obj.sha256 === "string" ? obj.sha256 : undefined,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
  };
}

/** 清单是否比当前版本新(versionCode 整数比较)。 */
export function isUpdateAvailable(
  manifest: UpdateManifest,
  current: AppVersionInfo,
): boolean {
  return manifest.versionCode > current.versionCode;
}

/** 组装下载地址列表:直链在前、镜像在后并去重;无地址时返回空数组。 */
export function buildDownloadUrls(manifest: UpdateManifest): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of [manifest.apkUrl, ...(manifest.mirrors ?? [])]) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** 拉取最新版 update.json 并解析。 */
export async function fetchUpdateManifest(): Promise<UpdateManifest> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(UPDATE_MANIFEST_URL, { signal: controller.signal });
    if (!response.ok) {
      throw new UpdateBridgeError(`检查更新失败:HTTP ${response.status}`);
    }
    const text = await response.text();
    return parseUpdateManifest(text);
  } catch (cause) {
    if (cause instanceof UpdateBridgeError) throw cause;
    throw new UpdateBridgeError("无法连接更新服务,请检查网络");
  } finally {
    window.clearTimeout(timer);
  }
}

function makeRequestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface BridgeResult {
  ok?: boolean;
  error?: string;
  needPermission?: boolean;
  [key: string]: unknown;
}

/**
 * 调一次原生桥方法并等结果(基于全局 __GkdAndroidBridgeResult 单回调,与 aiModel 同模式)。
 * bridge 调用返回 {ok:false,error:"..."} 或抛错时,reject UpdateBridgeError。
 */
function bridgeCall(
  method: "getAppUpdateInfo" | "canInstallApk" | "installApk",
  args: unknown[],
): Promise<BridgeResult> {
  return new Promise((resolve, reject) => {
    const bridge = window.GkdAndroidBridge as Record<string, unknown> | undefined;
    const fn = bridge?.[method];
    if (typeof fn !== "function") {
      reject(new UpdateBridgeError("当前环境不支持软件内更新"));
      return;
    }
    const requestId = makeRequestId(method);
    const previous = window.__GkdAndroidBridgeResult;
    let settled = false;

    const handler = (callbackId: string, result: BridgeResult) => {
      if (callbackId !== requestId) {
        previous?.(callbackId, result);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (result.ok === true) {
        resolve(result);
      } else {
        const message = result.error || "桥调用失败";
        reject(new UpdateBridgeError(message, result.needPermission === true));
      }
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new UpdateBridgeError("桥调用超时"));
    }, UPDATE_CHECK_TIMEOUT_MS);

    window.__GkdAndroidBridgeResult = handler;

    function cleanup(): void {
      window.clearTimeout(timer);
      if (window.__GkdAndroidBridgeResult === handler) {
        window.__GkdAndroidBridgeResult = previous;
      }
    }

    (fn as (...bridgeArgs: unknown[]) => void)(requestId, ...args);
  });
}

/** 读取 APK 内的版本信息(build.gradle 的 versionName/versionCode)。 */
export async function getAppVersionInfo(): Promise<AppVersionInfo> {
  const result = await bridgeCall("getAppUpdateInfo", []);
  return {
    versionName: typeof result.versionName === "string" ? result.versionName : "0.0.0",
    versionCode: typeof result.versionCode === "number" ? result.versionCode : 0,
  };
}

/** 当前是否已允许"安装未知应用"(API < 26 恒为 true)。 */
export async function hasInstallPermission(): Promise<boolean> {
  const result = await bridgeCall("canInstallApk", []);
  return result.allowed === true;
}

/** 打开系统"安装未知应用"设置页。 */
export function openInstallSettings(): void {
  window.GkdAndroidBridge?.openInstallSettings?.();
}

/**
 * 下载 APK:原生侧按 直链→镜像 顺序尝试,期间 onProgress 回调。
 * 成功返回安装包绝对路径;校验失败或全部地址失败时 reject。
 */
export function downloadApk(
  manifest: UpdateManifest,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  const urls = buildDownloadUrls(manifest);
  if (urls.length === 0) {
    return Promise.reject(new UpdateBridgeError("版本清单缺少下载地址"));
  }
  const bridge = window.GkdAndroidBridge as { downloadApk?: unknown } | undefined;
  const fn = bridge?.downloadApk;
  if (typeof fn !== "function") {
    return Promise.reject(new UpdateBridgeError("当前环境不支持软件内更新"));
  }

  return new Promise((resolve, reject) => {
    const requestId = makeRequestId("download-apk");
    const previous = window.__GkdAndroidBridgeResult;
    const previousProgress = window.__GkdUpdateProgress;
    let settled = false;

    const resultHandler = (callbackId: string, result: BridgeResult) => {
      if (callbackId !== requestId) {
        previous?.(callbackId, result);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (result.ok === true) {
        resolve(typeof result.path === "string" ? result.path : "");
      } else {
        reject(
          new UpdateBridgeError(
            typeof result.error === "string" ? result.error : "下载失败",
            result.needPermission === true,
          ),
        );
      }
    };

    const progressHandler = (callbackId: string, payload: DownloadProgress) => {
      if (callbackId !== requestId) {
        previousProgress?.(callbackId, payload);
        return;
      }
      if (!settled) onProgress(payload);
    };

    window.__GkdAndroidBridgeResult = resultHandler;
    window.__GkdUpdateProgress = progressHandler;

    function cleanup(): void {
      if (window.__GkdAndroidBridgeResult === resultHandler) {
        window.__GkdAndroidBridgeResult = previous;
      }
      if (window.__GkdUpdateProgress === progressHandler) {
        window.__GkdUpdateProgress = previousProgress;
      }
    }

    (fn as (
      requestId: string,
      urlsJson: string,
      sha256: string,
      fileName: string,
    ) => void)(
      requestId,
      JSON.stringify(urls),
      manifest.sha256 ?? "",
      UPDATE_APK_FILE_NAME,
    );
  });
}

/** 调起系统安装器安装 APK;未开"未知来源"权限时 reject(needPermission=true)。 */
export async function installApk(filePath: string): Promise<void> {
  await bridgeCall("installApk", [filePath]);
}