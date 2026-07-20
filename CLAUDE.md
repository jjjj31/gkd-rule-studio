# CLAUDE.md

> 该说明文件优先级仅次于 工作流.md。

## 角色约定（最高优先级）

你是一个**资深 vibe coding 工程师**，正在带一个**完全零编程基础的小白**完成这个项目。

用户有c语言语法基础，但是不会脱离AI来开发，不会自己debug，看不懂AI在写什么，不知道review什么。你的职责是：**一边写代码完成需求，一边用教学用户使用vibecoding工具编程，教用户在AI时代怎么不造轮子用AI工具写出自己看得懂，能维护，当AI无法解决错误时独立解决报错，你要提醒用户你作为一个AI的能力边界，你不擅长或者没有太大把握的地方请大大方方告诉用户，这对用户很有帮助**。

### 回复格式

每次回复可以分成两个区（具体是哪些区你自己决定），用 `---` 分隔：

**项目回复区**
- 完成了什么需求、改了什么文件、改动的代码在哪里
- 为什么这样改（思路，不是代码细节）
- 本次改了之后用户需要做什么（比如重新打包 APK、在手机上测试哪一步）

**教学区（只在有必要的知识点要讲时再开，没必要没得讲硬讲）**
- 用**日常生活的比喻**解释本次涉及的概念（不假设用户知道任何术语）
- 遇到术语必须先用一句话解释它是什么，再说怎么用
- 教一个小技巧（怎么在文件里找到东西、怎么理解一段代码、git 怎么用、怎么 debug 等）
- **每次只教一个知识点**，不要贪多

### 教学区规则

1. 解释概念时，先说日常例子（比如"HTTP 请求就像你在餐厅对服务员说一句话，服务员把话带回厨房"），再说代码里谁是谁
2. 不要用编程术语解释另一个编程术语。如果必须说术语，括号里加一句大白话
3. 每次教学只挑一个概念深入讲，用户消化不了太多
4. 实操技巧优先：怎么看懂报错、怎么找文件、怎么看某段代码是谁写的（git blame）、怎么打断点 print 日志，教用户怎么使用git管理代码
5. 用户说没听懂 → 换一个比喻再讲一遍，不要说"就是这样的"

## 项目回复区规则

1. 改代码前先读相关文件，理解全貌再动
2. 最短的 diff 解决问题（ponytail 模式）
3. 改完说清楚：改了哪个文件、现在用户要在手机上试什么
4. 用户每次改完代码都会重新打包 APK，项目里有 `pnpm run build:android-assets` 脚本构建 WebView 资源

---

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

GKD Rule Studio — a local tool for generating GKD (搞快点) ad-blocking rules from accessibility snapshots. Users select UI controls on device screenshots, get candidate CSS-like selectors, and produce JSON5 rule drafts that can be imported into GKD's in-memory subscription for testing.

Bilingual codebase: UI text and comments are in Chinese; code identifiers are in English.

## Commands

```bash
pnpm install              # Install dependencies
pnpm test                 # Run all tests (vitest)
pnpm run test -- src/lib/ruleDraft.test.ts   # Run a single test file
pnpm run typecheck        # TypeScript type checking (tsc -b)
pnpm run dev              # Dev server at http://127.0.0.1:5174/
pnpm run build            # Production build
pnpm run build:android-assets  # Build for Android WebView (base=./, outDir=android/app/src/main/assets)
```

Android APK build (requires Gradle):
```bash
cd android && gradle assembleDebug
```

## Architecture

### Platform

`App.tsx` renders `<AndroidLiteApp/>` (from `components/AndroidLiteApp.tsx`). This is a touch-optimized mobile UI that connects to GKD HTTP service directly. Communicates with the native Android layer via `window.GkdAndroidBridge` (clipboard, HTTP proxy, back button) — see `vite-env.d.ts` for the bridge interface.

The desktop version (formerly `DesktopApp`) has been moved to the `desktop` branch.

### Core data flow

1. **Snapshot loading** → `ParsedGkdSnapshot` (from GKD HTTP service via `deviceApi.ts`)
2. **User taps screenshot** → `nodePicker.ts` resolves tap coordinates to `NodePickResult` on the accessibility tree
3. **Candidate generation** → `regionCandidates.ts` produces ranked `SelectorCandidate[]` using multiple selector strategies (id, vid, text, bounds, etc.)
4. **Rule draft** → `ruleDraft.ts` (single-step) or `flowDraft.ts` (multi-step) assembles candidates into `AppRuleDraft` (JSON5-serializable GKD rule format)
5. **AI assistance** → `aiModel.ts` sends prompts + optional screenshots to configurable LLM endpoints; `helpPrompt.ts` / `flowDraft.ts` build the system/user prompts; returned candidates go into `inlineRuleTesting.ts`
6. **Test & import** → `testSubscription.ts` builds a GKD-compatible subscription payload; `deviceApi.ts` pushes it to GKD via `/api/updateSubscription`. Debug GKD builds also support local rules via `/api/localRules`.

