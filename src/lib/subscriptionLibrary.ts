import JSON5 from "json5";
import type {
  LibraryApp, LibraryImportRecord, LibrarySelection, LibrarySource,
  SubscriptionApp, SubscriptionGroup, SubscriptionRule,
} from "../types/subscriptionLibrary";
import { enhancedFetch } from "./networkExtension";

export const LIBRARY_SOURCES_KEY = "gkd-rule-studio-library-sources";
export const LIBRARY_IMPORTS_KEY = "gkd-rule-studio-library-imports";
type LibraryStorage = Pick<Storage, "getItem" | "setItem">;

export function normalizeSubscriptionUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("请输入完整的 HTTP(S) 订阅文件链接"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("请使用不含登录凭据的 HTTP(S) 订阅文件链接");
  }
  if (url.hostname === "github.com" && !url.pathname.includes("/raw/")) {
    throw new Error("这是 GitHub 网页，请提供订阅 JSON/JSON5 文件的原始链接");
  }
  url.hash = "";
  return url.href;
}

export function parseLibrarySubscription(text: string): LibrarySource["subscription"] {
  if (/^\s*</.test(text)) throw new Error("收到的是网页，请提供订阅 JSON/JSON5 文件链接");
  let value: unknown;
  try { value = JSON5.parse(text); } catch { throw new Error("订阅不是有效的 JSON/JSON5，请检查文件链接"); }
  if (!isRecord(value) || !isInteger(value.id) || value.id < 0 ||
      typeof value.name !== "string" || !value.name.trim() || !isInteger(value.version)) {
    throw new Error("订阅需要有效的 id、name 和 version");
  }
  if (value.apps !== undefined && !Array.isArray(value.apps)) throw new Error("订阅的 apps 必须是数组");
  if (value.author !== undefined && typeof value.author !== "string") throw new Error("订阅的 author 必须是文字");
  const apps = value.apps ?? [];
  const ids = new Set<string>();
  for (const app of apps as unknown[]) {
    if (!isRecord(app) || typeof app.id !== "string" || !app.id.trim() || !Array.isArray(app.groups)) {
      throw new Error("应用规则需要包名 id 和 groups 数组");
    }
    if (app.name !== undefined && typeof app.name !== "string") throw new Error(`应用 ${app.id} 的 name 必须是文字`);
    if (ids.has(app.id)) throw new Error(`订阅中存在重复应用包名：${app.id}`);
    ids.add(app.id);
  }
  assertFiniteJson(value);
  return { ...value, apps } as LibrarySource["subscription"];
}

export async function refreshLibrarySource(
  sources: LibrarySource[], input: string, storage: LibraryStorage = localStorage,
): Promise<LibrarySource[]> {
  const url = normalizeSubscriptionUrl(input);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // fetch resolves at headers; keep the deadline until the entire file has arrived.
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("订阅下载超时（20 秒），已保留原缓存，请检查网络后重试"));
      controller.abort();
    }, 20000);
  });
  let text: string;
  try {
    text = await Promise.race([deadline, (async () => {
      const response = await enhancedFetch(url, { cache: "no-store", signal: controller.signal }, { timeout: 20000 });
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
      return response.text();
    })()]);
  } finally { clearTimeout(timer); }
  const subscription = parseLibrarySubscription(text);
  const previous = sources.find((source) => source.url === url);
  if (previous && previous.subscription.id !== subscription.id) {
    throw new Error("刷新返回了不同的订阅 id，已保留原数据；请作为新来源添加");
  }
  const next: LibrarySource = { url, subscription, refreshedAt: Date.now() };
  const updated = previous ? sources.map((source) => source.url === url ? next : source) : [...sources, next];
  saveLibrarySources(updated, storage);
  return updated;
}

export function saveLibrarySources(sources: LibrarySource[], storage: LibraryStorage = localStorage): void {
  try { storage.setItem(LIBRARY_SOURCES_KEY, JSON.stringify(sources)); }
  catch { throw new Error("本地缓存保存失败，原缓存已保留；可删除不需要的来源后重试"); }
}

