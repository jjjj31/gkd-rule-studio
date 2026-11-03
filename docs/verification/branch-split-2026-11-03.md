# SDK / MCP 分支拆分记录

日期：2026-11-03。用户确定 SDK 检测和 MCP 各自独立，剩余功能为本次发行范围；实机测试由用户完成后才发布。

## 当前分支安排

| 分支 | 内容 |
| --- | --- |
| `codex/release-preparation` | 用户反馈、官方 GKD 双路径、规则制作/多步、规则库、PNG/WebP、构建与更新 |
| `codex/sdk-detection` | 发行基础 + 应用 SDK 扫描、LibChecker 导入、目录/schema/应用证据 AI 上下文；不含 MCP |
| `codex/android-mcp` | 发行基础 + Android 内置只读 MCP、Node MCP、原生服务/桥接/资源和依赖；不含新 SDK 检测 |
| `backup/before-sdk-mcp-split-2026-11-03` | 拆分前全部代码、文档和未跟踪功能的完整本地检查点 |

两条功能分支均基于发行准备分支；它们互不包含对方功能。未来只合并需要的功能分支；发行准备分支后续修复应同步到功能分支，再继续开发或验收。

原 `codex/subscription-rule-library` 分支指针保留在 `fbd7f7a`，没有改写已有提交。所有当时未提交工作先保存到备份分支；本次忽略的既有 `scripts/__pycache__/` 缓存仍保留在原目录。原始清单有 37 个修改文件、128 个未跟踪文件；再加上一轮两份审查文档。原始文件清单哈希用于回查，不代表当前状态。

## 拆分方式与保留内容

先用独立 Git 索引创建完整检查点，再在隔离 worktree 中分别移除 SDK、MCP，合成发行树。发行分支不只是隐藏入口：对应 Java 类、权限、桥接方法、前端模块、专用依赖、资源生成和专用文档一起分离。

保留 v0.2.0 已有的广告节点签名与跳过控件风险判断，它们只检查当前快照，不扫描已安装应用。保留反馈诊断、网络请求、覆盖更新和通用 Activity 资源清理。beta 选择器的内联 Wasm 插件属于官方 GKD 适配，仍在发行分支使用。

原全量功能树 `docs/feature-tree.html` 保存在备份分支，不再作为本次发行功能说明。[发行任务总表](release-readiness-2026-11-03.md)和[回归清单](release-v0.2.0-regression-checklist.md)已改为本次范围。SDK/MCP 的规格、tickets 和历史验收保存在各自功能分支。

## 切换与构建

运行目录：`C:\Users\kmttjnm\Desktop\各种项目\project\gkd-rule-builder`；Shell：PowerShell。先确认当前没有待保存改动，再切换：

```powershell
git status --short
git switch codex/release-preparation
# 或 git switch codex/sdk-detection
# 或 git switch codex/android-mcp
pnpm install --frozen-lockfile
pnpm run package:full
```

查看完整拆分前文件，无需切换：

```powershell
git show backup/before-sdk-mcp-split-2026-11-03:package.json
git diff codex/release-preparation..codex/sdk-detection --stat
git diff codex/release-preparation..codex/android-mcp --stat
```

不要用备份分支覆盖当前发行分支；它包含两块本次明确排除的功能。若需要恢复个别文件，先查看对应内容和差异。

## 检查结果

| 分支 | 前端测试 | Java 单测 | 类型检查 / Web / APK |
| --- | --- | --- | --- |
| `codex/release-preparation` | 32 文件 / 298 项通过 | 5 项通过 | 全部通过 |
| `codex/sdk-detection` | 35 文件 / 348 项通过 | 10 项通过 | 全部通过 |
| `codex/android-mcp` | 39 文件 / 362 项通过 | 6 项通过 | 全部通过 |

发行分支 Windows 构建入口 5 项自检通过。独立子 agent 复核未发现功能交叉依赖或误删。APK 的 DEX、资源与 Manifest 权限检查符合各分支范围；三份包签名一致。完整 hash、权限与验证代码版本见 [结构化检查结果](branch-split-checks-2026-11-03.json)。

发行内部包：`android/app/build/outputs/apk/debug/app-debug.apk`，版本 `0.2.0/200`，SHA-256：

```text
55e533b604e88685123635cf4cf8955eafc4971d03ef41bd85f6e0ce9650a347
```

原根目录旧 `node_modules` 在安装时遇到 EACCES，已原样保留到被忽略的 `.scratch/branch-split-2026-11-03/previous-node_modules/`，恢复说明在同级 `.note.md`。未改 ACL；根目录已按发行锁文件重新离线安装，测试和 APK 构建通过。

## 待用户验收

本次仅拆分和自动验证，不提高版本、不修复原审查发现、不安装 APK、不推送或发布。当前版本仍为 `0.2.0/200`。反馈脱敏、快照切换等待办继续保留；先用内部验证包实测，修复后还要重新验证最终 hash。
