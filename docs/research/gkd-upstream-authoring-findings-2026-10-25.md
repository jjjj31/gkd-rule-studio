# GKD 可视化规则编写讨论与 Rule Studio 对照（2026-10-25）

调查范围：`fktpp2022/gkd#10`、父议题 #1 及设计规格、录制相关 #11–#20，以及报告引用的 4 个代表性 `gkd-kit/gkd` 上游案例。下面把作者的设计决定、上游问题证据、本仓库源码核对及改进建议分开记录。此次只新增研究文档，没有修改产品代码。

## #10 与相关议题说了什么

- [#10](https://github.com/fktpp2022/gkd/issues/10) 是现有工具调研：官方 inspector 已有截图选点、重叠消歧、属性查看、匹配计数与规则生成；主要缺口在手机操作、持久保存和容易理解的完整制作流程。报告还比较了 MacroDroid、Tasker、Automate、AutoX、Appium 与示范编程研究。结项代表研究完成，不代表产品功能交付。[完整报告](https://github.com/fktpp2022/gkd/blob/research/local-rule-authoring-prior-art/docs/research/local-rule-authoring-prior-art.md)
- [父议题 #1](https://github.com/fktpp2022/gkd/issues/1) 的产物明确是交互设计规格。#2 研究选中节点如何变成选择器；#3/#9 决定先截图再编辑的入口；#4 设计已有规则识别和重复保存处理；#5 设计“文字等于/包含、ID、可点击、位于某容器内”等条件；#6 为纸面原型；#7 裁剪首版范围；#8 汇总规格。[最终规格](https://github.com/fktpp2022/gkd/blob/wayfinder/guided-local-rule-authoring/docs/specs/guided-local-rule-authoring.md)
- 研究与最终取舍不同：#10 建议模板、试运行和失败原因解释，但 #7 首版暂不做模板、真实执行自测或深入失败诊断，只做匹配预览。#5 设计了条件分支模型，但最终首版不提供 OR 编辑；不应把研究建议全当成首版承诺。[#5](https://github.com/fktpp2022/gkd/issues/5)、[#7](https://github.com/fktpp2022/gkd/issues/7)
- [#11](https://github.com/fktpp2022/gkd/issues/11) 后续探索“录制一次自己的点击”，只替代选目标步骤，不是宏录制或多步骤脚本。#12/#20 调查平台限制；[#14](https://github.com/fktpp2022/gkd/issues/14) 的模拟器实验观察到原生 View/WebView 点击可产生事件，而 Compose 用户点击、部分自行消失控件没有事件。#18 决定限定范围纳入规格，#19 更新文档；仍保留厂商系统、真实手指、旧 Android 的验证缺口。[#18](https://github.com/fktpp2022/gkd/issues/18)、[#19](https://github.com/fktpp2022/gkd/issues/19)

## 本仓库已经具备什么

核对的是当前工作区，含已有未提交修改；不是只读 README 后推定已经实现，也没有在此次重新验收所有 Android 功能。

| 能力 | 源码证据与边界 |
|---|---|
| 截图定位与同区域候选 | `src/lib/nodePicker.ts`、`src/lib/regionCandidates.ts`：按坐标选节点，结合父/子及同区域节点生成候选；现有算法已有消歧基础，但手机端尚未见独立“你指的是哪个控件”选择面板。 |
| 候选生成与静态匹配 | `src/lib/selectorStrategies.ts` 提供 14 种策略；`selectorMatcher.ts` 委托官方 selector JS 包匹配单个表达式；`riskScoring.ts` 已考虑命中数、活动页面、热区、危险文案。 |
| 真机测试与反馈 | `src/lib/inlineRuleTesting.ts`、`src/components/AndroidLiteApp.tsx`：多候选同步内存订阅，记录有效、无效、误触，并支持反馈给 AI。不是自动证明目标动作正确。 |
| 持久导入 | `src/lib/deviceApi.ts:106`：已有 fork 的 `localRules/append`，默认请求 selector 去重；官方目标使用复制路径。这不同于“读取现有启用规则，判断已覆盖目标并提供编辑/替换”。 |
| 场景化范围与时机 | `src/data/ruleSettings.ts`：已有开屏、进入页面、周期弹窗等预设，分别配置 activity 与匹配时间；不应为了套用对方首版而删去这些能力。 |

## 优先建议与一项已复现偏差

1. **先核对完整规则的静态预览。** `src/lib/selectorMatcher.ts:30` 和 `:54` 都逐项匹配 `matches` 后合并节点。官方语义是所有项成立后点击最后一项的目标，而不是把所有项的节点都作为点击目标。[官方 RawRuleProps](https://gkd.li/api/interfaces/rawruleprops#matches)
   - 此次用 Vite 的模块加载入口直接调用当前函数，构造两个兄弟节点 Context 与 Cancel，输入 `matches: ['[text="Context"]', '[text="Cancel"]']`。
   - 两者存在：当前返回 `hitCount=2, clickIds=[1,2]`；按规则语义，点击目标应只有最后一项的 Cancel。
   - 移除 Context、保留 Cancel：当前返回 `hitCount=1, clickIds=[2]`；按规则语义，此规则不应满足。
   - 这是对本地预览的实际复现，不是 Android 引擎实验；会影响包含上下文的候选计数、风险排序与高亮。`selectorStrategies.ts:126` 的 `exactTextWithContext` 会产生这类输入。此次未修复。
2. **增加可编辑条件与目标确认。** 复用现有生成结果，显示“文字包含跳过”“只在当前页面”“点击外层按钮”等摘要；支持改/删条件、补选容器，并实时更新计数与范围。现有手机候选卡片仍直接显示 selector，见 `AndroidLiteApp.tsx:4915`。不需要重做整套生成器。[#5](https://github.com/fktpp2022/gkd/issues/5)
3. **补失败诊断和已有规则提示。** 利用现有测试结果区分：树里没有目标、范围不满足、匹配窗口结束、命中但动作无效、误触。读取本地已启用规则需要 GKD 接口支持；当前客户端只提供 append，不能把写入去重当作覆盖检测。跨订阅扫描可后置。[#4](https://github.com/fktpp2022/gkd/issues/4)
4. **录制与悬浮入口后置。** 这些需要 GKD 原生服务或额外接口配合，当前 Rule Studio 的 WebView + HTTP 架构不能直接搬用 Kotlin 实现；优先复用截图入口及现有测试链路。

不照搬的默认值：对方的 text 优先、activity 留空、fastQuery 不自动开启，主要服务其通用首版与界面简化目标；本仓库面向广告跳过，已有资源 ID 优先、场景限制和优化判断。应基于重复控件、动态倒计时、假关闭按钮等样本验证优劣，不能仅凭研究建议改掉默认算法。[#2](https://github.com/fktpp2022/gkd/issues/2)、[#7](https://github.com/fktpp2022/gkd/issues/7)

以下保留上游问题的代表性证据。

## 结论

1. **AI 辅助规则编写目前仍是开放提案，不能当作 GKD 已有能力。** #1484 由维护者 `lisonge` 提出，尚无截止日期、分配人、关联 PR 或已合并实现；唯一评论只是外部项目自荐。[#1484](https://github.com/gkd-kit/gkd/issues/1484)
2. **高风险的“跳过/关闭”泛文本必须结合排除条件与匹配起点设计。** #669 中维护者确认：匹配从触发事件节点开始，若排除条件的节点在它的查询范围外，就不会生效；应使用 `matchRoot` 或让排除选择器从根节点定位。这不是统一修复，而是规则语义/编写方式。[#669](https://github.com/gkd-kit/gkd/issues/669#issuecomment-2239441288)
3. **无障碍树不能保证等同于用户看到的界面。** 维护者明确把 #662 解释为目标应用提供的无障碍节点与实际渲染不一致，节点可能缺失或错位；Shizuku 不负责取节点信息。后来社区给出的坐标补救选择器实际点到了错误入口，进一步说明缺失节点不能用“猜一个节点”来伪装可靠。[#662](https://github.com/gkd-kit/gkd/issues/662#issuecomment-2241449800)
4. **快照可能捕获到界面变化后的状态，耗时属于节点采集本身。** #1037 中维护者说明 `fastQuery` 只占约 71 ms，而全量节点收集耗时约 4.3 s，因此 5 秒广告结束时才保存出首页快照；该问题被标为 `not planned`。[#1037](https://github.com/gkd-kit/gkd/issues/1037#issuecomment-2966736953)

## 案例与证据

| 上游案例 | 事实与作者观点 | 当前状态 / 对本仓库的含义 |
|---|---|---|
| #1484 AI 助手（2026-10-14） | 维护者描述的**提案目标**是：用快照、截图框选、自然语言生成或修改 GKD 规则，降低编写门槛。没有定义输入协议、模型、校验方式或误触防护。 | 2026-10-25 仍 `open`，无 assignee、项目或里程碑，comments=1，body 之外无技术回复。桌面端已有的截图/策略/JS 匹配/真机导入与测试可视为产品基础，但“AI 已解决生成与验证”没有上游依据。 |
| #669 排除匹配仍触发（2024-07） | 用户提供了 `excludeMatches` 与开屏规则仍触发点击的日志。维护者结论：查询默认从**事件节点**开始；排除目标在事件节点范围之外时匹配不到。处理方式是 `matchRoot: true` 从根查询，或把排除项写成可回溯根节点的关系。[作者回复](https://github.com/gkd-kit/gkd/issues/669#issuecomment-2239441288) | 2024-07-20 以 `not_planned` 关闭；关闭不代表语义已变更。生成器应显示/保留 `matchRoot`、`excludeMatches`、`activityIds` 等作用域条件，并在快照中验证“危险页面也被考虑”，不能只因目标 selector 唯一命中就判安全。 |
| #662 无法捕获控件（2024-07） | 用户看不到“分类”等实际界面内容。维护者先判断目标应用的无障碍信息不完整；随后明确是“提供给系统的无障碍节点与实际渲染**不对应**”，并称这属于目标应用的 bug。[维护者说明](https://github.com/gkd-kit/gkd/issues/662#issuecomment-2229987927)、[进一步说明](https://github.com/gkd-kit/gkd/issues/662#issuecomment-2241449800) | issue 以 `completed` 关闭且标了 `wontfix`。后续尝试的 `[vid="imgclose"]` 被用户反馈实际点进“查看详情”，说明坐标准备并不能证明节点语义正确。工具应把“仅凭截图可点”和“无障碍树可稳定匹配”分开呈报；树中缺失/错位时明确阻止自动写成高置信度规则。 |
| #1037 快照耗时过长（2025-06） | 用户观察到广告页点击快照，5 秒倒计时结束后才完成，保存结果变成了首页。维护者日志说法：704 个节点、总耗时 4377 ms，其中节点收集 4306 ms、`fastQuery` 71 ms；并称某些应用获取全部节点很慢、“无解”。[维护者解释](https://github.com/gkd-kit/gkd/issues/1037#issuecomment-2966736953)、[耗时数据](https://github.com/gkd-kit/gkd/issues/1037#issuecomment-2966791063) | 同月以 `not_planned` 关闭。此案证明“快照原页成功”不能等价于“规则在实时页面会及时匹配”；需要记录采集起点与结束时的 app/activity/界面指纹，变化则提示重新采集，并把运行时诊断与静态快照验证分开。 |

## 与本仓库相关的取舍

- **条件 chips**：把 `activityIds`、`matchRoot`、`excludeMatches`、`matchTime` 等作为显式、可编辑的安全条件呈现，避免只编辑一个“看起来唯一”的 selector。`#669` 支持这项必要性。
- **重叠目标确认**：快照唯一命中只能说明当前树的静态唯一性。对父/子节点、关闭图标、广告卡片等重叠目标，显示候选与点击范围，要求用户在写入前确认。`#662` 的误点更接近语义错位，不能用一个自动抬父规则兜底。
- **完整规则匹配与失败诊断**：至少区分“快照过期/页面已变”“无障碍树缺节点或错位”“应用/activity 上下文未匹配”“规则条件未满足”。前两者有 #1037 与 #662 的一手证据。
- **AI 方案的边界**：可以让 AI 解释、提出候选和条件，但不应把自然语言生成视为验证。沿用官方 selector JS/真机匹配，给候选附带命中范围、上下文条件、采集稳定性与失败原因。

## 方法说明

通过已连接的 GitHub 工具读取 issue 正文、评论与状态，并用 GitHub API 核对 `gkd-kit/gkd` 的 `main` 分支与目录树；实现状态按 2026-10-25 本地调查时点陈述。上面的“维护者说明”是作者陈述或基于其日志的判断，除源码与测试另行验证外，不把 issue 讨论自动升级为已交付功能。
