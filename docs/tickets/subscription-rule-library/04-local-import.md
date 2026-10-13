# T4：无测试门槛的单组导入与固定副本记录

关联规格：[#3](https://github.com/jjjj31/gkd-rule-studio/issues/3)。依赖 [T1／#4](https://github.com/jjjj31/gkd-rule-studio/issues/4)、[T2／#5](https://github.com/jjjj31/gkd-rule-studio/issues/5)；无需等待 T3 的测试状态。对应 S5。

GitHub ticket：[#7](https://github.com/jjjj31/gkd-rule-studio/issues/7)。实施状态以 GitHub Issue 为准。

Blocked by: #4, #5

## 交付结果

用户选中订阅中的完整规则组后，可直接追加到支持本地规则接口的 GKD Beta，不必先测试。正式版始终能复制完整片段手动添加。生成器留存导入时内容、来源和版本记录。

## 工作范围

- 使用 `appendLocalRules` 追加所选组及对应应用信息，为外部订阅建立可直接导入的入口。
- 外部组不受生成候选 `canImport` 门槛限制；原有生成候选行为保持现状。
- 一键导入前检查连接和接口可用性；正式版或接口缺失时给出手动添加说明及复制入口。
- 保留组内步骤、公共执行字段、原始默认开关；测试时的临时 enable 覆盖不进入固定副本。
- 根据实际响应反馈新增／跳过数量；成功后保存固定副本与来源元数据，记录失败时区分设备写入与本地记录结果，避免诱导用户盲目重复写入。
- 源刷新或删除只影响规则库，不更新已写入 GKD 的副本与其来源记录。
- 实测 GKD fork 的 key 改写、字段保留及去重行为；若服务端无法保真，明确记录并处理限制后再完成，不宣称现有接口已经保证完整性。

## 代码入口与已知风险

- `src/lib/deviceApi.ts`：`appendLocalRules` 当前携带 `dedupe: true`，接口位于外部 GKD fork。
- `src/components/AndroidLiteApp.tsx`：现有 `importInlineItem`／`saveInlineItemToLocalRulesBeta` 检查 `canImport`，不能原样套用到未测试的外部组。
- `src/lib/testSubscription.ts`：现有导入记录主要跟踪选择器，没有订阅来源／版本；组名或 key 合并及重编号不保证外部组语义。
- `src/lib/gkdTarget.ts`、`src/lib/clipboard.ts`：目标分流和复制路径。

## 验收条件

- [ ] 未测试组在支持接口的已连接 Beta 中可一键导入；原生成候选测试门槛不变。
- [ ] 正式版、未连接与接口缺失状态说明准确，完整片段复制始终可用。
- [ ] GKD 端回读或编辑器核对，导入后的组内引用、公共参数、扩展字段、默认开关与所选原内容一致；命名空间重映射保持等价。
- [ ] 不同来源的同名组不在客户端合并；重复请求、接口失败和全部跳过都反馈真实结果。
- [ ] 记录来源链接、订阅 id／名称／版本、包名、原 group key、实际导入内容及时间；重启后可读取记录。
- [ ] 源刷新／删除不改变已有固定副本；新版追加不被描述成覆盖旧版。
- [ ] 设备成功而本地记录失败时有清楚提示，保留可恢复的结果，不自动重发追加请求。
- [ ] 使用自造多步组做 payload／状态回归测试，并在支持的 GKD fork 实测；留下实际版本、回读结果、验证命令和限制说明。

完成依赖设备写入完整性的验证结果。此 ticket 不添加本地规则删除、自动覆盖或源更新同步接口。

## 实现进度

2026-10-13：本地实现已完成，工作分支为 codex/subscription-rule-library。类型检查、184 个项目测试、19 项 Firefox 浏览器流程检查和开发 APK 构建／签名检查通过。验证记录见 docs/verification/subscription-rule-library.md。

浏览器测试使用自造订阅与模拟 GKD 接口；Android WebView、真实 GKD 触发及本地规则回读尚待连接设备验证。Issue 在设备验收和代码合入前保持开启。
