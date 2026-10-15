# T3：SDK 信息界面、Android 文件选择与端到端验收

关联规格：[#8](https://github.com/jjjj31/gkd-rule-studio/issues/8)（本地正文：`docs/specs/libchecker-sdk-import.md`），对应 S4 及整体验收。状态：面板、工作区摘要与 Android 文件选择已实现，浏览器检查通过；真实 LibChecker 导出与真机 WebView 验收未完成（当前无 adb 设备）。依赖 T1、T2。验证记录：`docs/verification/libchecker-sdk-import.md`。

Part of #8

Blocked by: #9, #10

依赖 [T1／#9](https://github.com/jjjj31/gkd-rule-studio/issues/9)、[T2／#10](https://github.com/jjjj31/gkd-rule-studio/issues/10)。

GitHub ticket：[#11](https://github.com/jjjj31/gkd-rule-studio/issues/11)。实施状态以 Issue 为准。

## 交付结果

用户可从首页导入和管理 LibChecker 应用信息，打开快照后查看 SDK 来源及版本状态，并将上下文带入现有规则生成。桌面浏览器和 APK 中的系统文件选择都能完成流程。

## 工作范围

- 首页增加“SDK 信息”入口和独立面板，复用现有界面风格；提供文件导入、应用名／包名搜索、档案详情和按应用删除。
- 处理未导入、读取中、导入成功、零 SDK 匹配、解析失败、保存失败及缓存损坏状态。解析及保存成功后才替换内存状态；重复选择同一文件可重新导入。
- 工作区用简短“应用 SDK／页面特征”摘要区分两类来源，按需展开证据；版本失配与未核对可见，不能标为确定的当前广告来源。
- 为单步及流程各步骤传入正确包名对应档案；数据变更使新 prompt 更新，但不改写已有 AI session、候选或设备测试状态。
- 在 `MainActivity.java` 补齐 WebView `onShowFileChooser` 和结果交付，支持 `.lcapps` 的 `application/octet-stream` 及 JSON／ZIP；无需全盘存储权限。取消、重复打开、读取失败、Activity 销毁正确完成回调；不把已有导出 `saveFile` 当成导入接口。
- 浏览器使用脱敏合成导出及快照验证；在真实手机导出文件和 APK WebView 上验证选择、解析、取消、重试与重启恢复。只验证上下文接入，不需要自动点击广告或调用真实 AI。
- 新建 `docs/verification/libchecker-sdk-import.md`，记录源码与真实导出来源、导出端版本、设备／WebView 版本、fixture、实际命令、通过项及未通过项；若采样需要脱敏，保持结构及匹配证据语义。

## 代码入口

- `src/components/AndroidLiteApp.tsx`：首页入口、工作区摘要、当前快照与 AI session 数据。
- 新增 SDK 信息面板及必要样式；导入与匹配逻辑调用 T1／T2 模块。
- `src/lib/helpPrompt.ts`、`src/lib/flowDraft.ts`：确认复制和内置 AI 走同一份已接入上下文的 prompt。
- `android/app/src/main/java/com/gkdrulebuilder/android/MainActivity.java`：目前只有 WebViewClient，没有文件选择支持；这是 APK 导入的必要实现。

## 验收条件

- [ ] 无设备连接、无快照、无 AI 配置时能打开面板、导入、搜索、查看和删除；结果计数准确。
- [ ] 文件选择取消无错误、可再次选择相同文件；非法／超限文件与保存失败保留旧记录；重启和离线恢复可用。
- [ ] 同名不同包名、多个 SDK、零匹配、版本相符／失配／未知、静态名单与页面不一致均有可见且准确的状态。
- [ ] 单步及多步 prompt 使用当前档案，其他应用不会混入；导入／删除后，已有 AI session 与测试状态不变。
- [ ] 导入不触发网络请求；生成／复制只包含当前应用必要 SDK 上下文，不上传或复制全文件。
- [ ] 桌面浏览器检查通过，真实 APK 的系统选择器可读取 `.lcapps` 和 JSON，取消／再次选择／读取失败回调正常。
- [ ] 至少一份脱敏真实 LibChecker 应用信息导出与合成 fixture 都通过，明确记录实际导出版本及是否符合固定源码基线。
- [ ] 类型检查、项目测试和生产构建通过；Android 构建完成，真实 WebView 验证有记录。

## 验证与完成记录

运行目录：仓库根目录。Shell：PowerShell。

```powershell
npm run typecheck
npm test
npm run build
npm run package:full
```

构建 APK 不能替代文件选择和真实导出验收。设备暂不可用时可以交付本地实现与浏览器验证，但此 ticket 和总体 spec 保持未完成，并标明缺少的证据；不因模拟成功关闭设备验收项。
