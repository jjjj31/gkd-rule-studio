# GKD Rule Studio Android

这是 GKD Rule Studio 的 Android WebView 壳工程。

## 功能边界

- 启动后直接加载内置 `index.html#android` 精简版界面。
- 只使用 GKD 手机 HTTP 服务连接快照。
- 不包含 ADB 功能。
- 默认允许 `http://局域网地址` 明文访问，方便连接 GKD HTTP 服务。
- 内置剪贴板桥接，用于复制场景 prompt 和最终规则求助 prompt。

## 构建步骤

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

## 当前环境限制

当前机器没有 Java、Gradle、Android SDK，所以这里没有直接生成 APK。
如果安装 Android Studio 后打开本工程即可构建。
