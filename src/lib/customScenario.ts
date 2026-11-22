/** 自定义场景管理：parse/import/persist（localStorage）。 */
import JSON5 from "json5";
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { RuleSettings } from "../types/ruleDraft";
import { isDynamicActivityId } from "./countdownText";

export interface CustomScenario {
  id: string;
  name: string;
  description: string;
  detail: string;
  settings: RuleSettings;
  activityIdsMode?: "current" | "empty" | "literal";
}

interface CustomScenarioPayload {
  name?: unknown;
  groupName?: unknown;
  activityIds?: unknown;
  matchTime?: unknown;
  actionMaximum?: unknown;
  actionCd?: unknown;
  resetMatch?: unknown;
  action?: unknown;
  actionDelay?: unknown;
  forcedTime?: unknown;
  matchRoot?: unknown;
  description?: unknown;
  detail?: unknown;
}

const VALID_ACTIONS = new Set([
  "click",
  "clickNode",
  "clickCenter",
  "longClick",
  "longClickNode",
  "longClickCenter",
  "back",
  "swipe",
  "none",
]);

export const CUSTOM_SCENARIO_STORAGE_KEY =
  "gkd-rule-studio-custom-scenarios";

/** 将逗号或换行分隔的 activityIds 设置文本拆分为去空白的非空数组。 */
export function parseActivityIdsSetting(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,，\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function buildCustomScenarioPrompt(snapshot: ParsedGkdSnapshot | null): string {
  const dynamicActivityWarning = isDynamicActivityId(snapshot?.activityId)
    ? `- ⚠️ 注意：当前 activityId（${snapshot?.activityId}）带有动态后缀，严禁写死或锁死为 current，请将 activityIds 设为 'empty'。`
    : null;

  return [
    "你是 GKD 规则运行场景分析助手。请先向用户提问，确认这个自动点击规则属于什么场景，然后根据回答给出可导入 GKD Rule Studio 的场景参数。",
    "",
    "你必须先问用户这些问题：",
    "1. 这个弹窗/广告是在打开 App 后出现、进入页面后出现、还是使用过程中周期出现？",
    "2. 是否只需要处理一次，还是同一页面/同一播放过程中会反复出现？",
    "3. 这个广告是在 App 的某个特定页面才有，还是整个 App 到处都可能出现？（例如只在「我的」页面出现 → 需要限制页面；整个 App 都可能弹 → 不用限制）",
    "4. 这个广告属于哪种类型：弹窗弹出（点×关闭）、全屏覆盖（有跳过按钮）、还是嵌在页面内容里混在一起（信息流广告）？",
    "5. 用户希望这个场景叫什么名字？",
    "",
    "用户回答后，只输出一个 JSON5 代码块，不要输出其它解释。字段必须是：",
    "```json5",
    "{",
    "  name: '用户给这个场景起的名字',",
    "  groupName: '开屏广告 | 全屏广告 | 局部广告 | 更新提示 | 权限提示 | 功能类-自动生成 | 其它短分组名',",
    "  activityIds: 'current | empty | 具体 activityId',",
    "  matchTime: 10000, // 数字毫秒，或 null",
    "  actionMaximum: 1, // 数字，或 null",
    "  actionCd: 3000, // 数字毫秒，或 null",
    "  resetMatch: 'app | activity | match | empty',",
    "  action: 'clickCenter | empty', // 仅不可点击节点/WebView/自绘控件时选 clickCenter，否则 empty",
    "  actionDelay: null, // 默认 null（立即点击）；仅倒计时初期不可点或已触发未关闭时按需填写毫秒数",
    "  forcedTime: null, // 默认 null；仅 WebView/动态广告无无障碍事件刷新时按需开启（如 10000）",
    "  matchRoot: null, // 默认 null；仅跨层级/WebView 或已触发未关闭需要从根节点重匹配时再设为 true",
    "  description: '一句话解释这个场景何时触发',",
    "  detail: '解释这些参数为什么这样选，提醒用户可调整哪些参数'",
    "}",
    "```",
    "",
    "参数选择规则：",
    "- 打开 App 后短时间出现：通常 matchTime=30000，actionMaximum=1，resetMatch='app'，activityIds 可为 empty。",
    "- 离开 App 后回到 App 出现的全屏广告：通常 activityIds='current'，matchTime=10000，actionMaximum=3，actionCd=1000，resetMatch='app'。",
    "- 进入某页面后出现：通常 activityIds='current'，matchTime=10000，actionMaximum=1，resetMatch='activity'。",
    "- 视频/阅读过程中周期弹窗：通常 activityIds='current'，matchTime=null，actionMaximum=1，actionCd=3000，resetMatch='match'。",
    "- 信息流/局部广告：通常 activityIds='current'，matchTime=null，actionMaximum=null，actionCd=3000，resetMatch='empty'。",
    "- 功能类自动确认：通常 activityIds='current'，matchTime=null，actionMaximum=null，actionCd=null，resetMatch='empty'。",
    "- actionDelay、forcedTime、matchRoot 默认均为 null（立即点击、尽量省电）；仅在 WebView 无无障碍事件刷新、倒计时初期不可点、或已触发未关闭时，再按需开启 clickCenter / actionDelay / forcedTime / matchRoot。",
    "- 如果使用当前快照 Activity，请输出 activityIds='current'，不要把下面的 activityId 直接写死；工具会在导入/切换快照时替换成当前 Activity（若遇到带动态数字/匿名后缀的 Activity，请输出 activityIds='empty'）。",
    "- 如果用户说有触发记录但没关，优先认为 selector 已匹配，再按需推荐 actionDelay、clickCenter、forcedTime、matchRoot、actionMaximum/actionCd，而不是只改 selector。",
    "",
    "当前快照上下文：",
    `- appId: ${snapshot?.appId ?? "(未加载快照)"}`,
    `- appName: ${snapshot?.appInfo?.name ?? "(未知)"}`,
    `- activityId: ${snapshot?.activityId ?? "(未加载快照)"}`,
    ...(dynamicActivityWarning ? [dynamicActivityWarning] : []),
  ].join("\n");
}

export function loadCustomScenarios(): CustomScenario[] {
  try {
    const raw = localStorage.getItem(CUSTOM_SCENARIO_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCustomScenario);
  } catch {
    return [];
  }
}

export function saveCustomScenarios(scenarios: CustomScenario[]): void {
  localStorage.setItem(CUSTOM_SCENARIO_STORAGE_KEY, JSON.stringify(scenarios));
}

export function parseCustomScenario(
  input: string,
  _snapshot: ParsedGkdSnapshot | null,
  fallbackName: string,
): CustomScenario {
  const payload = JSON5.parse(extractObjectSource(input)) as CustomScenarioPayload;
  const name = readString(payload.name, fallbackName).trim();
  const activityIdsMode = normalizeActivityIdsMode(payload.activityIds);
  if (!name) {
    throw new Error("自定义场景缺少 name，或你还没有填写场景名称。");
  }

  return {
    id: `custom-${Date.now()}`,
    name,
    description: readString(payload.description, "用户自定义场景"),
    detail: readString(payload.detail, "由 AI 辅助生成，可继续手动调整参数。"),
    activityIdsMode,
    settings: {
      groupName: readString(payload.groupName, name),
      activityIds: normalizeActivityIds(payload.activityIds, activityIdsMode),
      matchTime: readOptionalNumber(payload.matchTime),
      actionMaximum: readOptionalNumber(payload.actionMaximum),
      actionCd: readOptionalNumber(payload.actionCd),
      resetMatch: normalizeResetMatch(payload.resetMatch),
      action: normalizeAction(payload.action),
      actionDelay: readOptionalNumber(payload.actionDelay),
      forcedTime: readOptionalNumber(payload.forcedTime),
      matchRoot: readOptionalBoolean(payload.matchRoot),
    },
  };
}

export function resolveCustomScenarioSettings(
  scenario: CustomScenario,
  snapshot: ParsedGkdSnapshot | null,
): RuleSettings {
  if (scenario.activityIdsMode === "current") {
    const currentActivityId = snapshot?.activityId ?? "";
    return {
      ...scenario.settings,
      activityIds: isDynamicActivityId(currentActivityId) ? "" : currentActivityId,
    };
  }

  if (scenario.activityIdsMode === "empty") {
    return {
      ...scenario.settings,
      activityIds: "",
    };
  }

  return scenario.settings;
}

function extractObjectSource(input: string): string {
  const trimmed = input.trim();
  const fenced = trimmed.match(/```(?:json5?|javascript|js)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1]?.trim() ?? trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("没有找到 JSON5 对象，请粘贴 AI 返回的代码块。");
  }
  return source.slice(start, end + 1);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function readOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeActivityIdsMode(
  value: unknown,
): CustomScenario["activityIdsMode"] {
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    if (items.length === 0) return "empty";
    if (items.length === 1) return normalizeActivityIdsMode(items[0]);
    if (items.every((item) => item === "empty" || item === "留空")) return "empty";
    return "literal";
  }
  if (typeof value !== "string") return "empty";
  const normalized = value.trim();
  if (normalized === "current" || normalized === "当前") return "current";
  if (!normalized || normalized === "empty" || normalized === "留空") return "empty";
  return "literal";
}

function normalizeActivityIds(
  value: unknown,
  mode: CustomScenario["activityIdsMode"],
): string {
  if (mode !== "literal") return "";
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => Boolean(item) && item !== "empty" && item !== "留空")
      .join(", ");
  }
  if (typeof value !== "string") return "";
  return value.trim();
}

function normalizeResetMatch(value: unknown): RuleSettings["resetMatch"] {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (normalized === "app" || normalized === "activity" || normalized === "match") {
    return normalized;
  }
  return "";
}

function normalizeAction(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized === "empty" || normalized === "留空") return undefined;
  if (!VALID_ACTIONS.has(normalized)) return undefined;
  return normalized;
}

function readOptionalBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "empty" || normalized === "null") return null;
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
}

function isCustomScenario(value: unknown): value is CustomScenario {
  const item = value as Partial<CustomScenario>;
  return Boolean(
    item &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      item.settings &&
      typeof item.settings.groupName === "string",
  );
}
