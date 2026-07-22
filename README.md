# GKD Rule Studio

在手机上帮 GKD 生成跳过规则的辅助工具。连上 GKD HTTP 服务，在截图上拖动选目标控件，自动出候选规则 → 测试 → 导入，一条龙。

> 桌面版（Windows/Web）仍在但不主动维护。以下内容以 Android 版为准。

## 快速开始

1. 下载 APK、安装
2. 打开 GKD → 侧边栏 → HTTP 服务 → 启动
3. 打开 Rule Studio，填入地址（手机本机 `127.0.0.1:8888`），点连接
4. 连接后勾选一张快照，点「进入工作区」
5. 在截图画布上**拖动**（不是点击）到目标按钮上松手
6. 底部「候选」标签页会出现自动生成的规则，选一条点「测试」
7. 测试有效后 Beta 版直接「导入」，正式版「复制」再手动粘到 GKD

多步骤操作：勾选多张快照进入工作区，在「步骤」标签页编排顺序，适合"点红包 → 返回"这种连续操作。

## 什么时候用什么方式

- **简单的广告**：直接用自动生成的规则就行，候选列表里排前面的通常够用
- **流氓一点的广告**：复制 Prompt 发给 AI（ChatGPT、Claude 等），把 AI 回复贴回来提取规则
- **AI 也搞不定的**：去 [GKD Discussions](https://github.com/orgs/gkd-kit/discussions) 向大佬求助

画布上会有两种颜色的框：**蓝色**是实际命中的节点，**绿色**是规则匹配到的节点。

## GKD 版本说明

官方 GKD 的 HTTP 服务只支持导入"内存订阅"（临时生效），不支持直接写入本地规则。Rule Studio 默认连接 **GKD Debug/Beta 版**（包名 `li.songe.gkd.debug`），它额外提供了 `localRules/append` API，可以一键把规则存进本地。

> 我 fork 了一个支持本地规则导入的 GKD 版本：[链接待补充]()

App 内右上角可以切换「Beta / 正式」目标版本。正式版测试后只能复制 JSON5 手动粘贴到 GKD。

## 下载

GitHub Releases → 下载最新 APK：[前往发布页](https://github.com/jjjj31/gkd-rule-studio/releases)

## 关于这个项目

这个项目是我纯 vibe coding 写的，我本身没有写过 GKD 规则。核心的两块——候选规则生成算法和 AI Prompt 的注意事项——是我让 GPT 分析 GKD 规则仓库后总结出来的，AI 在这两块还是没法完善得很好。我没有精力去深入学习然后来完善，所以希望有经验的大佬来帮忙改进。

如果你熟悉 GKD 规则编写或对 selector 策略有更好的想法，欢迎提 Issue / PR。

## 开发

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run dev                  # 浏览器开发
pnpm run build:android-assets # 构建 Android WebView 资源
cd android && gradle assembleDebug  # 打包 APK
```

## 相关

- [GKD 搞快点](https://github.com/gkd-kit/gkd) — 广告跳过工具
- [GKD 订阅模板](https://github.com/gkd-kit/subscription) — 官方规则订阅