### Key type files

- `types/gkdSnapshot.ts` — Accessibility tree node structure, parsed snapshot, device snapshot summary
- `types/ruleDraft.ts` — `SelectorCandidate`, `RuleSettings`, `AppRuleDraft`, `RuleDraft`
- `types/flowDraft.ts` — `FlowRuleStep`, `FlowDraftInput`

### Important lib modules

| Module | Role |
|--------|------|
| `deviceApi.ts` | HTTP client for GKD service (snapshots, subscription update, local rules) |
| `aiModel.ts` | LLM integration (config/profile management, request, parse, feedback loop) |
| `inlineRuleTesting.ts` | Per-selector test tracking with AI session management, persisted to localStorage |
| `testSubscription.ts` | GKD subscription payload builder + import tracking |
| `ruleDraft.ts` | Single-step rule assembly from snapshot + candidate |
| `flowDraft.ts` | Multi-step flow rule assembly + help prompt generation |
| `nodePicker.ts` | Hit-test on accessibility tree from screen coordinates |
| `regionCandidates.ts` | Multi-strategy selector candidate generation and ranking |
| `gkdTarget.ts` | Debug vs official GKD package targeting (`com.gkd.debug` vs `com.gkd`) |
| `customScenario.ts` | User-defined scenario presets persisted to localStorage |
| `candidateGuidance.ts` | Beginner-friendly guidance labels for each candidate strategy |

### Android native layer

`android/app/src/main/java/.../MainActivity.java` — A bare WebView Activity that loads the built web assets. Exposes `@JavascriptInterface` methods for clipboard, HTTP proxy (`postJson`), and back-button control. No React Native or Capacitor.

### Platform extension points

The web app can also run in a userscript context. `vite-env.d.ts` declares `window.__NetworkExtension__` (GM_xmlhttpRequest) for cross-origin requests in that environment.

## Testing

Tests use **vitest** in node environment. Test files live alongside source in `src/lib/*.test.ts`. Key test files:
- `deviceApi.test.ts`, `flowDraft.test.ts`, `testSubscription.test.ts`, `inlineRuleTesting.test.ts`, `aiModel.test.ts`, `regionCandidates.test.ts`

## Conventions

- Package manager: **pnpm** (lockfile is `pnpm-lock.yaml`)
- State management: React `useState`/`useRef` only — no external state library
- Styling: Plain CSS in `src/styles.css` (no CSS modules, no Tailwind)
- Serialization: **JSON5** for GKD rule output (via `json5` package)
- Drag-and-drop: `@dnd-kit` for flow step reordering

---

# 功能模块详解（中文）

> 本分区为面向小白的模块说明 + 前端逐页交互细节，由 Claude 整理、用户自行修正。重点说清「每个模块是什么、和谁配合、用户在页面上看到什么、怎么操作」。
> 下列「后端」指 `src/lib/*.ts` 与 `src/types/*.ts`；「前端」指 `src/App.tsx` 与 `src/components/*.tsx`。安卓版是主线（`AndroidLiteApp`）。桌面版（`DesktopApp`）已移至 `desktop` 分支。

## 一、模块总分类

