/**
 * AI 模型集成。
 * 负责：profile 管理（多组 API 配置）、请求组装/发送/解析、测试连接、多模态降级、
 * 反馈循环（把测试结果发给 AI 让 AI 修正候选）。
 * 内置 AI 和外部 AI（粘贴模式）共用 parseAiCandidates 做正则提取。
 * @see helpPrompt.ts 单步 prompt 构建
 * @see inlineRuleTesting.ts AI session 存储与测试
 */
import JSON5 from "json5";
import type { AppRuleDraft, RuleDraft } from "../types/ruleDraft";
import { enhancedFetch } from "./networkExtension";

export type AiMode = "single" | "flow";

export type AiFeedbackResult =
  | "success"
  | "not-triggered"
  | "triggered-no-close"
  | "mistouch"
  | "other";

export interface AiModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  supportsMultimodal: boolean;
}

export interface AiModelProfile {
  id: string;
  name: string;
  config: AiModelConfig;
}

export interface AiModelProfileStore {
  activeId: string;
  profiles: AiModelProfile[];
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: AiChatMessageContent;
}

export type AiChatMessageContent =
  | string
  | Array<
      | {
          type: "text";
          text: string;
        }
      | {
          type: "image_url";
          image_url: {
            url: string;
          };
        }
    >;

export interface AiRuleCandidate {
  id: string;
  title: string;
  summary: string;
  risk: string;
  app: AppRuleDraft;
}

/** AI 供应商连接状态 */
export type AiConnectionStatus =
  | { status: "unknown" }
  | { status: "testing" }
  | { status: "connected"; lastTested: number }
  | { status: "failed"; error: string; category: AiErrorCategory; lastTested: number };

export type AiErrorCategory =
  | "network"
  | "http"
  | "auth"
  | "parse"
  | "server"
  | "unknown";

export interface AiConnectionDiagnosis {
  category: AiErrorCategory;
  message: string;
  hint: string;
}

export interface BuildAiGenerateMessagesInput {
  mode: AiMode;
  prompt: string;
  imageUrl?: string;
}

export interface BuildAiFeedbackMessagesInput {
  mode: AiMode;
  originalPrompt: string;
  candidate: AiRuleCandidate;
  result: AiFeedbackResult | "flow-note";
  note: string;
  imageUrl?: string;
}

export interface AiCandidateFeedback {
  candidate: AiRuleCandidate;
  result: Exclude<AiFeedbackResult, "success"> | "flow-note";
  note: string;
}

export interface BuildAiBatchFeedbackMessagesInput {
  mode: AiMode;
  originalPrompt: string;
  feedbacks: AiCandidateFeedback[];
  imageUrl?: string;
}

export interface RequestAiCandidatesInput {
  config: AiModelConfig;
  messages: AiChatMessage[];
  onDebugLog?: (line: string) => void;
}

export interface AiRequestPayload {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  promptChars: number;
  bodyChars: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
    text?: string;
  }>;
  output_text?: string;
  content?: string;
  error?: {
    message?: string;
  };
}

const CONFIG_STORAGE_KEY = "gkd-rule-studio-ai-config";
const PROFILE_STORAGE_KEY = "gkd-rule-studio-ai-profiles";

const DEFAULT_CONFIG: AiModelConfig = {
  baseURL: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  temperature: 0.2,
  timeoutMs: 120000,
  supportsMultimodal: false,
};

const MIN_GENERATION_TIMEOUT_MS = 120000;
const AI_MAX_TOKENS = 8192;
const MAX_COMPACT_TREE_LINES = 40;
const MAX_COMPACT_PROMPT_CHARS = 9000;

export function loadAiConfig(): AiModelConfig {
  const store = loadAiProfileStore();
  const active = getActiveAiProfile(store);
  if (active) return active.config;

  const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
  if (!raw) return DEFAULT_CONFIG;
  try {
    return normalizeAiConfig(JSON.parse(raw) as Partial<AiModelConfig>);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveAiConfig(config: AiModelConfig): void {
  const normalized = normalizeAiConfig(config);
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(normalized));
  saveAiProfileStore(upsertAiProfile(loadAiProfileStore(), createAiProfile(normalized)));
}

export function clearAiConfig(): void {
  localStorage.removeItem(CONFIG_STORAGE_KEY);
  localStorage.removeItem(PROFILE_STORAGE_KEY);
}

export function loadAiProfileStore(): AiModelProfileStore {
  const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (raw) {
    try {
      return normalizeAiProfileStore(JSON.parse(raw) as Partial<AiModelProfileStore>);
    } catch {
      // Fall through to legacy config migration.
    }
  }

  const legacyRaw = localStorage.getItem(CONFIG_STORAGE_KEY);
  if (!legacyRaw) {
    const profile = createAiProfile(DEFAULT_CONFIG);
    return { activeId: profile.id, profiles: [profile] };
  }

  try {
    const profile = createAiProfile(JSON.parse(legacyRaw) as Partial<AiModelConfig>);
    return { activeId: profile.id, profiles: [profile] };
  } catch {
    const profile = createAiProfile(DEFAULT_CONFIG);
    return { activeId: profile.id, profiles: [profile] };
  }
}

export function saveAiProfileStore(store: AiModelProfileStore): void {
  const normalized = normalizeAiProfileStore(store);
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalized));
  const active = getActiveAiProfile(normalized);
  if (active) {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(active.config));
  }
}

