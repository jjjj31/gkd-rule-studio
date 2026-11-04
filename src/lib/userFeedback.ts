import type {
  ParsedGkdSnapshot,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";

export type FeedbackCategory = "tool" | "rule" | "feature";

export interface FeedbackRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FeedbackAttachment {
  name: string;
  mimeType: "image/png" | "text/plain" | "application/json" | "application/zip";
  data: string;
}

export interface FeedbackPayload {
  version: 1;
  clientId: string;
  category: FeedbackCategory;
  description: string;
  contact: string;
  context: {
    appVersion: string;
    systemVersion: string;
    gkdVersion: string;
    gkdChannel: string;
    page: string;
    error: string;
  };
  attachments: FeedbackAttachment[];
}

export interface FeedbackDraft {
  payload: FeedbackPayload;
  savedAt: number;
}

const REDACTED = "[REDACTED]";
const HIDDEN_PLACEHOLDER = "[已隐藏]";
const CONFIRMED_FEEDBACK_ENDPOINT =
  "https://120.25.221.144/gkd-feedback/api/feedback";
const DEFAULT_FEEDBACK_ENDPOINT =
  import.meta.env.VITE_USER_FEEDBACK_URL?.trim() || CONFIRMED_FEEDBACK_ENDPOINT;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_PIXELS = 12_000_000;
const MAX_SCREENSHOT_DIMENSION = 8_192;
const REQUEST_TIMEOUT_MS = 20_000;
const IMAGE_LOAD_TIMEOUT_MS = 15_000;
const DRAFT_DATABASE = "gkd-rule-builder-feedback";
const DRAFT_STORE = "drafts";
const DRAFT_KEY = "latest";
const SECRET_KEY =
  "(?:(?:x[_-]?)?api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|client[_-]?secret|secret|password|passwd|pwd|signature|sig)";

export function sanitizeFeedbackText(
  text: string,
  secrets: string[] = [],
  sensitiveTexts: string[] = [],
): string {
  let sanitized = text;

  sanitized = replaceLiteralValues(sanitized, [...secrets, ...sensitiveTexts]);
  sanitized = sanitized.replace(
    new RegExp("([?&]" + SECRET_KEY + "=)([^&#\\s\"']+)", "gi"),
    "$1" + REDACTED,
  );
  sanitized = sanitized.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/:@"']+)(?::[^\s/@\"']*)?@/gi,
    "$1" + REDACTED + "@",
  );
  sanitized = sanitized.replace(
    /(\bAuthorization["']?\s*:\s*["']?(?:Bearer|Basic)\s+)[^\s"',;]+/gi,
    "$1" + REDACTED,
  );
  sanitized = sanitized.replace(
    /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    "$1" + REDACTED,
  );
  sanitized = sanitized.replace(
    new RegExp(
      "((?:[\"']?" + SECRET_KEY + "[\"']?)\\s*[:=]\\s*)([\"'])(.*?)\\2",
      "gi",
    ),
    "$1$2" + REDACTED + "$2",
  );
  sanitized = sanitized.replace(
    new RegExp(
      "(\\b" + SECRET_KEY + "\\b\\s*[\"']?\\s*[:=]\\s*)(?![\"'])([^\\s,;&}]+)",
      "gi",
    ),
    "$1" + REDACTED,
  );

  return replaceLiteralValues(sanitized, [...secrets, ...sensitiveTexts]);
}

export function redactFeedbackNodes(
  snapshot: ParsedGkdSnapshot,
  rects: FeedbackRect[],
  hiddenNodeIds: number[],
  secrets: string[] = [],
  sensitiveTexts: string[] = [],
): { nodes: unknown[]; sensitiveTexts: string[] } {
  const hiddenIds = new Set(hiddenNodeIds.filter(Number.isFinite));
  const sensitive = uniqueTexts([...secrets, ...sensitiveTexts]);
  const sensitiveSet = new Set(sensitive);

  for (const node of snapshot.nodes) {
    if (hiddenIds.has(node.id) || rects.some((rect) => intersectsNode(rect, node.attr))) {
      for (const value of sensitiveNodeValues(node.attr)) {
        sensitiveSet.add(value);
      }
    }
  }

  const allSensitive = [...sensitiveSet];

  const nodes = snapshot.nodes.map((node) => {
    const hideNode =
      hiddenIds.has(node.id) ||
      rects.some((rect) => intersectsNode(rect, node.attr)) ||
      sensitiveNodeValues(node.attr).some((value) =>
        allSensitive.some((needle) => value.includes(needle)),
      );
    return {
      id: node.id,
      pid: node.pid,
      idQf: node.idQf,
      textQf: node.textQf,
      children: [...node.children],
      attr: sanitizeNodeAttr(node.attr, secrets, allSensitive, hideNode),
    };
  });

  return { nodes, sensitiveTexts: allSensitive };
}

export async function renderRedactedScreenshot(
  sourceUrl: string,
  rects: FeedbackRect[],
): Promise<string> {
  if (typeof Image === "undefined" || typeof document === "undefined") {
    throw new Error("当前环境无法处理截图。");
  }

  const image = await loadScreenshot(sourceUrl);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new Error("截图尺寸无效。");
  }
  if (
    width > MAX_SCREENSHOT_DIMENSION ||
    height > MAX_SCREENSHOT_DIMENSION ||
    width * height > MAX_SCREENSHOT_PIXELS
  ) {
    throw new Error("截图像素尺寸过大，请缩小后重试。");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("当前环境无法创建截图画布。");
  }

  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = "#000000";
  context.drawImage(image, 0, 0, width, height);
  for (const rect of rects) {
    const clipped = clipRect(rect, width, height);
    if (clipped) {
      context.fillRect(
        clipped.left,
        clipped.top,
        clipped.right - clipped.left,
        clipped.bottom - clipped.top,
      );
    }
  }

  const blob = await canvasToBlob(canvas);
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("处理后的截图超过 8 MiB，请缩小后重试。");
  }
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export async function submitUserFeedback(
  payload: FeedbackPayload,
  endpoint: string = DEFAULT_FEEDBACK_ENDPOINT,
): Promise<{ id: string }> {
  validateFeedbackPayload(payload);
  const target = normalizeEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": payload.clientId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new Error("反馈提交超时，请稍后重试。");
      }
      throw new Error("反馈提交失败，请检查网络后重试。");
    }

    if (!response.ok) {
      if (response.status === 409) {
        throw new Error("该反馈已经提交，请勿重复发送。");
      }
      if (response.status === 429) {
        throw new Error("反馈提交过于频繁，请稍后再试。");
      }
      if (response.status === 413) {
        throw new Error("反馈附件过大，请减小后重试。");
      }
      throw new Error("反馈提交失败（HTTP " + response.status + "），请稍后重试。");
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      if (controller.signal.aborted) throw new Error("反馈提交超时，请稍后重试。");
      throw new Error("反馈服务返回了无效结果，请稍后重试。");
    }
    if (
      !result ||
      typeof result !== "object" ||
      typeof (result as { id?: unknown }).id !== "string" ||
      !(result as { id: string }).id.trim()
    ) {
      throw new Error("反馈服务未确认提交，请稍后重试。");
    }
    return { id: (result as { id: string }).id.trim() };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function saveFeedbackDraft(draft: FeedbackDraft): Promise<void> {
  validateFeedbackDraft(draft);
  await runDraftStore("readwrite", (store) => store.put(draft, DRAFT_KEY), {
    unavailable: "当前环境不支持 IndexedDB，无法保存反馈草稿。",
    quota: "IndexedDB 配额不足，反馈草稿未保存。",
    blocked: "浏览器拒绝访问反馈草稿存储，草稿未保存。",
    failed: "反馈草稿保存失败。",
  });
}

