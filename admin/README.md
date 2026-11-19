# GKD Rule Studio 公告与版本管理后台（操作系统）

专为作者设计的轻量可视化公告与版本发布系统，**零外部依赖、无需编写任何代码**。

---

## 🌟 功能特性

- **图形化操作界面**：手机与电脑浏览器秒开，像写备忘录一样打字填空。
- **所见即所得**：内置右侧/下方实时手机端真机弹窗模拟，发前预览效果。
- **双模发布**：
  - `💬 普通公告`：文字说明、作者留言、交流群号，正文链接自动识别为蓝字超链接；
  - `🚀 版本更新`：填写新版本号与 APK 链接，手机端自动变身更新卡片并带【立即更新】按钮。
- **强提醒控制**：支持紧急强提醒开关（每次启动弹窗），平时默认只弹一次。
- **历史记录账本**：自动记录所有发布历史，支持一键载入重新发布。
- **全网一键启停**：界面顶部提供全局开关，随时关闭全网弹窗。

---

## 🚀 本地快速启动

在项目根目录运行命令：

```powershell
pnpm admin
```

或直接用 Node.js 启动：

```powershell
node admin/server.mjs
```

启动后在浏览器打开：
- **管理后台网址**：`http://localhost:8421`
- **默认管理密码**：`gkd-admin-2026`（可通过环境变量 `ADMIN_PASSWORD` 自定义）
- **客户端拉取接口**：`http://localhost:8421/api/announcement`

---

## 🌐 服务器一键部署指南（Linux / 云服务器）

服务仅使用 Node.js 原生标准库，无任何 `node_modules` 依赖，内存占用极低（< 15MB）。

### 1. 放置文件
在服务器（如 `/opt/gkd-announcement`）放置以下文件：
```text
/opt/gkd-announcement/
├── server.mjs
├── public/
│   └── index.html
├── announcement.json
└── announcement-history.json
```

### 2. 配置 Systemd 开机自启服务
创建 `/etc/systemd/system/gkd-announcement.service`：

```ini
[Unit]
Description=GKD Rule Studio Announcement Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/gkd-announcement
ExecStart=/usr/bin/node server.mjs
Restart=always
Environment=PORT=8421
Environment=ADMIN_PASSWORD=你的安全管理密码

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：
```bash
systemctl daemon-reload
systemctl enable --now gkd-announcement
```

### 3. 配置 Cloudflare Tunnel 或 Nginx 反代
将你的二级域名（例如 `notice.kmttjnm.me`）反向代理至 `127.0.0.1:8421` 即可：
- 访问 `https://notice.kmttjnm.me` 打开管理后台。
- 手机 App 自动请求 `https://notice.kmttjnm.me/api/announcement`。