export function createAiProfile(
  config: Partial<AiModelConfig>,
  name?: string,
  id = `ai-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): AiModelProfile {
  const normalized = normalizeAiConfig(config);
  return {
    id,
    name: normalizeAiProfileName(name, normalized),
    config: normalized,
  };
}

export function upsertAiProfile(
  store: AiModelProfileStore,
  profile: AiModelProfile,
): AiModelProfileStore {
  const normalizedProfile = normalizeAiProfile(profile);
  const nextProfiles = store.profiles.some((item) => item.id === normalizedProfile.id)
    ? store.profiles.map((item) =>
        item.id === normalizedProfile.id ? normalizedProfile : item,
      )
    : [...store.profiles, normalizedProfile];

  return normalizeAiProfileStore({
    activeId: normalizedProfile.id,
    profiles: nextProfiles,
  });
}

export function deleteAiProfile(
  store: AiModelProfileStore,
  profileId: string,
): AiModelProfileStore {
  const nextProfiles = store.profiles.filter((item) => item.id !== profileId);
  if (nextProfiles.length === 0) {
    const profile = createAiProfile(DEFAULT_CONFIG);
    return { activeId: profile.id, profiles: [profile] };
  }
  const activeId =
    store.activeId === profileId ? nextProfiles[0]?.id ?? "" : store.activeId;
  return normalizeAiProfileStore({ activeId, profiles: nextProfiles });
}

export function setActiveAiProfile(
  store: AiModelProfileStore,
  profileId: string,
): AiModelProfileStore {
  return normalizeAiProfileStore({
    ...store,
    activeId: profileId,
  });
}

export function getActiveAiProfile(
  store: AiModelProfileStore,
): AiModelProfile | null {
  return (
    store.profiles.find((profile) => profile.id === store.activeId) ??
    store.profiles[0] ??
    null
  );
}

export function normalizeAiConfig(input: Partial<AiModelConfig>): AiModelConfig {
  const baseURL =
    typeof input.baseURL === "string"
      ? input.baseURL.trim().replace(/\/+$/g, "")
      : DEFAULT_CONFIG.baseURL;
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const model =
    typeof input.model === "string" ? input.model.trim() : DEFAULT_CONFIG.model;
  const temperature =
    typeof input.temperature === "number" && Number.isFinite(input.temperature)
      ? Math.min(2, Math.max(0, input.temperature))
      : DEFAULT_CONFIG.temperature;
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? Math.min(300000, Math.max(5000, Math.round(input.timeoutMs)))
      : DEFAULT_CONFIG.timeoutMs;
  const supportsMultimodal = input.supportsMultimodal === true;

  return {
    baseURL,
    apiKey,
    model,
    temperature,
    timeoutMs,
    supportsMultimodal,
  };
}

export function withAiGenerationTimeout(config: AiModelConfig): AiModelConfig {
  const normalized = normalizeAiConfig(config);
  return {
    ...normalized,
    timeoutMs: Math.max(normalized.timeoutMs, MIN_GENERATION_TIMEOUT_MS),
  };
}

export function buildChatCompletionsUrl(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/g, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}

export function maskApiKey(apiKey: string): string {
  const value = apiKey.trim();
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

const CONNECTION_STATUS_KEY = "gkd-rule-studio-ai-connection-status";

export function categorizeAiError(cause: unknown): AiConnectionDiagnosis {
  const message = cause instanceof Error ? cause.message : String(cause);
  const lower = message.toLowerCase();

  // API Key 问题
  if (
    lower.includes("api key") ||
    lower.includes("apikey") ||
    lower.includes("invalid key") ||
    lower.includes("unauthorized") ||
    lower.includes("403") ||
    lower.includes("401")
  ) {
    return { category: "auth", message, hint: "API Key 无效或被拒绝，请检查是否填写正确。某些服务商需要添加 sk- 前缀。" };
  }

  // HTTP 错误（除 auth 外的 4xx/5xx）
  if (
    lower.includes("404") ||
    lower.includes("not found") ||
    lower.includes("500") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("service unavailable")
  ) {
    if (lower.includes("404") || lower.includes("not found")) {
      return { category: "http", message, hint: "接口地址不存在（HTTP 404），检查 Base URL 路径。常见问题：缺少 /v1/ 路径段。" };
    }
    return { category: "server", message, hint: "服务端返回了错误响应，请稍后重试或检查模型是否可用。" };
  }

  // 超时
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("请求超时")
  ) {
    return { category: "network", message, hint: "请求超时，模型响应过慢或网络不稳定。可增大超时时间，或换用响应更快的模型。" };
  }

  // 网络错误
  if (
    lower.includes("network") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("abort") ||
    lower.includes("socket")
  ) {
    return { category: "network", message, hint: "网络连接失败，请检查设备网络和 Base URL 是否正确。若在手机上使用，确认手机能访问该地址。" };
  }

  // 解析错误
  if (
    lower.includes("parse") ||
    lower.includes("json") ||
    lower.includes("json5")
  ) {
    return { category: "parse", message, hint: "AI 返回内容格式异常，不是有效的 JSON5 规则。可在调试日志中查看原始响应，或重试生成。" };
  }

  // 多模态/图片不支持
  if (
    lower.includes("image_url") ||
    lower.includes("multimodal") ||
    lower.includes("vision") ||
    lower.includes("not support") ||
    lower.includes("unsupported")
  ) {
    return { category: "server", message, hint: "当前模型不支持图片识别（多模态），已自动降级为纯文本重试。可换用支持多模态的模型。" };
  }

  return { category: "unknown", message, hint: "未知错误，请查看调试日志获取详细信息。" };
}

export function saveConnectionStatus(status: AiConnectionStatus): void {
  try {
    localStorage.setItem(CONNECTION_STATUS_KEY, JSON.stringify(status));
  } catch {
    // 静默失败
  }
}

export function loadConnectionStatus(): AiConnectionStatus {
  try {
    const raw = localStorage.getItem(CONNECTION_STATUS_KEY);
    if (!raw) return { status: "unknown" };
    return JSON.parse(raw) as AiConnectionStatus;
  } catch {
    return { status: "unknown" };
  }
}

export function buildAiGenerateMessages({
  mode,
  prompt,
  imageUrl,
}: BuildAiGenerateMessagesInput): AiChatMessage[] {
  const compactPrompt = compactPromptForAi(prompt);
  const userText = [
    mode === "flow" ? "请生成多步骤流程规则候选。" : "请生成单步规则候选。",
    "候选必须按诊断矩阵覆盖不同失败原因，不要只改标题或重复同一种 selector。",
    imageUrl
      ? "已附带当前快照截图，请结合截图视觉位置、节点树和候选 selector 判断真实按钮层。"
      : "",
    "下面是工具生成的关键上下文 prompt：",
    compactPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    {
      role: "system",
      content: buildSystemPrompt(mode),
    },
    {
      role: "user",
      content: buildUserContent(userText, imageUrl),
    },
  ];
}

export function buildAiFeedbackMessages({
  mode,
  originalPrompt,
  candidate,
  result,
  note,
  imageUrl,
}: BuildAiFeedbackMessagesInput): AiChatMessage[] {
  const userText = [
    mode === "flow"
      ? "用户测试了一个流程规则候选，请根据反馈修正并重新给出 1-3 个候选。"
      : "用户测试了一个单步规则候选，请根据反馈修正并重新给出 1-3 个候选。",
    imageUrl ? "已附带当前会话截图，请结合截图和测试反馈修正规则。" : "",
    "",
    "原始上下文：",
    compactPromptForAi(originalPrompt),
    "",
    "上次 AI 候选：",
    JSON5.stringify(candidate, null, 2),
    "",
    "测试结果：",
    String(result),
    "",
    "用户补充说明：",
    note.trim() || "-",
    "",
    "重要：修正后的所有候选必须放在同一个 JSON5 代码块中，作为一个 candidates 数组统一输出。格式：{ candidates: [...] }。",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return [
    {
      role: "system",
      content: buildSystemPrompt(mode),
    },
    {
      role: "user",
      content: buildUserContent(userText, imageUrl),
    },
  ];
}

export function buildAiBatchFeedbackMessages({
  mode,
  originalPrompt,
  feedbacks,
  imageUrl,
}: BuildAiBatchFeedbackMessagesInput): AiChatMessage[] {
  const userText = [
    mode === "flow"
      ? "用户批量测试了多个流程规则候选，请根据所有反馈修正并重新给出 1-3 个候选。"
      : "用户批量测试了多个单步规则候选，请根据所有反馈修正并重新给出 1-3 个候选。",
    imageUrl ? "已附带当前会话截图，请结合截图和批量测试反馈修正规则。" : "",
    "",
    "原始上下文：",
    compactPromptForAi(originalPrompt),
    "",
    "重要：修正后的所有候选必须放在同一个 JSON5 代码块中，作为一个 candidates 数组统一输出。格式：{ candidates: [...] }。",
    "",
    "批量测试反馈：",
    JSON5.stringify(
      feedbacks.map((feedback) => ({
        candidateId: feedback.candidate.id,
        title: feedback.candidate.title,
        result: feedback.result,
        note: feedback.note.trim() || "-",
        candidate: feedback.candidate,
      })),
      null,
      2,
    ),
  ]
    .filter((line) => line !== "")
    .join("\n");
  return [
    {
      role: "system",
      content: buildSystemPrompt(mode),
    },
    {
      role: "user",
      content: buildUserContent(userText, imageUrl),
    },
  ];
}

export function compactPromptForAi(prompt: string): string {
  const [beforeTree, treeExcerpt] = splitPromptTreeExcerpt(prompt);
  const compactLines = compactPromptLines(beforeTree);
  if (treeExcerpt.length === 0) return compactLines.join("\n").trim();

  compactLines.push(
    "",
    `节点树摘要（目标相关节选，最多 ${MAX_COMPACT_TREE_LINES} 行，用于判断父子层、遮罩层和真实按钮层）：`,
    ...treeExcerpt.slice(0, MAX_COMPACT_TREE_LINES),
  );
  if (treeExcerpt.length > MAX_COMPACT_TREE_LINES) {
    compactLines.push(
      `... 已省略 ${treeExcerpt.length - MAX_COMPACT_TREE_LINES} 行节点树摘要`,
    );
  }

  return limitCompactPromptChars(compactLines.join("\n").trim());
}

function limitCompactPromptChars(prompt: string): string {
  if (prompt.length <= MAX_COMPACT_PROMPT_CHARS) return prompt;
  return [
    prompt.slice(0, MAX_COMPACT_PROMPT_CHARS - 80).trimEnd(),
    "",
    `... 已按内置 AI 请求限制省略 ${prompt.length - MAX_COMPACT_PROMPT_CHARS + 80} 个字符`,
  ].join("\n");
}

function splitPromptTreeExcerpt(prompt: string): [string, string[]] {
  const parts = prompt.split(/\n节点树摘要：/);
  if (parts.length < 2) return [prompt, []];
  const beforeTree = parts[0] ?? prompt;
  const treeText = parts.slice(1).join("\n节点树摘要：");
  const treeExcerpt = treeText
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return [beforeTree, treeExcerpt];
}

function compactPromptLines(prompt: string): string[] {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const compactLines: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
    if (!line.trim()) {
      blankCount += 1;
      if (blankCount <= 1) compactLines.push("");
      continue;
    }
    blankCount = 0;
    compactLines.push(line);
  }

  while (compactLines.length > 0 && !compactLines[compactLines.length - 1]?.trim()) {
    compactLines.pop();
  }
  return compactLines;
}

export async function requestAiCandidates({
  config,
  messages,
  onDebugLog,
}: RequestAiCandidatesInput): Promise<AiRuleCandidate[]> {
  const normalized = normalizeAiConfig(config);
  if (!normalized.baseURL) {
    throw new Error("请先填写大模型 Base URL");
  }
  if (!normalized.apiKey) {
    throw new Error("请先填写大模型 API Key");
  }
  if (!normalized.model) {
    throw new Error("请先填写模型名称");
  }

  const payload = await buildAiRequestPayload({
    config: normalized,
    messages,
    onDebugLog,
  });
  const response = await postAiJson(payload, onDebugLog);

  const content = extractAiResponseContent(response);
  if (!content) {
    onDebugLog?.(`response:empty ${summarizeAiResponseShape(response)}`);
    throw new Error(
      response.error?.message ||
        `模型返回了空 content：${summarizeAiResponseShape(response)}`,
    );
  }
  try {
    return parseAiCandidates(content);
  } catch (cause) {
    onDebugLog?.(`response:content-parse-error ${summarizeTextForLog(content)}`);
    const detail = cause instanceof Error ? cause.message : "JSON5 解析失败";
    throw new Error(
      `AI 返回规则不是有效 JSON5：${detail}；响应片段：${summarizeTextForLog(content)}`,
    );
  }
}

export function extractAiResponseContent(response: unknown): string {
  if (!isRecord(response)) return "";
  const direct = firstNonEmptyString(response.output_text, response.content);
  if (direct) return direct;

  const choices = Array.isArray(response.choices) ? response.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = isRecord(choice.message) ? choice.message : null;
    const content = message
      ? firstNonEmptyString(message.content, message.reasoning_content)
      : "";
    const fallback = firstNonEmptyString(content, choice.text);
    if (fallback) return fallback;
  }

  return "";
}

export async function buildAiRequestPayload({
  config,
  messages,
  onDebugLog,
}: RequestAiCandidatesInput): Promise<AiRequestPayload> {
  const normalized = normalizeAiConfig(config);
  const requestBody = {
    model: normalized.model,
    temperature: normalized.temperature,
    max_tokens: AI_MAX_TOKENS,
    messages,
  };
  const body = JSON.stringify(requestBody);
  const promptChars = messages.reduce(
    (sum, message) => sum + aiMessageTextContent(message.content).length,
    0,
  );
  const payload: AiRequestPayload = {
    url: buildChatCompletionsUrl(normalized.baseURL),
    body,
    headers: {
      Authorization: `Bearer ${normalized.apiKey}`,
      "Content-Type": "application/json",
    },
    timeoutMs: normalized.timeoutMs,
    promptChars,
    bodyChars: body.length,
  };
  onDebugLog?.(
    [
      "request",
      `url=${payload.url}`,
      `model=${normalized.model}`,
      `timeoutMs=${payload.timeoutMs}`,
      `promptChars=${payload.promptChars}`,
      `bodyChars=${payload.bodyChars}`,
      `multimodal=${messages.some((message) => hasImageContent(message.content))}`,
      `apiKey=${maskApiKey(normalized.apiKey)}`,
    ].join(" "),
  );
  return payload;
}

export async function testAiConnection(
  config: AiModelConfig,
  onDebugLog?: (line: string) => void,
): Promise<string> {
  const candidates = await requestAiCandidates({
    config,
    onDebugLog,
    messages: [
      {
        role: "system",
        content: buildSystemPrompt("single"),
      },
      {
        role: "user",
        content:
          "只返回一个空候选数组用于连接测试：{ candidates: [] }。不要输出其他文字。",
      },
    ],
  });
  return `连接成功，返回 ${candidates.length} 个候选`;
}

export function aiMessageTextContent(content: AiChatMessageContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
}

export function stripAiMessageImages(messages: AiChatMessage[]): AiChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: aiMessageTextContent(message.content),
  }));
}

export function aiMessagesHaveImage(messages: AiChatMessage[]): boolean {
  return messages.some((message) => hasImageContent(message.content));
}

export function shouldRetryTextOnlyAfterMultimodalError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(^|\D)(400|404|415|422)(\D|$)|image_url|image|vision|multimodal|unsupported|not\s+support/i.test(
    message,
  );
}

function buildUserContent(
  text: string,
  imageUrl: string | undefined,
): AiChatMessageContent {
  const trimmedImageUrl = imageUrl?.trim();
  if (!trimmedImageUrl) return text;
  return [
    {
      type: "text",
      text,
    },
    {
      type: "image_url",
      image_url: {
        url: trimmedImageUrl,
      },
    },
  ];
}

function hasImageContent(content: AiChatMessageContent): boolean {
  return (
    Array.isArray(content) &&
    content.some((part) => part.type === "image_url" && Boolean(part.image_url.url))
  );
}

const FEEDBACK_RESULT_LABELS: Record<string, string> = {
  "not-triggered": "未触发（规则没生效）",
  "triggered-no-close": "触发了但广告没关闭",
  mistouch: "误触到广告或其它按钮",
  other: "其他问题",
};

/**
 * 外部 AI 精简反馈文本：粘回同一个对话时用。
 * 不重发原始 prompt、不重发规则 JSON——上文里都有了，只给测试结论。
 */
export function buildExternalFeedbackPrompt(
  feedbacks: AiCandidateFeedback[],
  flowMode: boolean,
): string {
  const lines = feedbacks.map((feedback) => {
    const note = feedback.note.trim();
    if (flowMode || feedback.result === "flow-note") {
      return `- ${feedback.candidate.title}：${note || "（无补充说明）"}`;
    }
    const label = FEEDBACK_RESULT_LABELS[feedback.result] ?? String(feedback.result);
    return note
      ? `- ${feedback.candidate.title}：${label}。补充：${note}`
      : `- ${feedback.candidate.title}：${label}`;
  });
  return [
    flowMode
      ? "以上流程测试版的测试结果如下（每步是否触发、停在哪、是否误触见备注）："
      : "以上各测试版的测试结果如下：",
    ...lines,
    "",
    "请基于本对话上面已经给出的测试版规则修正，只返回修正后的 JSON5 代码块，所有修正版必须放在唯一一个 ```json5 代码块中，作为一个 candidates 数组统一输出。格式：{ candidates: [...] }。不要复述节点树或原始 prompt。",
  ].join("\n");
}

