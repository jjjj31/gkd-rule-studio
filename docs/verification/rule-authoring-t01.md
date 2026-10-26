# T01 规则层验证本地验收

日期：2026-10-26。Ticket：[T01](../tickets/rule-authoring-optimization/01-rule-validation.md)。目标：Rule Studio 当前 Beta 目标与项目所用 `@gkd-kit/selector@0.5.23`；运行时参考 fork `jjjj31/gkd@f84b8415`（1.12.1）及官方 GKD API/选择器文档。

## 已实现

- 单选择器继续交给官方解析/匹配包；规则层组合使用“`matches` 全约束、末项目标”，前面各项命中节点仅作支持上下文。
- 支持 `anyMatches`、`excludeMatches`、`excludeAllMatches`、规则/组 `activityIds`、`excludeActivityIds`、显式 `@`。
- 必需条件缺失、非法表达式、Activity 不匹配、排除条件命中均不提供可执行点击目标。group/rule 上任一已接受版本字段（`versionCode` / `versionCodes` / `versionName` / `versionNames` 及排除版本字段）使整体为 `partial`，原值保留。
- `enable: false` 的组或规则明确 `unsatisfied`、零目标；其他无法识别的 enable 值保持 `partial`，不冒充启用。
- 内置策略在补全动作计划后按最终 `rule` 重新验证；评分、fallback、去重、画布共用同一结果。
- AI 规则规范化保留分支/排除字段；同一规则内 `matches` 按 AND，App 内多条独立规则按 OR。存在 `invalid`/`partial` 时保守不显示点击目标；否则任一规则 `satisfied` 即显示满足规则的目标，全部 `unsatisfied` 才整体未命中。

## 验证结果

运行目录：仓库根目录；Shell：PowerShell。

```powershell
npm test -- --reporter=dot
npx tsc -b --pretty false
adb devices -l
```

2026-10-26 实际结果：32 个测试文件、308 项测试全部通过；验证/AI/多快照 86 项定向测试全部通过；`npx tsc -b --pretty false` 和 `git diff --check` 通过。

T01 重点回归包括：标题/按钮顺序、标题或按钮缺失、非法必需表达式、显式 `@`、支持节点范围、`anyMatches` 分支、两类排除、Activity 与组继承、group/rule 版本字段 partial 且原文保留、禁用组/规则、畸形 enable、内置最终规则验证、同一规则的 `matches` AND、App 多独立规则 OR、AI 聚合和大 App 规则身份。独立规则 A 命中而 B 不命中时必须保留 A 的目标；该回归已实际通过。AI 的 selector 字段只接受字符串或全字符串数组，`null` 当作未设置，畸形值拒绝候选。

## 未验收

- 当前没有连接 Android 设备，本机 8888 端口无监听；未在 GKD 1.12.1 Debug/Beta 上把代表性 `matches`、分支、排除和 `@` 规则实际启用并观察最终点击节点。
- 没有验证 GKD 事件节点查询范围、`matchRoot`、冷却、次数、`preKeys`、动态页面时序；这些仍需设备/运行时证据。
- Android WebView 工作区的布局、画布最终高亮和 T02/T05 展示由主 agent 集成后复核；本记录只证明共享静态验证及现有回归。
