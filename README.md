# GKD Rule Studio

在手机上帮 GKD 生成跳过规则的辅助工具。选一个广告按钮，自动出候选规则、测试、导入，一条龙。

> 桌面版（Windows/Web）仍在但不主动维护。以下内容以 Android 版为准。

## 快速开始

1. 下载 APK、安装
2. 打开 GKD → 侧边栏 → HTTP 服务 → 启动
3. 打开 Rule Studio，填入地址（手机本机 `127.0.0.1:8888`），点连接
4. 连接后勾选一张快照，点「进入工作区」
5. 在截图画布上**拖动**（不是点击）到目标按钮上松手
6. 底部「候选」标签页会出现自动生成的规则，选一条点「测试」
7. 测试有效后 Beta 版直接「导入」，正式版「复制」再手动粘到 GKD

多步骤操作：勾选多张快照进入工作区，在「步骤」标签页编排顺序，适合点红包→返回这种连续操作。

## 下载

GitHub Releases → 下载最新 APK：[前往发布页](https://github.com/phonon1/gkd-rule-builder/releases)

## 开发

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run dev              # 浏览器开发
pnpm run build:android-assets  # 构建安卓 WebView 资源
pnpm run package:full     # 构建 + 打包 APK
```

## 相关

- [GKD 搞快点](https://github.com/gkd-kit/gkd) — 广告跳过工具
- [GKD 订阅模板](https://github.com/gkd-kit/subscription) — 官方规则订阅