export async function loadFeedbackDraft(): Promise<FeedbackDraft | null> {
  const result = await runDraftStore<unknown>(
    "readonly",
    (store) => store.get(DRAFT_KEY),
    {
      unavailable: "当前环境不支持 IndexedDB，无法读取反馈草稿。",
      quota: "IndexedDB 无法读取反馈草稿。",
      blocked: "浏览器拒绝访问反馈草稿存储，无法读取草稿。",
      failed: "反馈草稿读取失败。",
    },
  );
  if (result == null) {
    return null;
  }
  try {
    validateFeedbackDraft(result as FeedbackDraft);
  } catch {
    throw new Error("反馈草稿已损坏，无法读取；可删除后重试。");
  }
  return result as FeedbackDraft;
}

export async function deleteFeedbackDraft(): Promise<void> {
  await runDraftStore("readwrite", (store) => store.delete(DRAFT_KEY), {
    unavailable: "当前环境不支持 IndexedDB，无法删除反馈草稿。",
    quota: "IndexedDB 无法删除反馈草稿。",
    blocked: "浏览器拒绝访问反馈草稿存储，无法删除草稿。",
    failed: "反馈草稿删除失败。",
  });
}

export function createFeedbackId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    return (
      hex.slice(0, 8) +
      "-" +
      hex.slice(8, 12) +
      "-" +
      hex.slice(12, 16) +
      "-" +
      hex.slice(16, 20) +
      "-" +
      hex.slice(20)
    );
  }
  const random = Math.random().toString(36).slice(2).padEnd(12, "0");
  return "feedback-" + Date.now().toString(36) + "-" + random;
}

