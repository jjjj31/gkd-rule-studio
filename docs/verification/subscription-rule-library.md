# 订阅规则库实现与验证记录

日期：2026-10-13。规格：[Spec #3](https://github.com/jjjj31/gkd-rule-studio/issues/3)。工作分支：`codex/subscription-rule-library`。

## 已实现

首页独立规则库入口；多个订阅文件链接的下载、手动刷新、删除和本地缓存；按应用名／包名搜索；按来源展示完整规则组；独立复制；无快照逐组测试；未测试直接导入支持本地接口的目标；来源、版本和固定副本记录。

规则组保持原始字段和组内引用，缺依赖的组可查看原文并显示交付限制。对当前 GKD fork 的本地导入，发送前按规则顺序重映射引用，单独关闭选择器去重，以避免拆坏完整组；原生成候选继续沿用其原有导入方式。

下载中往返首页会保留任务；测试和已有候选共享完整内存订阅；错误目标不会收到测试写入；同步失败、部分写入和本地记录保存失败有独立反馈。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过 |
| `pnpm test` | 22 个测试文件、184 个测试通过 |
| `scripts/check-subscription-library.py` | Firefox + 自造订阅 + 模拟 GKD 接口，19 项流程检查通过 |
| 浏览器布局 | 实际 viewport 为 500 × 830、DPR 1，无横向溢出；未宣称 Android 真机布局已通过 |
| `pnpm run build:android-assets` | 通过 |
| Gradle `assembleDebug` | 通过 |
| `apksigner verify` | 通过 |

浏览器检查覆盖：无设备和快照入口；下载过程中导航；不同来源同名组；离线复制；未测试导入；完整参数与引用；部分写入；设备成功而记录保存失败；保留已有候选；逐组切换／结束；失败重试；目标不匹配；一个源失败而另一个源成功刷新；旧副本不变；重启后离线搜索；缺依赖组限制；正式版手动添加；删除来源不修改 GKD。

详细结果：[检查数据](subscription-rule-library-checks.json)。截图使用自造规则：[浏览器截图](subscription-rule-library-mobile.png)。

## 开发测试 APK

- 文件：`release/gkd-rule-library-debug.apk`。
- 包名：`com.gkdrulebuilder.android`。
- 版本：`0.1.7`，versionCode `107`，开发构建，未作为新版本发布。
- 大小：704419 字节。
- SHA256：`CBB2D8992AEB46A5EAE12E87169C8E801CB93E94FEAC43F19B797AD32045B1A3`。
- 使用项目固定 debug 签名，签名检查通过。

本机从中文路径直接启动 Java/Gradle 失败。此次通过临时英文 Junction 路径、已安装的 JDK 17 和项目现有 Gradle 8.10.2 构建，命令参数覆盖 `org.gradle.java.home`，项目原构建配置保持原值。

## 重跑检查

运行目录：`C:\Users\kmttjnm\Desktop\各种项目\project\gkd-rule-builder`。Shell：PowerShell。

```powershell
pnpm run typecheck
pnpm test
```

浏览器流程检查使用本机已安装的 ruyipage 和托管 Firefox。先在一个 PowerShell 窗口运行开发服务器，再在另一个窗口执行检查：

```powershell
pnpm run dev
```

```powershell
C:\Python314\python.exe scripts/check-subscription-library.py
```

检查脚本使用本机 `127.0.0.1:8767` 的模拟接口，将自己的临时 profile 与结果放入已忽略的 `.scratch/subscription-library-browser-check/`，结束时关闭 Firefox 和模拟服务。

## 设备验收待补

`adb devices` 当前没有已连接设备。以下项目仍保留在 ticket 中：

- Android WebView 中实际导航、离线缓存和系统剪贴板。
- GKD 上的真实规则触发、多步骤顺序和结束后的清理。
- 支持本地规则接口的 GKD fork 中，回读导入后的参数、默认开关及引用，确认实际版本兼容。

浏览器模拟接口根据已核对的 fork 源码重现重编号行为；模拟检查通过不等于上述设备检查通过。
