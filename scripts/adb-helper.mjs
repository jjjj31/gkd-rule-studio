import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { promisify } from "node:util";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PORT = Number(process.env.GKD_ADB_HELPER_PORT || 18741);
const HOST = "127.0.0.1";
const ADB = resolveAdbPath();
const GKD_PACKAGE = process.env.GKD_PACKAGE || "li.songe.gkd";
const SNAPSHOT_DIRS = [
  `/sdcard/Android/data/${GKD_PACKAGE}/files/snapshot`,
  `/sdcard/Android/data/${GKD_PACKAGE}/files/snapshots`,
  `/sdcard/Android/data/${GKD_PACKAGE}/cache/snapshot`,
  `/sdcard/Android/data/${GKD_PACKAGE}/cache/snapshots`,
  `/sdcard/Download/GKD/snapshot`,
  `/sdcard/Download/GKD/snapshots`,
];

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${HOST}:${PORT}`);
  setCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (url.pathname === "/api/adb/status") {
      await handleStatus(url, response);
    } else if (url.pathname === "/api/adb/snapshots") {
      await handleSnapshots(url, response);
    } else if (url.pathname === "/api/adb/snapshot") {
      await handleSnapshot(url, response);
    } else {
      writeJson(response, 404, { message: "Unknown ADB helper endpoint" });
    }
  } catch (cause) {
    writeJson(response, 500, {
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[GKD ADB Helper] listening on http://${HOST}:${PORT}`);
});

async function handleStatus(url, response) {
  const diagnostics = [];
  let adbVersion = "";
  let devices = [];

  try {
    const result = await adb(["version"]);
    adbVersion = firstLine(result.stdout);
    diagnostics.push({ status: "pass", message: adbVersion });
    diagnostics.push({ status: "pass", message: `使用 adb: ${ADB}` });
  } catch (cause) {
    writeJson(response, 200, {
      ok: false,
      devices: [],
      diagnostics: [
        {
          status: "fail",
          message:
            "找不到 adb。请安装 Android Platform Tools，或把 adb.exe 加入 PATH。",
        },
        { status: "fail", message: formatError(cause) },
      ],
    });
    return;
  }

  try {
    const result = await adb(["devices", "-l"]);
    devices = parseAdbDevicesOutput(result.stdout);
    if (devices.length === 0) {
      diagnostics.push({
        status: "warn",
        message: "没有发现 USB 设备。请确认数据线、USB 调试和手机授权弹窗。",
      });
    } else {
      diagnostics.push({
        status: "pass",
        message: `发现 ${devices.length} 台设备`,
      });
    }
  } catch (cause) {
    diagnostics.push({ status: "fail", message: formatError(cause) });
  }

  const serial = url.searchParams.get("serial");
  const selected = selectDevice(devices, serial);
  if (selected?.state === "unauthorized") {
    diagnostics.push({
      status: "fail",
      message: `设备 ${selected.serial} 未授权，请在手机上允许 USB 调试。`,
    });
  } else if (selected && selected.state !== "device") {
    diagnostics.push({
      status: "fail",
      message: `设备 ${selected.serial} 状态为 ${selected.state}，当前不可读取。`,
    });
  }

  writeJson(response, 200, {
    ok: diagnostics.every((item) => item.status !== "fail"),
    adbVersion,
    devices,
    diagnostics,
  });
}

async function handleSnapshots(url, response) {
  const serial = await requireDevice(url.searchParams.get("serial"));
  const files = await listSnapshotFiles(serial);
  const summaries = [];

  for (const group of groupFilesById(files)) {
    const jsonFile = group.files.find((file) => file.extension === "json");
    const zipFile = group.files.find((file) => file.extension === "zip");
    if (!jsonFile && !zipFile) continue;

    let snapshot = null;
    try {
      snapshot = jsonFile
        ? JSON.parse(await adbText(serial, ["shell", "cat", jsonFile.path]))
        : JSON.parse(await readZipSnapshotJson(serial, zipFile.path));
    } catch {
      // Keep unreadable snapshots out of the list; diagnostics are exposed by load.
      continue;
    }

    summaries.push({
      id: Number(snapshot.id || group.id),
      appId: snapshot.appId,
      activityId: snapshot.activityId,
      screenWidth: snapshot.screenWidth,
      screenHeight: snapshot.screenHeight,
      isLandscape: Boolean(snapshot.isLandscape),
      appInfo: snapshot.appInfo,
      appName: snapshot.appName,
      appVersionName: snapshot.appVersionName,
      appVersionCode: snapshot.appVersionCode,
    });
  }

  summaries.sort((a, b) => b.id - a.id);
  writeJson(response, 200, summaries);
}

async function handleSnapshot(url, response) {
  const serial = await requireDevice(url.searchParams.get("serial"));
  const id = Number(url.searchParams.get("id"));
  if (!Number.isFinite(id)) {
    throw new Error("缺少有效的快照 id");
  }

  const files = await listSnapshotFiles(serial);
  const group = groupFilesById(files).find((item) => item.id === id);
  if (!group) {
    throw new Error(`没有找到快照 ${id}`);
  }

  const jsonFile = group.files.find((file) => file.extension === "json");
  const pngFile = group.files.find((file) => file.extension === "png");
  const zipFile = group.files.find((file) => file.extension === "zip");

  let snapshot;
  let screenshotBase64;
  if (zipFile) {
    const zip = await adbBuffer(serial, ["exec-out", "cat", zipFile.path]);
    const parsed = readStoredZip(zip);
    snapshot = parsed.snapshot;
    screenshotBase64 = parsed.screenshot.toString("base64");
  } else {
    if (!jsonFile) throw new Error(`快照 ${id} 缺少 JSON 文件`);
    if (!pngFile) throw new Error(`快照 ${id} 缺少截图 PNG 文件`);
    snapshot = JSON.parse(await adbText(serial, ["shell", "cat", jsonFile.path]));
    screenshotBase64 = (
      await adbBuffer(serial, ["exec-out", "cat", pngFile.path])
    ).toString("base64");
  }

  writeJson(response, 200, {
    snapshot,
    screenshotBase64,
    sourceName: `ADB 快照 ${formatSnapshotTime(Number(snapshot.id || id))}`,
  });
}

