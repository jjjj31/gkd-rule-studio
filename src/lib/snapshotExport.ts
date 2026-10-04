/**
 * 快照导出：把设备快照导出为 Markdown 文档 + PNG 截图两个文件。
 * Markdown 内容 = 基本信息（应用/Activity/分辨率/设备）+ 截图引用 + 缩进节点树。
 * 截图文件名与 Markdown 内的引用保持一致，两个文件放在同一目录即可直接预览。
 * 保存渠道：Android WebView 走 GkdAndroidBridge.saveFile（写入系统下载目录），
 * 普通浏览器走 <a download>。
 */
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";
import { sanitizeSnapshotFileName } from "./snapshotNames";

export interface SnapshotExportFiles {
  markdownName: string;
  markdownContent: string;
  screenshotName: string;
}

/**
 * 生成导出文件名主干。有自定义快照名时直接用它（清洗后），
 * 否则用 gkd-snapshot-20260815-221033-com.example.app。
 */
export function snapshotExportFileStem(
  snapshot: Pick<ParsedGkdSnapshot, "id" | "appId">,
  customName?: string | null,
): string {
  const safeName = sanitizeSnapshotFileName(customName ?? "");
  if (safeName) return safeName;

  const date = new Date(snapshot.id);
  // GKD 快照 id 是毫秒时间戳；早于 2000 年或非法值按原始 id 处理。
  const time = date.getTime();
  const stamp =
    Number.isNaN(time) || time < 946684800000
      ? String(snapshot.id)
      : [
          date.getFullYear(),
          pad2(date.getMonth() + 1),
          pad2(date.getDate()),
        ].join("") +
        "-" +
        [pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())].join(
          "",
        );
  const safeAppId = snapshot.appId.replace(/[^a-zA-Z0-9._-]+/g, "_") || "unknown";
  return `gkd-snapshot-${stamp}-${safeAppId}`;
}

/**
 * 组装导出文件：Markdown 文档内容 + 配套截图文件名。
 * customName 是用户给快照起的名字（可选），会作为导出文件名主干。
 * screenshotBlob 由调用方从设备接口获取，这里只负责纯文本部分。
 */
export function buildSnapshotExport(
  snapshot: ParsedGkdSnapshot,
  now: Date = new Date(),
  customName?: string | null,
): SnapshotExportFiles {
  const stem = snapshotExportFileStem(snapshot, customName);
  const screenshotName = `${stem}.png`;
  return {
    markdownName: `${stem}.md`,
    markdownContent: buildSnapshotMarkdown(snapshot, screenshotName, now),
    screenshotName,
  };
}

export function buildSnapshotMarkdown(
  snapshot: ParsedGkdSnapshot,
  screenshotFileName: string,
  now: Date = new Date(),
): string {
  const appName = snapshot.appInfo?.name ?? snapshot.appId;
  const lines: string[] = [];

  lines.push(`# GKD 快照导出 — ${appName}`);
  lines.push("");
  lines.push(`> 由 GKD Rule Studio 导出于 ${formatDateTime(now)}`);
  lines.push("");
  lines.push("## 基本信息");
  lines.push("");
  lines.push("| 属性 | 值 |");
  lines.push("| --- | --- |");
  lines.push(`| 应用名称 | ${mdCell(appName)} |`);
  lines.push(`| 包名 | ${mdCell(snapshot.appId)} |`);
  if (snapshot.appInfo?.versionName || snapshot.appInfo?.versionCode) {
    lines.push(
      `| 应用版本 | ${mdCell(
        [
          snapshot.appInfo.versionName,
          snapshot.appInfo.versionCode !== undefined
            ? `(${snapshot.appInfo.versionCode})`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      )} |`,
    );
  }
  lines.push(`| Activity | ${mdCell(snapshot.activityId)} |`);
  lines.push(
    `| 分辨率 | ${snapshot.screenWidth} × ${snapshot.screenHeight}（${
      snapshot.isLandscape ? "横屏" : "竖屏"
    }） |`,
  );
  lines.push(`| 快照时间 | ${formatDateTime(new Date(snapshot.id))} |`);
  const deviceLabel = formatDeviceLabel(snapshot);
  if (deviceLabel) {
    lines.push(`| 设备 | ${mdCell(deviceLabel)} |`);
  }
  lines.push(`| 节点数 | ${snapshot.nodes.length} |`);
  lines.push("");
  lines.push("## 截图");
  lines.push("");
  lines.push(`![截图](./${encodeUriSegment(screenshotFileName)})`);
  lines.push("");
  lines.push("## 节点树");
  lines.push("");
  lines.push(
    "缩进表示父子层级；方括号坐标为 `[left,top][right,bottom]`（快照分辨率下的像素）。",
  );
  lines.push("");
  appendNodeTreeLines(snapshot, lines);
  lines.push("");
  return lines.join("\n");
}

