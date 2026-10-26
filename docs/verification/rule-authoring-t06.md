# T06 失败反馈与 AI prompt 验证

日期：2026-10-26。Ticket：[T06](../tickets/rule-authoring-optimization/06-failure-feedback.md)。需求依据：[规则制作优化规格](../specs/rule-authoring-optimization-spec.md)。本轮只修改独立反馈库、AI prompt 与可复用面板，没有修改 `AndroidLiteApp.tsx`、`helpPrompt.ts`、核心类型或 selector matcher。

## 已实现

`src/lib/authoringFeedback.ts` 暴露以下集成接口：

```ts
type AuthoringFeedbackCategory =
  | "not-triggered"
  | "triggered-no-close"
  | "mistouch"
  | "node-unavailable"
  | "static-unsatisfied"
  | "scope-or-timing-pending"
  | "other";

classifyAuthoringFeedback(input): AuthoringFeedbackDescription;
describeAuthoringFeedback(input): AuthoringFeedbackDescription;
normalizeAuthoringFeedbackResult(value): AuthoringFeedbackCategory;
formatAuthoringFeedbackPrompt(input): string;
```

`AuthoringFeedbackDescription` 返回 `category`、兼容用的 `legacyResult`、界面标签、证据来源（`user-observation` / `static-validation` / `unknown`）、置信度、原因、短修复建议、用户备注、`snapshotId`、`appId` 与 `knownLimitations`。新分类不会在旧 `AiFeedbackResult` 中静默改变 UI；独立面板/helper 显式使用新分类。`toCandidateFeedback` 遇到新分类时把旧 `result` 映射为 `other`，同时保留精确 `category`，prompt 分类优先采用 `category`。UI 证据文案由 `formatAuthoringFeedbackEvidence` 映射为“用户反馈／快照验证／待核对”，不显示内部枚举或置信度。

`aiModel.ts` 的单条反馈入口增加可选字段：

```ts
snapshotId?: number | string;
appId?: string;
staticValidation?: "unsatisfied" | "partial" | "satisfied" | "unknown";
diagnostics?: string[];
knownLimitations?: string[];
limitations?: string[]; // 兼容别名
```

单条 `buildAiFeedbackMessages` 输出结构化 `testing feedback (structured)`；批量入口在每条反馈下附结构化摘要；外部精简入口增加标签与修复建议，仍不重发规则和上下文。`triggered-no-close` 固定显示「用户观察」，不会写成“已确认根因”。旧四项可走旧入口；新三项通过 `AiCandidateFeedback.category` 的独立结构化语义传递，不改变旧 `result`。

独立组件 `src/components/FailureFeedbackPanel.tsx` 接收 `feedback`、可选编辑/复制/发送回调与状态，供主 agent 接入；未修改当前 Android 组件。

## 自动检查

| 检查 | 结果 |
|---|---|
| `pnpm exec vitest run src/lib/authoringFeedback.test.ts` | 3/3 通过 |
| `pnpm exec vitest run src/lib/aiModel.test.ts` | 34/34 通过 |
| `pnpm exec vitest run src/lib/promptGeneration.test.ts` | 5/5 通过 |
| `pnpm exec vitest run src/lib/inlineRuleTesting.test.ts` | 12/12 通过 |
| 上述四文件合并复跑 | 4 个测试文件、57 个测试通过 |
| `git diff --check`（T06 写集） | 通过 |

红绿过程：先新增 helper 缺失、结构化字段缺失的失败测试，再补齐实现；新分类扩展期间发现旧主组件的局部联合类型不兼容，于是保持 `AiFeedbackResult` 旧值，把新分类放入独立 helper/反馈对象。这一兼容行为已有测试覆盖。

中间运行时，`pnpm run typecheck` 曾受并行工作区阻断（`nodePicker.test.ts` 增删与 T04 的 `ConditionEditor.tsx`/`conditionEditor.ts` 类型错误）。并行改动落定后，最终 `pnpm run typecheck` 已通过；T06 四个测试也全部通过。

## 快照与限制

测试用的 `snapshotId`、`appId`、诊断文本与备注均为脱敏合成值；没有上传快照、API key 或设备规则。测试只覆盖纯 helper 与公开 prompt 构造，不调用真实模型，也不读取真实设备。

主 agent 的集成接口为：

1. 反馈选择状态使用 `FailureFeedbackDraft`，或在现有草稿上增加同一组可选字段。
2. 发送时用 `toCandidateFeedback(candidate, draft)` 或直接构造带 optional `category` 的反馈对象；`result` 只作兼容，`category` 优先。需要更完整字段时用 `formatAuthoringFeedbackPrompt`。
3. 旧四项的兼容提示可走单条 `buildAiFeedbackMessages`、批量 `buildAiBatchFeedbackMessages` 与外部 `buildExternalFeedbackPrompt`；新三项也通过 `category` 保持精确语义。
4. 修正轮继续调用现有 `setAiSessionCandidates`；它递增 session generation，旧候选测试状态不会被新轮次继承。
5. 已有复制、发送失败与重试入口保持原状，面板的 `copyState` / `sendState` 只供集成显示，不自行宣称成功。面板的 `onCopyPrompt` 可由主 agent 用当前规则和当前快照调用独立反馈 helper 构造内容。

## 未验收

- 主工作区中的失败反馈面板布局、用户操作流、剪切板复制、内置 AI 网络调用和外部 AI 粘贴回环尚未由本 ticket 接入或运行。
- 真实设备上的未触发、触发未关闭、误触、节点不可用、范围和时机问题没有采集证据。
- AI 修订后的静态验证与设备测试需要由 T01、T02 及主 agent 的公共流程继续完成；本轮不把 prompt 约束当作实际模型行为。

## 重跑

运行目录：`C:\Users\kmttjnm\Desktop\各种项目\project\gkd-rule-builder`。Shell：PowerShell。

```powershell
pnpm exec vitest run src/lib/authoringFeedback.test.ts src/lib/aiModel.test.ts src/lib/promptGeneration.test.ts src/lib/inlineRuleTesting.test.ts
pnpm run typecheck
```
