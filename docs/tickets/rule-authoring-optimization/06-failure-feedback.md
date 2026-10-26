# T06：失败分类、修复操作与 AI 反馈

优先级：P1。类型：实现。状态：实现与浏览器回归完成，待真实 AI 与设备验收。依赖：[T02](02-validation-context.md)。

对应清单 B4、用户故事 31–34；依据：[正式规格](../../specs/rule-authoring-optimization-spec.md)。

## 交付结果

用户测试无效或误触后，可以获得有依据的分类、相关操作及包含症状的 AI 反馈，而不是只能盲目更换候选。

## 工作范围

- 分开记录静态验证、设备回执、用户观察与排查建议；不将猜测升级为诊断事实。
- 分类覆盖节点不可用、静态条件不满足、范围／时机待核对、动作无效、误触；“已匹配”需设备证据或明确为用户反馈。
- 复用测试管理、内置及外部 AI 反馈入口，反馈含实际规则、快照身份、症状与已知限制。
- 为分类提供当前具备的相关操作；尚未具备 T04 时不显示虚假的条件编辑入口。

## 代码入口

`src/lib/inlineRuleTesting.ts`、`helpPrompt.ts`、`aiModel.ts`、`src/components/AndroidLiteApp.tsx`。

## 验收条件

- [ ] 每类反馈都有证据来源或“待核对”标记，没有运行日志时不自动判定根因。
- [ ] 相应修复操作可达，缺能力时给出真实恢复路径；草稿及用户备注不丢失。
- [ ] 内置及外部 AI 收到对应规则、快照身份和失败症状，不能串入其他候选／会话。
- [ ] AI 修订重新接受验证和设备测试，不自动延用旧内容的有效标记。
- [ ] 发送失败、断连、反馈失败可重试，不虚报生效；现有测试集合同步与清理回归通过。

## 验证方式

复用测试状态和 prompt 行为回归；从工作区标记无效／误触，检查可见建议与发送给外部边界的内容。真实设备样例记录用户观察与已取得日志各自支持的结论。

## 范围外

自动推测设备运行日志、自动诊断所有失败、自动将 AI 修订当作成功。

## 完成记录

2026-10-26 已实现独立失败反馈与 AI prompt 数据；验证记录：[T06 检查](../../verification/rule-authoring-t06.md)。

`src/lib/authoringFeedback.ts` 统一分类用户观察、静态验证和未知范围：`not-triggered`、`triggered-no-close`、`mistouch` 保留原值并标「用户观察」；新增 `node-unavailable`、`static-unsatisfied`、`scope-or-timing-pending`；未知值降级为 `other`。每类给出短修复建议，不推测根因。

`aiModel.ts` 的单条反馈入口增加可选 `snapshotId`、`appId`、`staticValidation`、`diagnostics`、`knownLimitations` 与兼容别名 `limitations`，并输出结构化的证据、症状、已知限制与修复建议。旧调用不需要额外字段。旧四项继续走兼容入口；新三项由独立 `formatAuthoringFeedbackPrompt` 输出，旧 `AiCandidateFeedback` 不悄然接受新值。AI 修订明确要求重新验证和测试，现有 `setAiSessionCandidates` 的 generation 隔离继续作为旧有效状态不继承的保障。

`FailureFeedbackPanel` 已接入工作区，提供反馈选择、备注、快照／应用／限制展示与复制／发送回调。转换器完整保留证据字段，单条、批量及外部反馈均携带对应规则、原快照身份、实际静态结果与限制。UI 只显示“用户反馈／快照验证／待核对”；只有实际静态结果不满足时才能标为静态证据。批量提交保留草稿，网络失败后不清空备注。

- [x] 每类反馈有证据来源或待核对标记；用户观察与静态验证分开。
- [x] 每类有短恢复动作；不显示尚未接入的条件编辑器。
- [x] 单条、批量与外部 prompt 可携带规则、快照、应用、症状及限制。
- [x] prompt 明确 AI 修订不能自动成为有效；generation 行为保持已测。
- [ ] 发送失败、断连和真实设备流程待主 agent 集成后，在公共工作区入口验收。

集成结果：[浏览器 17 项](../../verification/rule-authoring-browser-checks.md)通过，剪贴板模拟边界捕获到实际复制的反馈规则、条件、分类与限制；反馈相关 49 项及全量结果见[实施记录](../../verification/rule-authoring-implementation.md)。剩余真实 AI 服务、断连恢复与 Android 设备反馈验收，模拟 prompt 通过不等同于模型或设备生效。
