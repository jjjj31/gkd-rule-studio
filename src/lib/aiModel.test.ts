import { describe, expect, it } from "vitest";
import {
  buildAiFeedbackMessages,
  buildAiBatchFeedbackMessages,
  buildExternalFeedbackPrompt,
  buildAiGenerateMessages,
  buildAiRequestPayload,
  buildChatCompletionsUrl,
  createAiProfile,
  compactPromptForAi,
  deleteAiProfile,
  getActiveAiProfile,
  setActiveAiProfile,
  withAiGenerationTimeout,
  maskApiKey,
  normalizeAiConfig,
  parseAiCandidates,
  tryRepairJson5,
  shouldRetryTextOnlyAfterMultimodalError,
  stripAiMessageImages,
  extractAiResponseContent,
  categorizeAiError,
  upsertAiProfile,
} from "./aiModel";
import type { AppRuleDraft } from "../types/ruleDraft";

describe("ai model helpers", () => {
  it("stores multiple AI model profiles and switches the active profile", () => {
    const first = createAiProfile(
      {
        baseURL: "https://api.one.example/v1",
        apiKey: "sk-one-secret",
        model: "model-one",
      },
      "主模型",
      "one",
    );
    const second = createAiProfile(
      {
        baseURL: "https://api.two.example/v1",
        apiKey: "sk-two-secret",
        model: "model-two",
      },
      "备用模型",
      "two",
    );

    const store = setActiveAiProfile(
      upsertAiProfile(upsertAiProfile({ activeId: "", profiles: [] }, first), second),
      "one",
    );

    expect(getActiveAiProfile(store)?.id).toBe("one");
    expect(getActiveAiProfile(deleteAiProfile(store, "one"))?.id).toBe("two");
  });

  it("normalizes local config and builds an OpenAI-compatible chat URL", () => {
    const config = normalizeAiConfig({
      baseURL: " https://api.example.com/v1/ ",
      apiKey: " sk-demo-secret ",
      model: " deepseek-chat ",
      temperature: 0.4,
      timeoutMs: 12000,
      supportsMultimodal: true,
    });

    expect(config).toEqual({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-demo-secret",
      model: "deepseek-chat",
      temperature: 0.4,
      timeoutMs: 12000,
      supportsMultimodal: true,
    });
    expect(buildChatCompletionsUrl(config.baseURL)).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(maskApiKey(config.apiKey)).toBe("sk-d...cret");
  });

  it("keeps explicitly cleared API config fields empty", () => {
    expect(
      normalizeAiConfig({
        baseURL: "",
        apiKey: "",
        model: "",
      }),
    ).toMatchObject({
      baseURL: "",
      apiKey: "",
      model: "",
    });
  });

  it("normalizes duplicate pasted candidate titles to distinct test labels", () => {
    const parsed = parseAiCandidates(`{
      candidates: [
        {
          id: 'a',
          title: '粘贴规则 1',
          summary: 'a',
          risk: 'low',
          app: { id: 'demo.app', name: 'Demo', groups: [{ key: 0, name: 'g', rules: [{ key: 0, matches: ['@TextView[text="A"]'] }] }] },
        },
        {
          id: 'b',
          title: '粘贴规则 1',
          summary: 'b',
          risk: 'low',
          app: { id: 'demo.app', name: 'Demo', groups: [{ key: 0, name: 'g', rules: [{ key: 0, matches: ['@TextView[text="B"]'] }] }] },
        },
      ],
    }`);

    expect(parsed.map((candidate) => candidate.title)).toEqual([
      "测试版 A",
      "测试版 B",
    ]);
  });

  it("parses JSON5 candidates from a markdown code block", () => {
    const parsed = parseAiCandidates(`
      下面是结果：
      \`\`\`json5
      {
        candidates: [
          {
            id: 'a',
            title: '测试版 A',
            summary: '验证稳定资源 id',
            risk: '低误触',
            app: {
              id: 'com.demo',
              name: 'Demo',
              groups: [{
                key: 0,
                name: '开屏广告',
                rules: [{ key: 0, name: '点击跳过', matches: ['[vid="skip"]'] }],
              }],
            },
          },
        ],
      }
      \`\`\`
    `);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "a",
      title: "测试版 A",
      summary: "验证稳定资源 id",
      risk: "低误触",
    });
    expect(parsed[0].app.groups[0].rules[0].matches).toEqual(['[vid="skip"]']);
  });

  it("extracts real rule candidates from pasted AI text with multiple code blocks", () => {
    const parsed = parseAiCandidates(`
      说明：第一个只是思路，不要导入。
      \`\`\`json5
      { note: 'not a rule', matches: [] }
      \`\`\`

      真正规则如下：
      \`\`\`json5
      {
        id: 'com.demo',
        name: 'Demo',
        groups: [{
          key: 0,
          name: '开屏广告',
          rules: [{ key: 0, name: '点击跳过', matches: ['[vid="skip_real"]'] }],
        }],
      }
      \`\`\`
    `);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      title: "粘贴规则 1",
      summary: "从 AI 粘贴内容提取",
      risk: "请先加入测试区验证",
    });
    expect(parsed[0].app.groups[0].rules[0].matches).toEqual(['[vid="skip_real"]']);
  });

  it("assigns unique ids when multiple bare rule blocks are pasted separately", () => {
    const parsed = parseAiCandidates(`
      测试版 A：
      \`\`\`json5
      { id: 'com.demo', name: 'Demo', groups: [{ key: 0, name: '开屏', rules: [{ key: 0, matches: ['[vid="a"]'] }] }] }
      \`\`\`
      测试版 B：
      \`\`\`json5
      { id: 'com.demo', name: 'Demo', groups: [{ key: 0, name: '开屏', rules: [{ key: 0, matches: ['[vid="b"]'] }] }] }
      \`\`\`
    `);

    expect(parsed).toHaveLength(2);
    const ids = parsed.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects model responses that do not contain candidate apps", () => {
    expect(() => parseAiCandidates("{ candidates: [{ title: '坏结果' }] }")).toThrow(
      "AI 返回候选缺少 app",
    );
  });

  it("extracts content from OpenAI-compatible fallback response shapes", () => {
    expect(
      extractAiResponseContent({
        choices: [{ message: { reasoning_content: "思考", content: "" } }],
        output_text: "{ candidates: [] }",
      }),
    ).toBe("{ candidates: [] }");

    expect(
      extractAiResponseContent({
        choices: [{ text: "{ candidates: [] }" }],
      }),
    ).toBe("{ candidates: [] }");
  });

  it("builds generate and feedback chat messages with the strict JSON contract", () => {
    const app = appDraft();
    const generateMessages = buildAiGenerateMessages({
      mode: "single",
      prompt: "原始单步 prompt",
    });

    expect(generateMessages[0].role).toBe("system");
    expect(generateMessages.map((message) => message.content).join("\n")).toContain(
      "candidates",
    );
    expect(generateMessages.map((message) => message.content).join("\n")).toContain(
      "原始单步 prompt",
    );
    expect(generateMessages.map((message) => message.content).join("\n")).toContain(
      "诊断矩阵",
    );

    const feedbackMessages = buildAiFeedbackMessages({
      mode: "single",
      originalPrompt: "原始单步 prompt",
      candidate: {
        id: "a",
        title: "测试版 A",
        summary: "验证稳定资源 id",
        risk: "低误触",
        app,
      },
      result: "triggered-no-close",
      note: "有触发记录，但广告没有关闭",
    });

    const feedbackText = feedbackMessages.map((message) => message.content).join("\n");
    expect(feedbackText).toContain("triggered-no-close");
    expect(feedbackText).toContain("有触发记录，但广告没有关闭");
    expect(feedbackText).toContain("[vid=\"skip\"]");
  });

  it("can attach a screenshot to generate messages for multimodal models", () => {
    const messages = buildAiGenerateMessages({
      mode: "single",
      prompt: "原始单步 prompt",
      imageUrl: "data:image/jpeg;base64,abc",
    });

    const userContent = messages[1].content;

    expect(Array.isArray(userContent)).toBe(true);
    expect(JSON.stringify(userContent)).toContain("image_url");
    expect(JSON.stringify(userContent)).toContain("data:image/jpeg;base64,abc");
  });

  it("can strip multimodal image parts and identify vision fallback errors", () => {
    const messages = buildAiGenerateMessages({
      mode: "single",
      prompt: "原始单步 prompt",
      imageUrl: "data:image/jpeg;base64,abc",
    });
    const stripped = stripAiMessageImages(messages);

    expect(JSON.stringify(stripped)).not.toContain("image_url");
    expect(stripped[1].content).toContain("原始单步 prompt");
    expect(shouldRetryTextOnlyAfterMultimodalError(new Error("HTTP 404"))).toBe(true);
    expect(shouldRetryTextOnlyAfterMultimodalError(new Error("unsupported image_url"))).toBe(true);
    expect(shouldRetryTextOnlyAfterMultimodalError(new Error("timeout"))).toBe(false);
  });

  it("builds one batch feedback prompt for multiple tested AI candidates", () => {
    const app = appDraft();
    const messages = buildAiBatchFeedbackMessages({
      mode: "single",
      originalPrompt: "原始单步 prompt",
      feedbacks: [
        {
          candidate: {
            id: "a",
            title: "测试版 A",
            summary: "资源 id",
            risk: "低",
            app,
          },
          result: "not-triggered",
          note: "没有触发",
        },
        {
          candidate: {
            id: "b",
            title: "测试版 B",
            summary: "父节点",
            risk: "中",
            app,
          },
          result: "triggered-no-close",
          note: "有触发但没关",
        },
      ],
    });

    const text = messages.map((message) => message.content).join("\n");
    expect(text).toContain("批量测试反馈");
    expect(text).toContain("not-triggered");
    expect(text).toContain("triggered-no-close");
    expect(text).toContain("测试版 A");
    expect(text).toContain("测试版 B");
  });

  it("builds a lean external feedback prompt without resending context or rule json", () => {
    const app = appDraft();
    const prompt = buildExternalFeedbackPrompt(
      [
        {
          candidate: { id: "a", title: "测试版 A", summary: "s", risk: "r", app },
          result: "not-triggered",
          note: "点了没反应",
        },
        {
          candidate: { id: "b", title: "测试版 B", summary: "s", risk: "r", app },
          result: "mistouch",
          note: "",
        },
      ],
      false,
    );

    expect(prompt).toContain("测试版 A");
    expect(prompt).toContain("未触发");
    expect(prompt).toContain("点了没反应");
    expect(prompt).toContain("测试版 B");
    expect(prompt).toContain("误触");
    // 精简版不重发原始规则 JSON / 节点树，避免同会话冗余
    expect(prompt).not.toContain(app.groups[0].rules[0].matches[0] as string);
    expect(prompt).not.toContain("groups");
  });

  it("compacts direct AI prompts while preserving a bounded target node tree excerpt", () => {
    const prompt = [
      "应用信息：",
      "- appId: com.demo",
      "用户点击的目标节点：",
      "{ id: 1, vid: 'skip' }",
      "候选 selector 列表：",
      "- exactVid: [vid=\"skip\"]",
      "当前 JSON5 草稿（优先在此基础上修正，不要从零重写）：",
      "{ id: 'com.demo', groups: [] }",
      "节点树摘要：",
      "#0 FrameLayout bounds=0,0,100,100",
      "#1 View bounds=0,0,100,100",
      ...Array.from({ length: 140 }, (_, index) => `#${index + 2} View bounds=0,0,10,10`),
    ].join("\n");

    const compact = compactPromptForAi(prompt);

    expect(compact).toContain("用户点击的目标节点");
    expect(compact).toContain("[vid=\"skip\"]");
    expect(compact).toContain("当前 JSON5 草稿");
    expect(compact).toContain("节点树摘要");
    expect(compact).toContain("#0 FrameLayout");
    expect(compact).toContain("#39 View");
    expect(compact).toContain("已省略");
    expect(compact).not.toContain("#41 View");
    expect(compact.length).toBeLessThanOrEqual(9000);
  });

  it("emits developer diagnostics for AI request sizing", async () => {
    const logs: string[] = [];
    const payload = await buildAiRequestPayload({
        config: normalizeAiConfig({
          baseURL: "https://api.example.com/v1",
          apiKey: "sk-secret-value",
          model: "demo-model",
        }),
        messages: buildAiGenerateMessages({
          mode: "single",
          prompt: "用户点击的目标节点：\n{ id: 1 }",
          imageUrl: "data:image/jpeg;base64,abc",
        }),
        onDebugLog: (line) => logs.push(line),
      });

    expect(payload).toMatchObject({
      url: "https://api.example.com/v1/chat/completions",
    });
    expect(JSON.parse(payload.body)).toMatchObject({
      max_tokens: 8192,
    });
    expect(JSON.stringify(JSON.parse(payload.body).messages)).toContain("image_url");

    expect(logs.join("\n")).toContain("request");
    expect(logs.join("\n")).toContain("bodyChars=");
    expect(logs.join("\n")).toContain("promptChars=");
    expect(logs.join("\n")).toContain("sk-s...alue");
    expect(logs.join("\n")).not.toContain("sk-secret-value");
  });

  it("raises generation timeout above a saved short connection-test timeout", () => {
    const config = normalizeAiConfig({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-secret-value",
      model: "demo-model",
      timeoutMs: 30000,
    });

    expect(withAiGenerationTimeout(config).timeoutMs).toBe(120000);
  });
});

