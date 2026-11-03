# 反馈后台部署前置检查

- 检查时间：2026-10-29 19:27 CST
- 检查范围：DNS、`my-server2`、Nginx/TLS、Docker、SMTP、DNS 管理入口、本地 Android 与浏览器验收入口
- 检查方式：本机和服务器上的只读命令、DNS 公开解析、HTTP/HTTPS 连通性探测
- 安全边界：未修改服务器、DNS、邮件或本地配置；未发送邮件；未输出、复制或测试任何凭据值

## 结论

域名公网路径暂不可用，但用户已选择的 IP HTTPS 临时上线方案可用。服务可以放在 `my-server2`，通过 `https://120.25.221.144/gkd-feedback/` 接入；域名接入仍受阿里云备案拦截和 DNS 缺失影响。邮件提醒暂缓配置，不阻塞网页后台先上线。

| 项目 | 状态 | 结论 |
| --- | --- | --- |
| `feedback.kmttjnm.me` DNS | 阻塞 | A/AAAA 均为空，公开解析返回 NXDOMAIN |
| 阿里云域名接入 | 阻塞 | 域名 Host 被阿里云边缘以 `Non-compliance ICP Filing` 拒绝 |
| `my-server2` SSH/Docker | 可用 | SSH 可直达，Docker 与 Compose 正常，`8020` 空闲 |
| Nginx | 可用但未配置反馈站 | 80/443 正常监听，当前没有 `feedback.kmttjnm.me` 的 server 配置 |
| IP HTTPS 临时上线 | 可用 | 证书只覆盖服务器 IP、浏览器当前可信；主 agent 的续期 dry-run 已通过 |
| TLS 域名路径 | 域名暂阻 | 现有 IP 证书不能用于域名；域名访问仍需先解除阿里云备案拦截、配置 DNS 并另行签发域名证书 |
| 邮件通知 | 暂缓，不阻塞网页上线 | 没有可复用 SMTP 配置或本地 SMTP 服务，公共 QQ SMTP 端口可达但没有认证信息 |
| DNS 自动管理 | 阻塞 | 未发现 Namecheap API 命令、配置或环境变量入口 |
| 本地浏览器验收 | 可用 | Playwright MCP、Playwright 1.60.0、Chrome、Edge 均可用 |
| 本地 Android 验收 | 可用 | JDK 21、SDK、ADB、Gradle 和已授权设备可用，运行时需显式设置 `JAVA_HOME` |

## 1. DNS 与权威解析

本次查询结果：

- `feedback.kmttjnm.me` 的 A 记录：不存在。
- `feedback.kmttjnm.me` 的 AAAA 记录：不存在。
- 公开解析状态：NXDOMAIN。
- `kmttjnm.me` 的权威 NS：`dns1.registrar-servers.com`、`dns2.registrar-servers.com`。
- 按权威 NS 判断，当前 DNS 服务为 Namecheap BasicDNS。
- `kmttjnm.me` 当前 A 记录为 `39.108.141.70`，没有查到 AAAA 记录。
- 公开查询没有得到 CAA 记录。

目标 A 记录应为：

```text
feedback.kmttjnm.me.  A  120.25.221.144
```

本次没有写入该记录。若未来需要 IPv6，还应先确认 `my-server2` 有可用的公网 IPv6 地址和入站策略，再添加 AAAA；不能仅为补齐记录类型而写入无法服务的地址。

## 2. 阿里云备案/域名准入阻碍

从本机访问 `my-server2` 时：

- 直接访问 IP 的 HTTP 80：返回 Nginx `200 OK`。
- 直接访问 IP 的 HTTPS 443：返回 Nginx `200 OK`。
- 使用 `Host: feedback.kmttjnm.me` 访问 HTTP：被阿里云边缘拦截，页面标题为 `Non-compliance ICP Filing`，响应头为 `Server: Beaver`。
- 使用 `feedback.kmttjnm.me` 作为 TLS SNI 访问 HTTPS：连接被重置。
- 在服务器本机访问相同 Host：Nginx 返回 `200`。

因此端口和 Nginx 本身是通的，问题发生在阿里云的备案/站点准入层。这个阻碍会同时影响公网访问和 Certbot HTTP-01 验证。即使先创建 DNS 记录，也需要先在阿里云侧完成该域名/实例的备案或准入处理，才能把公网 HTTPS 标记为可用。

