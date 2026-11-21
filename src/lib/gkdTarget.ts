import type { SnapshotAppInfo } from "../types/gkdSnapshot";

export type GkdTargetChannel = "stable" | "beta";

export const OFFICIAL_GKD_PACKAGE_ID = "li.songe.gkd";
export const MIN_SUPPORTED_GKD_VERSION = "1.13.0";

function parseGkdVersion(versionName: string | undefined): { major: number; minor: number } | null {
  if (!versionName) return null;
  const match = versionName.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-(?:beta|alpha|rc|preview)(?:[.\d-]+)?)?$/i);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

export function isSupportedGkdApp(app: SnapshotAppInfo | undefined): boolean {
  if (app?.id !== OFFICIAL_GKD_PACKAGE_ID) return false;
  const version = parseGkdVersion(app.versionName);
  if (!version) return false;
  return version.major > 1 || (version.major === 1 && version.minor >= 13);
}

export function describeUnsupportedGkdApp(app: SnapshotAppInfo | undefined): string {
  if (app?.id !== OFFICIAL_GKD_PACKAGE_ID) {
    return `仅支持官方 GKD（${OFFICIAL_GKD_PACKAGE_ID}）${MIN_SUPPORTED_GKD_VERSION} 及以上版本，当前连接到 ${app?.versionName ?? "未知版本"}（${app?.id ?? "未知包名"}）`;
  }
  const version = parseGkdVersion(app.versionName);
  if (!version) {
    return `无法识别 GKD 版本（${app.versionName ?? "未知版本"}），请升级到官方 GKD ${MIN_SUPPORTED_GKD_VERSION} 及以上版本`;
  }
  return `当前仅支持官方 GKD ${MIN_SUPPORTED_GKD_VERSION} 及以上版本，当前连接为 ${app.versionName}，请先升级 GKD`;
}

export function getGkdChannel(app: SnapshotAppInfo | undefined): GkdTargetChannel | null {
  if (app?.id !== OFFICIAL_GKD_PACKAGE_ID || !app.versionName) return null;
  const version = app.versionName.trim().replace(/^v/i, "");
  if (/^\d+\.\d+\.\d+-(?:beta|alpha|rc|preview)(?:[.\d-]|$)/i.test(version)) return "beta";
  return /^\d+\.\d+\.\d+$/.test(version) ? "stable" : null;
}

/** Match new records ("li.songe.gkd") as well as historical official stable/beta records. */
export function isOfficialGkdImportTarget(targetPackage: string): boolean {
  return targetPackage === OFFICIAL_GKD_PACKAGE_ID || targetPackage === "beta" || targetPackage === "stable";
}