export function parseAiCandidates(source: string): AiRuleCandidate[] {
  const candidates = extractJsonLikeTexts(source).flatMap((text) => {
    try {
      return normalizeAiCandidatePayload(JSON5.parse(text) as unknown);
    } catch {
      return [];
    }
  });

  if (candidates.length === 0) {
    const raw = extractJsonLikeText(source);
    const repaired = tryRepairJson5(raw);
    const parsed = JSON5.parse(repaired) as unknown;
    return normalizeAiCandidatePayload(parsed, true);
  }

  const seenIds = new Set<string>();
  return candidates.map((candidate, index, allCandidates) => {
    const raw = candidate.id?.trim();
    const id = raw && !seenIds.has(raw) ? raw : `ai-${index + 1}`;
    seenIds.add(id);
    return {
      ...candidate,
      id,
      title: shouldReplaceCandidateTitle(candidate.title, allCandidates)
        ? `测试版 ${candidateLabel(index)}`
        : candidate.title,
    };
  });
}

/**
 * 轻量级 JSON5 修复：尝试常见的 AI 输出问题后重新解析。
 * 1. 直接解析
 * 2. 若源是数组但缺少外层 candidates 包裹 → 包成 { candidates: [...] }
 * 3. 若失败则恢复原始内容（让上游抛出更准确的错误）
 */