这项处理涉及阿里云控制台与备案主体信息，本次检查没有读取或修改相关内容。

## 3. my-server2 当前状态

SSH 别名 `my-server2`：

- Host：`120.25.221.144`
- Port：`22`
- User：`root`
- SSH BatchMode 登录成功，普通 sudo 检查成功。

主机资源：

- OS：Ubuntu 24.04.2 LTS，Linux 6.8.0-63-generic。
- CPU：2 vCPU。
- 内存：总约 1.6 GiB，检查时可用约 936 MiB。
- 根分区：40 GiB，已用 11 GiB，剩余约 28 GiB。
- 系统提示有 93 个待更新包，并要求重启；这不是本任务造成的，也未在本任务中处理。

Nginx：

- 版本：nginx/1.24.0 (Ubuntu)。
- 服务：active、enabled。
- 80 和 443 均在 IPv4/IPv6 监听。
- `nginx -T` 中没有 `feedback.kmttjnm.me` 的 `server_name`。
- UFW：inactive。公网能否访问仍同时受云安全组、阿里云备案/WAF 平台规则约束。
- 当前 active 的 443 配置只有一个：`/etc/nginx/sites-enabled/ai-review-ip`。
- 443 路径的现有用途是：将 IP HTTPS 的根路径 `/` 反代到 `127.0.0.1:8010` 的 `ai-review` 服务。
- 已核实 active 配置中没有 `/gkd-feedback/` location；`8020` 当前也没有监听。

现有 443 配置中与本项检查相关的摘录：

```text
/etc/nginx/sites-enabled/ai-review-ip
listen 443 ssl http2;
server_name 120.25.221.144;
ssl_certificate /etc/letsencrypt/live/120.25.221.144/fullchain.pem;
location / { ... proxy_pass http://127.0.0.1:8010; }
```

现有 TLS：

- 证书目录：`/etc/letsencrypt/live/120.25.221.144/`。
- 类型：Let's Encrypt ECDSA。
- SAN：仅有 `IP Address:120.25.221.144`。
- 有效期至：2026-11-02 13:17:03 UTC，即 2026-11-02 21:17:03 CST。
- 该证书不能作为 `feedback.kmttjnm.me` 的正式证书。
- Certbot：5.8.0。
- 当前续期 authenticator：webroot。
- `certbot-renew.timer` 为 enabled，每日多次运行，最近一次运行状态为成功。
- 2026-10-29，**主 agent 实际执行**了：

  ```text
  certbot renew --dry-run --cert-name 120.25.221.144 --non-interactive
  ```

  输出为 `Congratulations, all simulated renewals succeeded`。这项续期演练是主 agent 的实际验证，不是本检查文档执行者运行的命令。

### IP HTTPS 临时上线方案

- Windows `curl.exe` 不使用 `-k` 访问 `https://120.25.221.144/`，TLS 校验通过并收到 HTTP 200。
- Playwright/浏览器实际打开 `https://120.25.221.144/`，没有证书拦截，页面标题为“学习”；当前浏览器信任该 IP 证书。
- PowerShell `Invoke-WebRequest` 的 HEAD 请求返回 405，但已经完成 TLS 握手并收到 HTTP 响应，不是证书错误。
- 证书链由公开可信的 Let's Encrypt 签发；SAN 精确包含目标 IPv4，因此 `https://120.25.221.144/...` 当前可作为临时入口。
- 当前证书将在 2026-11-02 21:17:03 CST 到期；续期 timer 已启用、每日多次运行且最近成功，主 agent 的模拟续期也已通过，因此续期路径已具备可用证据。
- 正式上线后仍应在证书实际续期后复核新证书的 SAN 和有效期；模拟续期通过不等于已经签发了新证书。

### `/gkd-feedback/` 临时路径反代可行性

技术上可以在现有 `120.25.221.144` 的 443 server 中新增一个更具体的 location，不搬迁或改写现有根 location：

```nginx
location /gkd-feedback/ {
    proxy_pass http://127.0.0.1:8020/;
}
```