export function loadLibrarySources(storage: LibraryStorage = localStorage): { sources: LibrarySource[]; error?: string } {
  try {
    const raw = storage.getItem(LIBRARY_SOURCES_KEY);
    if (!raw) return { sources: [] };
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) throw new Error("缓存结构错误");
    const sources: LibrarySource[] = [];
    let error: string | undefined;
    for (const item of stored) {
      try {
        if (!isRecord(item) || typeof item.url !== "string" || typeof item.refreshedAt !== "number") throw new Error("来源损坏");
        sources.push({
          url: normalizeSubscriptionUrl(item.url), refreshedAt: item.refreshedAt,
          subscription: parseLibrarySubscription(JSON.stringify(item.subscription)),
          error: typeof item.error === "string" ? item.error : undefined,
        });
      } catch { error = "部分来源缓存损坏，请重新添加；其他来源仍可使用"; }
    }
    return { sources, error };
  } catch { return { sources: [], error: "读取本地订阅缓存失败，请检查存储权限或重新添加来源" }; }
}

export function searchLibraryApps(sources: LibrarySource[], input: string) {
  const query = input.trim().toLocaleLowerCase();
  const byId = new Map<string, { id: string; name: string; names: Set<string>; sourceCount: number; groupCount: number }>();
  for (const source of sources) for (const app of source.subscription.apps) {
    const name = app.name || app.id;
    const item = byId.get(app.id) ?? { id: app.id, name, names: new Set<string>(), sourceCount: 0, groupCount: 0 };
    item.names.add(name);
    item.sourceCount++;
    item.groupCount += app.groups.length;
    byId.set(app.id, item);
  }
  return [...byId.values()].filter((app) => app.id.toLocaleLowerCase().includes(query) ||
    [...app.names].some((name) => name.toLocaleLowerCase().includes(query)))
    .sort((a, b) => Number(b.names.has(input.trim())) - Number(a.names.has(input.trim())) || a.name.localeCompare(b.name, "zh-CN"));
}

export function inspectLibraryGroup(raw: unknown): { group?: SubscriptionGroup; error?: string; name: string } {
  const name = isRecord(raw) && typeof raw.name === "string" ? raw.name : "无法识别的规则组";
  try {
    if (!isRecord(raw) || !isInteger(raw.key) || typeof raw.name !== "string" || !raw.name.trim()) {
      throw new Error("规则组缺少有效的 key 或名称");
    }
    if (raw.enable !== undefined && typeof raw.enable !== "boolean") throw new Error("enable 必须是布尔值");
    if (raw.desc !== undefined && typeof raw.desc !== "string") throw new Error("desc 必须是文字");
    if (raw.rules === undefined) throw new Error("规则组缺少 rules");
    const rules = (Array.isArray(raw.rules) ? raw.rules : [raw.rules]).map(normalizeLibraryRule);
    if (rules.length === 0) throw new Error("规则组没有规则");
    const keys = new Set<number>();
    for (const rule of rules) if (rule.key !== undefined) {
      if (keys.has(rule.key)) throw new Error(`规则 key 重复：${rule.key}`);
      keys.add(rule.key);
    }
    if (raw.scopeKeys !== undefined) {
      const externalKeys = integerArray(raw.scopeKeys).filter((key) => key !== raw.key);
      if (externalKeys.length) throw new Error(`依赖其他规则组（key：${externalKeys.join("、")}），第一版仅支持独立规则组`);
    }
    for (const props of [raw, ...rules]) {
      for (const field of ["actionCdKey", "actionMaximumKey"]) {
        if (props[field] !== undefined && !isInteger(props[field])) throw new Error(`${field} 必须是整数`);
      }
      const references = [
        ...(props.preKeys === undefined ? [] : integerArray(props.preKeys)),
        ...(props.actionCdKey === undefined ? [] : integerArray(props.actionCdKey)),
        ...(props.actionMaximumKey === undefined ? [] : integerArray(props.actionMaximumKey)),
      ];
      const missing = references.filter((key) => !keys.has(key));
      if (missing.length) throw new Error(`规则引用缺失（key：${[...new Set(missing)].join("、")}），无法独立交付`);
    }
    return { name, group: { ...raw, key: raw.key, name: raw.name, rules } };
  } catch (cause) { return { name, error: cause instanceof Error ? cause.message : "规则组结构不支持" }; }
}

