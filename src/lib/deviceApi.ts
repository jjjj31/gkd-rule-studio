import type {
  DeviceServerInfo,
  DeviceSnapshotSummary,
  ParsedGkdSnapshot,
  RawGkdSnapshot,
} from "../types/gkdSnapshot";
import type { RawSubscriptionDraft } from "./testSubscription";
import { enhancedFetch, extensionFetch, hasNetworkExtension, fetchWithTimeout } from "./networkExtension";
import { normalizeSnapshot } from "./snapshotZip";

interface RpcError {
  message: string;
  code: number;
  __error: true;
}

export type DeviceDiagnosticStatus = "pass" | "warn" | "fail" | "skip";

export interface DeviceDiagnosticStep {
  id: string;
  name: string;
  status: DeviceDiagnosticStatus;
  detail: string;
  durationMs?: number;
}

export interface DeviceAddressProbe {
  origin: string;
  status: "pass" | "fail";
  detail: string;
  durationMs: number;
  channel?: "fetch" | "gm";
}

export interface DeviceApiClient {
  origin: string;
  serverInfo: DeviceServerInfo;
  getSnapshots: () => Promise<DeviceSnapshotSummary[]>;
  getSnapshot: (id: number) => Promise<RawGkdSnapshot>;
  getScreenshot: (id: number) => Promise<ArrayBuffer>;
  captureSnapshot: () => Promise<RawGkdSnapshot>;
  loadSnapshot: (id: number) => Promise<ParsedGkdSnapshot>;
  updateSubscription: (subscription: RawSubscriptionDraft) => Promise<void>;
}

export async function createDeviceApiClient(input: string): Promise<DeviceApiClient> {
  const origin = normalizeDeviceOrigin(input);
  const serverInfo = await postJson<DeviceServerInfo>(origin, "getServerInfo");

  const client: DeviceApiClient = {
    origin,
    serverInfo,
    getSnapshots: async () => {
      const snapshots = await postJson<DeviceSnapshotSummary[]>(origin, "getSnapshots");
      return [...snapshots].sort(
        (a: DeviceSnapshotSummary, b: DeviceSnapshotSummary) => b.id - a.id,
      );
    },
    getSnapshot: async (id) => {
      if (serverInfo.gkdAppInfo?.versionName === "1.10.4") {
        return getJson<RawGkdSnapshot>(origin, `snapshot?id=${id}`);
      }
      return postJson<RawGkdSnapshot>(origin, "getSnapshot", { id });
    },
    getScreenshot: async (id) => {
      return postBuffer(origin, "getScreenshot", { id });
    },
    captureSnapshot: async () => {
      return postJson<RawGkdSnapshot>(origin, "captureSnapshot");
    },
    updateSubscription: async (subscription) => {
      await postJson(origin, "updateSubscription", subscription);
    },
    loadSnapshot: async (id) => {
      const [snapshot, screenshot] = await Promise.all([
        client.getSnapshot(id),
        client.getScreenshot(id),
      ]);
      const screenshotUrl = URL.createObjectURL(
        new Blob([screenshot], { type: "image/png" }),
      );
      return normalizeSnapshot(
        snapshot,
        screenshotUrl,
        `设备快照 ${formatSnapshotTime(snapshot.id)}`,
      );
    },
  };

  return client;
}