`proxy_pass` 末尾的 `/` 会执行 strip：例如外部 `/gkd-feedback/api/items` 会由后端收到 `/api/items`。Nginx 的前缀匹配规则会让 `/gkd-feedback/` 优先于现有 `/`，因此现有 `location /` 和 `127.0.0.1:8010` 路由无需改动。本次没有写入该配置，也不存在同名 location 冲突。

启用前还要核实应用自身兼容性：

- 前端资源如果生成根绝对路径（例如 `/assets/...` 或 `/api/...`），会绕过 `/gkd-feedback/` 并落到现有根站点；应用必须配置 `/gkd-feedback/` 作为 base path，或改用相对路径。
- Cookie 的 Path 应限制到 `/gkd-feedback/`，避免和同一 IP origin 下的现有站点冲突。
- 浏览器 localStorage/IndexedDB 按 origin 共享，不能按 URL path 隔离；反馈后台应使用独立键名前缀或独立 origin。
- `8020` 后端目前不存在，反代连通、重定向、静态资源、上传大小和 WebSocket 等只能等服务实际启动后做集成验收。

Docker：

- Docker Server：29.8.0。
- Docker Compose：v5.5.1。
- Storage Driver：overlayfs。
- 容器：共 3 个，运行中 2 个。
- 运行中服务：`ai-review`（`127.0.0.1:8010`）、`workbuddy2api`（`127.0.0.1:7863`）。
- 镜像：16 个，约 2.432 GB，其中约 1.581 GB 可回收。
- Build Cache：约 2.195 GB，其中约 110.8 MB 可回收。
- Local Volumes：0 B。
- `8020` 当前没有监听。

部署位置：

- `/opt/feedback`、`/srv/feedback`、`/var/www/feedback` 均不存在。
- 建议使用 `/opt/feedback` 存 Compose 与部署配置，持久数据使用 Docker volume 或明确的持久目录。
- 建议容器端口绑定为 `127.0.0.1:8020:8020`，Nginx 仅反代到此地址，避免绕过 Nginx 暴露服务。
- 按当前余量，轻量 Python/Node 服务可以部署；建议设置约 256-384 MiB 容器内存上限，并在上线前做一次与目标实现相符的压测。该资源上限是基于当前余量的建议，不是已实施值。

## 4. SMTP 与本地邮件服务

已检查但没有发现：

- 本机或服务器进程环境中的 SMTP/MAIL/EMAIL/SENDGRID/POSTMARK/MAILGUN/RESEND 变量名。
- `/opt`、`/srv`、`/var/www` 下部署环境文件中的相关邮件变量名。
- 运行中 Docker 容器环境里的相关邮件变量名。
- Postfix、Exim、Docker Mailserver、Mailpit 等活动服务。
- 本机 25、465、587、2525 端口上的本地 SMTP 服务。

服务器出站 TCP 检查：

- `smtp.qq.com:465`：可达。
- `smtp.qq.com:587`：可达。
- `smtp.qq.com:25`：不可达。

上述检查只建立 TCP 连接，没有登录 SMTP、没有发送邮件，也没有输出或使用任何凭据。当前没有收件提醒所需的发信账号和服务配置，因此不能宣称邮件发送可用。上线前必须提供并配置经授权的 SMTP 服务；QQ SMTP 通常还需要账号侧启用服务并使用授权码，但本次没有核实账号状态。

## 5. DNS 管理入口

已检查本机和服务器的以下入口，均未发现当前可用的 Namecheap/DNS 自动化配置：

- 命令：`namecheap-api`、`ncctl`、`aliyun`、`tccli`、`aws`、`gcloud`、`wrangler`、`cloudflared`、`lego`、`acme.sh`。
- 常见配置路径：Namecheap、Aliyun、Tencent/DNSPod、Cloudflare、Wrangler、rclone、lego、通用 secrets 目录。
- 只在环境中匹配变量名，未读取变量值；没有匹配的 DNS/API 变量。
- 本机只有通用 `~/.aws` 路径存在；其内容没有检查，也不能证明它可以管理 Namecheap 的 `kmttjnm.me` 区域。
- 工具台账没有 Namecheap 相关登记。

按现有证据，不能在不进行人工操作的情况下完成：

1. 在 Namecheap 控制台或 API 创建 `feedback` A 记录。
2. 在阿里云侧处理 `Non-compliance ICP Filing` 准入。

