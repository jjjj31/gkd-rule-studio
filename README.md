# GKD Rule Studio

> 分支范围：`codex/release-preparation` — 本次发行准备，不包含新 SDK 检测或 MCP。见[分支与发行范围](docs/verification/branch-split-2026-11-03.md)。

[![License: SATA](https://img.shields.io/badge/License-SATA-blue.svg)](LICENSE)

在手机上帮 GKD 生成跳过规则的辅助工具。连上 GKD HTTP 服务，在截图上拖动选目标控件，自动出候选规则 → 测试 → 导入，一条龙。

> 桌面版（Windows/Web）仍在但不主动维护。以下内容以 Android 版为准。

## 亮点

**🧠 AI 定制场景** — 用自然语言描述你的场景（比如"进首页后 5 秒弹出的新人红包"），复制 prompt 给 AI，AI 返回 JSON5 格式的场景配置，粘贴回来就能用。8 种内置预设不够？自己造。

**⚡ 一键生成规则** — 截图画布上拖动放大镜定位控件，松手瞬间出候选规则。14 种选择器策略自动打分排序，不用写一行 GKD selector。

**🧪 同时测试多条规则** — 同一控件可以加多个候选同时测试，在手机上触发一次就能对比哪条命中最准。测试管理页统一查看所有测试状态。

**📥 一键导入本地订阅** — 连接官方 GKD 1.13 测试版后，测试有效的规则可以直接导入本地规则；正式版路径保留复制后手动添加。

**🔄 软件内更新** — App 内直接检查新版本、下载并安装，不用去 Releases 页翻。发版由 GitHub Actions 自动完成：打 tag 即自动构建 APK 并生成更新清单。清单在国内网络下会自动尝试镜像源。

**📋 一键复制求助 Prompt** — 内置结构化的求助 prompt，包含当前控件信息、节点树上下文、GKD selector 语法约束。复制到 ChatGPT / Claude / Kimi 等任何 AI 工具，拿回复粘贴回来自动提取规则。

**🤖 内置 AI 直接生成** — 配置好 API Key 后在 App 里直接调 AI 生成规则，不需要来回切 App 复制粘贴。

**🔒 基础功能离线可用** — 选点出候选、测试导入全在本地完成，没有 API Key 也能照常用。仅 AI 生成、检查更新、加载字体需要联网。

**📦 轻量安装包** — 一个纯 WebView + 前端代码的轻量 APK，不内置任何 AI 模型、不需要 Google Play Service。

**💬 应用内反馈** — 首页、规则工作区和测试结果可直接反馈工具故障或规则问题。版本和相关错误自动整理，规则、截图及节点树按需附带；支持截图打码、关联文字隐藏和提交前预览。发送失败保留本地脱敏草稿，手动重试；联系方式选填，材料保留 90 天。作者使用私有后台处理反馈，邮件提醒待配置后启用。[功能说明](docs/specs/user-feedback.md)。

## 快速开始

1. 下载 APK、安装
2. 打开 GKD → 侧边栏 → HTTP 服务 → 启动
3. 打开 Rule Studio，填入地址（手机本机 `127.0.0.1:8888`），点连接
4. 连接后勾选一张快照，点「进入工作区」
5. 在截图画布上**拖动**（不是点击）到目标按钮上松手
6. 底部「候选」标签页会出现自动生成的规则，选一条点「测试」
7. 测试有效后，官方测试版直接「导入」，正式版「复制」再手动粘到 GKD

多步骤操作：勾选多张快照进入工作区，在「步骤」标签页编排顺序，适合"点红包 → 返回"这种连续操作。

## 什么时候用什么方式

### 从订阅里找现成规则

1. 首页打开「订阅规则库」，在「管理订阅来源」添加用于 GKD 的订阅文件链接，可添加多个来源。
2. 输入软件名或包名，进入应用后按来源查看规则组原名称和说明，逐组选取需要的功能。
3. 点「复制」得到包含应用信息和完整规则组的 JSON5，粘贴到 GKD → 本地订阅 → 应用规则的添加位置。复制无需连接设备或先测试。
4. 需要测试时连接对应版本的 GKD HTTP 服务，逐组实测并手动记录有效／无效。官方 GKD 1.13 测试版也可以直接「导入」规则组；正式版通过复制后手动添加。

订阅下载后保存在本地，重启或断网仍可搜索和复制，更新由用户手动刷新。导入的是固定副本，不随原订阅自动更新；源规则默认禁用的组会保留这一设置，可在 GKD 按需启用。

规格与实施进度见 [Spec #3](https://github.com/jjjj31/gkd-rule-studio/issues/3)。

### 自己生成规则

- **简单的广告**：直接用自动生成的规则就行，候选列表里排前面的通常够用
- **流氓一点的广告**：复制 Prompt 发给 AI（ChatGPT、Claude 等），把 AI 回复贴回来提取规则
- **AI 也搞不定的**：去 [GKD Discussions](https://github.com/orgs/gkd-kit/discussions) 向大佬求助

画布上会有两种颜色的框：**蓝色**是实际命中的节点，**绿色**是规则匹配到的节点。

## GKD 版本说明

App 内保留「正式版 / 测试版」两条路径，首次使用默认正式版：

- **正式版**：面向现有正式发布版本，沿用 0.5.23 选择器引擎；支持快照读取和内存订阅测试，最终规则复制后手动添加。
- **测试版**：面向官方 GKD 1.13 测试版，使用 0.6.1 选择器引擎，通过 `/api/appendRules` 追加到本地规则。保留规则编号和引用；再次导入会追加副本，不进行选择器去重。

两者可能共用 `li.songe.gkd` 包名，连接时按包名和版本号共同核对；版本不符会提示切换路径。旧 `.debug` 自改版不再作为官方测试版入口。两条路径均支持读取 PNG/WebP 截图；新版引擎和 WebAssembly 随应用打包，按需加载。

源码依据及验证范围见 [版本路径验收记录](docs/verification/gkd-release-channels.md)。

## 下载

GitHub Releases → 下载最新 APK：[前往发布页](https://github.com/jjjj31/gkd-rule-studio/releases)

装好之后，App 内的「检查更新」可以直接升级新版本：自动检查 → 下载（校验 sha256）→ 拉起安装。检查更新在国内网络下会自动尝试镜像源，失败时多半是设备断网。

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
pnpm run check:update         # 发版后校验线上更新清单是否可用
```

Windows 打包（运行目录：项目根目录；Shell：PowerShell）：`pnpm run package:full`，会构建资源、运行 Java 单测并生成 APK 和 SHA256。可先执行 `pnpm run check:android-env` 检查 JDK 17+、SDK 35 和路径；详见 [Android 构建说明](android/README.md#构建步骤)。日常 PR 和分支推送由 CI 执行前端、Android 和反馈后端检查。

发版：升级 `package.json` 的 version → `git tag vX.Y.Z && git push origin vX.Y.Z`，GitHub Actions 会自动构建并发布 APK 与更新清单（`update.json`）。

> 注意：`android/debug.keystore` 是固定的签名密钥（本地与 CI 共用同一把）。App 内更新的覆盖安装依赖签名一致，**请勿删除或更换**，否则已装用户将无法再收到更新。

## 开源协议

本项目使用 [SATA 协议（Star And Thank Author License）](LICENSE)。简单来说：你可以自由使用本项目，但请给仓库点个 ⭐ Star 并感谢作者。感谢你的支持！

## 相关

- [GKD 搞快点](https://github.com/gkd-kit/gkd) — 广告跳过工具
- [GKD 订阅模板](https://github.com/gkd-kit/subscription) — 官方规则订阅