describe("feedback prompt format consistency", () => {
  it("builds external feedback prompt without multi-block instruction", () => {
    const result = buildExternalFeedbackPrompt(
      [
        {
          candidate: { id: "a", title: "测试版 A", summary: "", risk: "", app: appDraft() },
          result: "not-triggered",
          note: "没触发",
        },
      ],
      false,
    );
    expect(result).not.toContain("每个测试版单独一个块");
    expect(result).toContain("唯一一个");
    expect(result).toContain("candidates 数组");
  });

  it("buildAiFeedbackMessages user text includes format emphasis", () => {
    const messages = buildAiFeedbackMessages({
      mode: "single",
      originalPrompt: "test prompt",
      candidate: { id: "c1", title: "测试版 A", summary: "", risk: "", app: appDraft() },
      result: "not-triggered",
      note: "没触发",
    });
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    if (userMsg && typeof userMsg.content === "string") {
      expect(userMsg.content).toContain("candidates 数组");
    }
  });

  it("buildAiBatchFeedbackMessages user text includes format emphasis", () => {
    const messages = buildAiBatchFeedbackMessages({
      mode: "single",
      originalPrompt: "test prompt",
      feedbacks: [
        {
          candidate: { id: "c1", title: "测试版 A", summary: "", risk: "", app: appDraft() },
          result: "not-triggered",
          note: "没触发",
        },
      ],
    });
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    if (userMsg && typeof userMsg.content === "string") {
      expect(userMsg.content).toContain("candidates 数组");
    }
  });
});

