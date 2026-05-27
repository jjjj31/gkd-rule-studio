import JSON5 from "json5";
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { AppRuleDraft, SelectorCandidate } from "../types/ruleDraft";
import { compactSingletonMatches, createAppRuleDraft } from "./ruleDraft";

const HISTORY_KEY = "gkd-rule-builder-subscription-import-history";
const HISTORY_LIMIT = 30;

export interface ConnectedSubscriptionRepo {
  handle: FileSystemDirectoryHandle;
  name: string;
}

export interface SubscriptionImportRecord {
  id: string;
  createdAt: string;
  repoName: string;
  appId: string;
  appName: string;
  groupName: string;
  ruleName: string;
  selector: string;
  score: number;
  filePath: string;
  action: "create" | "append";
  beforeContent: string | null;
  afterContent: string;
  revertedAt?: string;
}

export interface SubscriptionUpdateResult {
  record: SubscriptionImportRecord;
  filePath: string;
  action: "create" | "append";
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

export async function pickSubscriptionRepo(): Promise<ConnectedSubscriptionRepo> {
  if (!window.showDirectoryPicker) {
    throw new Error("当前浏览器不支持目录写入，请使用 Chromium / Edge 环境。");
  }

  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await ensureWritePermission(handle);
  await assertSubscriptionRepo(handle);

  return {
    handle,
    name: handle.name,
  };
}

export function loadImportHistory(): SubscriptionImportRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveImportHistory(records: SubscriptionImportRecord[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(records.slice(0, HISTORY_LIMIT)));
}

export async function updateSubscriptionRule({
  repo,
  snapshot,
  candidate,
  fallbackCandidates = [],
}: {
  repo: ConnectedSubscriptionRepo;
  snapshot: ParsedGkdSnapshot;
  candidate: SelectorCandidate;
  fallbackCandidates?: SelectorCandidate[];
}): Promise<SubscriptionUpdateResult> {
  await ensureWritePermission(repo.handle);

  const appsDir = await getAppsDir(repo.handle);
  const fileName = `${sanitizeFileName(snapshot.appId)}.ts`;
  const filePath = `src/apps/${fileName}`;
  const existing = await readOptionalFile(appsDir, fileName);
  const draft = assignStableKeys(
    createAppRuleDraft(snapshot, candidate, fallbackCandidates),
    existing,
  );
  const recordId = crypto.randomUUID();
  const action = existing === null ? "create" : "append";
  const nextContent =
    existing === null
      ? createAppSource(draft, recordId)
      : appendGroupToAppSource(existing, draft.groups[0], recordId);

  await writeTextFile(appsDir, fileName, nextContent);

  const primaryRule = draft.groups[0]?.rules[0];
  const primarySelector = formatMatches(primaryRule?.matches ?? []);
  const sourceCandidate =
    [candidate, ...fallbackCandidates].find((item) => {
      return item.rule.matches.join(" && ") === primarySelector;
    }) ?? candidate;

  const record: SubscriptionImportRecord = {
    id: recordId,
    createdAt: new Date().toISOString(),
    repoName: repo.name,
    appId: draft.id,
    appName: draft.name,
    groupName: draft.groups[0]?.name ?? candidate.groupName,
    ruleName: primaryRule?.name ?? draft.groups[0]?.name ?? candidate.groupName,
    selector: primarySelector,
    score: sourceCandidate.risk.finalScore,
    filePath,
    action,
    beforeContent: existing,
    afterContent: nextContent,
  };

  return {
    record,
    filePath,
    action,
  };
}

export async function rollbackImportRecord(
  repo: ConnectedSubscriptionRepo,
  record: SubscriptionImportRecord,
): Promise<SubscriptionImportRecord> {
  await ensureWritePermission(repo.handle);
  const { directory, fileName } = await resolveParentDirectory(
    repo.handle,
    record.filePath,
  );
  const currentContent = await readOptionalFile(directory, fileName);
  const contentWithoutRecord = currentContent
    ? removeGeneratedBlock(currentContent, record.id)
    : null;

  if (contentWithoutRecord !== null) {
    if (record.action === "create" && currentContent === record.afterContent) {
      await directory.removeEntry(fileName);
    } else {
      await writeTextFile(directory, fileName, contentWithoutRecord);
    }
    return {
      ...record,
      revertedAt: new Date().toISOString(),
    };
  }

  if (record.action === "create" && record.beforeContent === null) {
    await directory.removeEntry(fileName);
  } else if (record.beforeContent !== null) {
    await writeTextFile(directory, fileName, record.beforeContent);
  } else {
    throw new Error("这条历史记录缺少撤回前的文件内容。");
  }

  return {
    ...record,
    revertedAt: new Date().toISOString(),
  };
}

async function assertSubscriptionRepo(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  try {
    await handle.getFileHandle("package.json");
    await getAppsDir(handle);
  } catch {
    throw new Error("请选择订阅仓库根目录，需要包含 package.json 和 src/apps。");
  }
}

async function getAppsDir(
  handle: FileSystemDirectoryHandle,
): Promise<FileSystemDirectoryHandle> {
  const srcDir = await handle.getDirectoryHandle("src");
  return srcDir.getDirectoryHandle("apps");
}

async function ensureWritePermission(handle: FileSystemDirectoryHandle): Promise<void> {
  const descriptor = { mode: "readwrite" as const };
  const current = await handle.queryPermission?.(descriptor);
  if (current === "granted") return;

  const next = await handle.requestPermission?.(descriptor);
  if (next !== "granted") {
    throw new Error("没有获得订阅仓库写入权限。");
  }
}

async function readOptionalFile(
  directory: FileSystemDirectoryHandle,
  fileName: string,
): Promise<string | null> {
  try {
    const fileHandle = await directory.getFileHandle(fileName);
    return await (await fileHandle.getFile()).text();
  } catch {
    return null;
  }
}

async function writeTextFile(
  directory: FileSystemDirectoryHandle,
  fileName: string,
  content: string,
): Promise<void> {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function resolveParentDirectory(
  root: FileSystemDirectoryHandle,
  filePath: string,
): Promise<{ directory: FileSystemDirectoryHandle; fileName: string }> {
  const parts = filePath.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error("历史记录里的文件路径无效。");

  let directory = root;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part);
  }

