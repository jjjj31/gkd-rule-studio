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
  extractAiTokenUsage,
  AiCandidateParseError,
  categorizeAiError,
  upsertAiProfile,
} from "./aiModel";
import type { AppRuleDraft } from "../types/ruleDraft";
import type { RawGkdSnapshot, SnapshotNode, SnapshotNodeAttr } from "../types/gkdSnapshot";
import { DEFAULT_RULE_SETTINGS } from "../data/ruleSettings";
import { buildFlowHelpPrompt } from "./flowDraft";
import type { FlowRuleStep } from "../types/flowDraft";
import { normalizeSnapshot } from "./snapshotNormalize";
import { pickNodeAtPoint } from "./nodePicker";
import { toCandidateFeedback, type FailureFeedbackDraft } from "../components/FailureFeedbackPanel";
import {
  classifyAuthoringFeedback,
  formatAuthoringFeedbackPrompt,
} from "./authoringFeedback";

describe("ai model helpers", () => {
  it("extracts token usage from chat completions and responses payloads", () => {
    expect(
      extractAiTokenUsage({
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    ).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
    expect(
      extractAiTokenUsage({
        usage: { input_tokens: 5, output_tokens: 7 },
      }),
    ).toEqual({ promptTokens: 5, completionTokens: 7 });
    expect(extractAiTokenUsage({ usage: {} })).toBeNull();
    expect(extractAiTokenUsage({})).toBeNull();
  });

  it("keeps usage and content on AI parse errors for cost accounting", () => {
    const error = new AiCandidateParseError("bad json", {
      content: "{ candidates: [",
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      elapsedMs: 42,
      promptChars: 100,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AiCandidateParseError");
    expect(error).toMatchObject({
      content: "{ candidates: [",
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      elapsedMs: 42,
      promptChars: 100,
    });
  });

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

  it("keeps official anyMatches rules without injecting empty matches array", () => {
    const parsed = parseAiCandidates(JSON.stringify({
      candidates: [{
        id: "a",
        title: "A",
        summary: "test",
        risk: "low",
        app: {
          id: "com.demo",
          name: "Demo",
          groups: [{
            key: 0,
            name: "g",
            rules: [{ key: 0, anyMatches: ['[text="A"]'] }],
          }],
        },
      }],
    }));

    expect(parsed[0].app.groups[0].rules[0].matches).toBeUndefined();
    expect(parsed[0].app.groups[0].rules[0].anyMatches).toEqual(['[text="A"]']);

    // Bare anyMatches-only app draft without outer candidates wrapper
    const bareParsed = parseAiCandidates(`\`\`\`json5
      {
        id: 'com.demo',
        name: 'Demo',
        groups: [{
          key: 0,
          name: '弹窗',
          rules: [{ key: 0, anyMatches: ['[text="关闭"]', '[desc="关闭"]'] }],
        }],
      }
    \`\`\``);
    expect(bareParsed).toHaveLength(1);
    expect(bareParsed[0].app.groups[0].rules[0].matches).toBeUndefined();
    expect(bareParsed[0].app.groups[0].rules[0].anyMatches).toEqual([
      '[text="关闭"]',
      '[desc="关闭"]',
    ]);
  });

  it("does not duplicate candidates when fenced json5 contains comments or trailing semicolon", () => {
    const parsed = parseAiCandidates(`
      \`\`\`json5
      // 下面是生成的 3 个候选（don't duplicate!）
      {
        candidates: [
          {
            id: 'candidate-a',
            title: '测试版 A',
            summary: '保守',
            risk: '低',
            app: { id: 'com.demo', name: 'Demo', groups: [{ key: 0, name: 'g', rules: [{ key: 0, matches: ['[vid="a"]'] }] }] },
          },
          /* 块注释里带花括号 { 和撇号 ' 不应打断提取 */
          {
            id: 'candidate-b',
            title: '测试版 B',
            summary: '同框',
            risk: '低',
            app: { id: 'com.demo', name: 'Demo', groups: [{ key: 0, name: 'g', rules: [{ key: 0, matches: ['[vid="b"]'] }] }] },
          },
          {
            id: 'candidate-c',
            title: '测试版 C',
            summary: '兜底',
            risk: '中',
            app: { id: 'com.demo', name: 'Demo', groups: [{ key: 0, name: 'g', rules: [{ key: 0, matches: ['[vid="c"]'] }] }] },
          },
        ],
      };
      \`\`\`
    `);

    expect(parsed).toHaveLength(3);
    expect(parsed.map((c) => c.id)).toEqual([
      "candidate-a",
      "candidate-b",
      "candidate-c",
    ]);
  });

  it("skips JSON5 line/block comments and prose apostrophes when extracting unfenced objects", () => {
    const parsed = parseAiCandidates(`
      Here's the rule you'll want:
      {
        // don't break on apostrophe or { in single-line comment
        /* block comment with } and ' shouldn't break either */
        id: 'com.demo',
        name: 'Demo',
        groups: [{
          key: 0,
          name: 'g',
          rules: [{ key: 0, matches: ['[text="跳过"]'] }],
        }],
      }
    `);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].app.groups[0].rules[0].matches).toEqual(['[text="跳过"]']);
  });

  it("rejects malformed exclusion fields instead of silently weakening the rule", () => {
    const candidate = {
      id: "a",
      title: "A",
      summary: "test",
      risk: "low",
      app: {
        id: "com.demo",
        name: "Demo",
        groups: [{
          key: 0,
          name: "g",
          rules: [{
            key: 0,
            matches: ['[text="A"]'],
            excludeMatches: { text: "B" },
          }],
        }],
      },
    };

    expect(() => parseAiCandidates(JSON.stringify({ candidates: [candidate] }))).toThrow(
      "excludeMatches",
    );
  });

  it("rejects matchRoot selector strings with the exact field path", () => {
    expect(() => parseAiCandidates(JSON.stringify({
      candidates: [{
        id: "a",
        title: "A",
        summary: "test",
        risk: "low",
        app: {
          id: "com.demo",
          name: "Demo",
          groups: [{
            key: 0,
            name: "g",
            rules: [{
              key: 0,
              matches: ['[vid="skip"]'],
              matchRoot: "content_container",
            }],
          }],
        },
      }],
    }))).toThrow("rules[0].matchRoot");
  });

  it("rejects unparsable AI selectors before creating candidates", () => {
    expect(() => parseAiCandidates(JSON.stringify({
      candidates: [{
        id: "a",
        title: "A",
        summary: "test",
        risk: "low",
        app: {
          id: "com.demo",
          name: "Demo",
          groups: [{
            key: 0,
            name: "g",
            rules: [{ key: 0, matches: ["not a selector ???"] }],
          }],
        },
      }],
    }))).toThrow("选择器语法错误");
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

  it("carries snapshot, app, known limits, evidence and repair advice in feedback prompts", () => {
    const app = appDraft();
    const messages = buildAiFeedbackMessages({
      mode: "single",
      originalPrompt: "原始单步 prompt",
      candidate: {
        id: "a",
        title: "测试版 A",
        summary: "",
        risk: "",
        app,
      },
      result: "triggered-no-close",
      note: "我观察到点击后广告仍在",
      snapshotId: 42,
      appId: "com.demo",
      knownLimitations: ["未取得 GKD 运行日志"],
    });
    const text = messages.map((message) => message.content).join("\n");
    expect(text).toContain("testing feedback (structured)");
    expect(text).toContain('"snapshotId": 42');
    expect(text).toContain('"appId": "com.demo"');
    expect(text).toContain("user-observation");
    expect(text).toContain("用户观察");
    expect(text).toContain("未取得 GKD 运行日志");
    expect(text).toContain("检查动作和目标");
    expect(text).toContain("不要因为规则内容不同就宣布修正版有效");
  });

  it("normalizes new feedback categories in batch and external prompts", () => {
    const formatted = formatAuthoringFeedbackPrompt({
      description: classifyAuthoringFeedback({
        result: "node-unavailable",
        note: "快照里的按钮已经消失",
        snapshotId: "s-42",
        appId: "com.demo",
      }),
    });
    expect(formatted).toContain(
      "node-unavailable",
    );
    expect(formatted).toContain(
      "节点不可用",
    );
  });

  it("prefers a precise category when a feedback object keeps a legacy result", () => {
    const app = appDraft();
    const feedback = {
      candidate: { id: "a", title: "测试版 A", summary: "", risk: "", app },
      result: "other" as const,
      category: "node-unavailable" as const,
      note: "按钮已消失",
    };
    const batch = buildAiBatchFeedbackMessages({
      mode: "single",
      originalPrompt: "原始 prompt",
      feedbacks: [feedback],
    }).map((message) => message.content).join("\n");
    const external = buildExternalFeedbackPrompt([feedback], false);
    expect(batch).toContain('"result": "node-unavailable"');
    expect(external).toContain("节点不可用");
  });

  it("maps structured panel feedback through to the batch prompt", () => {
    const draft: FailureFeedbackDraft = {
      result: "node-unavailable",
      note: "按钮已消失",
      snapshotId: "snapshot-42",
      appId: "com.demo",
      staticValidation: "partial",
      diagnostics: ["目标节点不在当前快照中"],
      knownLimitations: ["没有设备运行日志"],
    };
    const feedback = toCandidateFeedback(
      { id: "a", title: "测试版 A", summary: "", risk: "", app: appDraft() },
      draft,
    );
    const batchPrompt = buildAiBatchFeedbackMessages({
      mode: "single",
      originalPrompt: "原始 prompt",
      feedbacks: [feedback],
    }).map((message) => message.content).join("\n");

    expect(feedback).toMatchObject({
      result: "other",
      category: "node-unavailable",
      note: "按钮已消失",
      snapshotId: "snapshot-42",
      appId: "com.demo",
      staticValidation: "partial",
      diagnostics: ["目标节点不在当前快照中"],
      knownLimitations: ["没有设备运行日志"],
    });
    expect(batchPrompt).toContain('"snapshotId": "snapshot-42"');
    expect(batchPrompt).toContain('"appId": "com.demo"');
    expect(batchPrompt).toContain('"staticValidation": "partial"');
    expect(batchPrompt).toContain("目标节点不在当前快照中");
    expect(batchPrompt).toContain("没有设备运行日志");
  });

  it("keeps legacy feedback calls valid without structured extras", () => {
    const messages = buildAiFeedbackMessages({
      mode: "single",
      originalPrompt: "legacy prompt",
      candidate: {
        id: "legacy",
        title: "旧候选",
        summary: "",
        risk: "",
        app: appDraft(),
      },
      result: "not-triggered",
      note: "",
    });
    expect(messages.map((message) => message.content).join("\n")).toContain("not-triggered");
  });

  it("builds a structured external feedback prompt without resending context", () => {
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
    expect(prompt).toContain(app.groups[0].rules[0].matches[0] as string);
    expect(prompt).toContain("testing feedback (structured)");
  });

  it("keeps metadata for regular and flow feedback in external prompts", () => {
    const app = appDraft();
    const prompt = buildExternalFeedbackPrompt([
      {
        candidate: { id: "a", title: "测试版 A", summary: "", risk: "", app },
        result: "other",
        category: "static-unsatisfied",
        note: "规则没有命中",
        snapshotId: "snapshot-42",
        appId: "com.demo",
        staticValidation: "unsatisfied",
        diagnostics: ["当前 Activity 不匹配"],
        knownLimitations: ["没有设备运行日志"],
      },
      {
        candidate: { id: "b", title: "测试版 B", summary: "", risk: "", app },
        result: "flow-note",
        note: "流程停在第二步",
        snapshotId: "snapshot-43",
        appId: "com.demo",
        staticValidation: "partial",
        diagnostics: ["第二步目标缺失"],
        knownLimitations: ["未取得流程日志"],
      },
    ], false);

    for (const expected of [
      '\"snapshotId\": \"snapshot-42\"',
      '\"snapshotId\": \"snapshot-43\"',
      '\"appId\": \"com.demo\"',
      '\"staticValidation\": \"unsatisfied\"',
      '\"staticValidation\": \"partial\"',
      "当前 Activity 不匹配",
      "第二步目标缺失",
      "没有设备运行日志",
      "未取得流程日志",
      app.groups[0].rules[0].matches[0] as string,
    ]) {
      expect(prompt).toContain(expected);
    }
    expect(prompt).toContain("测试版 B：流程备注");
    expect(prompt).toContain("唯一一个 ```json5 代码块");
    expect(prompt).toContain("{ candidates: [...] }");
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
    expect(compact).toContain("#64 View");
    expect(compact).toContain("已省略");
    expect(compact).not.toContain("#66 View");
    expect(compact.length).toBeLessThanOrEqual(18000);
  });

  it("preserves all steps and per-step target subtrees when compacting flow prompts", () => {
    const buildStepTree = (stepNum: number, pickedId: number) =>
      Array.from(
        { length: 70 },
        (_, i) =>
          `  #${i} View d=1 p=#0 idx=${i} 100x50 ${i === pickedId ? `text="步骤${stepNum}目标"` : `text="占位节点${stepNum}-${i}"`} bounds=[0,${i * 10},100,${i * 10 + 10}]`,
      ).join("\n");

    const flowPrompt = [
      "你是 GKD 规则专家。请根据下面的多快照流程信息生成完整的多步骤 GKD 规则。",
      "",
      "流程信息：",
      "- flowName: 三步跳过流程",
      "- stepCount: 3",
      "",
      "步骤 1：点击入口",
      "- appId: com.demo",
      "- 用户点击目标节点：",
      '{"id":55,"name":"TextView","text":"步骤1目标"}',
      "- 当前步骤节点树摘要：",
      buildStepTree(1, 55),
      "",
      "步骤 2：关闭弹窗",
      "- appId: com.demo",
      "- 用户点击目标节点：",
      '{"id":60,"name":"TextView","text":"步骤2目标"}',
      "- 当前步骤节点树摘要：",
      buildStepTree(2, 60),
      "",
      "步骤 3：确认退出",
      "- appId: com.demo",
      "- 用户点击目标节点：",
      '{"id":62,"name":"TextView","text":"步骤3目标"}',
      "- 当前步骤节点树摘要：",
      buildStepTree(3, 62),
    ].join("\n");

    const compact = compactPromptForAi(flowPrompt);

    expect(compact).toContain("步骤 1：点击入口");
    expect(compact).toContain("步骤 2：关闭弹窗");
    expect(compact).toContain("步骤 3：确认退出");
    expect(compact).toContain('#55 View');
    expect(compact).toContain('#60 View');
    expect(compact).toContain('#62 View');
    expect(compact.length).toBeLessThanOrEqual(18000);
  });

  it("compresses redundant header lists instead of starving the node tree when header is very long", () => {
    const longSiblings = Array.from(
      { length: 40 },
      (_, i) => `#${i + 100} TextView text="${"很长的兄弟节点冗余说明文本".repeat(12)}-${i}"`,
    );
    const longNearby = Array.from(
      { length: 40 },
      (_, i) => `#${i + 200} TextView text="${"很长的附近无关文案列表内容".repeat(12)}-${i}"`,
    );
    const prompt = [
      "你是 GKD 规则专家。",
      "",
      "应用信息：",
      "- appId: com.demo",
      "",
      "用户点击的目标节点：",
      '{"id": 9, "name": "android.widget.TextView", "text": "跳过"}',
      "",
      "同屏属性冲突与全屏遮罩告警：",
      "- ⚠️ 同屏属性冲突：[text=\"跳过\"] 另命中 1 个节点",
      "",
      "同级节点：",
      ...longSiblings,
      "",
      "附近文本/描述节点：",
      ...longNearby,
      "",
      "节点树摘要：",
      "#0 FrameLayout d=0 p=#-1",
      "  #9 TextView clickable d=1 p=#0 text=\"跳过\"",
      "",
      "输出前自检（在内部完成，不要输出自检过程）：",
      "1. 检查全部规则。",
    ].join("\n");

    const compact = compactPromptForAi(prompt);

    expect(compact).toContain("同屏属性冲突与全屏遮罩告警");
    expect(compact).toContain("#9 TextView");
    expect(compact).toContain("输出前自检");
    expect(compact.length).toBeLessThanOrEqual(18000);
  });

  it("streams concise external feedback without dumping full candidate JSON twice", () => {
    const app = appDraft();
    const prompt = buildExternalFeedbackPrompt(
      [
        {
          candidate: { id: "a", title: "测试版 A", summary: "s-only-once", risk: "r", app },
          result: "not-triggered",
          note: "没触发",
        },
      ],
      false,
    );

    expect(prompt).toContain('[vid="skip"]');
    expect(prompt).toContain("testing feedback (structured)");
    expect(prompt).not.toContain("s-only-once");
    expect(prompt.match(/testing feedback \(structured\)/g)?.length).toBe(1);
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

  it("parseAiCandidates parses unfenced bare candidate array without markdown fences", () => {
    const input = `
      以下是 2 个候选：
      [
        {
          id: 'candidate-a',
          title: '测试版 A',
          summary: '直接匹配 vid',
          risk: '低',
          app: {
            id: 'com.demo',
            name: 'Demo',
            groups: [{ key: 0, name: 'g', rules: [{ key: 0, matches: ['[vid="skip_a"]'] }] }],
          },
        },
        {
          id: 'candidate-b',
          title: '测试版 B',
          summary: '匹配文本',
          risk: '低',
          app: {
            id: 'com.demo',
            name: 'Demo',
            groups: [{ key: 0, name: 'g', rules: [{ key: 0, matches: ['[text="跳过"]'] }] }],
          },
        },
      ]
    `;
    const candidates = parseAiCandidates(input);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.id)).toEqual(["candidate-a", "candidate-b"]);
    expect(candidates[0].app.groups[0].rules[0].matches).toEqual(['[vid="skip_a"]']);
    expect(candidates[1].app.groups[0].rules[0].matches).toEqual(['[text="跳过"]']);
  });

  it("parseAiCandidates isolates fenced export default JSON5 from unclosed brace in preceding prose", () => {
    const input = `
      提示：遇到类似 { text="跳过" 这种未闭合花括号说明时不要被干扰。
      \`\`\`json5
      // 合法围栏规则
      export default {
        candidates: [
          {
            id: 'candidate-a',
            title: '测试版 A',
            summary: '围栏内独立解析',
            risk: '低',
            app: {
              id: 'com.demo',
              name: 'Demo',
              groups: [{ key: 0, name: 'g', rules: [{ key: 0, matches: ['[vid="real_skip"]'] }] }],
            },
          },
        ],
      };
      \`\`\`
    `;
    const candidates = parseAiCandidates(input);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("candidate-a");
    expect(candidates[0].app.groups[0].rules[0].matches).toEqual(['[vid="real_skip"]']);
  });
});

describe("compactPromptForAi integration & critical-fact preservation", () => {
  function makeFlowStep(stepIndex: number): FlowRuleStep {
    const pickedId = 48 + stepIndex;
    const baseAttr = (overrides: Partial<SnapshotNodeAttr>): SnapshotNodeAttr => ({
      id: null,
      vid: null,
      name: "android.view.View",
      text: null,
      desc: null,
      clickable: false,
      focusable: false,
      checkable: false,
      checked: false,
      editable: false,
      longClickable: false,
      visibleToUser: true,
      left: 0,
      top: 0,
      right: 1080,
      bottom: 2400,
      width: 1080,
      height: 2400,
      childCount: 0,
      index: 0,
      depth: 0,
      ...overrides,
    });
    const nodes: SnapshotNode[] = [
      {
        id: 0,
        pid: -1,
        idQf: false,
        textQf: false,
        attr: baseAttr({ name: "android.widget.FrameLayout", childCount: 60 }),
      },
    ];
    for (let i = 1; i <= 60; i += 1) {
      const isTarget = i === pickedId;
      nodes.push({
        id: i,
        pid: 0,
        idQf: isTarget,
        textQf: true,
        attr: baseAttr({
          name: isTarget ? "android.widget.Button" : "android.widget.TextView",
          id: isTarget ? `com.demo:id/step_${stepIndex}_target` : null,
          vid: isTarget ? `step_${stepIndex}_target` : `filler_node_${stepIndex}_${i}`,
          text: isTarget
            ? `步骤${stepIndex}真实目标按钮`
            : `流程第${stepIndex}步背景列表项超长文案描述用于压测紧凑裁剪逻辑-${i}`,
          clickable: isTarget,
          left: isTarget ? 800 : 20,
          top: isTarget ? 100 : i * 30,
          right: isTarget ? 1020 : 700,
          bottom: isTarget ? 180 : i * 30 + 25,
          width: isTarget ? 220 : 680,
          height: isTarget ? 80 : 25,
          depth: 1,
          index: i - 1,
        }),
      });
    }
    const raw: RawGkdSnapshot = {
      id: 100 + stepIndex,
      appId: "com.demo",
      activityId: `com.demo.Step${stepIndex}Activity`,
      screenWidth: 1080,
      screenHeight: 2400,
      isLandscape: false,
      appInfo: { id: "com.demo", name: "DemoApp" },
      nodes,
    };
    const snapshot = normalizeSnapshot(raw, `blob:step-${stepIndex}`, `step-${stepIndex}.zip`);
    const pickResult = pickNodeAtPoint(snapshot, { x: 900, y: 140 });
    return {
      id: `step-${stepIndex}`,
      title: `第${stepIndex}步关键动作`,
      scenarioId: "popup",
      snapshot,
      pickResult,
      candidates: [],
      selectedCandidate: null,
      ruleSettings: { ...DEFAULT_RULE_SETTINGS, groupName: "六步流程", activityIds: "" },
      note: `这是第 ${stepIndex} 步的操作说明：`.repeat(6),
      delayNote: `延迟说明 ${stepIndex}`,
    };
  }

  it("preserves all 6 step titles, target nodes, and stays within MAX_COMPACT_PROMPT_CHARS for real buildFlowHelpPrompt output", () => {
    const steps = Array.from({ length: 6 }, (_, i) => makeFlowStep(i + 1));
    const fullFlowPrompt = buildFlowHelpPrompt({
      flowName: "六步超长真实流程压测",
      flowDesc: "验证 6 个超长步骤在 compactPromptForAi 裁剪后不会丢失尾部步骤或目标节点",
      steps,
      includeNodeTrees: true,
      audience: "builtin",
    });

    expect(fullFlowPrompt.length).toBeGreaterThan(18000);

    const compact = compactPromptForAi(fullFlowPrompt);
    expect(compact.length).toBeLessThanOrEqual(18000);
    for (let i = 1; i <= 6; i += 1) {
      expect(compact).toContain(`步骤 ${i}：第${i}步关键动作`);
      expect(compact).toContain(`步骤${i}真实目标按钮`);
      expect(compact).toContain(`#${48 + i} `);
    }
  });

  it("drops generic preamble instead of critical facts when criticalTail exceeds single-step header budget", () => {
    const hugePreamble = `你是 GKD 规则专家。\n${"这是一段非常冗长的通用背景说明废话。".repeat(250)}\n\n`;
    const hugeJsonDraft = `当前 JSON5 草稿：\n${"  { key: 0, matches: ['[text=\"占位\"]'] },\n".repeat(450)}`;
    const prompt = [
      hugePreamble,
      "应用信息：",
      "- appId: com.demo",
      "",
      "用户点击的目标节点：",
      '{"id": 7, "name": "android.widget.TextView", "text": "立即跳过", "clickable": false}',
      "⚠️ 警示：目标节点 #7 clickable=false，必须使用 action: \"clickCenter\"",
      "- 真实 vid 白名单: vid=\"skip_btn\"",
      "",
      hugeJsonDraft,
      "",
      "节点树摘要：",
      "#0 FrameLayout d=0 p=#-1",
      '  #7 TextView d=1 p=#0 text="立即跳过" vid="skip_btn"',
      '  #8 Button d=1 p=#0 text="底部按钮"',
    ].join("\n");

    const compact = compactPromptForAi(prompt);
    expect(compact.length).toBeLessThanOrEqual(18000);
    expect(compact).toContain("应用信息：");
    expect(compact).toContain("用户点击的目标节点：");
    expect(compact).toContain("clickable=false");
    expect(compact).toContain('vid="skip_btn"');
    expect(compact).toContain("#7 TextView");
    expect(compact).toContain("#8 Button");
    expect(compact).not.toContain("这是一段非常冗长的通用背景说明废话。");
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