/** 把导出文件保存到本地。Android WebView 走原生桥，浏览器走 <a download>。 */
export async function saveExportedFile(fileName: string, blob: Blob): Promise<void> {
  // 注意：必须以方法调用形式 bridge.saveFile(...) 调用，单独取出函数引用
  // 再调用会丢失 this，WebView 会抛
  // "Java bridge method can't be invoked on a non-injected object"。
  if (window.GkdAndroidBridge?.saveFile) {
    window.GkdAndroidBridge.saveFile(
      fileName,
      blob.type || "application/octet-stream",
      await blobToBase64(blob),
    );
    return;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function appendNodeTreeLines(
  snapshot: ParsedGkdSnapshot,
  lines: string[]): void {
  const roots = snapshot.nodes.filter((node) => node.pid < 0);
  const visited = new Set<number>();

  const walk = (node: NormalizedSnapshotNode, depth: number): void => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    lines.push(`${"  ".repeat(depth)}- ${formatNodeTreeLine(node)}`);
    for (const childId of node.children) {
      const child = snapshot.nodeById.get(childId);
      if (child) walk(child, depth + 1);
    }
  };

  for (const root of roots) {
    walk(root, 0);
  }

  // 悬空节点（父 id 不存在等异常数据）也要导出，避免内容缺失。
  for (const node of snapshot.nodes) {
    if (!visited.has(node.id)) {
      lines.push(`- ${formatNodeTreeLine(node)} _(未挂载节点)_`);
    }
  }
}

function formatNodeTreeLine(node: NormalizedSnapshotNode): string {
  const attr: SnapshotNodeAttr = node.attr;
  const parts: string[] = [`\`${attr.name}\``];
  if (attr.id) parts.push(`id=\`${attr.id}\``);
  if (attr.vid) parts.push(`vid=\`${attr.vid}\``);
  if (attr.text) parts.push(`text=\`${mdCode(attr.text)}\``);
  if (attr.desc) parts.push(`desc=\`${mdCode(attr.desc)}\``);
  const flags: string[] = [];
  if (attr.clickable) flags.push("可点击");
  if (attr.longClickable) flags.push("可长按");
  if (attr.checked) flags.push("已勾选");
  if (attr.editable) flags.push("可输入");
  if (!attr.visibleToUser) flags.push("不可见");
  if (flags.length > 0) parts.push(`[${flags.join(" ")}]`);
  parts.push(`\`[${attr.left},${attr.top}][${attr.right},${attr.bottom}]\``);
  return parts.join(" ");
}

function formatDeviceLabel(snapshot: ParsedGkdSnapshot): string {
  const device = snapshot.device;
  if (!device) return "";
  return [
    [device.manufacturer, device.model].filter(Boolean).join(" "),
    device.release ? `Android ${device.release}` : "",
    device.sdkInt !== undefined ? `SDK ${device.sdkInt}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Markdown 行内代码值：去掉反引号，换行折叠成空格。 */
function mdCode(value: string): string {
  return value.replace(/`/g, "'").replace(/\s+/g, " ").trim();
}

/** Markdown 表格单元格：竖线转义，换行折叠。 */
function mdCell(value: string | null | undefined): string {
  return (value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

/** 文件名放进 Markdown 链接时做 URI 编码，保证特殊字符也能解析。 */
function encodeUriSegment(fileName: string): string {
  return encodeURIComponent(fileName).replace(/%2E/gi, ".");
}

function formatDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return "未知时间";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