export function tryRepairJson5(source: string): string {
  // 先试直接解析且结构符合 candidates 格式
  try {
    const parsed = JSON5.parse(source);
    if (
      isRecord(parsed) &&
      (Array.isArray(parsed.candidates) || isAppDraftLike(parsed))
    ) {
      return source;
    }
  } catch {
    // fall through to repair
  }

  const trimmed = source.trim();

  // 首字符是 [ → 可能是裸 candidates 数组，尝试包裹
  if (trimmed.startsWith("[")) {
    const wrapped = `{ candidates: ${trimmed} }`;
    try {
      JSON5.parse(wrapped);
      return wrapped;
    } catch {
      // 包裹失败，继续
    }
  }

  // 原样返回，让 parseAiCandidates 的 fallback 抛出具体错误
  return source;
}

function buildSystemPrompt(mode: AiMode): string {
  return [
    "你是 GKD 规则专家。你必须只返回一个 JSON/JSON5 对象，不要返回 Markdown、解释或节点树复述。",
    "返回格式：{ candidates: [{ id, title, summary, risk, app }] }。",
    "candidates 数量为 2-4 个，反馈修正时数量为 1-3 个。",
    "每个候选的 id 和 title 必须唯一，id 使用 candidate-a/candidate-b 这类稳定短 id。",
    "title 必须使用“测试版 A / 测试版 B / 测试版 C”这种互不重复的短名称；禁止使用“粘贴规则”“规则1”“方案”等泛称。",
    "app 必须是 GKD 应用规则对象：{ id, name, groups }，groups[].rules[].matches 必须是字符串数组。",
    "summary 说明验证思路；risk 说明误触风险。",
    "诊断矩阵：测试版 A 使用本地最高分/最短稳定 selector 的保守方案；测试版 B 验证同框节点、父节点或真实按钮层；测试版 C 优先调整 actionDelay/actionCd/actionMaximum/matchRoot 等执行参数；测试版 D 仅在上下文有 WebView、广告容器、遮罩或热区证据时生成兜底方案。",
    "不同候选必须覆盖不同失败原因，不能只是重复同一个 matches 或只改规则名称。",
    "不要生成下载、安装、打开、浏览、查看详情等正向 CTA 点击规则。",
    mode === "flow"
      ? "当前是流程模式，候选应覆盖完整多步骤规则，必要时使用 preKeys。"
      : "当前是单步模式，候选应覆盖不同 selector/action 策略。",
  ].join("\n");
}