export async function runDeviceDiagnostics(
  input: string,
): Promise<DeviceDiagnosticStep[]> {
  const steps: DeviceDiagnosticStep[] = [];
  let origin = "";

  try {
    origin = normalizeDeviceOrigin(input);
    steps.push({
      id: "url",
      name: "地址解析",
      status: "pass",
      detail: origin,
    });
  } catch (cause) {
    steps.push({
      id: "url",
      name: "地址解析",
      status: "fail",
      detail: cause instanceof Error ? cause.message : "地址无效",
    });
    return steps;
  }

  steps.push({
    id: "extension",
    name: "油猴网络扩展",
    status: hasNetworkExtension() ? "pass" : "warn",
    detail: hasNetworkExtension()
      ? "已检测到 window.__NetworkExtension__.GM_xmlhttpRequest"
      : "未检测到扩展注入。若浏览器直连失败，请在油猴菜单启用“注入GM_XHR到当前网站”后刷新页面。",
  });

  const directServer = await timeStep("浏览器直连 getServerInfo", async () => {
    const response = await postWithFetch(origin, "getServerInfo");
    await assertJsonRpcOk(response, "getServerInfo");
    const serverInfo = (await response.json()) as DeviceServerInfo;
    return formatServerTitle(serverInfo);
  });
  steps.push({ id: "fetch-server", ...directServer });

  if (hasNetworkExtension()) {
    const extensionServer = await timeStep("扩展通道 getServerInfo", async () => {
      const response = await postWithExtension(origin, "getServerInfo");
      await assertJsonRpcOk(response, "getServerInfo");
      const serverInfo = (await response.json()) as DeviceServerInfo;
      return formatServerTitle(serverInfo);
    });
    steps.push({ id: "gm-server", ...extensionServer });
  } else {
    steps.push({
      id: "gm-server",
      name: "扩展通道 getServerInfo",
      status: "skip",
      detail: "未注入油猴网络扩展，跳过。",
    });
  }

  const snapshotsStep = await timeStep("获取快照列表", async () => {
    const client = await createDeviceApiClient(origin);
    const snapshots = await client.getSnapshots();
    return `成功获取 ${snapshots.length} 条快照`;
  });
  steps.push({ id: "snapshots", ...snapshotsStep });

  if (snapshotsStep.status === "pass") {
    const latestSnapshot = await latestSnapshotProbe(origin);
    steps.push(...latestSnapshot);
  } else {
    steps.push({
      id: "latest-snapshot",
      name: "读取最新快照",
      status: "skip",
      detail: "快照列表获取失败，跳过读取快照详情。",
    });
  }

  return steps;
}