async function requireDevice(serial) {
  const devices = parseAdbDevicesOutput((await adb(["devices", "-l"])).stdout);
  const selected = selectDevice(devices, serial);
  if (!selected) {
    throw new Error("没有可用 ADB 设备。请连接数据线并开启 USB 调试。");
  }
  if (selected.state === "unauthorized") {
    throw new Error(`设备 ${selected.serial} 未授权，请在手机上允许 USB 调试。`);
  }
  if (selected.state !== "device") {
    throw new Error(`设备 ${selected.serial} 状态为 ${selected.state}，无法读取。`);
  }
  return selected.serial;
}

async function listSnapshotFiles(serial) {
  const files = [];
  const errors = [];

  for (const dir of SNAPSHOT_DIRS) {
    try {
      const output = await adbText(serial, [
        "shell",
        "find",
        dir,
        "-maxdepth",
        "2",
        "-type",
        "f",
        "\\(",
        "-name",
        "*.json",
        "-o",
        "-name",
        "*.png",
        "-o",
        "-name",
        "*.zip",
        "\\)",
      ]);
      output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((path) => {
          const file = parseAdbSnapshotFileName(path.split("/").at(-1) || "");
          if (file) files.push({ ...file, path });
        });
    } catch (cause) {
      errors.push(`${dir}: ${formatError(cause)}`);
    }
  }

  if (files.length === 0) {
    throw new Error(
      [
        "ADB 已连接，但没有在常见目录找到 GKD 快照。",
        "请先在 GKD 内保存快照，再刷新。",
        "已扫描目录:",
        ...SNAPSHOT_DIRS.map((dir) => `- ${dir}`),
        ...errors.slice(0, 4),
      ].join("\n"),
    );
  }

  return files;
}

function groupFilesById(files) {
  const groups = new Map();
  for (const file of files) {
    const group = groups.get(file.id) || { id: file.id, files: [] };
    group.files.push(file);
    groups.set(file.id, group);
  }
  return [...groups.values()].sort((a, b) => b.id - a.id);
}

async function readZipSnapshotJson(serial, path) {
  const zip = await adbBuffer(serial, ["exec-out", "cat", path]);
  return readStoredZip(zip).snapshotText;
}

function readStoredZip(buffer) {
  const entries = readZipEntries(buffer);
  const snapshotEntry = entries.find((entry) => entry.name.endsWith(".json"));
  const screenshotEntry = entries.find((entry) => entry.name.endsWith(".png"));
  if (!snapshotEntry || !screenshotEntry) {
    throw new Error("zip 内缺少 snapshot.json 或 screenshot.png");
  }
  const snapshotText = snapshotEntry.data.toString("utf8");
  return {
    snapshotText,
    snapshot: JSON.parse(snapshotText),
    screenshot: screenshotEntry.data,
  };
}

function readZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataEnd);
    if (method !== 0 && method !== 8) {
      throw new Error(
        `暂不支持压缩方式 ${method} 的 zip，请使用导出的原始 zip 或 JSON/PNG 文件。`,
      );
    }
    entries.push({
      name,
      data: method === 8 ? inflateRawSync(compressed) : compressed,
    });
    offset = dataEnd;
  }
  return entries;
}

function parseAdbDevicesOutput(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"))
    .map((line) => {
      const [serial, state, ...rest] = line.split(/\s+/);
      const model = rest
        .find((item) => item.startsWith("model:"))
        ?.replace(/^model:/, "");
      return { serial, state, model };
    })
    .filter((device) => Boolean(device.serial && device.state));
}

function parseAdbSnapshotFileName(fileName) {
  const match = fileName.match(/(?:snapshot-|screenshot-)?(\d+)\.(json|png|zip)$/i);
  if (!match) return null;
  return {
    id: Number(match[1]),
    extension: match[2].toLowerCase(),
  };
}

function selectDevice(devices, serial) {
  if (serial) return devices.find((device) => device.serial === serial) || null;
  return devices.find((device) => device.state === "device") || devices[0] || null;
}

async function adb(args) {
  const { stdout, stderr } = await execFileAsync(ADB, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 32,
  });
  return { stdout, stderr };
}

async function adbText(serial, args) {
  return (await adb(["-s", serial, ...args])).stdout;
}

async function adbBuffer(serial, args) {
  const { stdout } = await execFileAsync(ADB, ["-s", serial, ...args], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
}

function firstLine(value) {
  return value.split(/\r?\n/).find(Boolean) || value.trim();
}

function formatError(cause) {
  if (cause instanceof Error) {
    const stderr = cause.stderr ? String(cause.stderr).trim() : "";
    return stderr || cause.message;
  }
  return String(cause);
}

function formatSnapshotTime(id) {
  const date = new Date(id);
  if (Number.isNaN(date.getTime())) return String(id);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5174");
  response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function writeJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json;charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function resolveAdbPath() {
  const candidates = [
    process.env.ADB,
    path.join(ROOT_DIR, "adb", "adb.exe"),
    "adb",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "adb" || existsSync(candidate)) {
      return candidate;
    }
  }

  return "adb";
}
