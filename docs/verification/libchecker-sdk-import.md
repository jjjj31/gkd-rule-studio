# LibChecker 导入与广告 SDK 上下文实现与验证记录

日期：2026-10-14。规格：[Spec #8](https://github.com/jjjj31/gkd-rule-studio/issues/8)（本地正文：`docs/specs/libchecker-sdk-import.md`）。工作分支：`codex/subscription-rule-library`，基线 `02ba8d0`。

对应 ticket：[T1／#9](https://github.com/jjjj31/gkd-rule-studio/issues/9)、[T2／#10](https://github.com/jjjj31/gkd-rule-studio/issues/10)、[T3／#11](https://github.com/jjjj31/gkd-rule-studio/issues/11)。

## 已实现

首页独立“SDK 信息”入口；导入 LibChecker 的 `.lcapps`／ZIP 或解压后的 `apps.json`；按现有六类广告 SDK 的类名前缀匹配组件，按包名整条替换并保存在独立本地 key；按应用名／包名搜索、查看证据和按应用删除。

打开快照后，工作区用“应用 SDK／页面特征”两块分别呈现导入清单与当前页面的 SDK 特征，版本相符／失配／未核对分别显示。单步 `buildHelpPrompt`、多步 `buildFlowHelpPrompt`、内置 AI 与外部复制共用同一套上下文格式：每 SDK 最多两条清单证据和两条页面证据，稳定排序；版本失配只提示状态并省略名单；两类证据都缺失时不改变原有 prompt。

静态清单不进入候选评分，也不生成 `activityIds`、按钮或执行参数；跳过控件加分仍只由现有目标节点判断产生。APK 侧补齐 WebView `onShowFileChooser` 与结果交付，支持未知扩展名／`application/octet-stream` 的导出，未新增存储权限。

依赖选择：ZIP 读取使用 `fflate@0.8.3`（项目已有依赖体系中体积最小的成熟实现，未手写 DEFLATE）。存储使用独立 key `gkd-rule-studio-app-sdk-profiles` 与 schema version `1`，不改写订阅库、快照记忆或 AI session 存储。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过 |
| `pnpm test` | 25 个测试文件、224 个测试通过 |
| `scripts/check-libchecker-import.py` | Firefox + 自造 LibChecker 导出 + 模拟 GKD 接口，18 项流程检查通过 |
| 浏览器布局 | 实际 viewport 412 × 915、DPR 1，SDK 面板与工作区摘要均无横向溢出；未宣称 Android 真机布局已通过 |
| `pnpm run build` | 通过（chunk 体积 warning，非错误） |
| `pnpm run build:android-assets` | 通过 |
| Gradle `assembleDebug` | 通过（需下面的中文路径 workaround） |
| `apksigner verify` | 通过 |

浏览器检查覆盖：首页入口无设备可用；空状态；非 LibChecker 文件被拒绝且不动缓存；`apps.json` 导入计数与存储一致；同一数据的 ZIP 去重；按包名与应用名搜索；详情版本／SDK 名单／匹配前缀；超安全整数版本码保留且零匹配显示“未识别到受支持的 SDK”；按应用删除；重复选择同一文件；超过 32 MiB 拒绝；重启离线恢复；连接模拟 GKD 并进入工作区；工作区摘要区分清单与页面证据；版本失配折叠名单；缓存损坏提示且不覆盖原值。

详细结果：[检查数据](libchecker-sdk-import-checks.json)。截图使用自造导出：[SDK 面板](libchecker-sdk-import-mobile.png)、[工作区摘要](libchecker-sdk-import-workspace.png)。

## Fixture 与来源

上游源码基线：LibChecker commit `625c4ecc40b0ed6d70e37ccdfb961867ffc1a622`（2026-10-13）。核对内容为 `LcAppsExporter.kt`（ZIP 根目录唯一 `apps.json`，报告数组，应用身份在 `apkInfo.packageName`，`apkInfo.versionCode` 为字符串，`sdkSummary` 可能为空、组件 `sdk` 可能为 null）与 `LcAppsSerializationTest.kt`（数组、可空字段、超出 JavaScript 安全整数范围的版本码 `9007199254740993`）。

本记录的 fixture 全部是**脱敏合成数据**，按上述结构构造，不包含任何真实应用清单：

- 单元测试 `src/lib/libCheckerImport.test.ts`：单／多应用、空组件、零／多 SDK、`sdkSummary` 为空、`sdk: null`、前缀反例、BOM、重复包名、损坏 ZIP、重复／缺失 `apps.json`、不安全版本码、各项上限。
- 浏览器检查 `scripts/check-libchecker-import.py`：3 个合成应用（`com.example.video` 命中穿山甲＋优量汇、`com.example.reader` 使用 `9007199254740993`、`com.example.plain` 零匹配）与一份版本失配样本。

**尚缺真实手机导出。** 上游源码核对和浏览器 mock 不能替代设备验收，相关验收项保持未完成。

## Prompt 示例（脱敏合成）

单步 prompt 中，静态清单与页面特征分两段出现，页面特征带节点编号：

```text
- 应用 SDK 上下文：
  - 版本核对：相符（versionCode 12345）。
  - 导入清单（只代表应用包含该 SDK，不代表当前页面）：
    - pangle / 穿山甲：activity com.byted.pangle.core.SplashAdActivity；receiver com.byted.pangle.core.NetworkReceiver
    - gdt / 优量汇：service com.qq.e.comm.DownloadService
  - 当前页面命中（结合当前节点树确认）：
    - pangle / 穿山甲：#1 vid=tt_splash_container（特征 tt_splash）；#2 vid=tt_splash_skip_btn（特征 tt_splash_skip_btn）
  - 定位提示：静态清单只代表应用包含该 SDK，定位必须用当前节点树；只能点击当前页面实际可定位的关闭/跳过节点，不要仅凭 SDK 名单编造选择器。
```

多步 prompt 按步骤各自带入上下文，不会跨应用泄漏：步骤 1（`com.example.video.ui.SplashActivity`）显示上面的页面命中；步骤 2（`com.example.video.ui.MainActivity`）显示同一份导入清单，但页面特征为“页面未命中已知 SDK 特征”。示例中不含 `com.example.reader` 的任何信息。

示例由临时脚本生成于已忽略的 `.scratch/`，只作本记录的摘录来源，不作为测试用例。

## 开发测试 APK

- 文件：`android/app/build/outputs/apk/debug/app-debug.apk`。
- 包名：`com.gkdrulebuilder.android`。
- 版本：`0.2.0`，versionCode `200`，开发构建，未作为新版本发布。
- 大小：717177 字节。
- SHA256：`912C347704021B47EE73A30AA9FED5E728D062D088016130FEFB939F7CC867D1`。
- 签名：项目固定 debug 签名（`CN=Android Debug`，证书 SHA-256 `c6aa24ff1596424f69368353c964393e15d17c873670f9611cfaa2579d691c64`），`apksigner verify` 通过。

本机从中文路径直接运行 `android\gradlew.bat assembleDebug` 会报 `java.lang.ClassNotFoundException: org.gradle.wrapper.GradleWrapperMain`。此次改用已安装的 JDK 17 直接调用 wrapper jar 构建，命令参数覆盖 `org.gradle.java.home`，项目原构建配置保持原值。`pnpm run package:full` 走同一 `gradlew` 入口，因此在本机中文路径下同样不可用；上面的 workaround 等价替代，不修改仓库配置。

## 重跑检查

运行目录：`C:\Users\kmttjnm\Desktop\各种项目\project\gkd-rule-builder`。Shell：PowerShell。

```powershell
pnpm run typecheck
pnpm test
pnpm run build
pnpm run build:android-assets
```

浏览器流程检查使用本机已安装的 ruyipage 和托管 Firefox。脚本会在 5174 未监听时自行启动 Vite 开发服务器，并使用本机 `127.0.0.1:8768` 的模拟 GKD 接口；中间产物与截图写入已忽略的 `.scratch/libchecker-sdk-import-browser-check/`。

```powershell
C:\Python314\python.exe scripts/check-libchecker-import.py
```

脚本用 `browsingContext.setViewport` 显式把视口设成 412 × 915、DPR 1（Firefox 窗口有最小宽度，只靠 `window_size` 拿不到这个视口）。冷启动一次约 80-90 秒：`index.html` 的 `<head>` 里有 `fonts.googleapis.com` 外链，离线环境里首次导航要等这个请求超时（约 40-50 秒）React 才挂载，脚本因此对首次导航给足超时，并保留整页重试兜底。这个外链拖慢离线首屏是既有行为，不属于本次改动。

Android 构建（中文路径 workaround）：

```powershell
cd android
& "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot\bin\java.exe" `
  -classpath "gradle\wrapper\gradle-wrapper.jar" `
  org.gradle.wrapper.GradleWrapperMain `
  "-Dorg.gradle.java.home=C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot" `
  assembleDebug --console=plain
```

## 设备验收待补

`adb devices` 当前没有已连接设备（adb 1.0.41 / 37.0.0）。以下验收项保持未完成，不因浏览器模拟通过而关闭：

- 真实手机 LibChecker 导出的 `.lcapps`／`apps.json` 导入，并记录导出端版本与是否符合上述源码基线。
- APK WebView 中系统文件选择器读取 `.lcapps`（`application/octet-stream`）与 JSON，取消、再次选择、读取失败和 Activity 销毁的回调行为。
- 真机重启后离线恢复、按应用删除与存储配额失败时的实际表现。
- 真机工作区摘要与 prompt 的显示、多步骤流程中的实际规则生成。

浏览器检查使用模拟 GKD 接口复现连接、快照与工作区流程；模拟通过不等于上述设备检查通过。