若要后续自动化，需要用户明确提供一条已获授权的 Namecheap API 使用路径，或先在控制台完成域名接入准备；凭据值应只进入服务器密钥/环境配置，不应写入仓库或本检查文档。

## 6. 本地 Android 与浏览器验收入口

已核实可用：

- Rule Studio ASCII junction：`C:\Users\kmttjnm\.local\worktrees\gkd-rule-builder-ascii`。
- JDK：Temurin 21.0.11+10。
- Android SDK junction：`C:\Users\kmttjnm\.local\tools\android-sdk-current`。
- `sdkmanager`：20.0；显式设置 `JAVA_HOME` 后可运行。
- ADB：1.0.41 / 37.0.0。
- 当前设备：1 台 `device` 状态，0 台 `unauthorized`。检查结果没有记录设备序列号。
- Android wrapper：Gradle 8.10.2、Kotlin 1.9.24。
- Android Gradle 使用项目指定的 JDK 21；显式设置 SDK 环境后，`gradlew.bat --version` 通过。
- 前端：Node v24.13.1、pnpm 10.33.2。
- Playwright CLI：1.60.0。
- Playwright MCP 已实际打开无外部数据的 `data:` 测试页并成功关闭。
- 本机存在 Chrome 与 Edge。

本地浏览器预览入口：

```powershell
# Shell: PowerShell
# Run dir: C:\Users\kmttjnm\.local\worktrees\gkd-rule-builder-ascii
pnpm run dev
```

服务监听 `127.0.0.1:5174`。后续可用 Playwright MCP 做页面操作、网络请求和截图验收。

本地 Android 构建入口：

```powershell
# Shell: PowerShell
# Run dir: C:\Users\kmttjnm\.local\worktrees\gkd-rule-builder-ascii
$env:JAVA_HOME = 'C:\Users\kmttjnm\.local\tools\jdk21-current'
$env:ANDROID_HOME = 'C:\Users\kmttjnm\.local\tools\android-sdk-current'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
pnpm run build:android-assets
Push-Location .\android
.\gradlew.bat assembleDebug
Pop-Location
```

直接调用 `sdkmanager` 而不设置 `JAVA_HOME` 会命中系统 JDK 11 并失败；从普通自动化入口调用 Gradle 也可能误用 JDK 11。因此每次构建前都应显式设置上述环境变量。SDK manager 还会提示现有 SDK XML 版本比工具理解的版本新；本次版本查询仍成功，后续正式构建若遇到兼容错误再处理。

## 7. 建议的解锁顺序

1. 按用户已确认的方案，先使用 `https://120.25.221.144/gkd-feedback/` 作为临时入口；轻量服务部署到 `/opt/feedback`，容器仅绑定 `127.0.0.1:8020`。
2. 在现有 `120.25.221.144` 443 server 内增加 `/gkd-feedback/` 的 strip 反代，并验证前端 base path、Cookie Path 和存储键隔离。
3. 验证 IP HTTPS、服务端接口、浏览器端和 Android 端；邮件通知暂缓，不阻塞网页后台上线。
4. 确认自动续期实际签发的新证书仍含 IP SAN 且浏览器可信。
5. 后续切换域名路径时，再在阿里云处理备案/站点准入，并创建 `feedback.kmttjnm.me A 120.25.221.144`；不要在没有 IPv6 服务时添加 AAAA。
6. 域名接入后为 `feedback.kmttjnm.me` 单独签发证书。当前 IP 证书不能复用为域名证书。
7. 邮件发信配置恢复时，再接入经授权的 SMTP，并验证“邮件失败不撤销已保存反馈”的重试逻辑。

## 8. 本次未执行的操作

- 未写入 DNS 记录、未修改权威 DNS。
- 未修改阿里云备案、站点、安全组或 WAF 配置。
- 未安装或更新 Nginx、Docker、Certbot。
- 未创建 Nginx 站点或申请证书。
- 未执行 `certbot renew --dry-run`；该项由主 agent 另行实际执行并已通过。
- 未修改 SMTP、系统服务或仓库配置。
- 未发送测试邮件。
- 未读取或输出任何密钥、密码、API 值和 SMTP 凭据。
