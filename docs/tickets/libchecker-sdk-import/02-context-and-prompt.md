# T2：SDK 页面证据、版本关联与共享 prompt

关联规格：[#8](https://github.com/jjjj31/gkd-rule-studio/issues/8)（本地正文：`docs/specs/libchecker-sdk-import.md`），对应 S3 及 S4 的规则生成路径。状态：已实现；上下文与 prompt 测试、评分回归通过，见 `docs/verification/libchecker-sdk-import.md`。依赖 T1。

Part of #8

Blocked by: #9

GitHub ticket：[#10](https://github.com/jjjj31/gkd-rule-studio/issues/10)。实施状态以 Issue 为准。

## 交付结果

同一个应用 SDK 上下文供界面与规则生成消费：分别呈现导入清单和当前页面证据，支持多个 SDK，正确处理包名与版本；单步、多步、内置 AI 和外部复制使用一致语义。

## 工作范围

- 提供纯函数 `resolveAdSdkContext(snapshot, profile?)` 或等价接口，不在该函数读取本地存储、联网或发送请求。
- 只关联精确 `appId`，按 spec 比较版本码／版本名；版本未核对显式标记，版本失配的档案名单不进入 prompt，页面证据仍独立收集。
- 从当前 Activity 和节点 `id`／`vid`／`name` 收集全部 SDK 匹配，保留 SDK id、来源字段、节点编号／Activity 和命中特征。复用现有签名数据，不把首个 SDK 当作页面唯一 SDK。
- Activity／组件类名使用前缀及点分隔规则；`ad_area`、`hotarea` 等泛化资源词不单独确认 SDK。清单存在、页面不存在与清单／页面不同都保留真实状态。
- 清单不影响候选评分和验证，不凭导出组件填入 `activityIds` 或编造按钮；现有目标控件加分与遮罩扣分行为通过回归测试保留。
- 在 `buildHelpPrompt` 和 `buildFlowHelpPrompt` 的每一步接入同一上下文格式，支持不内嵌节点树的复制路径。每 SDK、每类来源最多两条证据，稳定排序，不带其他应用资料。
- 补充 prompt 限定：静态清单仅代表包含 SDK，以当前节点树为定位依据；版本未知带标记，版本失配省略档案名单，不声称确定 SDK 版本或当前广告提供方。
- 当前工作区数据变更供新生成使用；已有 AI session 的 `originalPrompt` 与候选保持不变，沿用现有生成、反馈和测试流程。

## 代码入口与风险

- `src/data/adSdkSignatures.ts`：当前 `detectAdSdkInSnapshot` 只返回首个 SDK。可新增收集接口，避免无理由破坏原有单结果接口与测试。
- `src/lib/helpPrompt.ts`、`src/lib/flowDraft.ts`：共享单步／多步 prompt 入口。
- `src/components/AndroidLiteApp.tsx`：`singleAiPrompt`、`flowPrompt`、复制路径和 `generateAiRules`；内置 AI 已使用共享 prompt，不需要另一套 SDK 拼接逻辑。
- `src/lib/aiModel.ts`：既有消息组装及反馈保留 `originalPrompt`，避免导入后悄悄改变已有 session。
- `src/lib/riskScoring.ts`、`src/lib/selectorStrategies.test.ts`：静态清单不得提升危险热区或改变现有候选评分。必要时新增评分不受清单影响的行为回归。

## 验收条件

- [ ] 同名不同包名不关联；版本相符、失配、缺失与字符串版本码比较均正确，输入档案／快照不被修改。
- [ ] 清单含穿山甲和优量汇、页面只有穿山甲时正确区分；页面快手不在清单中也保留。
- [ ] Activity 可单独贡献 SDK 页面特征；多 SDK 页面全部保留；普通 `ad_area`／`hotarea` 节点不能单独标记 SDK。
- [ ] 只有静态 SDK 的普通页面，候选分数与无档案时相同；真实跳过与广告遮罩现有回归继续通过。
- [ ] 单步／多步、内置 AI／外部复制和省略节点树路径采用同一证据语义；多应用流程逐步隔离背景信息。
- [ ] prompt 中无完整导出、无关应用或无关设备信息，证据条数及顺序可预测；版本失配只显示状态而不泄漏过时名单。
- [ ] 不导入可正常生成；导入或删除不改写既有 session、候选与测试结果；新 session 使用更新后的背景。

## 验证与完成记录

运行目录：仓库根目录。Shell：PowerShell。

```powershell
npm run typecheck
npm test -- src/data/adSdkSignatures.test.ts src/lib/flowDraft.test.ts src/lib/aiModel.test.ts src/lib/selectorStrategies.test.ts
```

另运行新增上下文／prompt 测试，覆盖上述反例与各调用路径；不向真实 AI 服务发送测试请求。完成时提供一份脱敏的单步／多步 prompt 示例，证明静态名单和页面特征被分开表达，并记录是否新增或保留了检测接口。
