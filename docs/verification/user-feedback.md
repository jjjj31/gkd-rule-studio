# 用户反馈实施与验收

日期：2026-10-29。规格：[用户反馈首版](../specs/user-feedback.md)。

## 实施范围

Android 首页、工作区、当前测试及渲染错误页均已接入反馈。基础信息可编辑，规则、截图、节点默认不选；截图经本地 PNG 重绘和不透明遮挡，节点使用字段白名单重建，并联动隐藏关联文字。凭据自动清除，最终材料必须预览并确认后才能提交。

本地使用 IndexedDB 保存已脱敏草稿。手动重试保留提交标识；重新整理内容未变时也复用该标识。服务器用 SQLite 的唯一提交标识与内容摘要持久判重。

原生桥只提供有限系统说明及最近一次 Java 崩溃摘要，最多 8 KiB，7 天过期；不读取全机日志或设备唯一 ID。

服务端使用 FastAPI、SQLite 和私有附件目录，提供登录收件箱、详情、按需单图预览、附件下载、状态标记、分页及彻底删除。正文、附件、联系方式和待通知任务在 90 天后清理。

## 当前部署

- 服务器：`my-server2`，独立容器 `gkd-feedback`，仅绑定 `127.0.0.1:8020`。
- 后台：`https://120.25.221.144/gkd-feedback/admin`。Nginx 剥离路径前缀，覆盖客户端提供的转发头，服务只信任独立 Docker 网桥的网关 `/32`。
- 管理员资料在本机 `~/.config/gkd-rule-studio/feedback-admin.local`，不在仓库、不在聊天或验证报告中输出。
- 配置变更前的 Nginx、Compose/env 备份位于 `~/skill-backups/gkd-feedback-<UTC时间>/`，同目录说明包含检查、升级和恢复命令。
- 已核实 IP 证书被客户端信任，自动续期 timer 已启用，Certbot 模拟续期成功。
- 邮件提醒按用户决定暂缓启用；SMTP 未配置，服务健康接口如实返回 `smtp_configured: false`。已保存反馈的通知任务等待以后配置，测试未发真实邮件。
- 独立域名受 DNS 缺失及云侧域名准入影响，详见 [部署条件](feedback-deployment-prerequisites.md)。用户确认先走 IP HTTPS；临时路径共享现有根站的 origin，后续迁移独立主机名。

## 已验证

| 项目 | 实际结果与证据 |
| --- | --- |
| 全仓前端测试 | 40 个文件、393 项通过；反馈专项为 18 项，包含响应体超时和 JSON Basic 凭据清除 |
| 类型与资源构建 | `pnpm run typecheck` 与 `pnpm run build:android-assets` 通过 |
| Android | ASCII 工作区 JDK 21 下最终 `assembleDebug testDebugUnitTest --rerun-tasks` 成功，3 个测试套件共 10 项、0 失败 |
| 浏览器 | 真实 Firefox 412×915，17 项通过：框选、纯黑像素、请求体脱敏、源数据不变、断网、重开恢复、同意框、幂等重试、未改内容重新预览复用编号、损坏草稿删除及无横向溢出 |
| 服务端 | 16 项通过：认证、CSRF、私有附件、尺寸与体积、异常输入、持久幂等、90 天清理、SMTP 重试，以及每日预算、删除不返还额度、失败事务不扣费、限流桶上限和 2 个任务并发限制 |
| 公网 API | 9 项真实 HTTPS 检查通过，含 Android null Origin 预检、登录、幂等、附件权限、状态和彻底删除；合成反馈已清除 |
| 真机端到端 | 已保留数据覆盖安装最终 APK；file:// WebView 下草稿、诊断、自然 OPTIONS、HTTPS 与真实 UI 提交均通过，收到 201 和反馈编号。通过管理员接口删除精确的合成反馈，确认正文、附件及 outbox 均清除，退出会话并移除 ADB forward |
| 后台网页 | 真实 Firefox 13 项通过：深链登录、脚本/样式/CSP/base、按需单图、状态修改、UI 删除、桌面/手机无横向溢出、模拟退出失败仍保持登录视图、真实退出后会话失效 |

浏览器、真机、后台页面及公网 API 的机器可读报告分别位于同目录的 `user-feedback-*-checks.json`。它们的验收范围各自标明，浏览器替身不冒充真实设备或公网投递。

生产保护：单来源每日最多 20 条／16 MiB，全局每日最多 200 条／64 MiB，另有每分钟限流、10,000 条／512 MiB 总容量和磁盘余量检查。每日额度持久化，不因重启或删除记录返还，幂等重试不重复扣费；限流使用私有盐的 HMAC 来源标识，预算记录最多保留两天。资源预算可在服务端私有 env 调整。

图谱已更新；新增反馈模块尚未进入当前图谱索引，因此新增调用关系另用源码搜索与上述测试核实。

最终调试 APK：`release/gkd-rule-studio-feedback-0.2.0-debug.apk`，SHA256 `e8881dbf302879f9a7b7d5ced2f4610cfaabae26287a34ff60e14f38e9436243`。仅生成本地安装包，未创建 GitHub Release。

收尾再次核对：服务端反馈和 outbox 均为 0 条，合成测试数据清除；容器使用约 36 MiB／256 MiB，原有根站仍返回 200。完成验收后重启本服务以清空测试触发的进程内登录限流，持久反馈和每日上传预算保持不变。部署摘要见 `user-feedback-deployment.json`。

## 重跑入口

运行目录：仓库根目录；Shell：PowerShell。

```powershell
pnpm test
pnpm run typecheck
python -X utf8 scripts/check-user-feedback.py
python -X utf8 scripts/check-feedback-service.py
python -X utf8 scripts/check-feedback-admin.py
python -X utf8 scripts/check-user-feedback-device.py
```

真机脚本默认仅做本地草稿与连接检查；加 `--submit-synthetic` 会实际投递一条固定合成反馈，并按精确编号在服务端删除。

服务端测试：运行目录 `server/feedback`；Shell：PowerShell。

```powershell
python -X utf8 -m unittest discover -s tests -v
```

升级服务：运行目录为仓库根目录；Shell：PowerShell。脚本保留既有服务端私有 env 和数据 volume，并在修改前生成备份。

```powershell
python -X utf8 scripts/deploy-feedback.py
```