export function extractDeviceOrigins(input: string): string[] {
  const tokens = input
    .split(/[\s,，;；]+/)
    .map((token) => token.trim().replace(/^["'(<]+|[>"')]+$/g, ""))
    .filter(Boolean);
  const candidates = tokens.length > 0 ? tokens : [input];
  const origins = new Set<string>();

  for (const candidate of candidates) {
    try {
      origins.add(normalizeDeviceOrigin(candidate));
    } catch {
      // Ignore non-url fragments from copied device text.
    }
  }

  return [...origins];
}

export async function probeDeviceOrigin(input: string): Promise<DeviceAddressProbe> {
  const origin = normalizeDeviceOrigin(input);
  const start = performance.now();

  try {
    const response = await postWithFetch(origin, "getServerInfo", {}, 3000);
    await assertJsonRpcOk(response, "getServerInfo");
    const serverInfo = (await response.json()) as DeviceServerInfo;
    return {
      origin,
      status: "pass",
      channel: "fetch",
      detail: formatServerTitle(serverInfo),
      durationMs: Math.round(performance.now() - start),
    };
  } catch (fetchCause) {
    if (!hasNetworkExtension()) {
      return {
        origin,
        status: "fail",
        detail: `浏览器直连失败，且未注入油猴网络扩展：${formatError(fetchCause)}`,
        durationMs: Math.round(performance.now() - start),
      };
    }

    try {
      const response = await postWithExtension(origin, "getServerInfo", {}, undefined, 5000);
      await assertJsonRpcOk(response, "getServerInfo");
      const serverInfo = (await response.json()) as DeviceServerInfo;
      return {
        origin,
        status: "pass",
        channel: "gm",
        detail: formatServerTitle(serverInfo),
        durationMs: Math.round(performance.now() - start),
      };
    } catch (extensionCause) {
      return {
        origin,
        status: "fail",
        detail: `直连失败：${formatError(fetchCause)}；扩展失败：${formatError(
          extensionCause,
        )}`,
        durationMs: Math.round(performance.now() - start),
      };
    }
  }
}

export function formatSnapshotOption(snapshot: DeviceSnapshotSummary): string {
  const appName = snapshot.appInfo?.name ?? snapshot.appName ?? snapshot.appId;
  return `${formatSnapshotTime(snapshot.id)} · ${appName} · ${shortActivity(
    snapshot.activityId,
  )}`;
}

export function formatServerTitle(serverInfo: DeviceServerInfo): string {
  const device = serverInfo.device;
  const gkd = serverInfo.gkdAppInfo;
  const phone = [device.manufacturer, device.model].filter(Boolean).join(" ");
  return `${phone || "Android 设备"} · Android ${device.release ?? "?"} · GKD ${
    gkd.versionName ?? "?"
  }`;
}

export function normalizeDeviceOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("请输入设备地址");
  }

  const url = new URL(
    /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`,
  );
  return url.origin;
}

async function getJson<T>(origin: string, name: string): Promise<T> {
  const response = await enhancedFetch(new URL(`/api/${name}`, origin), {}, {
    timeout: 8000,
  });
  await assertOk(response, name);
  return response.json() as Promise<T>;
}

async function postJson<T>(
  origin: string,
  name: string,
  data: object = {},
): Promise<T> {
  const response = await post(origin, name, data);
  await assertJsonRpcOk(response, name);
  return response.json() as Promise<T>;
}

async function postBuffer(
  origin: string,
  name: string,
  data: object = {},
): Promise<ArrayBuffer> {
  const response = await post(origin, name, data, { responseType: "arraybuffer" });
  await assertOk(response, name);
  return response.arrayBuffer();
}

async function post(
  origin: string,
  name: string,
  data: object,
  options: { responseType?: "arraybuffer" } = {},
): Promise<Response> {
  return enhancedFetch(new URL(`/api/${name}`, origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  }, {
    responseType: options.responseType,
    timeout: 8000,
  });
}

async function postWithFetch(
  origin: string,
  name: string,
  data: object = {},
  timeoutMs = 5000,
): Promise<Response> {
  return fetchWithTimeout(
    new URL(`/api/${name}`, origin),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    },
    timeoutMs,
  );
}

async function postWithExtension(
  origin: string,
  name: string,
  data: object = {},
  responseType?: "arraybuffer",
  timeoutMs = 8000,
): Promise<Response> {
  return extensionFetch(
    new URL(`/api/${name}`, origin),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    },
    {
      responseType,
      timeout: timeoutMs,
    },
  );
}

async function timeStep(
  name: string,
  action: () => Promise<string>,
): Promise<Omit<DeviceDiagnosticStep, "id">> {
  const start = performance.now();
  try {
    const detail = await action();
    return {
      name,
      status: "pass",
      detail,
      durationMs: Math.round(performance.now() - start),
    };
  } catch (cause) {
    return {
      name,
      status: "fail",
      detail: formatError(cause),
      durationMs: Math.round(performance.now() - start),
    };
  }
}

async function latestSnapshotProbe(origin: string): Promise<DeviceDiagnosticStep[]> {
  const client = await createDeviceApiClient(origin).catch(() => null);
  if (!client) {
    return [
      {
        id: "latest-snapshot",
        name: "读取最新快照",
        status: "skip",
        detail: "设备客户端无法建立，跳过。",
      },
    ];
  }

  const snapshots = await client.getSnapshots().catch(() => []);
  const latest = snapshots[0];
  if (!latest) {
    return [
      {
        id: "latest-snapshot",
        name: "读取最新快照",
        status: "skip",
        detail: "快照列表为空，跳过。",
      },
    ];
  }

  const snapshotStep = await timeStep("读取最新快照 JSON", async () => {
    const snapshot = await client.getSnapshot(latest.id);
    return `${snapshot.appId} / ${shortActivity(snapshot.activityId)} / ${
      snapshot.nodes.length
    } nodes`;
  });

  const screenshotStep = await timeStep("读取最新快照截图", async () => {
    const screenshot = await client.getScreenshot(latest.id);
    return `${Math.round(screenshot.byteLength / 1024)} KB`;
  });

  return [
    { id: "latest-snapshot", ...snapshotStep },
    { id: "latest-screenshot", ...screenshotStep },
  ];
}

function formatError(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === "AbortError") {
    return "请求超时或被取消";
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

async function assertJsonRpcOk(response: Response, name: string): Promise<void> {
  await assertOk(response, name);

  if (!response.headers.get("Content-Type")?.includes("application/json")) {
    return;
  }

  const clone = response.clone();
  const value = (await clone.json().catch(() => null)) as RpcError | null;
  if (value?.__error) {
    throw new Error(value.message || `设备接口错误: ${name}`);
  }
}

async function assertOk(response: Response, name: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`设备接口错误: ${name} ${response.status}`);
  }
}

function formatSnapshotTime(id: number): string {
  const date = new Date(id);
  if (Number.isNaN(date.getTime())) return String(id);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortActivity(activityId: string): string {
  return activityId.split(".").slice(-2).join(".");
}