function shouldReplaceCandidateTitle(
  title: string,
  candidates: AiRuleCandidate[],
): boolean {
  const normalized = title.trim();
  if (!normalized) return true;
  if (/^粘贴规则\s*\d*$/u.test(normalized) && candidates.length > 1) return true;
  return candidates.filter((candidate) => candidate.title.trim() === normalized).length > 1;
}

function candidateLabel(index: number): string {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

function extractJsonLikeText(source: string): string {
  const fenced = /```(?:json5?|javascript|js)?\s*([\s\S]*?)```/i.exec(source);
  if (fenced?.[1]) return fenced[1].trim();

  const firstObject = source.indexOf("{");
  const lastObject = source.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    return source.slice(firstObject, lastObject + 1).trim();
  }
  return source.trim();
}

function extractJsonLikeTexts(source: string): string[] {
  const snippets: string[] = [];
  const fencePattern = /```(?:json5?|javascript|js)?\s*([\s\S]*?)```/gi;
  for (const match of source.matchAll(fencePattern)) {
    if (match[1]?.trim()) snippets.push(match[1].trim());
  }

  const objectSnippets = extractBalancedObjects(source);
  snippets.push(...objectSnippets);

  return uniqueStrings(snippets);
}

function extractBalancedObjects(source: string): string[] {
  const snippets: string[] = [];
  let start = -1;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
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

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}") continue;

    depth -= 1;
    if (depth === 0 && start >= 0) {
      snippets.push(source.slice(start, index + 1).trim());
      start = -1;
    }
  }

  return snippets;
}