export function selectLibraryGroup(source: LibrarySource, app: LibraryApp, index: number): LibrarySelection {
  const inspected = inspectLibraryGroup(app.groups[index]);
  if (!inspected.group) throw new Error(inspected.error);
  const group = inspected.group;
  const duplicateKey = app.groups.some((raw, i) => i !== index && isRecord(raw) && raw.key === group.key);
  if (duplicateKey) throw new Error(`同一应用中的规则组 key 重复：${group.key}`);
  return {
    id: JSON.stringify([source.url, app.id, group.key]), sourceUrl: source.url,
    subscriptionId: source.subscription.id, subscriptionName: source.subscription.name,
    version: source.subscription.version,
    app: clone({ ...app, name: app.name || app.id, groups: [group] }),
  };
}

export function stringifyLibrarySelection(selection: LibrarySelection): string {
  const attribution = JSON5.stringify({ 来源: selection.subscriptionName, 版本: selection.version, 链接: selection.sourceUrl });
  return `// ${attribution}\n${JSON5.stringify(selection.app, null, 2)}`;
}

export function prepareLibraryAppend(selection: LibrarySelection): SubscriptionApp {
  return clone(selection.app);
}

export function libraryContentKey(selection: LibrarySelection): string {
  return `${selection.id}\n${stableJson(selection.app)}`;
}

export function loadLibraryImports(storage: LibraryStorage = localStorage): { records: LibraryImportRecord[]; error?: string } {
  try {
    const raw = storage.getItem(LIBRARY_IMPORTS_KEY);
    if (!raw) return { records: [] };
    const records: unknown = JSON.parse(raw);
    if (!Array.isArray(records) || records.some((item) => !isRecord(item) || typeof item.id !== "string" ||
      typeof item.sourceUrl !== "string" || typeof item.subscriptionName !== "string" ||
      !isInteger(item.subscriptionId) || !isInteger(item.version) ||
      typeof item.deviceOrigin !== "string" || typeof item.targetPackage !== "string" ||
      (item.complete !== undefined && typeof item.complete !== "boolean") ||
      typeof item.importedAt !== "number" || !Number.isFinite(item.importedAt) ||
      !isValidImportedApp(item.app) || !isValidImportedApp(item.submittedApp))) throw new Error("导入记录损坏");
    return { records: records as LibraryImportRecord[] };
  } catch { return { records: [], error: "读取固定副本记录失败，原记录未被覆盖；可先使用复制" }; }
}

export function saveLibraryImports(records: LibraryImportRecord[], storage: LibraryStorage = localStorage): void {
  try { storage.setItem(LIBRARY_IMPORTS_KEY, JSON.stringify(records)); }
  catch { throw new Error("GKD 已写入，但本地来源记录保存失败；请勿重复导入，可复制规则留存"); }
}

function normalizeLibraryRule(value: unknown): SubscriptionRule {
  const rule: Record<string, unknown> = typeof value === "string" ? { matches: value } : isRecord(value) ? { ...value } : {};
  if (rule.key !== undefined && !isInteger(rule.key)) throw new Error("规则 key 必须是整数");
  for (const field of ["matches", "anyMatches", "excludeMatches", "excludeAllMatches"]) {
    const selectors = rule[field];
    if (selectors !== undefined && !(typeof selectors === "string" && selectors.trim() ||
      Array.isArray(selectors) && selectors.every((selector) => typeof selector === "string" && selector.trim()))) {
      throw new Error(`${field} 必须是选择器文字或数组`);
    }
  }
  if (rule.matches === undefined && rule.anyMatches === undefined) throw new Error("规则缺少 matches 或 anyMatches");
  for (const field of ["preKeys", "actionCdKey", "actionMaximumKey"]) {
    if (rule[field] !== undefined) integerArray(rule[field]);
  }
  return rule as SubscriptionRule;
}

function integerArray(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  if (!values.every(isInteger)) throw new Error("规则引用必须是整数或整数数组");
  return values;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => isRecord(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

function isValidImportedApp(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && Boolean(value.id.trim()) &&
    typeof value.name === "string" && Array.isArray(value.groups) && value.groups.length === 1 &&
    Boolean(inspectLibraryGroup(value.groups[0]).group);
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function assertFiniteJson(value: unknown): void {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("订阅包含无法传给 GKD 的非有限数值");
  if (value && typeof value === "object") for (const item of Object.values(value)) assertFiniteJson(item);
}
