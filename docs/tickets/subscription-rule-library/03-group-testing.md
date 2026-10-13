# T3：无快照的规则组逐组测试

关联规格：[#3](https://github.com/jjjj31/gkd-rule-studio/issues/3)。依赖 [T1／#4](https://github.com/jjjj31/gkd-rule-studio/issues/4)、[T2／#5](https://github.com/jjjj31/gkd-rule-studio/issues/5)。对应 S4。

GitHub ticket：[#6](https://github.com/jjjj31/gkd-rule-studio/issues/6)。实施状态以 GitHub Issue 为准。

Blocked by: #4, #5

## 交付结果

用户在规则库里连接 GKD 后即可测试所选完整规则组，手动判断有效或无效，并切换到另一组。测试不依赖快照、选点或 AI session，不影响复制与直接导入资格。

## 工作范围

- 订阅来源与版本、应用身份和 group key 构成测试项身份，保存开始时的规则内容；源刷新不会偷换正在测试的内容。
- 规则库同时测试一组，切换时移除上一组规则库测试；提供结束、有效和无效的操作。
- 使用 `updateSubscription`，把规则库测试并入现有当前测试集合的统一同步流程，保留现有生成候选测试。
- 完整组组内引用保持一致；遇到与其他测试组 key 冲突时正确分配并重映射，按名称匹配不能成为合并依据。
- 用户显式测试默认禁用组时只在临时 payload 启用，源配置和复制输出不被修改。
- 处理发送中、同步失败、断连和结束清理；成功发送与有效测试结果分别呈现。

## 代码入口与注意点

- `src/lib/inlineRuleTesting.ts`：现有测试状态及 `buildActiveTestSubscription`，需要支持没有快照和 AI session 的来源。
- `src/lib/testSubscription.ts`：现有合并与重编号需要核对组内引用。
- `src/lib/deviceApi.ts`：现有 `updateSubscription`。
- `src/components/AndroidLiteApp.tsx`：测试同步、当前测试管理与连接状态。

## 验收条件

- [ ] 没有快照和 AI session 时可连接设备并测试完整组。
- [ ] 切换 A → B 后，当前内存 payload 不再含 A；结束后移除 B，仍在测试的生成候选保持存在。
- [ ] 同名组和 key 冲突不会合并不同来源或破坏 `preKeys`、共享冷却／计数引用。
- [ ] 默认禁用组只在临时测试中启用，原始源数据与复制结果保持原设置。
- [ ] 同步失败／断连不显示已生效，重新连接或结束时能同步当前集合。
- [ ] 用户手动标记有效／无效；发送成功不自动标记有效；未测试也仍可复制、导入。
- [ ] 状态及 payload 回归测试覆盖切换、清理、冲突、失败和已有候选保留；支持目标的设备实测验证多步行为。

完成时记录实际 GKD 目标版本、测试步骤和观察结果。此 ticket 不读取或自动暂停 GKD 已装订阅。

## 实现进度

2026-10-13：本地实现已完成，工作分支为 codex/subscription-rule-library。类型检查、184 个项目测试、19 项 Firefox 浏览器流程检查和开发 APK 构建／签名检查通过。验证记录见 docs/verification/subscription-rule-library.md。

浏览器测试使用自造订阅与模拟 GKD 接口；Android WebView、真实 GKD 触发及本地规则回读尚待连接设备验证。Issue 在设备验收和代码合入前保持开启。