function normalizeAiCandidatePayload(
  parsed: unknown,
  throwOnInvalid = false,
): AiRuleCandidate[] {
  if (isRecord(parsed) && Array.isArray(parsed.candidates)) {
    return parsed.candidates.map((candidate, index) => normalizeCandidate(candidate, index));
  }

  if (isAppDraftLike(parsed)) {
    return [
      {
        id: "pasted-rule-1",
        title: "粘贴规则 1",
        summary: "从 AI 粘贴内容提取",
        risk: "请先加入测试区验证",
        app: normalizeAppDraft(parsed),
      },
    ];
  }

  if (throwOnInvalid) {
    throw new Error("AI 返回内容必须包含 candidates 数组或 GKD app 规则对象");
  }
  return [];
}

function isAppDraftLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.groups) &&
    value.groups.some(
      (group) =>
        isRecord(group) &&
        Array.isArray(group.rules) &&
        group.rules.some(
          (rule) =>
            isRecord(rule) &&
            (typeof rule.matches === "string" || Array.isArray(rule.matches)),
        ),
    )
  );
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)];
}

function normalizeCandidate(value: unknown, index: number): AiRuleCandidate {
  if (!isRecord(value)) {
    throw new Error(`AI 返回候选 ${index + 1} 必须是对象`);
  }
  if (!value.app) {
    throw new Error("AI 返回候选缺少 app");
  }

  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : `ai-${index + 1}`,
    title:
      typeof value.title === "string" && value.title.trim()
        ? value.title.trim()
        : `测试版 ${index + 1}`,
    summary: typeof value.summary === "string" ? value.summary : "",
    risk: typeof value.risk === "string" ? value.risk : "",
    app: normalizeAppDraft(value.app),
  };
}