| 类别      | 模块             | 文件                                                             | 一句话职责                                             |
| ------- | -------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| 平台入口    | 平台路由           | `App.tsx`                                                      | 渲染 AndroidLiteApp                                 |
| 前端-页面壳  | 安卓主壳           | `components/AndroidLiteApp.tsx`                                | 安卓版全部 UI 与状态（连接/选择/工作区/标签页/对话框）                   |
| 前端-交互核心 | 放大镜截图          | `components/ScreenshotCanvas.tsx`                              | 显示截图、放大镜拖动选点、画命中框                                 |
| 前端-面板   | 快照选择器          | `AndroidLiteApp` 内 `AndroidSnapshotChooser`                    | 首页勾选快照、多选进流程                                      |
| 前端-面板   | 候选卡片           | `AndroidLiteApp` 内 `CandidateSummary`                          | 显示候选 selector、测试、复制 JSON5                         |
| 前端-面板   | 场景面板           | `AndroidLiteApp` 内 `AndroidScenePanel`                         | 选场景预设 / 自定义场景                                     |
| 前端-面板   | 外部 AI 面板       | `AndroidLiteApp` 内 `AndroidPromptPanel`                        | 复制求助 prompt、粘贴 AI 回复提取                            |
| 前端-面板   | 流程编辑           | `AndroidLiteApp` 内 `AndroidFlowEditor` + `AndroidFlowStepRail` | 多步步骤的增删改、拖拽排序                                     |
| 前端-面板   | 内置 AI 面板       | `AndroidLiteApp` 内 `AndroidAiPanel`                            | 调内置 AI 生成、测试、反馈                                   |
| 前端-面板   | 测试管理页          | `AndroidInlineTestManagerPage`                                 | 全屏查看当前测试集合                                        |
| 前端-面板   | AI session 管理页 | `AndroidAiSessionManagerPage`                                  | 全屏管理 AI 会话                                        |
| 前端-面板   | AI 配置对话框       | `AndroidAiConfigDialog`                                        | 多 profile 的 API 配置                                |
| 前端-面板   | 调试报告           | `AndroidDebugReportPanel`                                      | 查看 / 复制调试日志                                       |
| 数据-类型   | 快照类型           | `types/gkdSnapshot.ts`                                         | 无障碍树节点、解析后快照、设备摘要                                 |
| 数据-类型   | 规则草稿类型         | `types/ruleDraft.ts`                                           | `SelectorCandidate`、`RuleSettings`、`AppRuleDraft` |
| 数据-类型   | 流程草稿类型         | `types/flowDraft.ts`                                           | `FlowRuleStep`、`FlowDraftInput`                   |
| 数据-预设   | 规则设置预设         | `data/ruleSettings.ts`                                         | 开屏/视频等场景预设的 `RuleSettings` 构造器                    |
| 数据-词表   | 风险词表           | `data/riskWords.ts`                                            | 危险点击词、正向 CTA 词、通用动作词                              |
| 设备通信    | 设备 HTTP 客户端    | `lib/deviceApi.ts`                                             | 与 gkd HTTP 服务通信（快照、订阅导入、本地规则）                     |
| 设备通信    | 网络通道扩展         | `lib/networkExtension.ts`                                      | fetch / GM_xmlhttpRequest / 超时封装                  |
| 设备通信    | 目标包名           | `lib/gkdTarget.ts`                                             | 官方版 / Beta 版包名切换与持久化                              |
| 快照解析    | 节点命中           | `lib/nodePicker.ts`                                            | 屏幕坐标 → 命中节点 + 祖先/兄弟/邻近文本                          |
| 选点交互    | 放大镜几何          | `lib/dragMagnifier.ts`                                         | 拖动放大镜的坐标换算、节点框映射                                  |
| 候选生成    | 候选生成总入口        | `lib/regionCandidates.ts`                                      | 主候选 + 同框节点候选，排序去重                                 |
| 候选生成    | 选择器策略          | `lib/selectorStrategies.ts`                                    | 14 种策略产出 `SelectorCandidate`                      |
| 候选生成    | 选择器匹配          | `lib/selectorMatcher.ts`                                       | 反向在快照里验证 selector 命中                              |
| 候选生成    | 选择器序列化         | `lib/selectorSerialize.ts`                                     | selector ↔ 字符串                                    |
| 候选生成    | 候选引导文案         | `lib/candidateGuidance.ts`                                     | 给每张候选卡片贴「推荐/谨慎/危险」小白话标签                           |
| 风险打分    | 风险打分           | `lib/riskScoring.ts`                                           | 基础分 + 加扣分 + 风险等级                                  |
| 风险打分    | 动作计划           | `lib/actionPlan.ts`                                            | 决定 action 类型 / delay / max / cd                   |
| 规则装配    | 单步规则           | `lib/ruleDraft.ts`                                             | 快照 + 候选 → `AppRuleDraft`（含兜底候选）                   |
| 规则装配    | 多步流程规则         | `lib/flowDraft.ts`                                             | 多步 → 大 `AppRuleDraft`；+ 流程 help prompt            |
| 规则装配    | 流程步骤辅助         | `lib/flowSteps.ts`                                             | 步骤 id、相邻快照查找等纯函数                                  |
| 安卓流程    | 安卓流程流转         | `lib/androidLiteFlow.ts`                                       | 安卓多步打开模式、步骤快照分配                                   |
| 订阅导入    | 订阅载荷           | `lib/testSubscription.ts`                                      | 组装 GKD 订阅 payload、导入计数标记                          |
| 测试管理    | 内联测试状态         | `lib/inlineRuleTesting.ts`                                     | 每条 selector 的测试状态 + AI session，落 localStorage     |
| AI 集成   | AI 模型          | `lib/aiModel.ts`                                               | 配置 / profile / 请求 / 解析 / 反馈循环                     |
| AI 集成   | 单步 prompt      | `lib/helpPrompt.ts`                                            | 单步「求助 prompt」组装                                   |
| AI 集成   | 场景 prompt      | `lib/customScenario.ts`                                        | 自定义场景的解析、持久化、prompt                               |
| 调试      | 调试日志           | `lib/debugLog.ts`                                              | 全局分类调试日志、导出报告                                     |
| 杂项      | 剪贴板            | `lib/clipboard.ts`                                             | 跨平台复制（Web / 安卓桥 / GM）                             |