  return { directory, fileName };
}

function assignStableKeys(draft: AppRuleDraft, existing: string | null): AppRuleDraft {
  const nextDraft = structuredClone(draft) as AppRuleDraft;
  let key = existing ? findMaxRuleKey(existing) : 1000;

  nextDraft.groups = nextDraft.groups.map((group) => {
    key += 1;
    return {
      ...group,
      key,
      rules: group.rules.map((rule) => ({
        ...rule,
        key,
        name: rule.name ?? group.name,
      })),
    };
  });

  return nextDraft;
}

function findMaxRuleKey(source: string): number {
  let max = 0;
  for (const match of source.matchAll(/\bkey\s*:\s*(\d+)/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

function createAppSource(draft: AppRuleDraft, recordId: string): string {
  return [
    "import { defineGkdApp } from '@gkd-kit/define';",
    "",
    "export default defineGkdApp({",
    `  id: ${formatObject(draft.id)},`,
    `  name: ${formatObject(draft.name)},`,
    "  groups: [",
    formatGeneratedGroup(draft.groups[0], recordId),
    "  ],",
    "});",
    "",
  ].join("\n");
}

function appendGroupToAppSource(
  source: string,
  group: AppRuleDraft["groups"][number],
  recordId: string,
): string {
  const groupsBounds = findGroupsArrayBounds(source);
  if (!groupsBounds) {
    throw new Error("无法定位现有 app 文件里的 groups 数组，未写入。");
  }

  const beforeArrayEnd = source.slice(0, groupsBounds.end);
  const beforeArrayEndTrimmed = beforeArrayEnd.replace(/\s*$/, "");
  const closingIndent = beforeArrayEnd.slice(beforeArrayEndTrimmed.length);
  const afterArrayEnd = source.slice(groupsBounds.end);
  const inside = source.slice(groupsBounds.start + 1, groupsBounds.end);
  const needsComma = inside.trim().length > 0 && !inside.trimEnd().endsWith(",");
  const groupSource = formatGeneratedGroup(group, recordId);

  return `${beforeArrayEndTrimmed}${needsComma ? "," : ""}\n${groupSource}${closingIndent}${afterArrayEnd}`;
}

function formatGeneratedGroup(
  group: AppRuleDraft["groups"][number],
  recordId: string,
): string {
  return indent(
    [
      `// gkd-rule-builder:start ${recordId}`,
      `${formatObject(group)},`,
      `// gkd-rule-builder:end ${recordId}`,
    ].join("\n"),
    4,
  );
}

function removeGeneratedBlock(source: string, recordId: string): string | null {
  const startMarker = `// gkd-rule-builder:start ${recordId}`;
  const endMarker = `// gkd-rule-builder:end ${recordId}`;
  const markerStart = source.indexOf(startMarker);
  if (markerStart < 0) return null;

  const markerEnd = source.indexOf(endMarker, markerStart);
  if (markerEnd < 0) return null;

  const blockStart = source.lastIndexOf("\n", markerStart) + 1;
  const endLineBreak = source.indexOf("\n", markerEnd);
  const blockEnd = endLineBreak < 0 ? source.length : endLineBreak + 1;

  return `${source.slice(0, blockStart)}${source.slice(blockEnd)}`;
}

function findGroupsArrayBounds(source: string): { start: number; end: number } | null {
  const groupsMatch = /\bgroups\s*:/.exec(source);
  if (!groupsMatch) return null;

  const arrayStart = source.indexOf("[", groupsMatch.index + groupsMatch[0].length);
  if (arrayStart < 0) return null;

  const arrayEnd = findMatchingBracket(source, arrayStart);
  if (arrayEnd < 0) return null;

  return {
    start: arrayStart,
    end: arrayEnd,
  };
}

function findMatchingBracket(source: string, start: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function formatObject(value: unknown): string {
  return JSON5.stringify(compactSingletonMatches(value), null, 2);
}

function indent(source: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return source
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function sanitizeFileName(appId: string): string {
  return appId.replace(/[^\w.-]+/g, "_") || "unknown.app";
}

function formatMatches(matches: string[]): string {
  return matches.join(" && ");
}
