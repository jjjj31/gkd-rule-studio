import type { RawGkdSnapshot } from "../types/gkdSnapshot";

export type SkipCaptureOutcome = "success" | "failure" | "unknown";

export interface SkipCaptureSummary {
  id: number;
  createdAt: number;
  packageName: string;
  appLabel: string;
  activityId: string | null;
  outcome: SkipCaptureOutcome;
  reason: string;
  clickedKey: string;
  clickedClass: string;
  clickedText: string;
  durationMs: number;
  nodeCount: number;
  beforeSource: string;
  /** 判定依据，例如 node_absent_after_1500ms；与 GKD 的 ActionResult 不是一回事。 */
  outcomeBasis: string;
}

export interface SkipCaptureDetail extends SkipCaptureSummary {
  before: RawGkdSnapshot | null;
  after: RawGkdSnapshot | null;
  hasBeforeScreenshot: boolean;
  hasAfterScreenshot: boolean;
}

export interface SkipCaptureStatus {
  enabled: boolean;
  serviceConnected: boolean;
  screenshots: boolean;
  maxRecords: number;
  count: number;
  bytes: number;
}

export interface SkipCaptureExportResult {
  path: string;
  bytes: number;
}

type BridgeMethod = (...args: unknown[]) => void;

export function hasSkipCaptureBridge(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = window.GkdAndroidBridge as Record<string, unknown> | undefined;
  return typeof bridge?.getSkipCaptureStatus === "function";
}

/**
 * 统一走 requestId + __GkdAndroidBridgeResult 的桥接协议，
 * 和现有的 AI 请求、APK 下载保持同一套写法。
 */
function callBridge<T>(method: string, ...args: unknown[]): Promise<T> {
  const bridge = window.GkdAndroidBridge as unknown as
    | Record<string, BridgeMethod>
    | undefined;
  const fn = bridge?.[method];
  if (typeof fn !== "function") {
    return Promise.reject(new Error("当前环境不支持跳过记录，请在 Android 版中使用"));
  }

  return new Promise<T>((resolve, reject) => {
    const requestId = `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const previous = window.__GkdAndroidBridgeResult;
    let settled = false;

    const cleanup = () => {
      window.clearTimeout(timer);
      if (window.__GkdAndroidBridgeResult === handler) {
        window.__GkdAndroidBridgeResult = previous;
      }
    };

    const handler = (
      id: string,
      result: { ok: boolean; error?: string; [key: string]: unknown },
    ) => {
      if (id !== requestId) {
        previous?.(id, result);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (result?.ok === false) {
        reject(new Error(result.error || "操作失败"));
        return;
      }
      resolve(result as T);
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("操作超时，请重试"));
    }, 20000);

    window.__GkdAndroidBridgeResult = handler;
    fn.call(bridge, requestId, ...args);
  });
}

export function getSkipCaptureStatus(): Promise<SkipCaptureStatus> {
  return callBridge<SkipCaptureStatus>("getSkipCaptureStatus");
}

export function setSkipCaptureEnabled(
  enabled: boolean,
): Promise<SkipCaptureStatus> {
  return callBridge<SkipCaptureStatus>("setSkipCaptureEnabled", enabled);
}

export function setSkipCaptureScreenshots(
  enabled: boolean,
): Promise<SkipCaptureStatus> {
  return callBridge<SkipCaptureStatus>("setSkipCaptureScreenshots", enabled);
}

export async function listSkipCaptures(
  offset = 0,
  limit = 50,
): Promise<SkipCaptureSummary[]> {
  const result = await callBridge<{ items?: SkipCaptureSummary[] }>(
    "listSkipCaptures",
    offset,
    limit,
  );
  return result.items ?? [];
}

export async function getSkipCapture(id: number): Promise<SkipCaptureDetail> {
  const result = await callBridge<{ item?: SkipCaptureDetail }>(
    "getSkipCapture",
    id,
  );
  if (!result.item) throw new Error("记录不存在或已清理");
  return result.item;
}

export async function deleteSkipCaptures(): Promise<number> {
  const result = await callBridge<{ deleted?: number }>("deleteSkipCaptures");
  return result.deleted ?? 0;
}

export function exportSkipCaptures(
  limit = 300,
  gkdChannel = "stable",
): Promise<SkipCaptureExportResult> {
  return callBridge<SkipCaptureExportResult>(
    "exportSkipCaptures",
    limit,
    gkdChannel,
  );
}

export function openSkipCaptureSettings(): void {
  window.GkdAndroidBridge?.openSkipCaptureSettings?.();
}

export function outcomeLabel(outcome: SkipCaptureOutcome): string {
  switch (outcome) {
    case "success":
      return "成功";
    case "failure":
      return "未消失";
    default:
      return "不确定";
  }
}

export function reasonLabel(reason: string): string {
  switch (reason) {
    case "node-gone":
      return "点击后控件消失";
    case "node-still-there":
      return "点击后控件仍在";
    case "ambiguous-window-change":
      return "页面切换，结果不确定";
    case "before-miss":
      return "没抓到点击前的界面";
    case "no-after":
      return "没抓到点击后的界面";
    default:
      return reason || "-";
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatCapturedAt(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/** 详情页顶部的一句话摘要：多少节点、屏幕尺寸。 */
export function summarizeSnapshot(snapshot: RawGkdSnapshot | null): string {
  if (!snapshot) return "无";
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.length : 0;
  return `${nodes} 个节点 · ${snapshot.screenWidth}×${snapshot.screenHeight}`;
}

/** 被点控件的可读描述，优先文字，其次类名。 */
export function describeClicked(summary: SkipCaptureSummary): string {
  if (summary.clickedText) return summary.clickedText;
  const className = summary.clickedClass.split(".").pop() || summary.clickedClass;
  return className || summary.clickedKey;
}