## 二、后端模块详解（按数据流顺序）

### 2.1 设备通信层

- **`deviceApi.ts`**：`createDeviceApiClient(origin)` 先发 `getServerInfo` 拿到 gkd 版本/包名，再封装 `getSnapshots / getSnapshot / getScreenshot / captureSnapshot / loadSnapshot / updateSubscription / appendLocalRules`。`loadSnapshot` 同时拉取快照 JSON 和截图二进制，把截图做成 `blob:URL`，再用 `normalizeSnapshot` 归一化成 `ParsedGkdSnapshot`。它和 `gkdTarget.ts` 配合：`getServerInfo` 返回的 `gkdAppInfo.id` 用来比对当前目标包名，不匹配就给用户提醒。
- **`networkExtension.ts`**：`deviceApi` 默认走 `fetch`；在油猴/魔改环境中优先用 `window.__NetworkExtension__`（`GM_xmlhttpRequest`）跨域。`fetchWithTimeout` / `enhancedFetch` 是带超时的封装。aiModel 也复用它。
- **`gkdTarget.ts`**：管理「正式版 `li.songe.gkd`」vs「Beta 版 `li.songe.gkd.debug`」。Beta 版才有 `localRules/append`（直接把规则存进 gkd 本地规则），正式版只能复制规则让用户手动粘。这一选择影响「测试后导入」按钮的行为（导入 vs 复制）。

> 配合关系：`AndroidLiteApp.connect()` → `createDeviceApiClient` → `getSnapshots()`。选了快照后 `loadDeviceSnapshot` → `loadSnapshot` → `openSnapshot`。

### 2.2 选点与节点解析

- **`nodePicker.ts`**：`pickNodeAtPoint(snapshot, point)` 做命中测试：在无障碍树里找出包含该坐标、可见、可点的节点，同时返回祖先链、兄弟节点、邻近文本节点、可点祖先。`pickExistingNode` 是从节点树直接选（不靠坐标）。它决定了「放大镜点一下」之后能拿到什么。
- **`dragMagnifier.ts`**：纯几何。屏幕坐标 ↔ 图片本地坐标 ↔ 快照坐标的换算、放大镜内节点框的绘制参数。`ScreenshotCanvas` 调它做拖动跟随。
- **放大镜为什么「像手指」**：`nodePicker` 不只看精确命中的那个叶子节点，还会带出附近/邻居节点；`regionCandidates` 还会再找「同框节点」候选（见下）。所以放大镜不需要精细到像素，逻辑上模拟成「一点就带出一片」。

### 2.3 候选生成与打分

- **`regionCandidates.ts`** = 候选生成总入口。先对 pickedNode 跑一遍策略得到主候选，再在「同框区域」内挑最多 12 个节点各产候选，最后去重排序。
- **`selectorStrategies.ts`**：14 种策略（对应前端 `humanStrategyTitle` 的中文标题），如「稳定资源 + 跳过语义」「控件 vid 定位」「开屏跳过按钮」「点击可点父节点」「广告容器内跳过兜底」等。每个策略产出 `SelectorCandidate`，包含 `rule.matches`、`validation`（命中情况）、`risk`、`actionPlan`、`debugReasons`。
- **`selectorMatcher.ts` / `selectorSerialize.ts`**：selector 反向验证 + 序列化。
- **`riskScoring.ts`**：根据 `DANGEROUS_CLICK_WORDS`（如「升级」「立即开通」）等给扣分；命中文本稳定性、唯一命中等加分；最终给出 `finalScore` 与 `low/medium/high` 等级。
- **`actionPlan.ts`**：决定这条规则点的动作 `action`、`actionDelay`、`actionMaximum`（最大触发次数，开屏类常用）、`actionCd`（冷却）、`matchRoot` 等，影响前端「评分注解」里那条 `action=… / delay=… / max=…`。
- **`candidateGuidance.ts`**：把候选转成小白话「推荐/谨慎/危险」标签和一句理由，直接喂给候选卡片顶部那行彩色标签。

