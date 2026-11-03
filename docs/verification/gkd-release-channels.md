# GKD 正式版与测试版路径

日期：2026-10-30。目标是保留两条官方版本路径，替换原先把 `.debug` 自改版当作 Beta 的判断。

## 当前行为

| 路径 | 当前对应版本 | 快照匹配 | 最终保存 |
| --- | --- | --- | --- |
| 正式版（默认） | 官方 1.12.x | 保留 `@gkd-kit/selector` 0.5.23 | 复制规则后在 GKD 手动添加 |
| 测试版 | 官方 1.13.0-beta-1 / beta-2 | 单独使用 `@gkd-kit/selector` 0.6.1 | `POST /api/appendRules` 追加到本地规则 |

两条路径使用相同界面和规则数据结构，按包名与 `versionName` 区分。官方包名同为 `li.songe.gkd`，不再以 `.debug` 判断测试版。缺失版本信息、连接版本不符或连接到自改版时拒绝建立该路径的连接。旧包名选择记录不自动迁移成官方测试版，首次默认正式版；旧固定副本历史保留，显示为旧版自改 GKD。

测试版追加请求使用 `subsId: -2`、`groupType: 2`、目标 `appId` 和完整应用规则 JSON 字符串 `source`。校验返回的规则组及规则数量，保持原规则编号和引用，不使用旧 fork 的重新编号和按选择器去重逻辑。重复追加会产生副本；响应丢失时不自动换通道重试，提示先在 GKD 核对。

截图按文件头识别 PNG/WebP，前端预览和 Markdown 导出传递实际格式。归一化快照保留 GKD 版本和设备元数据，使用对应引擎。

新版引擎按需加载，原有引擎保持独立。官方 `regex-wasm` 二进制随应用内联，构建插件仅替换宿主加载入口，保留官方正则实现，使 Android `file://` 分析页无需联网加载 Wasm。旧 WebView 不支持新版 Wasm 时，加载测试版引擎会明确提示更新 WebView，不退回旧引擎伪造测试结果。

## 验证

- TypeScript 类型检查和生产 Web 资源构建通过。
- 前端自动测试覆盖：同包名版本区分、拒绝错误连接、默认路径及持久化、官方追加请求和返回值、完整规则引用保留、HTTP 200 业务错误、不重放追加、两代选择器、父子节点及字符串方法、PNG/WebP 和导出链接。
- Android `testDebugUnitTest` 通过，`ScreenshotFormatTest` 的 PNG/WebP 与无效数据校验通过。
- 历史独立分析资源曾通过无网络环境中的两代引擎检查；MCP 资源和对应验收现保存在 MCP 独立分支，本分支使用 Web 资源验证。

运行目录为仓库根目录，Shell 为 PowerShell：

```powershell
pnpm test
pnpm run typecheck
pnpm run build
pnpm run test:android
```

## 边界

本次未安装 APK，未执行两版 GKD 的真机导入。HTTP 行为由模拟测试和已发布版本源码核对；静态命中不等于手机实际效果有效。全局规则编辑与官方读取/替换/删除接口不在本次实现范围内。

官方测试版没有自改版的 `/api/getActionLogs` 和 `capabilities` 扩展。MCP 及其扩展接口适配保存在独立分支，不属于本分支的交付范围。

当前正式版路径面向 1.12.x；未来正式版升级到新引擎时，应重新核对版本适配，不能仅凭“正式版”标签推断引擎版本。

## 一手依据

- [官方 beta-1 发布说明](https://github.com/gkd-kit/gkd/releases/tag/v1.13.0-beta-1)
- [beta-2 订阅 HTTP 路由](https://github.com/gkd-kit/gkd/blob/v1.13.0-beta-2/gkd-app/src/commonMain/kotlin/li/gkd/app/network/inspection/SubscriptionRoutes.kt)
- [beta-2 本地订阅编号](https://github.com/gkd-kit/gkd/blob/v1.13.0-beta-2/gkd-db/src/commonMain/kotlin/li/gkd/db/SubscriptionIds.kt)
- [beta-2 截图文件格式](https://github.com/gkd-kit/gkd/blob/v1.13.0-beta-2/gkd-app/src/commonMain/kotlin/li/gkd/app/snapshot/SnapshotFileLayout.kt)
- [beta-2 选择器包与使用说明](https://github.com/gkd-kit/gkd/tree/v1.13.0-beta-2/gkd-selector)
