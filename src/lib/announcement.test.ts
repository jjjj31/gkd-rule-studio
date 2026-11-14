import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Announcement,
  fetchAnnouncement,
  getCachedAnnouncement,
  getStoredLastReadId,
  hasUnreadAnnouncement,
  parseTextWithLinks,
  setCachedAnnouncement,
  setStoredLastReadId,
  shouldShowAnnouncement,
  validateAnnouncement,
} from "./announcement";

describe("announcement module", () => {
  let storageMap: Map<string, string>;

  beforeEach(() => {
    storageMap = new Map();
    const mockStorage = {
      getItem: (key: string) => storageMap.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageMap.set(key, String(value));
      },
      removeItem: (key: string) => {
        storageMap.delete(key);
      },
      clear: () => {
        storageMap.clear();
      },
    };
    vi.stubGlobal("localStorage", mockStorage);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("validateAnnouncement", () => {
    it("validates a full announcement object", () => {
      const valid: Announcement = {
        id: "20261114-1",
        enabled: true,
        title: "欢迎使用新版",
        content: "这是测试内容",
        type: "notice",
      };
      expect(validateAnnouncement(valid)).toBe(true);
    });

    it("rejects invalid announcements missing id or enabled", () => {
      expect(validateAnnouncement(null)).toBe(false);
      expect(validateAnnouncement({})).toBe(false);
      expect(validateAnnouncement({ id: "", enabled: true, title: "t", content: "c", type: "notice" })).toBe(false);
      expect(validateAnnouncement({ id: "1", title: "t", content: "c", type: "notice" })).toBe(false);
      expect(validateAnnouncement({ id: "1", enabled: true, title: "t", content: "c", type: "other" })).toBe(false);
    });
  });

  describe("shouldShowAnnouncement (防打扰核心规则)", () => {
    const sample: Announcement = {
      id: "ann-001",
      enabled: true,
      title: "关于规则更新的说明",
      content: "请及时更新规则库",
      type: "notice",
    };

    it("绝不在 enabled 为 false 时弹出", () => {
      expect(shouldShowAnnouncement({ ...sample, enabled: false }, null)).toBe(false);
      expect(shouldShowAnnouncement({ ...sample, enabled: false }, "other-id")).toBe(false);
    });

    it("当用户未读（无已读记录或 ID 不匹配）时主动弹出", () => {
      expect(shouldShowAnnouncement(sample, null)).toBe(true);
      expect(shouldShowAnnouncement(sample, "old-id-000")).toBe(true);
    });

    it("已读相同 ID 后，绝不再重复弹出打扰用户", () => {
      expect(shouldShowAnnouncement(sample, "ann-001")).toBe(false);
    });

    it("当开启紧急强提醒 forced: true 时，即使已读也依然弹出", () => {
      const forcedNotice: Announcement = { ...sample, forced: true };
      expect(shouldShowAnnouncement(forcedNotice, "ann-001")).toBe(true);
    });
  });

  describe("hasUnreadAnnouncement (小喇叭红点标记)", () => {
    const sample: Announcement = {
      id: "ann-002",
      enabled: true,
      title: "更新通知",
      content: "内容",
      type: "update",
    };

    it("当未读时返回 true", () => {
      expect(hasUnreadAnnouncement(sample, null)).toBe(true);
      expect(hasUnreadAnnouncement(sample, "other-id")).toBe(true);
    });

    it("当已读或未启用时返回 false", () => {
      expect(hasUnreadAnnouncement(sample, "ann-002")).toBe(false);
      expect(hasUnreadAnnouncement({ ...sample, enabled: false }, null)).toBe(false);
    });
  });

  describe("storage helpers", () => {
    it("reads and writes last read announcement ID", () => {
      expect(getStoredLastReadId()).toBeNull();
      setStoredLastReadId("ann-123");
      expect(getStoredLastReadId()).toBe("ann-123");
    });

    it("reads and writes cached announcement", () => {
      const sample: Announcement = {
        id: "cache-1",
        enabled: true,
        title: "缓存公告",
        content: "这是离线缓存",
        type: "notice",
      };
      expect(getCachedAnnouncement()).toBeNull();
      setCachedAnnouncement(sample);
      expect(getCachedAnnouncement()).toEqual(sample);
    });
  });

  describe("parseTextWithLinks", () => {
    it("returns empty array for empty content", () => {
      expect(parseTextWithLinks("")).toEqual([]);
    });

    it("handles plain text without any links", () => {
      expect(parseTextWithLinks("你好，这是一条普通文本")).toEqual([
        { text: "你好，这是一条普通文本" },
      ]);
    });

    it("identifies and splits links inside text", () => {
      const text = "加入交流群：https://example.com/chat 获取最新规则";
      const tokens = parseTextWithLinks(text);
      expect(tokens).toEqual([
        { text: "加入交流群：" },
        { text: "https://example.com/chat", url: "https://example.com/chat" },
        { text: " 获取最新规则" },
      ]);
    });
  });

  describe("fetchAnnouncement", () => {
    it("fetches announcement successfully and caches it", async () => {
      const data: Announcement = {
        id: "fetch-1",
        enabled: true,
        title: "在线公告",
        content: "内容",
        type: "notice",
      };

      const fakeFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => data,
      });
      vi.stubGlobal("fetch", fakeFetch);

      const res = await fetchAnnouncement({ endpoints: ["https://test.com/api"] });
      expect(res).toEqual(data);
      expect(getCachedAnnouncement()).toEqual(data);
    });

    it("gracefully falls back to cached announcement on network failure without throwing", async () => {
      const cached: Announcement = {
        id: "cached-fallback",
        enabled: true,
        title: "旧离线公告",
        content: "网络不可用时的离线数据",
        type: "notice",
      };
      setCachedAnnouncement(cached);

      const fakeFetch = vi.fn().mockRejectedValue(new Error("Network connection failed"));
      vi.stubGlobal("fetch", fakeFetch);

      const res = await fetchAnnouncement({ endpoints: ["https://test.com/fail"] });
      expect(res).toEqual(cached);
    });
  });
});
