# T01：修正规则层验证与最终点击目标

优先级：P0。类型：修复。状态：本地实现完成，待设备验收。依赖：无。

对应清单 A1、用户故事 1–7；依据：[正式规格](../../specs/rule-authoring-optimization-spec.md)。

## 交付结果

用户看到的点击目标、命中数、风险评分、首选排序和画布高亮遵循同一份规则层验证结果；必需上下文缺失时不会显示规则可执行。

## 工作范围

- 核对实际支持的目标 GKD 版本与官方规则字段语义；复用官方单个选择器解析／匹配能力，补齐规则层组合判断。
- `matches` 全部成立时，只把最后一项规定的目标计为点击目标；前项匹配作为上下文，不加入点击目标数。
- 对已接受的分支、排除条件、显式 `@` 与规则组继承完整处理；尚不支持的语义显式返回未完整验证，保留原文。
- 内置策略与 AI 候选共用结果，贯通评分、排序、计数和画布；不修改默认策略优先级来掩盖计数问题。

前序已复现：标题与取消按钮都存在时，当前返回两个点击目标；标题移除后，仍返回按钮命中。这是本地验证复现，尚未完成设备对照。

## 代码入口

`src/lib/selectorMatcher.ts`、`selectorAdapter.ts`、`selectorSerialize.ts`、`selectorStrategies.ts`、`riskScoring.ts`，以及候选验证结果的类型与画布调用方。先通过图谱确认实际调用方和相关测试。

## 验收条件

- [x] 标题与按钮都在时，点击目标只有最后一项规定的按钮，标题作为上下文。
- [x] 标题缺失、按钮缺失或必需表达式非法时，不把部分命中显示为规则可执行。
- [x] 多目标、显式 `@`、已支持分支／排除条件与继承语义按目标版本一致处理。
- [x] 内置与 AI 候选计数一致；评分、排序、画布不再各自解释命中结果。
- [x] 未支持字段不被删除，结果不冒充完整验证；现有单项规则、测试与交付行为回归通过。
- [ ] 代表性样例完成实际目标 GKD 对照，记录版本；未完成时标为待设备验收。

## 验证方式

沿用选择器匹配、序列化、策略的现有回归，先将上述两项复现转成行为测试。通过工作区检查最终计数与高亮；设备对照断言实际目标，而非只检查 HTTP 成功。运行相关测试与类型检查。

## 范围外

新选择器解析器、规则语言变更、条件编辑界面及重写候选策略。

## 共用验证契约

- `validateAppRuleAgainstSnapshot(snapshot, app): SelectorValidation[]`：按 group/rule 声明顺序返回每条规则的结果，处理规则组继承的 `activityIds` / `excludeActivityIds`。
- `validateAiCandidateAgainstSnapshot(candidate, snapshot)`：保留旧签名，汇总完整 AI/App 规则。同一规则的 `matches` 是 AND；App 内独立规则是 OR。任一规则 `invalid` / `partial` 时整体保守且不暴露目标；否则任一规则 `satisfied` 即聚合这些已满足规则，全部 `unsatisfied` 才整体未命中。
- `SelectorValidation.status`：`satisfied`、`unsatisfied`、`invalid`、`partial`；缺省仅用于旧构造的对象。
- `diagnostics?: string[]`、`excludedMatches?: string[]` 为增量字段；原有 `hitCount`、`clickNodes`、`supportNodes`、`unparsedMatches` 保持。

实现边界：静态全树验证不等于 GKD 事件节点范围、运行时次数、冷却或前置 `preKeys` 已验证。版本条件（`versionCode` / `versionName`）暂时标为 `partial`，原文不删除。

## 完成记录

2026-10-26 完成本地代码、回归与全量测试。T02/T03/T05 工作区集成由主 agent 负责；验收见 [`docs/verification/rule-authoring-t01.md`](../../verification/rule-authoring-t01.md)。设备对照未完成：`adb devices -l` 无设备，8888 端口无监听。
