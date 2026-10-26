# T04 条件编辑实施与集成验收

日期：2026-10-26。Ticket：`docs/tickets/rule-authoring-optimization/04-condition-editor.md`。

## 本分支交付

- `src/lib/conditionEditor.ts`：支持子集完整反解、条件重建、统一序列化、完整 AppRule 验证、重新评分、倒计时稳定化和内容 ID。
- `src/components/ConditionEditor.tsx` 与 `ConditionEditor.css`：文本条件、类型、clickable/visible、父子或相邻上下文、快照节点选择、实时预览、应用／取消、高级 JSON 与复制。
- `src/lib/conditionEditor.test.ts`：13 项公开行为回归。

组件接口：`snapshot`, `candidate`, `onPreview?`, `onApply(candidate)`, `onCancel?`。父组件传入稳定的 `setState` 风格 `onPreview`；取消和应用都先同步回放对应候选，再调用父回调。

## 已自动验证

运行目录：仓库根目录。Shell：PowerShell。

```powershell
pnpm test -- src/lib/conditionEditor.test.ts
```

2026-10-26 结果：13/13 通过。覆盖：

- 支持 AND 子集的 plan → 表单 → 新 plan/rule 完整往返；父子点击目标正确。
- 引号、反斜杠、中文、动态倒计时；类型注入被拒绝。
- 复杂操作符、多段链、未知执行字段、plan/rule 或 rule/actionPlan 不一致时整条进入只读高级 JSON。
- 完整规则验证：不匹配 Activity 与零命中均不产生可应用候选，但仍显示验证诊断。
- 编辑后内容 ID 可复现且随条件变化，验证和风险重新计算。

新文件还通过项目 `tsconfig.app.json` 的过滤式类型检查，没有本 ticket 文件报错。全仓库 `pnpm run typecheck` 当时被并行改动的 `src/lib/candidateIdentity.test.ts` 既有类型错误阻断，因此不能声称全仓库通过。

## 主 agent 集成检查

1. 在工作区把组件接到候选编辑入口，`onPreview` 使用稳定回调；将返回候选同时用于高亮、验证计数、应用和后续复制／导入。
2. 确认取消后父状态恢复原 `selectedCandidate`，组件卸载后原高亮仍保留；编辑前被选中的候选在新草稿无效时不继续冒充可执行。
3. 设备上复核：新增父/子与相邻上下文、最终 `clickNodes` 指向点击目标、多命中提示、零命中提示、实时预览和高级 JSON 复制。
4. 主状态模块负责让旧候选测试结果失效，并让测试、复制、导入读取编辑后的同一 candidate。纯组件已换新 ID，但未修改测试资格状态。
5. 若 T01 同伴的共享验证 API 改名或签名变化，更新 `conditionEditor.ts` 的 import，再跑 ticket 测试；不得退回只验证 typed plan。

## 未验证范围

没有浏览器交互截图或真机证据；本次没有修改 `AndroidLiteApp`、类型、`selectorMatcher`、`ruleDraft`、`inlineRuleTesting` 或其他 agent 文件。设备端 T03 再次选点集成、父工作区状态与剪贴板桥的最终界面验收留待主 agent。
