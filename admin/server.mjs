/**
 * GKD Rule Studio 公告与版本管理后台服务。
 * 纯 Node 原生标准库，零外部依赖，任何服务器或本地环境即开即用。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.ANNOUNCEMENT_DATA_FILE || resolve(__dirname, "../announcement.json");
const HISTORY_FILE = process.env.ANNOUNCEMENT_HISTORY_FILE || resolve(__dirname, "../announcement-history.json");
const PUBLIC_DIR = resolve(__dirname, "public");

const PORT = Number(process.env.PORT || process.env.ADMIN_PORT || 8421);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "gkd-admin-2026";

// 内存会话 Token 管理
const activeSessions = new Set();

function generateToken() {
  const token = randomBytes(24).toString("hex");
  activeSessions.add(token);
  return token;
}

function verifyToken(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  return Boolean(token && activeSessions.has(token));
}

function loadAnnouncement() {
  if (!existsSync(DATA_FILE)) {
    const initial = {
      id: "init",
      enabled: false,
      title: "欢迎使用 GKD Rule Studio",
      content: "在这里可以发布给用户的通知、交流群号或使用提示。",
      type: "notice",
      forced: false,
      updatedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
    };
    saveAnnouncement(initial);
    return initial;
  }
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch {
    return {
      id: "fallback",
      enabled: false,
      title: "暂无公告",
      content: "",
      type: "notice",
    };
  }
}

function saveAnnouncement(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function loadHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const raw = readFileSync(HISTORY_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function appendHistory(item) {
  const list = loadHistory();
  list.unshift(item);
  // 保留最近 50 条历史记录
  const trimmed = list.slice(0, 50);
  writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2) + "\n", "utf8");
}

function jsonResponse(res, statusCode, data, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 512) {
        reject(new Error("Payload Too Large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function createAppServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // 处理 CORS 预检
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      });
      res.end();
      return;
    }

    // 1. 公开接口：手机端 App 拉取公告
    if (pathname === "/api/announcement" && req.method === "GET") {
      const current = loadAnnouncement();
      jsonResponse(res, 200, current, {
        "Cache-Control": "public, max-age=15, stale-while-revalidate=60",
      });
      return;
    }

    // 2. 管理接口：登录验证
    if (pathname === "/api/admin/login" && req.method === "POST") {
      try {
        const body = await readRequestBody(req);
        if (body.password === ADMIN_PASSWORD) {
          const token = generateToken();
          jsonResponse(res, 200, { success: true, token });
        } else {
          jsonResponse(res, 401, { success: false, message: "密码错误，请重新输入" });
        }
      } catch {
        jsonResponse(res, 400, { success: false, message: "无效的请求格式" });
      }
      return;
    }

    // 3. 管理接口：获取当前状态与历史
    if (pathname === "/api/admin/status" && req.method === "GET") {
      if (!verifyToken(req)) {
        jsonResponse(res, 401, { success: false, message: "未登录或登录已过期" });
        return;
      }
      const current = loadAnnouncement();
      const history = loadHistory();
      jsonResponse(res, 200, { success: true, current, history });
      return;
    }

    // 4. 管理接口：发布新公告
    if (pathname === "/api/admin/publish" && req.method === "POST") {
      if (!verifyToken(req)) {
        jsonResponse(res, 401, { success: false, message: "未登录或登录已过期" });
        return;
      }
      try {
        const body = await readRequestBody(req);
        if (!body.title || !body.content) {
          jsonResponse(res, 400, { success: false, message: "标题和内容不能为空" });
          return;
        }

        // 自动生成唯一新 ID，唤醒手机端弹窗
        const now = new Date();
        const timestampStr = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const newId = `ann-${timestampStr}`;
        const updatedAt = now.toISOString().slice(0, 19).replace("T", " ");

        const announcement = {
          id: newId,
          enabled: body.enabled ?? true,
          title: String(body.title).trim(),
          content: String(body.content).trim(),
          type: body.type === "update" ? "update" : "notice",
          forced: Boolean(body.forced),
          updatedAt,
          versionName: body.versionName ? String(body.versionName).trim() : undefined,
          versionCode: body.versionCode ? Number(body.versionCode) : undefined,
          apkUrl: body.apkUrl ? String(body.apkUrl).trim() : undefined,
          mirrors: Array.isArray(body.mirrors) ? body.mirrors : undefined,
          sha256: body.sha256 ? String(body.sha256).trim() : undefined,
          actionUrl: body.actionUrl ? String(body.actionUrl).trim() : undefined,
          actionText: body.actionText ? String(body.actionText).trim() : undefined,
        };

        saveAnnouncement(announcement);
        appendHistory(announcement);
        jsonResponse(res, 200, { success: true, announcement });
      } catch (err) {
        jsonResponse(res, 500, { success: false, message: err instanceof Error ? err.message : "保存失败" });
      }
      return;
    }

    // 5. 管理接口：一键启停总开关
    if (pathname === "/api/admin/toggle" && req.method === "POST") {
      if (!verifyToken(req)) {
        jsonResponse(res, 401, { success: false, message: "未登录或登录已过期" });
        return;
      }
      try {
        const body = await readRequestBody(req);
        const current = loadAnnouncement();
        current.enabled = Boolean(body.enabled);
        saveAnnouncement(current);
        jsonResponse(res, 200, { success: true, enabled: current.enabled });
      } catch {
        jsonResponse(res, 400, { success: false, message: "操作失败" });
      }
      return;
    }

    // 6. 前端静态页面托管
    if (pathname === "/" || pathname === "/index.html") {
      const htmlPath = join(PUBLIC_DIR, "index.html");
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  });
}

// 直接运行本文件时启动服务器
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n==================================================`);
    console.log(`[GKD Rule Studio] 公告管理后台服务已启动！`);
    console.log(`管理后台网址: http://localhost:${PORT}`);
    console.log(`手机拉取接口: http://localhost:${PORT}/api/announcement`);
    console.log(`默认管理密码: ${ADMIN_PASSWORD}`);
    console.log(`==================================================\n`);
  });
}
