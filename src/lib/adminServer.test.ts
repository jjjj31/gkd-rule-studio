import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const testScratchDir = resolve(process.cwd(), ".scratch/test-admin-server");
mkdirSync(testScratchDir, { recursive: true });
process.env.ANNOUNCEMENT_DATA_FILE = resolve(testScratchDir, "announcement.json");
process.env.ANNOUNCEMENT_HISTORY_FILE = resolve(testScratchDir, "announcement-history.json");

// @ts-expect-error admin/server.mjs is outside src
const serverModulePromise = import("../../admin/server.mjs");

describe("admin/server.mjs", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const { createAppServer } = await serverModulePromise;
    server = createAppServer();
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    try {
      rmSync(testScratchDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("GET /api/announcement returns public announcement with CORS headers", async () => {
    const res = await fetch(`${baseUrl}/api/announcement`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const data = await res.json();
    expect(data).toHaveProperty("id");
    expect(data).toHaveProperty("title");
    expect(data).toHaveProperty("content");
  });

  it("POST /api/admin/login validates password", async () => {
    // 错误密码
    const wrongRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(wrongRes.status).toBe(401);

    // 正确密码
    const correctRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || "gkd-admin-2026" }),
    });
    expect(correctRes.status).toBe(200);
    const json = await correctRes.json();
    expect(json.success).toBe(true);
    expect(typeof json.token).toBe("string");
  });

  it("POST /api/admin/publish creates and publishes an announcement", async () => {
    // 登录拿 token
    const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || "gkd-admin-2026" }),
    });
    const { token } = await loginRes.json();

    // 发布
    const pubRes = await fetch(`${baseUrl}/api/admin/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        enabled: true,
        type: "notice",
        title: "自动化测试公告",
        content: "这是一条来自测试的通知",
        forced: false,
      }),
    });
    expect(pubRes.status).toBe(200);
    const pubData = await pubRes.json();
    expect(pubData.success).toBe(true);
    expect(pubData.announcement.title).toBe("自动化测试公告");
    expect(pubData.announcement.id).toMatch(/^ann-/);

    // 校验公开接口立即能获取到刚才发布的内容
    const getRes = await fetch(`${baseUrl}/api/announcement`);
    const current = await getRes.json();
    expect(current.title).toBe("自动化测试公告");
    expect(current.id).toBe(pubData.announcement.id);
  });

  it("GET / serves the dashboard HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("GKD Rule Studio");
    expect(html).toContain("公告发布系统");
  });
});