> 配合关系：选点 → `handlePointSelected` → `pickNodeAtPoint` → `generateRegionSelectorCandidates` → 一组 `SelectorCandidate` → 前端 `CandidateSummary` 渲染。改了场景/设置会再用 `buildCandidates` 重算。

### 2.4 规则装配

- **`ruleDraft.ts`**：`createAppRuleDraft(snapshot, candidate, fallbackCandidates)` 把单候选组装成 `AppRuleDraft`（含 `appId`、`groups[].rules[]`），`selectFallbackCandidates` 决定兜底候选（rocket 表里失败时让 GKD 再试的次优 selector）。`stringifyRuleDraft` 用 JSON5 序列化，就是「复制 JSON5」按钮吐出来的东西。
- **`flowDraft.ts`**：`createFlowAppRuleDraft` 把多步 `FlowRuleStep[]` 合成一个 `AppRuleDraft`；`stringifyFlowRuleDraft` 出流程规则字符串；`buildFlowHelpPrompt` 出流程求助 prompt（含每步备注）。
- **`flowSteps.ts`**：相邻快照 id 查找等小工具。
- **`androidLiteFlow.ts`**：安卓多步进入逻辑。`resolveAndroidSnapshotOpenMode` 判断「单选还是多选」「进了之后是单步还是流程」；`createAndroidFlowSteps` 把多张快照包成初始步骤；`reassignAndroidFlowStepSnapshot` 在流程画布上左右切换快照时把当前步骤的快照换掉。

### 2.5 订阅导入与测试

- **`testSubscription.ts`**：`addAppDraftToTestSubscription` 把一条 `AppRuleDraft` 塞进当前测试集合（按 selector 去重、记录 `importedSelectors`）；`buildActiveTestSubscription`（在 `inlineRuleTesting` 里）组合出完整订阅；`exportRawSubscription` 输出最终 payload；`markImportedAndClearBuffer` 在成功导入本地规则后清理标记；`wasSelectorImported` 判断某 selector 是否已导入，用于「导入过」徽标。
- **`inlineRuleTesting.ts`**：测试集合的核心状态机。维护 `items[]`（每条正在测/已测/有效/无效）和 `aiSessions[]`（每个 AI 会话及其候选）。`startOfflineCandidateTest` / `startAiCandidateTest` 把候选加入测试；`markInlineTestItemResult` 改状态；`deleteInlineTestItem` / `removeInlineTestItem` 清理；`buildActiveTestSubscription` 整合出待同步给 gkd 的订阅。状态整体持久化到 `localStorage`（key 见下），关掉应用再开还在。
  - localStorage key：`gkd-rule-studio-inline-testing`、还有安卓快照记忆 `gkd-rule-studio-snapshot-memory`、设备地址 `gkd-rule-builder-device-url`、目标包名 `gkd-rule-studio-target-package`。

> 「测试」是怎么落地的：`syncInlineTestsToGkd` → `buildActiveTestSubscription(state)` → `client.updateSubscription(...)`。这一步走 GKD 的「内存订阅」，临时生效，方便试。正式阳台子/魔改版都能用这条。
> 「导入」（Beta 专属）：`saveInlineItemToLocalRulesBeta` → `client.appendLocalRules(item.app)`，走 `localRules/append`，把规则真正存进 gkd。
> 「结束/删除」每一步也会重新同步一次内存订阅，保证 gkd 端状态和界面一致。

### 2.6 AI 集成

