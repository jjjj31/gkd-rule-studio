import type { UpdateManifest } from "./androidUpdater";

export type AnnouncementType = "notice" | "update";

export interface Announcement {
  /** 唯一标识，例如 "20261114-1" 或时间戳。更新后 id 变化以唤醒用户。 */
  id: string;
  /** 总开关：false 时对所有用户隐藏。 */
  enabled: boolean;
  /** 标题。 */
  title: string;
  /** 正文内容，支持换行和 http(s) 链接。 */
  content: string;
  /** 类型：普通公告 notice 或版本更新 update。 */
  type: AnnouncementType;
  /** 紧急强提醒模式：为 true 时即使点击过关闭，每次进入依然弹出。 */
  forced?: boolean;
  /** 发布时间字符串。 */
  updatedAt?: string;

  /** 若为版本更新类型：新版本号（如 "0.2.2"）。 */
  versionName?: string;
  /** 若为版本更新类型：版本代号（如 202）。 */
  versionCode?: number;
  /** 若为版本更新类型：APK 下载直链。 */
  apkUrl?: string;
  /** 若为版本更新类型：国内加速镜像列表。 */
  mirrors?: string[];
  /** 若为版本更新类型：APK SHA-256 校验和。 */
  sha256?: string;

  /** 附加跳转链接（例如交流群链接、教程链接）。 */
  actionUrl?: string;
  /** 附加跳转按钮文案（例如 "加入交流群"、"查看教程"）。 */
  actionText?: string;
}

export const ANNOUNCEMENT_STORAGE_KEY_LAST_READ = "gkd_last_read_announcement_id";
export const ANNOUNCEMENT_STORAGE_KEY_CACHED = "gkd_cached_announcement";

/** 默认拉取超时时间（毫秒）。严格限制在 2.5 秒内，绝不阻塞用户启动。 */
export const ANNOUNCEMENT_DEFAULT_TIMEOUT_MS = 2500;

/** 默认公告拉取地址（主站及备用源）。 */
export const DEFAULT_ANNOUNCEMENT_ENDPOINTS = [
  "http://127.0.0.1:8421/api/announcement",
  "https://notice.kmttjnm.me/api/announcement",
  "https://raw.githubusercontent.com/jjjj31/gkd-rule-studio/main/announcement.json",
  "https://ghproxy.net/https://raw.githubusercontent.com/jjjj31/gkd-rule-studio/main/announcement.json",
  "https://ghfast.top/https://raw.githubusercontent.com/jjjj31/gkd-rule-studio/main/announcement.json",
] as const;

/** 读取本地存储的已读公告 ID。 */
export function getStoredLastReadId(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY_LAST_READ);
  } catch {
    return null;
  }
}

/** 记录本地已读公告 ID。 */
export function setStoredLastReadId(id: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(ANNOUNCEMENT_STORAGE_KEY_LAST_READ, id);
  } catch {
    // 忽略私密浏览或存储限制错误
  }
}

/** 读取本地离线缓存的公告数据。 */
export function getCachedAnnouncement(): Announcement | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY_CACHED);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (validateAnnouncement(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** 保存公告数据到本地离线缓存。 */
export function setCachedAnnouncement(data: Announcement): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(ANNOUNCEMENT_STORAGE_KEY_CACHED, JSON.stringify(data));
  } catch {
    // 忽略存储错误
  }
}

/**
 * 校验对象是否符合公告结构。
 */
export function validateAnnouncement(obj: unknown): obj is Announcement {
  if (!obj || typeof obj !== "object") return false;
  const item = obj as Record<string, unknown>;
  if (typeof item.id !== "string" || !item.id.trim()) return false;
  if (typeof item.enabled !== "boolean") return false;
  if (typeof item.title !== "string") return false;
  if (typeof item.content !== "string") return false;
  if (item.type !== "notice" && item.type !== "update") return false;
  return true;
}

/**
 * 判断是否需要在进入软件时主动弹出该公告。
 * 核心防打扰规则：
 * 1. 若 enabled 为 false，绝不弹出；
 * 2. 若开启 forced（紧急强提醒），每次进入均弹出；
 * 3. 若当前公告 ID 与本地已读 ID 相同，绝不重复弹出；
 * 4. 仅当公告未读（ID 不一致或首次进入）时弹出。
 */
export function shouldShowAnnouncement(
  announcement: Announcement | null,
  lastReadId: string | null
): boolean {
  if (!announcement || !announcement.enabled) return false;
  if (announcement.forced) return true;
  return announcement.id !== lastReadId;
}

/**
 * 判断是否存在未读公告（用于首页小喇叭红点标记）。
 */
export function hasUnreadAnnouncement(
  announcement: Announcement | null,
  lastReadId: string | null
): boolean {
  if (!announcement || !announcement.enabled) return false;
  return announcement.id !== lastReadId;
}

export interface TextToken {
  text: string;
  url?: string;
}

/**
 * 解析纯文本中的 http/https 链接，将其拆分为文本片段与可点击的 URL 片段。
 */
export function parseTextWithLinks(content: string): TextToken[] {
  if (!content) return [];
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const tokens: TextToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: content.slice(lastIndex, match.index) });
    }
    tokens.push({ text: match[0], url: match[0] });
    lastIndex = urlRegex.lastIndex;
  }

  if (lastIndex < content.length) {
    tokens.push({ text: content.slice(lastIndex) });
  }

  return tokens;
}

export interface FetchAnnouncementOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  endpoints?: string[];
}

/**
 * 异步静默拉取公告数据。
 * 特点：
 * 1. 严格 2.5 秒超时控制，超时立即放弃，不阻塞启动；
 * 2. 静默吞下所有网络错误，绝不弹出网络故障报错；
 * 3. 成功后自动更新本地离线缓存；
 * 4. 网络失败时返回本地缓存（保证离线也能在小喇叭里看到历史内容）。
 */
export async function fetchAnnouncement(
  options: FetchAnnouncementOptions = {}
): Promise<Announcement | null> {
  const timeoutMs = options.timeoutMs ?? ANNOUNCEMENT_DEFAULT_TIMEOUT_MS;
  const endpoints = options.endpoints && options.endpoints.length > 0
    ? options.endpoints
    : [...DEFAULT_ANNOUNCEMENT_ENDPOINTS];

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  if (options.signal) {
    options.signal.addEventListener("abort", () => controller.abort());
  }

  try {
    for (const url of endpoints) {
      if (controller.signal.aborted) break;
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
          cache: "no-cache",
        });
        if (res.ok) {
          const json = await res.json();
          if (validateAnnouncement(json)) {
            setCachedAnnouncement(json);
            return json;
          }
        }
      } catch {
        // 单个端点失败（如国内连不上直接换下一个镜像），继续尝试下一个备用地址
      }
    }
  } catch {
    // 整个过程静默保护
  } finally {
    clearTimeout(timeoutTimer);
  }

  // 线上全部拉取失败或超时时，降级使用离线缓存
  return getCachedAnnouncement();
}

/**
 * 将更新类型的公告转换为安卓更新清单格式，便于无缝复用下载与安装流程。
 */
export function announcementToUpdateManifest(ann: Announcement): UpdateManifest {
  return {
    versionCode: ann.versionCode ?? 0,
    versionName: ann.versionName ?? "",
    forced: Boolean(ann.forced),
    apkUrl: ann.apkUrl ?? "",
    mirrors: ann.mirrors && ann.mirrors.length > 0 ? ann.mirrors : undefined,
    sha256: ann.sha256,
    notes: ann.content,
  };
}
