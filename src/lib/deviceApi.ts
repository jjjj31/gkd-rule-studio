/**
 * GKD HTTP 服务的 API 客户端。
 * 负责：连接设备、获取快照列表、加载快照数据、导入规则到 GKD 内存订阅或本地规则。
 * 所有方法返回的 / 接受的快照类型有多个层级：原始 → 摘要 → 解析后。
 */
import type {
  DeviceServerInfo,
  DeviceSnapshotSummary,
  ParsedGkdSnapshot,
  RawGkdSnapshot,
} from "../types/gkdSnapshot";
import type { AppRuleDraft } from "../types/ruleDraft";
import type { RawSubscriptionDraft } from "./testSubscription";
import type { LibraryTestSubscription, SubscriptionApp } from "../types/subscriptionLibrary";
import { enhancedFetch, extensionFetch, hasNetworkExtension, fetchWithTimeout } from "./networkExtension";
import { normalizeSnapshot } from "./snapshotNormalize";
import { getGkdChannel, matchesTargetChannel, targetChannelLabel, type GkdTargetChannel } from "./gkdTarget";
import { prepareSelectorEngine } from "./selectorAdapter";
import { screenshotMimeType } from "./screenshotFormat";
import {
  formatGkdRuleValidationIssues,
  validateAppRuleDraft,
} from "./gkdRuleValidation";

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

export interface LocalRulesAppendResponse {
  ok: boolean;
  action: "append";
  appId: string;
  appName?: string | null;
  addedGroups: number;
  addedRules: number;
  skippedDuplicates: number;
}

export interface DeviceApiClient {
  origin: string;
  serverInfo: DeviceServerInfo;
  getSnapshots: () => Promise<DeviceSnapshotSummary[]>;
  getSnapshot: (id: number) => Promise<RawGkdSnapshot>;
  getScreenshot: (id: number) => Promise<ArrayBuffer>;
  captureSnapshot: () => Promise<RawGkdSnapshot>;
  loadSnapshot: (id: number) => Promise<ParsedGkdSnapshot>;
  updateSubscription: (subscription: RawSubscriptionDraft | LibraryTestSubscription) => Promise<void>;
  appendLocalRules: (app: AppRuleDraft | SubscriptionApp) => Promise<LocalRulesAppendResponse>;
}

/**
 * 建立与 GKD HTTP 服务的连接。
 * 先发 getServerInfo 确认版本和包名，再封装 getSnapshots / loadSnapshot / updateSubscription 等方法。
 * input 可以是 "192.168.1.5:8888" 或 "http://192.168.1.5:8888" 等形式。
 * 返回的 DeviceApiClient.origin 是规范化后的完整 URL。
 */
