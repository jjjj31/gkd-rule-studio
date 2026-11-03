import type { SnapshotAppInfo } from "../types/gkdSnapshot";

export type GkdTargetChannel = "stable" | "beta";
export const GKD_TARGET_STORAGE_KEY = "gkd-rule-studio-target-channel";

export function readStoredTargetChannel(): GkdTargetChannel {
  return localStorage.getItem(GKD_TARGET_STORAGE_KEY) === "beta" ? "beta" : "stable";
}

export function storeTargetChannel(channel: GkdTargetChannel): void {
  localStorage.setItem(GKD_TARGET_STORAGE_KEY, channel);
  // The former .debug choice identified a fork, not an official beta.
  localStorage.removeItem("gkd-rule-studio-target-package");
}

export function targetChannelLabel(channel: string): string {
  if (channel === "beta") return "GKD 测试版";
  if (channel === "stable" || channel === "li.songe.gkd") return "GKD 正式版";
  return "旧版自改 GKD";
}

export function isBetaTarget(channel: GkdTargetChannel): boolean {
  return channel === "beta";
}

export function getGkdChannel(app: SnapshotAppInfo | undefined): GkdTargetChannel | null {
  if (app?.id !== "li.songe.gkd" || !app.versionName) return null;
  const version = app.versionName.replace(/^v/, "");
  if (/^\d+\.\d+\.\d+-(?:beta|alpha|rc|preview)(?:[.\d-]|$)/i.test(version)) return "beta";
  return /^\d+\.\d+\.\d+$/.test(version) ? "stable" : null;
}

export function matchesTargetChannel(app: SnapshotAppInfo | undefined, channel: GkdTargetChannel): boolean {
  return getGkdChannel(app) === channel;
}
