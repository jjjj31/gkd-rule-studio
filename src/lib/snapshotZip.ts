import JSZip from "jszip";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
  RawGkdSnapshot,
  SnapshotNode,
} from "../types/gkdSnapshot";

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

export async function loadSnapshotZip(file: File): Promise<ParsedGkdSnapshot> {
  const zip = await JSZip.loadAsync(file);
  const jsonEntry = findSnapshotJson(zip);
  const imageEntry = findScreenshot(zip);

  if (!jsonEntry) {
    throw new Error("zip 中没有找到包含 nodes 的 snapshot JSON");
  }

  if (!imageEntry) {
    throw new Error("zip 中没有找到截图图片");
  }

  const rawText = await jsonEntry.async("string");
  const raw = JSON.parse(rawText) as RawGkdSnapshot;
  validateRawSnapshot(raw);

  const imageBlob = await imageEntry.async("blob");
  const screenshotUrl = URL.createObjectURL(imageBlob);

  return normalizeSnapshot(raw, screenshotUrl, file.name);
}

function findSnapshotJson(zip: JSZip): JSZip.JSZipObject | null {
  const jsonFiles = Object.values(zip.files).filter(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith(".json"),
  );

  const exact = jsonFiles.find((entry) =>
    entry.name.toLowerCase().endsWith("snapshot.json"),
  );

  return exact ?? jsonFiles[0] ?? null;
}

function findScreenshot(zip: JSZip): JSZip.JSZipObject | null {
  const imageFiles = Object.values(zip.files).filter(
    (entry) => !entry.dir && IMAGE_RE.test(entry.name),
  );

  const exact = imageFiles.find((entry) =>
    /(^|\/)screenshot\.(png|jpe?g|webp)$/i.test(entry.name),
  );

  return exact ?? imageFiles[0] ?? null;
}

function validateRawSnapshot(raw: RawGkdSnapshot): void {
  if (!raw || typeof raw !== "object") {
    throw new Error("snapshot JSON 不是对象");
  }

  if (!Array.isArray(raw.nodes)) {
    throw new Error("snapshot JSON 缺少 nodes 数组");
  }

  if (!raw.appId || !raw.activityId) {
    throw new Error("snapshot JSON 缺少 appId 或 activityId");
  }
}

export function normalizeSnapshot(
  raw: RawGkdSnapshot,
  screenshotUrl: string,
  sourceName: string,
): ParsedGkdSnapshot {
  const nodes = raw.nodes.map(normalizeNode);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    if (node.pid >= 0) {
      nodeById.get(node.pid)?.children.push(node.id);
    }
  }

  return {
    id: raw.id,
    appId: raw.appId,
    activityId: raw.activityId,
    screenWidth: raw.screenWidth,
    screenHeight: raw.screenHeight,
    isLandscape: raw.isLandscape,
    appInfo: raw.appInfo,
    nodes,
    nodeById,
    screenshotUrl,
    sourceName,
  };
}

function normalizeNode(node: SnapshotNode): NormalizedSnapshotNode {
  return {
    ...node,
    attr: {
      ...node.attr,
      id: node.attr.id ?? null,
      vid: node.attr.vid ?? null,
      text: node.attr.text ?? null,
      desc: node.attr.desc ?? null,
      clickable: Boolean(node.attr.clickable),
      focusable: Boolean(node.attr.focusable),
      checkable: Boolean(node.attr.checkable),
      checked: Boolean(node.attr.checked),
      editable: Boolean(node.attr.editable),
      longClickable: Boolean(node.attr.longClickable),
      visibleToUser: Boolean(node.attr.visibleToUser),
    },
    children: [],
  };
}