- **`aiModel.ts`**：AI 全家桶。`normalizeAiConfig` / `loadAiConfig` / `loadAiProfileStore` / `upsertAiProfile` / `setActiveAiProfile` / `deleteAiProfile` / `getActiveAiProfile` 管 profile；`requestAiCandidates` 真发请求；`parseAiCandidates` 用正则从 AI 回复里抽规则；`buildAiGenerateMessages` / `buildAiBatchFeedbackMessages` 组消息；`shouldRetryTextOnlyAfterMultimodalError` + `stripAiMessageImages` 做多模态失败回退纯文本；`testAiConnection` 做配置里的「测试连接」；`maskApiKey` 在错误信息里把 key 打码。
- **`helpPrompt.ts`**：单步求助 prompt（含场景、所选节点、候选情况、注意事项、输出格式）。点「复制求助 prompt」按钮吐它。
- **`customScenario.ts`**：自定义场景。`parseCustomScenario` 从粘贴的 JSON5 解析；`resolveCustomScenarioSettings` 转 `RuleSettings`；`buildCustomScenarioPrompt` 出「我想加一个场景，请按这个格式返回」的 prompt；`saveCustomScenarios` 落 localStorage（最多 20 个）。
- 「外部 AI」和「内置 AI」共用 `parseAiCandidates` 和 session 机制，区别只是消息从哪来：外部 AI 是用户手动复制 prompt → 在别处问 AI → 把答案贴回来 `importPastedAiResult`；内置 AI 是 `generateAiRules` 直接发请求。两者最终都把候选塞进 `inlineRuleTesting.aiSessions`，再走同一套测试流程。

## 三、前端框架（安卓版逐页拆解）

> 安卓版就一个大组件 `AndroidLiteApp`，靠 `view`（`"home"` / `"workspace"`）和 `activeTab`（`"scene"` / `"candidates"` / `"prompt"` / `"steps"` / `"ai"`）切两个大屏和五个标签页。没有 React Router，用 `history.pushState` + 安卓后退键联动。

### 3.1 首页（`view === "home"`）

**你看到什么**：
- 顶部一条窄头：左边一个圆形「G」品牌图标；右边依次是「Beta / 正式」目标版本切换（两个并排小按钮，当前那个高亮）、一个插头形状的「模型配置」按钮（配了 API Key 会变绿表示就绪）、一个「已连接 / 未连接」状态小标。
- 下方一张「HTTP 服务」卡片：一个输入框（占位符 `例如 127.0.0.1:8888 或 192.168.1.23:8888`）+ 一个「连接」按钮（已连接后变「重连」，带手机图标）。
- 连接成功后，下方多出「选择快照」卡片：一个带复选框的快照列表（每行一条 GKD 快照），底部一排「刷新快照」按钮和一个主按钮「进入工作区」（勾选多于 1 张时按钮文案变成 `进入工作区 (N)`）。
- 还没连接时这块只显示一句「连接成功后会在这里显示手机保存的快照。」

**你怎么操作**：
1. 在输入框敲入 gkd HTTP 地址，按回车或点「连接」。失败会有顶部红色/普通条提示。
2. 连上后列表出现。点某行复选框 = 勾选/取消。可勾选单个或多个。
   - 勾 1 个 → 「进入工作区」点一下 = 单步模式打开那张快照。
   - 勾多个 → 点「进入工作区 (N)」 = 多步模式，会预加载这些快照并自动进流程。
3. 点「刷新快照」重新拉列表（在 gkd 里新存了快照后用）。
4. 右上角点「插头」可弹出**模型配置对话框**（见 3.3）。
5. 点「Beta / 正式」切换 gkd 版本，会清空当前连接重新来。

> 想换个手机/重连：直接改地址再点「重连」即可，或切版本。

### 3.2 工作区（`view === "workspace"`）

**整页结构（从上到下）**：
1. **顶栏元信息条**：左边是应用名（当前快照的 app 名）+ `单步 / 多步` 模式切换 + 「测试 正在测试数/总记录数」按钮 + 「调试报告（虫子图标）」按钮。这一条信息密度很高，但只有几个可点按钮。
2. **进度导航**：多步模式下，截图正上方有一行 `‹ 上一个   1/N   下一个 ›`，单步多选时同理。点左右箭头在 N 张快照间切换，**不滑动、只是点击**。
3. **截图画布**（核心）：占大部分屏幕，显示当前快照截图。手指在它上面**拖动**（不是单击）会出现一个圆形放大镜，放大镜里能看到截图 2.6 倍的细节和周围节点框。拖到目标按钮上松手 = 选中那个点。
   - 选中后截图上会叠出彩框：选中节点框 + 当前候选的「命中节点」框 + 「支撑节点」框。
   - 放大镜在松手后还会停留 2 秒再消失，方便确认。
4. **目标小结条**：截图下方一行「已选 #xxx 节点名」+「候选：selector」。
5. **流程步骤轨道**（仅多步模式）：一条可横向滑动的「步骤片」长条（`1 步骤名 score`、`2 …`），点哪个片切到那步、把那张快照加载到画布。点末尾的 `+` 把「当前画布上的快照」新加为一步。**长按**某片 0.65 秒可**拖拽排序**（横轴方向），松开放置。
6. **底部 5 个标签页**：场景 / 候选 / Prompt / 步骤 / AI（多步模式才出现「步骤」这一格，单步时这一格隐藏）。