function replaceLiteralValues(text: string, values: string[]): string {
  return uniqueTexts(values)
    .filter((value) => value !== REDACTED)
    .sort((left, right) => right.length - left.length)
    .reduce((result, value) => result.split(value).join(REDACTED), text);
}

function uniqueTexts(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter(
          (value) =>
            Boolean(value) && value !== REDACTED && value !== HIDDEN_PLACEHOLDER,
        ),
    ),
  ];
}

function sensitiveNodeValues(attr: SnapshotNodeAttr): string[] {
  return uniqueTexts([attr.text ?? "", attr.desc ?? "", attr.id ?? "", attr.vid ?? ""]);
}

function sanitizeNodeAttr(
  attr: SnapshotNodeAttr,
  secrets: string[],
  sensitiveTexts: string[],
  hideSensitiveFields: boolean,
): SnapshotNodeAttr {
  const sanitize = (value: string | null): string | null =>
    value === null ? null : sanitizeFeedbackText(value, secrets, sensitiveTexts);
  return {
    id: hideSensitiveFields ? null : sanitize(attr.id),
    vid: hideSensitiveFields ? null : sanitize(attr.vid),
    name: sanitizeFeedbackText(attr.name, secrets, sensitiveTexts),
    text: hideSensitiveFields ? null : sanitize(attr.text),
    desc: hideSensitiveFields ? null : sanitize(attr.desc),
    clickable: attr.clickable,
    focusable: attr.focusable,
    checkable: attr.checkable,
    checked: attr.checked,
    editable: attr.editable,
    longClickable: attr.longClickable,
    visibleToUser: attr.visibleToUser,
    left: attr.left,
    top: attr.top,
    right: attr.right,
    bottom: attr.bottom,
    width: attr.width,
    height: attr.height,
    childCount: attr.childCount,
    index: attr.index,
    depth: attr.depth,
  };
}

function intersectsNode(rect: FeedbackRect, attr: SnapshotNodeAttr): boolean {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return false;
  }
  const left = Math.min(rect.x, rect.x + rect.width);
  const right = Math.max(rect.x, rect.x + rect.width);
  const top = Math.min(rect.y, rect.y + rect.height);
  const bottom = Math.max(rect.y, rect.y + rect.height);
  return (
    attr.left <= right &&
    attr.right >= left &&
    attr.top <= bottom &&
    attr.bottom >= top
  );
}

async function loadScreenshot(sourceUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      image.onload = null;
      image.onerror = null;
      reject(new Error("截图加载超时，请重试。"));
    }, IMAGE_LOAD_TIMEOUT_MS);
    image.onload = () => {
      globalThis.clearTimeout(timeout);
      resolve(image);
    };
    image.onerror = () => {
      globalThis.clearTimeout(timeout);
      reject(new Error("截图加载失败，请重试。"));
    };
    image.src = sourceUrl;
  });
}

function clipRect(
  rect: FeedbackRect,
  width: number,
  height: number,
): { left: number; top: number; right: number; bottom: number } | null {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return null;
  }
  const left = Math.max(0, Math.floor(Math.min(rect.x, rect.x + rect.width)));
  const right = Math.min(width, Math.ceil(Math.max(rect.x, rect.x + rect.width)));
  const top = Math.max(0, Math.floor(Math.min(rect.y, rect.y + rect.height)));
  const bottom = Math.min(height, Math.ceil(Math.max(rect.y, rect.y + rect.height)));
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("截图转换失败，请重试。"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") {
    throw new Error("当前环境无法编码截图。");
  }
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function validateFeedbackDraft(draft: FeedbackDraft): void {
  if (
    !isRecord(draft) ||
    !Number.isFinite(draft.savedAt) ||
    draft.savedAt < 0
  ) {
    throw new Error("反馈草稿格式无效，未保存。");
  }
  validateFeedbackPayload(draft.payload, "反馈草稿");
}