export async function createDeviceApiClient(input: string, targetChannel?: GkdTargetChannel): Promise<DeviceApiClient> {
  const origin = normalizeDeviceOrigin(input);
  const serverInfo = await postJson<DeviceServerInfo>(origin, "getServerInfo");
  if (targetChannel && !matchesTargetChannel(serverInfo.gkdAppInfo, targetChannel)) {
    throw new Error(`请选择对应版本：当前目标为 ${targetChannelLabel(targetChannel)}，连接到 ${serverInfo.gkdAppInfo?.versionName ?? "未知版本"}（${serverInfo.gkdAppInfo?.id ?? "未知包名"}）`);
  }
  const channel = targetChannel ?? getGkdChannel(serverInfo.gkdAppInfo);

  const client: DeviceApiClient = {
    origin,
    serverInfo,
    getSnapshots: async () => {
      const data: unknown = await postJson<unknown>(origin, "getSnapshots");
      if (!Array.isArray(data)) {
        throw new Error("设备返回的快照列表格式不正确");
      }
      // 过滤掉结构残缺的条目，避免后续渲染读字段时空指针
      const snapshots = (data as DeviceSnapshotSummary[]).filter(
        (item): item is DeviceSnapshotSummary =>
          Boolean(item) && typeof item === "object" && typeof item.id === "number",
      );
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
      for (const app of subscription.apps) {
        const validation = validateAppRuleDraft(app, {
          strict: false,
          // 订阅同步会同时覆盖测试规则；先拦截字段类型错误。
          validateSelectors: false,
        });
        if (!validation.valid) {
          throw new Error(
            `本地规则校验失败（${app.id || "未知应用"}）：${formatGkdRuleValidationIssues(validation)}`,
          );
        }
      }
      await postJson(origin, "updateSubscription", subscription);
    },
    appendLocalRules: async (app) => {
      const [major, minor] = (serverInfo.gkdAppInfo?.versionName ?? "").replace(/^v/, "").split(".").map(Number);
      if (channel !== "beta" || !(major > 1 || (major === 1 && minor >= 13))) {
        throw new Error("直接导入需要官方 GKD 1.13 测试版，请使用复制手动添加或切换测试版路径");
      }
      const appId = typeof app?.id === "string" ? app.id.trim() : "";
      if (!appId) {
        throw new Error("规则缺少有效的应用包名 id，请删除旧测试记录后重新生成");
      }
      if (!Array.isArray(app.groups) || app.groups.length === 0) {
        throw new Error("没有可导入的规则组");
      }
      const validation = validateAppRuleDraft(app, {
        strict: false,
        // selector 的实际解析依赖目标版本；这里先拦截字段值类型错误。
        validateSelectors: false,
      });
      if (!validation.valid) {
        throw new Error(
          `本地规则校验失败：${formatGkdRuleValidationIssues(validation)}`,
        );
      }
      // GKD accepts a single group and takes the app ID from the route, so avoid
      // requiring a redundant root id in the serialized source.
      const appendSource = app.groups.length === 1 ? app.groups[0] : app;
      // Append is not idempotent: choose one transport and never retry after a lost response.
      const response = await (hasNetworkExtension() ? postWithExtension : postWithFetch)(origin, "appendRules", {
        subsId: -2, groupType: 2, appId, source: JSON.stringify(appendSource),
      });
      await assertJsonRpcOk(response, "appendRules");
      const result: unknown = await response.json();
      if (!Array.isArray(result) || result.length !== app.groups.length || result.some((group, index) =>
        !group || !Number.isSafeInteger(group.key) || !Array.isArray(group.rules)
        || group.rules.length !== app.groups[index].rules.length)) {
        throw new Error("GKD 返回的导入结果不完整，请在 GKD 核对是否已写入后再重试");
      }
      return { ok: true, action: "append", appId, appName: app.name,
        addedGroups: result.length, addedRules: result.reduce((count, group) => count + group.rules.length, 0),
        skippedDuplicates: 0 };
    },
    loadSnapshot: async (id) => {
      if (channel) await prepareSelectorEngine(channel);
      const [snapshot, screenshot] = await Promise.all([
        client.getSnapshot(id),
        client.getScreenshot(id),
      ]);
      const screenshotUrl = URL.createObjectURL(
        new Blob([screenshot], { type: screenshotMimeType(new Uint8Array(screenshot)) }),
      );
      const parsed = normalizeSnapshot(
        snapshot,
        screenshotUrl,
        `设备快照 ${formatSnapshotTime(snapshot.id)}`,
      );
      parsed.gkdChannel = channel ?? undefined;
      return parsed;
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
  const device = serverInfo.device ?? {};
  const gkd = serverInfo.gkdAppInfo ?? {};
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
  if (value?.__error || (value && "code" in value && "message" in value)) {
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

/** 取 Activity 路径最后两段用于短展示；桌面/系统界面快照的 activityId 可能为 null。 */
function shortActivity(activityId: string | null | undefined): string {
  return activityId?.split(".").slice(-2).join(".") ?? "未知页面";
}
