/**
 * 快照自定义名称。GKD 的 HTTP 接口不支持改快照名，所以改名只存在本地
 * （localStorage，key 为快照 id），用于首页列表展示和导出文件命名。
 */
import type { DeviceSnapshotSummary } from "../types/gkdSnapshot";
import { formatSnapshotOption } from "./deviceApi";

const SNAPSHOT_NAMES_STORAGE_KEY = "gkd-rule-studio-snapshot-names";

export type SnapshotNameMap = Record<string, string>;

export function loadSnapshotNames(): SnapshotNameMap {
  try {
    const raw = localStorage.getItem(SNAPSHOT_NAMES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] =>
            typeof entry[0] === "string" &&
            typeof entry[1] === "string" &&
            entry[1].trim() !== "",
        ),
      );
    }
  } catch {
    /* localStorage 不可用或数据损坏，回退空表 */
  }
  return {};
}

export function persistSnapshotNames(names: SnapshotNameMap): void {
  try {
    localStorage.setItem(SNAPSHOT_NAMES_STORAGE_KEY, JSON.stringify(names));
  } catch {
    /* localStorage 满或不可用，改名仅本次会话生效 */
  }
}

/** 列表行文案：有自定义名时前置并括注原始信息（时间/应用/Activity）。 */
export function snapshotOptionLabel(
  snapshot: DeviceSnapshotSummary,
  customName?: string | null,
): string {
  const name = customName?.trim();
  if (name) return `${name}（${formatSnapshotOption(snapshot)}）`;
  return formatSnapshotOption(snapshot);
}

/**
 * 导出文件名清洗：去掉 Windows/Android 文件系统非法字符与控制字符，
 * 折叠空白，最长 60 字符，去掉结尾的点/空格。结果为空表示应回退自动命名。
 */
export function sanitizeSnapshotFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, "");
}
