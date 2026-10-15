# T1：LibChecker 文件解析、SDK 档案与本地保存

关联规格：[#8](https://github.com/jjjj31/gkd-rule-studio/issues/8)（本地正文：`docs/specs/libchecker-sdk-import.md`），对应 S1、S2。状态：已实现；类型检查、单元测试与浏览器流程检查通过，见 `docs/verification/libchecker-sdk-import.md`。无前置实施 ticket。

Part of #8

GitHub ticket：[#9](https://github.com/jjjj31/gkd-rule-studio/issues/9)。实施状态以 Issue 为准。

## 交付结果

生成器可读取 LibChecker 的 `.lcapps`／ZIP 或其中的 `apps.json`，从原始组件类名识别现有六类广告 SDK，返回并保存按包名组织的应用 SDK 档案。没有 SDK 汇总标签也能工作；导入失败不丢失旧记录。

## 工作范围

- 以 spec 中固定上游 commit 的导出结构及序列化测试为依据；编写脱敏 fixture，注明哪些来自源码结构、哪些经真实设备核实，不编造 SDK 名单导出格式。
- 新增导入模块，提供 `readLibCheckerProfiles(file, importedAt)` 或等价的小接口；ZIP 与 JSON 共用报告校验／规范化。
- ZIP 仅解压唯一根条目 `apps.json`，不处理图标；使用成熟 ZIP 库，并按 S1 同时限制上传、实际解压输出、报告数量和组件数量。处理重复条目、损坏、加密及不支持格式。
- 按 `apkInfo.packageName` 读取应用身份，四类 `components[].name` 使用已有 `packagePrefixes` 的类名开头和点分隔规则匹配；一次收集全部 SDK。`sdkSummary`、组件 `sdk`、展示名和未知原生库不能成为前置条件。
- 保持版本码字符串语义，拒绝不安全数值；保留必要版本、分析／导入时间和匹配证据。未知字段可忽略，导出原文和无关权限、证书、图标不落盘。
- 新增独立、带 schema version 的本地档案存储，按包名整条替换，保留文件外记录；空文件不清库，同文件重复包名报错。批量解析及保存成功后才提交界面状态。
- 提供加载、导入更新与按包名删除所需存储操作，使用可替换 Storage 验证容量失败／损坏缓存不覆盖旧值。规范化存储上限为 UTF-8 2 MiB。

## 代码入口

- `src/data/adSdkSignatures.ts`：六类 SDK 稳定 id 和类名前缀；复用数据，不复制第二份 SDK 表。
- `src/lib/subscriptionLibrary.ts`：参考已有存储参数及持久化错误处理，使用独立 key。
- 新增 `src/lib/libCheckerImport.ts`、`src/types/appSdkProfile.ts`，存储可放在一个小模块内或按项目习惯单独拆分。
- 新增导入和存储行为测试；此 ticket 不承担 UI 或原生扫描。

## 验收条件

- [ ] 合成 `.lcapps` 与同内容 JSON 返回一致档案，数组包含单／多应用、空组件、零／多 SDK 的情况。
- [ ] 空 `sdkSummary`／null `sdk` 不影响类名匹配；现有六类 id 顺序稳定，同 SDK 多组件不会重复 SDK。
- [ ] `com.qq.e.ads.ADActivity` 命中，`com.qq.evil.AdActivity` 与普通 `ad_area` 组件不命中；记录匹配来源。
- [ ] 字符串 `9007199254740993` 保留原值；不安全数字、重复包名、非法必需字段拒绝，错误指出位置。
- [ ] ZIP 缺失／重复 `apps.json`、损坏、加密、各项超限及实际解压输出超限有测试或明确的库行为验证，失败时没有缓存变更。
- [ ] 重新导入替换同包名档案，包括清空该应用旧 SDK 匹配；其他应用保留；空文件不会清空记录。
- [ ] 重启回读、按应用删除、存储配额失败和损坏缓存验证通过；失败不以空值覆盖旧缓存。
- [ ] 保存数据只含 spec 指定字段，没有权限、证书、图标、完整导出或无关组件信息。

## 验证与完成记录

运行目录：仓库根目录。Shell：PowerShell。

```powershell
npm run typecheck
npm test -- src/lib/libCheckerImport.test.ts src/data/adSdkSignatures.test.ts
```

测试文件名按最终布局调整；覆盖实际 parser／store 公共接口，不只断言内部常量。完成时记录 fixture 来源、上游 commit、依赖选择、上限失败行为及测试结果。真实手机导出兼容性由 T3 补齐，不能在本 ticket 中声称已验证全部 LibChecker 版本。
