# GKD Rule Studio Android

这是 GKD Rule Studio 的 Android WebView 壳工程。

## 功能边界

- 启动后直接加载内置 `index.html#android` 精简版界面。
- 只使用 GKD 手机 HTTP 服务连接快照。
- 首页可选择官方 GKD「正式版 / 测试版」，首次使用默认正式版；测试版支持官方 1.13 的本地规则追加接口，正式版保留复制后手动添加。两条路径按版本核对连接，分别使用旧/新选择器引擎，支持 PNG/WebP 截图。详见 [版本路径验收](../docs/verification/gkd-release-channels.md)。
- 不包含 ADB 功能。
- 默认允许 `http://局域网地址` 明文访问，方便连接 GKD HTTP 服务。
- 内置剪贴板桥接，用于复制场景 prompt 和最终规则求助 prompt。

## 用户反馈

首页、规则工作区和测试结果均可发起反馈。无需账号，联系方式选填；版本、系统和相关错误可预览编辑，规则、截图和节点树默认不附带。

截图支持框选不透明打码，与遮挡区域相交的节点文字同步隐藏；文字材料还可手动编辑和隐藏字段。只有用户预览确认的脱敏结果会上传。失败时保存本地草稿，重新打开后手动重试；成功显示编号。服务器在 90 天后自动删除反馈及附件。

最近一次 Java 未处理异常摘要仅保存在应用私有目录，最多 8 KiB、保留 7 天，用户发起反馈时才加入可编辑材料；不采集全机 logcat。详见 [用户反馈规格](../docs/specs/user-feedback.md)。

## 构建步骤

Windows 命令行入口（运行目录：项目根目录；Shell：PowerShell）：

```powershell
pnpm run check:android-env     # 仅检查 JDK、SDK 和构建目录
pnpm run check:android-wrapper # 检查错误环境会被拦截，且不改动其他目录
pnpm run test:android          # 构建 Web 资源并运行 Java 单测
pnpm run package:full          # 构建资源、运行 Java 单测并生成 APK 与 SHA256
```

入口为 `scripts/build-android.ps1`，从任意目录直接调用该脚本也会定位到本仓库。JDK 需 17 以上，推荐 21；SDK 需包含 `platforms;android-35`、`build-tools;35.0.0`、`platform-tools`，并先执行 `pnpm install`。脚本优先复用用户目录 `.local/tools/jdk21-current`，再检查 `JAVA_HOME`，显式覆盖 Gradle 中的相对 Java 路径。SDK 遵循 `android/local.properties` 的 `sdk.dir`；未设置时依次检查 `.local/tools/android-sdk-current`、`ANDROID_HOME`、`ANDROID_SDK_ROOT`。脚本不修改这些配置。

仓库路径含中文时，默认复用 `.local/worktrees/gkd-rule-builder-ascii` 目录联接，并核实它指向当前仓库；不会重定向已有目录。自定义环境可显式传入路径（运行目录：项目根目录；Shell：PowerShell）：

```powershell
# 仅在该路径不存在时创建；目标必须是当前仓库。
New-Item -ItemType Junction -Path C:\gkd-rule-studio-ascii -Target (Get-Location).Path
.\scripts\build-android.ps1 -BuildRoot C:\gkd-rule-studio-ascii -JavaHome C:\path\to\jdk21 -AndroidSdk C:\path\to\android-sdk
```

APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。目录联接与源目录共用文件，不复制源码或构建产物。日常 CI 在 Windows runner 上调用同一 `package:full` 入口，并单独运行反馈后端静态检查与测试；不会访问生产服务。修改仅保存在本地时，CI 需提交推送后才会触发。

本次检查结果与验证边界见 [Windows 构建与 CI 验证](../docs/verification/windows-build-ci.md)。

Android Studio 构建方式：

1. 在项目根目录执行：

   ```bash
   pnpm run build:android-assets
   ```

2. 用 Android Studio 打开 `android` 目录。

3. 等 Gradle 同步完成后，选择：

   ```text
   Build > Build Bundle(s) / APK(s) > Build APK(s)
   ```

4. APK 会生成在：

   ```text
   android/app/build/outputs/apk/debug/app-debug.apk
   ```

执行 Gradle clean 后，须重新运行 `pnpm run build:android-assets` 再打包。CI 也使用同一资源构建入口。