function validateFeedbackPayload(
  payload: unknown,
  label = "反馈",
): asserts payload is FeedbackPayload {
  if (!isRecord(payload)) {
    throw new Error(label + "格式无效，未提交。");
  }
  if (!isNonEmptyString(payload.clientId)) {
    throw new Error("反馈缺少唯一提交标识，无法安全重试。");
  }
  if (
    payload.version !== 1 ||
    (payload.category !== "tool" &&
      payload.category !== "rule" &&
      payload.category !== "feature") ||
    typeof payload.description !== "string" ||
    typeof payload.contact !== "string"
  ) {
    throw new Error(label + "格式无效，未提交。");
  }
  if (
    !isRecord(payload.context) ||
    typeof payload.context.appVersion !== "string" ||
    typeof payload.context.systemVersion !== "string" ||
    typeof payload.context.page !== "string" ||
    typeof payload.context.error !== "string" ||
    (payload.context.gkdVersion !== undefined &&
      typeof payload.context.gkdVersion !== "string") ||
    (payload.context.gkdChannel !== undefined &&
      typeof payload.context.gkdChannel !== "string")
  ) {
    throw new Error(label + "上下文格式无效，未提交。");
  }
  if (!Array.isArray(payload.attachments)) {
    throw new Error(label + "附件格式无效，未提交。");
  }
  if (payload.attachments.length > MAX_ATTACHMENTS) {
    throw new Error("反馈附件不能超过 4 个。");
  }
  let totalBytes = 0;
  for (const attachment of payload.attachments) {
    if (
      !isRecord(attachment) ||
      !isNonEmptyString(attachment.name) ||
      !["image/png", "text/plain", "application/json", "application/zip"].includes(
        String(attachment.mimeType),
      ) ||
      typeof attachment.data !== "string"
    ) {
      throw new Error("反馈附件类型不受支持。");
    }
    totalBytes += attachmentByteLength(attachment as unknown as FeedbackAttachment);
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error("反馈附件总大小不能超过 8 MiB。");
    }
  }
}

function attachmentByteLength(attachment: FeedbackAttachment): number {
  const data = attachment.data.replace(/^data:[^,]*,/, "");
  const decodedLength = base64DecodedLength(data);
  if (decodedLength === null) {
    throw new Error("反馈附件必须是有效 base64 数据。");
  }
  return decodedLength;
}

function base64DecodedLength(value: string): number | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return null;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

function normalizeEndpoint(endpoint: string): string {
  const target = endpoint.trim() || DEFAULT_FEEDBACK_ENDPOINT;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error("反馈提交地址无效。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("反馈提交地址必须使用 HTTP 或 HTTPS。");
  }
  if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) {
    throw new Error("生产反馈地址必须使用 HTTPS；HTTP 仅允许本机测试。");
  }
  return url.toString();
}

function isLocalHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

interface DraftStoreMessages {
  unavailable: string;
  quota: string;
  blocked: string;
  failed: string;
}

async function runDraftStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
  messages: DraftStoreMessages,
): Promise<T> {
  const database = await openDraftDatabase(messages);
  try {
    return await new Promise<T>((resolve, reject) => {
      let request: IDBRequest<T>;
      let transaction: IDBTransaction;
      try {
        transaction = database.transaction(DRAFT_STORE, mode);
        request = operation(transaction.objectStore(DRAFT_STORE));
      } catch (error) {
        reject(draftStorageError(messages, error));
        return;
      }

      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => {
        reject(draftStorageError(messages, request.error ?? transaction.error));
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => {
        reject(draftStorageError(messages, transaction.error ?? request.error));
      };
      transaction.onabort = () => {
        reject(draftStorageError(messages, transaction.error ?? request.error));
      };
    });
  } finally {
    database.close();
  }
}

function openDraftDatabase(messages: DraftStoreMessages): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error(messages.unavailable));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DRAFT_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        database.createObjectStore(DRAFT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(draftStorageError(messages, request.error));
    request.onblocked = () => reject(new Error(messages.blocked));
  });
}

function draftStorageError(messages: DraftStoreMessages, error: unknown): Error {
  const name = error && typeof error === "object"
    ? (error as { name?: unknown }).name
    : undefined;
  if (name === "QuotaExceededError") {
    return new Error(messages.quota);
  }
  if (name === "SecurityError" || name === "NotAllowedError") {
    return new Error(messages.blocked);
  }
  return new Error(messages.failed);
}

