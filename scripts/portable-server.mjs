import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const ROOT_DIR = resolve(new URL("..", import.meta.url).pathname.slice(1));
const DIST_DIR = resolve(ROOT_DIR, "dist");
const HOST = "127.0.0.1";
const PORT = Number(process.env.GKD_RULE_STUDIO_PORT || process.env.GKD_RULE_BUILDER_PORT || 5174);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

if (!existsSync(join(DIST_DIR, "index.html"))) {
  console.error(`[GKD Rule Studio] dist/index.html not found: ${DIST_DIR}`);
  process.exit(1);
}

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  const filePath = resolveRequestPath(url.pathname);

  response.setHeader("Cache-Control", cacheHeader(filePath));
  response.setHeader("X-Content-Type-Options", "nosniff");

  createReadStream(filePath)
    .on("error", () => {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Failed to read file.");
    })
    .once("open", () => {
      response.writeHead(200, {
        "Content-Type": MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream",
      });
    })
    .pipe(response);
});

server.listen(PORT, HOST, () => {
  console.log(`[GKD Rule Studio] listening on http://${HOST}:${PORT}`);
});

function resolveRequestPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  const requested = resolve(DIST_DIR, relative);

  if (!requested.startsWith(DIST_DIR)) {
    return join(DIST_DIR, "index.html");
  }

  if (existsSync(requested) && statSync(requested).isFile()) {
    return requested;
  }

  return join(DIST_DIR, "index.html");
}

function cacheHeader(filePath) {
  return filePath.includes(`${resolve(DIST_DIR, "assets")}`) ||
    filePath.includes(`${resolve(DIST_DIR, "assets")}\\`)
    ? "public, max-age=31536000, immutable"
    : "no-store";
}