function normalizeAiProfileStore(
  store: Partial<AiModelProfileStore>,
): AiModelProfileStore {
  const profiles = Array.isArray(store.profiles)
    ? store.profiles.map(normalizeAiProfile)
    : [];
  const fallback = profiles[0] ?? createAiProfile(DEFAULT_CONFIG);
  const activeId =
    typeof store.activeId === "string" &&
    profiles.some((profile) => profile.id === store.activeId)
      ? store.activeId
      : fallback.id;

  return {
    activeId,
    profiles: profiles.length > 0 ? profiles : [fallback],
  };
}

function normalizeAiProfile(value: unknown): AiModelProfile {
  if (!isRecord(value)) {
    return createAiProfile(DEFAULT_CONFIG);
  }
  const config = normalizeAiConfig(
    isRecord(value.config) ? (value.config as Partial<AiModelConfig>) : {},
  );
  const id =
    typeof value.id === "string" && value.id.trim()
      ? value.id.trim()
      : `ai-profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = typeof value.name === "string" ? value.name : "";
  return {
    id,
    name: normalizeAiProfileName(name, config),
    config,
  };
}

function normalizeAiProfileName(name: string | undefined, config: AiModelConfig): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  try {
    const host = new URL(config.baseURL).host || config.baseURL;
    return `${config.model} / ${host}`;
  } catch {
    return `${config.model} / ${config.baseURL}`;
  }
}

function normalizeAppDraft(value: unknown): AppRuleDraft {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error("AI 返回 app 缺少 id");
  }
  if (!Array.isArray(value.groups)) {
    throw new Error("AI 返回 app 缺少 groups");
  }

  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
    groups: value.groups.map(normalizeGroupDraft),
  };
}

function normalizeGroupDraft(value: unknown): AppRuleDraft["groups"][number] {
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    throw new Error("AI 返回 group 缺少 rules");
  }

  const group = {
    ...value,
    key: typeof value.key === "number" ? value.key : 0,
    name: typeof value.name === "string" ? value.name : "AI 规则候选",
    rules: value.rules.map(normalizeRuleDraft),
  } as AppRuleDraft["groups"][number];
  return group;
}

function normalizeRuleDraft(value: unknown): RuleDraft {
  if (!isRecord(value)) {
    throw new Error("AI 返回 rule 必须是对象");
  }
  const matches = normalizeMatches(value.matches);
  if (matches.length === 0) {
    throw new Error("AI 返回 rule 缺少 matches");
  }

  return {
    ...value,
    key: typeof value.key === "number" ? value.key : 0,
    matches,
  } as RuleDraft;
}

function normalizeMatches(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

const AI_MAX_RETRIES = 2;
const AI_RETRY_BASE_DELAY_MS = 1500;

function isTransientNetworkError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  const lower = message.toLowerCase();
  // 网络层临时错误
  if (
    lower.includes("software caused connection abort") ||
    lower.includes("connection reset") ||
    lower.includes("broken pipe") ||
    lower.includes("network request failed") ||
    lower.includes("请求超时") ||
    lower.includes("timeout") ||
    lower.includes("abort") ||
    lower.includes("econnreset") ||
    lower.includes("econnaborted") ||
    lower.includes("etimedout") ||
    lower.includes("network io error") ||
    lower.includes("socket closed")
  ) {
    return true;
  }
  // HTTP 5xx 服务器临时错误也重试
  return /^HTTP\s+5\d\d/.test(message) || /(^|\D)(500|502|503|504)(\D|$)/.test(lower);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function postAiJson(
  payload: AiRequestPayload,
  onDebugLog?: (line: string) => void,
): Promise<ChatCompletionResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
    try {
      return await attemptPostAiJson(payload, onDebugLog);
    } catch (cause) {
      lastError = cause;
      if (attempt < AI_MAX_RETRIES && isTransientNetworkError(cause)) {
        const delay = Math.min(
          AI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
          12000,
        );
        onDebugLog?.(
          `retry:attempt=${attempt + 1}/${AI_MAX_RETRIES + 1} delay=${delay}ms reason=${formatTransientError(cause)}`,
        );
        await sleep(delay);
        continue;
      }
      throw cause;
    }
  }
  throw lastError;
}

async function attemptPostAiJson(
  payload: AiRequestPayload,
  onDebugLog?: (line: string) => void,
): Promise<ChatCompletionResponse> {
  if (hasAndroidBridge()) {
    return postJsonWithAndroidBridge(payload, onDebugLog);
  }

  const startedAt = Date.now();
  onDebugLog?.("fetch:start");
  const response = await enhancedFetch(
    payload.url,
    {
      method: "POST",
      headers: payload.headers,
      body: payload.body,
    },
    {
      timeout: payload.timeoutMs,
    },
  );
  const text = await response.text();
  onDebugLog?.(
    `fetch:result status=${response.status} ms=${Date.now() - startedAt} responseChars=${text.length}`,
  );
  if (!response.ok) {
    throw new Error(formatHttpError(response.status, text));
  }
  return parseAiResponseBody(text, onDebugLog);
}

function formatTransientError(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message.length > 100
      ? cause.message.slice(0, 100) + "..."
      : cause.message;
  }
  return String(cause).slice(0, 100);
}

function hasAndroidBridge(): boolean {
  return typeof window !== "undefined" && typeof window.GkdAndroidBridge?.postJson === "function";
}

function postJsonWithAndroidBridge(
  payload: AiRequestPayload,
  onDebugLog?: (line: string) => void,
): Promise<ChatCompletionResponse> {
  const bridge = window.GkdAndroidBridge;
  if (!bridge || typeof bridge.postJson !== "function") {
    throw new Error("Android 网络桥不可用");
  }

  return new Promise((resolve, reject) => {
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const startedAt = Date.now();
    onDebugLog?.(`bridge:start requestId=${requestId}`);

    const previous = window.__GkdAndroidBridgeResult;
    let settled = false;

    const handler = (id: string, result: { ok: boolean; status?: number; body: string; error?: string }) => {
      if (id !== requestId) {
        previous?.(id, result);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      onDebugLog?.(
        `bridge:result requestId=${requestId} ok=${result.ok} status=${result.status ?? "-"} ms=${Date.now() - startedAt} responseChars=${result.body.length} error=${result.error ?? "-"}`,
      );
      if (!result.ok) {
        const errorMsg = result.error || "Android 网络请求失败";
        // HTTP 5xx 时带上响应体内容（服务器可能返回了具体错误信息）
        if (result.status && result.status >= 500 && result.status < 600 && result.body?.trim()) {
          reject(new Error(formatHttpError(result.status, result.body)));
        } else {
          reject(new Error(errorMsg));
        }
        return;
      }
      try {
        resolve(parseAiResponseBody(result.body, onDebugLog));
      } catch (cause) {
        reject(cause);
      }
    };

    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const message = `模型请求超时：已等待 ${Math.round(payload.timeoutMs / 1000)} 秒`;
      onDebugLog?.(`bridge:timeout requestId=${requestId} ms=${Date.now() - startedAt}`);
      reject(new Error(message));
    }, payload.timeoutMs + 1500);

    window.__GkdAndroidBridgeResult = handler;

    function cleanup(): void {
      window.clearTimeout(timeout);
      if (window.__GkdAndroidBridgeResult === handler) {
        window.__GkdAndroidBridgeResult = previous;
      }
    }

    bridge.postJson!(
      requestId,
      payload.url,
      JSON.stringify(payload.headers),
      payload.body,
      payload.timeoutMs,
    );
  });
}

function formatHttpError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as ChatCompletionResponse;
    return `模型请求失败 ${status}: ${parsed.error?.message || "未知错误"}`;
  } catch {
    return `模型请求失败 ${status}: ${body.slice(0, 120)}`;
  }
}

function parseAiResponseBody(
  text: string,
  onDebugLog?: (line: string) => void,
): ChatCompletionResponse {
  try {
    return JSON.parse(text) as ChatCompletionResponse;
  } catch {
    const sse = parseSseResponseBody(text);
    if (sse) return sse;
    const summary = summarizeTextForLog(text);
    onDebugLog?.(`response:non-json ${summary}`);
    throw new Error(`模型响应不是有效 JSON：${summary}`);
  }
}

function parseSseResponseBody(text: string): ChatCompletionResponse | null {
  const dataLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  if (dataLines.length === 0) return null;

  const chunks: string[] = [];
  for (const line of dataLines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const piece = extractAiResponseContent(parsed);
      if (piece) chunks.push(piece);
    } catch {
      return null;
    }
  }

  return { choices: [{ message: { content: chunks.join("") } }] };
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function summarizeTextForLog(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 420) return compact || "<empty>";
  return `${compact.slice(0, 240)} ... ${compact.slice(-160)}`;
}

function summarizeAiResponseShape(response: unknown): string {
  if (!isRecord(response)) return "shape=non-object";
  const keys = Object.keys(response).slice(0, 12).join(",");
  const choice = Array.isArray(response.choices) ? response.choices[0] : null;
  const choiceKeys = isRecord(choice) ? Object.keys(choice).slice(0, 12).join(",") : "-";
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
  const messageKeys = message ? Object.keys(message).slice(0, 12).join(",") : "-";
  const finishReason = isRecord(choice) ? firstNonEmptyString(choice.finish_reason) || "-" : "-";
  const contentValue = message ? message.content : undefined;
  const reasoningValue = message ? message.reasoning_content : undefined;
  const contentLength = typeof contentValue === "string" ? contentValue.length : "-";
  const reasoningLength =
    typeof reasoningValue === "string" ? reasoningValue.length : "-";
  const messagePreview =
    typeof contentValue === "string" && contentValue.trim()
      ? ` content=${summarizeTextForLog(contentValue)}`
      : "";
  return `keys=${keys || "-"} choiceKeys=${choiceKeys} messageKeys=${messageKeys} finish=${finishReason} contentLen=${contentLength} reasoningLen=${reasoningLength}${messagePreview}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
