# GKD Rule Studio

GKD Rule Studio 是一个本地运行的 GKD 规则辅助生成工具，用于从 GKD 快照中选择控件、生成 JSON5 规则草稿，并把测试规则导入 GKD 内存订阅。

## 功能

- 读取 GKD HTTP 服务快照，或在 Windows 版通过 ADB 辅助服务读取快照。
- 根据用户点击区域生成候选 selector，并给出适合新手选择的提示。
- 生成单步规则、多步骤规则、AI 求助 prompt 和可导入的 JSON5 片段。
- 提供测试区，把候选 selector 或 AI 返回规则合并成 GKD 内存订阅进行临时测试。
- Windows/Web 版可连接本地订阅仓库，把规则写入 `src/apps` 并保留撤回记录。
- Android APK 内置轻量界面，适合直接在手机上连接 GKD HTTP 服务做快照规则测试。

## 下载

请在 GitHub Releases 下载：

- `GKD-Rule-Studio-Portable-0.1.0.zip`：Windows 便携版。
- `GKD-Rule-Studio-Android-0.1.0-debug.apk`：Android 调试 APK。

## Windows 便携版

1. 解压 zip。
2. 双击 `START.cmd`。
3. 浏览器会打开 `http://127.0.0.1:5174/`。
4. 需要关闭后台服务时双击 `STOP.cmd`。

## Android APK

安装 APK 后打开应用，按界面提示填写 GKD HTTP 服务地址。手机本机访问通常使用 `127.0.0.1:8888`。

## 本地开发

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
pnpm run dev
```

构建 Android WebView 资源：

```bash
pnpm run build:android-assets
```

构建 APK：

```bash
cd android
gradle assembleDebug
```

生成本地发布文件：

```powershell
pnpm run build
pnpm run build:android-assets
gradle -p android :app:assembleDebug
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-release.ps1
```

发布产物在 `release/current`，Windows 便携版模板在 `packaging/windows`。

## GKD 内存订阅导入

测试区导入 GKD 使用的是 GKD HTTP 服务的 `/api/updateSubscription`，写入目标是 GKD 的内存订阅。它适合临时验证规则，不等同于发布到正式订阅仓库。