describe("tryRepairJson5", () => {
  it("passes valid JSON through unchanged", () => {
    const input = '{ "candidates": [{ "id": "a", "title": "测试版 A" }] }';
    expect(tryRepairJson5(input)).toBe(input);
  });

  it("wraps bare array in candidates object", () => {
    const input = '[{ "id": "a", "title": "测试版 A" }]';
    const repaired = tryRepairJson5(input);
    expect(repaired).toBe('{ candidates: [{ "id": "a", "title": "测试版 A" }] }');
  });

  it("returns original string when repair fails", () => {
    const input = "not even close to json";
    expect(tryRepairJson5(input)).toBe(input);
  });

  it("parseAiCandidates can handle bare array with repair", () => {
    const input = "```json5\n[{ id: \"a\", title: \"测试版 A\", summary: \"test\", risk: \"low\", app: { id: \"com.app\", name: \"App\", groups: [{ key: 0, name: \"g\", rules: [{ matches: [\"@View\"] }] }] } }]```";
    const candidates = parseAiCandidates(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("a");
    expect(candidates[0].app.id).toBe("com.app");
  });
});

describe("categorizeAiError", () => {
  it("categorizes API key errors", () => {
    const result = categorizeAiError(new Error("API key is invalid: 401"));
    expect(result.category).toBe("auth");
    expect(result.hint).toContain("API Key");
  });

  it("categorizes 404 errors", () => {
    const result = categorizeAiError(new Error("HTTP 404 Not Found"));
    expect(result.category).toBe("http");
    expect(result.hint).toContain("404");
  });

  it("categorizes timeout errors", () => {
    const result = categorizeAiError(new Error("请求超时：已等待 120 秒"));
    expect(result.category).toBe("network");
    expect(result.hint).toContain("超时");
  });

  it("categorizes network errors", () => {
    const result = categorizeAiError(new TypeError("fetch failed"));
    expect(result.category).toBe("network");
    expect(result.hint).toContain("网络");
  });

  it("categorizes parse errors", () => {
    const result = categorizeAiError(new SyntaxError("JSON5 parse error"));
    expect(result.category).toBe("parse");
    expect(result.hint).toContain("JSON5");
  });

  it("returns unknown for unrecognized errors", () => {
    const result = categorizeAiError(new Error("something weird happened"));
    expect(result.category).toBe("unknown");
    expect(result.hint).toContain("未知错误");
  });

  it("handles non-Error input", () => {
    const result = categorizeAiError("some random string");
    expect(result.category).toBe("unknown");
  });
});

function appDraft(): AppRuleDraft {
  return {
    id: "com.demo",
    name: "Demo",
    groups: [
      {
        key: 0,
        name: "开屏广告",
        rules: [
          {
            key: 0,
            name: "点击跳过",
            matches: ['[vid="skip"]'],
            fastQuery: true,
          },
        ],
      },
    ],
  };
}