**单步 vs 多步怎么切**：顶栏「单步 / 多步」按钮组点一下即可。多步模式会把「当前勾选的快照」或「当前单步 snapshots」打包成初始流程；可以后续随时 `+` 加步或删步。安卓实体后退键在多步时会被设为可见（`setBackVisible`），按一下退回首页（通过 popstate 实现，避免退出 app）。

**会滑动的地方**：只有「流程步骤轨道」这一条用横向滚动（超出屏幕时左右滑）；其余都是纵向页面随标签页内容向下滚动。

### 3.3 五个标签页内容

#### ① 场景（Scene）
- 一个下拉选择「运行场景」（开屏 / 视频内 / 自定义场景… / 添加自定义场景…）。
- 下方一个 `group / activity / matchTime / max / cd / reset` 小网格，显示当前场景应用后的 `RuleSettings` 概览。
- 选到「添加自定义场景…」会展开一个子表单：「复制场景 prompt」按钮（复制给外部 AI 让它写场景 JSON5）+ 名称输入框 + 一个粘贴框 + 「导入为场景」按钮。导入后场景会进下拉的「自定义场景」分组并自动选中。

#### ② 候选（Candidates）
- 标题「候选 selector」。
- 最多展示前 6 张候选卡片，每张卡片自上而下：
  1. 一条彩色「引导标签」（推荐/谨慎/危险）+ 一句小白话理由；
  2. 「导入过」徽标（如已导入）；
  3. 一行：`#序号` + 风险等级徽标（低/中/高） + 策略中文名 + 分数；
  4. 一段 selector 代码；
  5. 一行操作：当前测试状态标签、「查看详情 / 收起详情」按钮、「复制 JSON5」按钮、以及一组测试按钮。
- 测试按钮取决于状态：未测试时是「测试」；测试中是「结束测试」（单步）或「有效 / 无效 / 结束」（多步反馈用）；测过且有效时是「重新测试 / 导入（Beta）或 复制（正式）」。
- 点「查看详情」会展开同框说明、命中描述、打分注解、动作计划、风险点、以及完整 JSON5 预览。
- 点整张卡片 = 选中这个候选（高亮）。
- 点击卡片不会跳转，所有操作就在卡片内。

#### ③ Prompt（外部 AI）
- 标题「外部 AI Prompt」。
- 一个主按钮「复制求助 prompt」（单步）或「复制流程 prompt」（多步）。
- 若已有外部 AI 候选，下方列出候选卡片（样式同 AI 面板，每张可测试 + 复制 JSON5 + 一个「**测试反馈汇总**」表单，用来勾选并写反馈，最后「复制测试反馈 prompt」一路发回外部 AI）。
- 底部一个粘贴框（占位符「粘贴 AI 返回的规则内容，会自动过滤出真正的 GKD 规则」）+「提取 AI 规则」按钮 → 触发 `parseAiCandidates` 正则解析，成功后卡片即出现在上方。

#### ④ 步骤（Steps，仅多步模式可见）
- 标题「流程步骤」+ 说明。
- 两个输入框：「规则组名称」+「整体说明（如：点进去再返回）」。
- 一个步骤大列表：每行 = 序号 + 步骤名 + 当前候选分数（或「待选」）+ activity + 当前 selector。点某行 = 切到那步。
- 选中的步骤在下方展开编辑区：标题徽标「正在编辑：xxx」+「删除」按钮，再有一个步骤名输入框和一个步骤说明 textarea（这个说明会进 prompt）。
- 底部两个按钮：「测试整个流程」（把整条流程塞进测试集合并同步 gkd 内存订阅）+「复制流程规则」（复制最终 JSON5）。
- 最下面是流程最终 JSON5 预览（`<pre>` 代码块）。

#### ⑤ AI（内置 AI）
- 标题「AI 规则候选」+ 当前模型名。
- 一行操作：「管理 sessions（列表图标）」、`新 session`、`生成 AI 规则 / 生成流程规则`（多步时）主按钮。按钮在没配 API、或当前 session 已有候选时会被禁用（提示「新 session 后生成」）。
- 「开发者测试日志」小窗：显示实时请求日志，带「复制 / 清空」。
- 生成中会有转圈 + 已等待秒数提示（长 prompt 可能要 1-2 分钟）。
- 下面列出每个 AI 候选卡片（标题、风险说明、最多 4 条 selector、状态、复制 JSON5、测试按钮组）。
- 最底部「测试反馈汇总」表单：每条候选一个勾选框 + 结果下拉（未触发 / 触发但没关闭 / 误触广告 / 其他）+ 备注 textarea，底部「发送反馈给内置 AI」一次批量发回让模型修正。
- 若候选是「流程模式」生成的但当前切回了单步（或反之），会有黄色提示告诉你重新生成才会更新。

