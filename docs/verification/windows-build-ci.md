# Windows 构建入口与日常 CI 验证

日期：2026-10-30。范围：回顾建议中的日常 CI 和 Windows Android 构建入口。

## 入口

- `.github/workflows/check.yml`：PR、分支推送、手动运行；只读仓库权限；同源同分支重复运行自动取消。
- Windows job：Node 24、JDK 21、SDK 35；执行入口自检、前端类型检查与测试、`package:full`。
- 后端 job：Python 3.12、锁定的服务依赖和 Ruff 版本；执行 Ruff F 检查与本地单测。
- `scripts/build-android.ps1`：选择 JDK/SDK，核对 ASCII 路径属于当前仓库，构建 Web 资源，运行 Java 单测，打包并输出 SHA256。子命令失败时保留退出码。
- `scripts/test-android-build.ps1`：验证成功与失败路径；先确认构建目录归属，再创建临时材料；清理前拒绝重解析点。

命令说明和环境缺项处理见 [Android 构建步骤](../../android/README.md#构建步骤)。脚本不修改机器 JDK/SDK 配置或已有目录联接。

## 本地结果

| 检查 | 结果 |
| --- | --- |
| 前端类型检查 | 通过 |
| 前端测试 | 42 个测试文件，407 项通过 |
| 反馈后端 Ruff F 检查 | 通过 |
| 反馈后端单测 | 16 项通过，由实现子 agent 执行 |
| 构建入口自检 | 5 项通过：异目录调用、缺失 JDK、缺失 SDK、错误仓库、Unicode 构建目录 |
| Android Java 单测 | 11 项通过，0 失败、0 错误、0 跳过 |
| 完整打包 | `pnpm run package:full` 返回 0，Gradle BUILD SUCCESSFUL |
| 工作流静态检查 | YAML 可解析，触发器、权限、任务和命令结构通过检查 |

本地打包从原始中文路径发起，使用已有 ASCII 目录联接与 JDK 21；SDK 遵循本机 `android/local.properties`。测试不连接生产反馈服务。

APK：`android/app/build/outputs/apk/debug/app-debug.apk`，1,622,606 字节。

SHA256：`a15dd1e241e556aad5cb514fad1907f8d788e49df9e894ab0899c14d3e174e58`。

该 APK 用于验证当前混合工作区能完整构建，包含其他正在开发的功能；本次没有发布或安装它。仓库原有未提交改动予以保留。

## 尚未验证

新增工作流尚未提交推送，未在 GitHub 托管的 Windows/Ubuntu runner 上实际运行。本地测试结果不能替代远端首次运行结果。