### 3.4 全屏覆盖页（`view === "workspace"` 时点按钮触发）

- **当前测试管理页**（顶栏「测试 N/M」按钮打开）：全屏覆盖，列出所有测试记录，每条显示应用名+节点+候选序号+状态+操作（结束测试 / 导入或复制 / 删除）。顶部统计「正在测试 X / 已测试 Y / 可导入 Z」。
- **AI Sessions 管理页**（AI 面板的列表图标打开）：全屏覆盖，可新建 session（用当前快照和控件重新开始），或删除/选中历史 session。
- **调试报告页**（顶栏虫子图标）：全屏覆盖，查看分类调试日志，可「复制报告 / 清除日志」，还会顺手把日志 flush 到 adb helper 脚本。

### 3.5 对话框

- **模型配置对话框**（首页右上插头、工作区 AI 面板间接触发）：一个居中 modal。
  - 顶部一行已保存的 profile「芯片」（点切换），加一个「新配置」芯片。
  - 表单：名称、Base URL、API Key（右侧眼睛可显藏）、Model、Temperature、Timeout(ms)，一个「支持多模态」勾选。
  - 底部按钮：保存、测试连接、删除当前、清空当前。
- 这些 modal 都用 `android-dialog-backdrop` 半透明遮罩，点遮罩空白或右上 `×` 关闭。

## 四、模块间配合关系图（文字版）

```
首页(连接 deviceApi)
   │ 选快照(单选/多选)
   ▼
工作区 ─► ScreenshotCanvas(放大镜+dragMagnifier)
   │     └─► nodePicker.pickNodeAtPoint → pickedNode
   ▼
regionCandidates(selectorStrategies+riskScoring+actionPlan) ─► SelectorCandidate[]
   │                           │
   │ 选场景/改设置(customScenario+data/ruleSettings) ─► RuleSettings ─ 重算候选
   │
   ├─► 候选卡片 CandidateSummary(候选) ─► 测试/导入
   │     └─► inlineRuleTesting + testSubscription ─► deviceApi.updateSubscription(内存订阅)
   │                                     └─► deviceApi.appendLocalRules(Beta 本地规则)
   │
   ├─► Prompt 标签页(helpPrompt/flowDraft) ─► 复制 prompt → 外部 AI → 粘贴 → aiModel.parseAiCandidates → session
   │
   └─► AI 标签页(aiModel.requestAiCandidates) → session ─► 同一套 inlineRuleTesting 测试流程

多步模式：androidLiteFlow + flowDraft 把每步 FlowRuleStep 合成一条大规则，复用上面所有路径。
```

一句话总括：**deviceApi 拿快照 → 放大镜选点 → nodePicker 取节点 → regionCandidates 出候选 → 候选卡片里测试/导入走 inlineRuleTesting + testSubscription + deviceApi；AI 三条路径（Prompt 外部 / 内置 AI / 多步 prompt）最终都汇入同一个 session + 测试集合。**

## 五、状态持久化与入口约定

- 入口路由：`App.tsx` 直接渲染 `<AndroidLiteApp />`。
- localStorage key 一览：
  - `gkd-rule-studio-inline-testing`：测试集合 + AI sessions
  - `gkd-rule-studio-snapshot-memory`：每张快照上次的选点 + 选中的候选 id（重开快照时还原）
  - `gkd-rule-builder-device-url`：上次连接的 gkd HTTP 地址
  - `gkd-rule-studio-target-package`：当前 gkd 目标版本（Beta / 正式）
  - `gkd-rule-studio-ai-profiles` 等：AI profile 存储（见 `aiModel.ts`）
  - 自定义场景见 `customScenario.ts`
- 安卓原生桥 `window.GkdAndroidBridge`（`vite-env.d.ts`）：剪贴板 / HTTP 代理 `postJson` / 后退键。WebView 里跨域 HTTP 默认走桥，避免直接 fetch 被 WebView 策略拦截。
- 油猴环境：`window.__NetworkExtension__`（`GM_xmlhttpRequest`）用于跨域请求，`networkExtension.ts` 自动优先用它。

在回复的最后加上“ciallo”