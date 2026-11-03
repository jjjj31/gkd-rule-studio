# GKD 反馈接收服务

FastAPI + SQLite 的小型反馈接收器和私有管理后台。公开入口只有提交反馈和健康检查；管理接口必须登录，并通过 CSRF 校验后才能修改或删除数据。

## 目录与数据

- app/main.py：API、校验、SQLite、登录会话、后台、通知 outbox、限流和定期维护。
- app/web/：无内联脚本的中文响应式管理后台。
- tests/test_app.py：使用标准库 unittest 和自建 ASGI 调用器，不引入额外测试框架。
- 运行时数据：feedback.sqlite3、attachments/ 和权限为 0600 的 ip_hash_salt，默认位于 FEEDBACK_DATA_DIR。

## 配置管理员

运行目录：server/feedback

Shell：PowerShell

~~~powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m app
~~~

命令会隐藏输入并输出一次 PBKDF2-SHA256 密码哈希。把哈希原样写入私有的 ADMIN_PASSWORD_HASH 环境变量；不要把管理员密码或哈希提交到仓库。服务只接受 ADMIN_PASSWORD_HASH，不保存管理员明文密码。

必需变量：

- ADMIN_USERNAME：管理员用户名。
- ADMIN_PASSWORD_HASH：python -m app 生成的 PBKDF2 哈希。
- PUBLIC_BASE_URL：外部可访问的根 URL，可带路径，但不得包含查询参数。
- SESSION_COOKIE_SECURE：生产保持 true。仅本机纯 HTTP 联调时设为 false。
- ALLOWED_ORIGINS：可选的浏览器 Origin 列表，逗号分隔，只写 scheme://host，不带路径。PUBLIC_BASE_URL 的 Origin 会自动加入。
- TRUSTED_PROXY_IPS：可选的 Nginx 来源 IP/CIDR，逗号分隔。直连 Uvicorn 时留空。
- SUBMIT_DAILY_IP_COUNT / SUBMIT_DAILY_IP_BYTES：每个匿名来源每 UTC 天默认 20 条、16 MiB。
- SUBMIT_DAILY_GLOBAL_COUNT / SUBMIT_DAILY_GLOBAL_BYTES：全局每 UTC 天默认 200 条、64 MiB。
- SUBMIT_CONCURRENCY：同时解析并持久化的公开提交数，默认且最多为 2。

全部可调项见 .env.example。

## 本机运行

运行目录：server/feedback

Shell：PowerShell

~~~powershell
$env:FEEDBACK_DATA_DIR = (Join-Path $PWD 'data')
$env:ADMIN_USERNAME = '<使用你的私有配置>'
$env:ADMIN_PASSWORD_HASH = '<粘贴 python -m app 的输出>'
$env:SESSION_COOKIE_SECURE = 'false'
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8080 --workers 1
~~~

浏览器访问 http://127.0.0.1:8080/admin。不要用这个本机地址作为生产配置。

健康检查：

~~~powershell
Invoke-RestMethod http://127.0.0.1:8080/healthz
~~~

返回只包含 status 和 smtp_configured。SMTP 缺配置时服务仍正常启动，反馈和 outbox 会先持久化；后台通知保持待发。

## Docker 运行

运行目录：server/feedback

Shell：PowerShell

~~~powershell
docker build -t gkd-feedback:local .
Copy-Item .env.example .env
# 私密编辑 .env，填入管理员配置和实际 SMTP 配置。
docker run --detach --name gkd-feedback --restart unless-stopped --env-file .env -v gkd-feedback-data:/data -p 127.0.0.1:8020:8080 gkd-feedback:local
docker ps --filter name=gkd-feedback
docker logs --tail 50 gkd-feedback
~~~

不要提交 .env。Dockerfile 固定 Python 3.12.16，requirements.txt 固定 FastAPI 0.162.0 和 Uvicorn 0.54.0。容器保持单 worker；进程内 IP 限流不支持多 worker 横向扩展。

## HTTPS、路径前缀与 Nginx

已确认的当前生产入口是 https://120.25.221.144/gkd-feedback/，Nginx 剥离 /gkd-feedback/ 后转发到 127.0.0.1:8020/。域名和备案完成后才切换到默认域名。

示例配置要点：

~~~nginx
location = /gkd-feedback {
    return 301 /gkd-feedback/;
}

location /gkd-feedback/ {
    client_max_body_size 12m;
    proxy_pass http://127.0.0.1:8020/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
~~~

对应私有环境：

~~~dotenv
PUBLIC_BASE_URL=https://120.25.221.144/gkd-feedback/
ALLOWED_ORIGINS=https://120.25.221.144
SESSION_COOKIE_SECURE=true
~~~

浏览器后台地址是 https://120.25.221.144/gkd-feedback/admin。服务端按 PUBLIC_BASE_URL 的路径注入 base 标签，因此根路径和带前缀、带或不带尾斜杠都会解析到同一组 admin/static 与 admin/api；SESSION Cookie 的 Path 推导为 /gkd-feedback/admin，邮件后台链接也保留 /gkd-feedback 前缀。

TRUSTED_PROXY_IPS 必须填 Nginx 到 Uvicorn 时实际看到的来源 IP/CIDR。只有直接来源命中该集合时，服务才读取 X-Forwarded-For；否则使用 TCP 来源地址，避免客户端伪造 IP 绕过限流。不要把公网网段或 0.0.0.0/0 填入。

公开提交 CORS 仅作用于 POST /api/feedback 和其 OPTIONS：允许 Android file:// 的 Origin: null、部分 WebView 未发送 Origin 的 OPTIONS 预检，以及 PUBLIC_BASE_URL/ALLOWED_ORIGINS 中的精确 Origin；允许 Content-Type、Accept 和 Idempotency-Key 请求头，且不启用 credentials。非法非空 Origin 不返回 CORS 许可，管理接口没有 CORS 放开。

域名迁移时修改 PUBLIC_BASE_URL 为 https://feedback.kmttjnm.me、把 ALLOWED_ORIGINS 换成 https://feedback.kmttjnm.me，并让 Nginx 把根路径转发到同一上游。旧 IP Origin 可从 ALLOWED_ORIGINS 移除；Cookie Path 会随新 URL 的根路径变为 /admin。

## SMTP 和通知

收件人默认是 3428864257@qq.com，也可通过 SMTP_TO 改；SMTP_HOST、SMTP_PORT、SMTP_SECURITY、SMTP_FROM、SMTP_USERNAME、SMTP_PASSWORD 由私有环境提供。

- SMTP_SECURITY 可选 starttls、ssl、none。
- SMTP 用户名和密码必须同时配置或同时留空。
- 缺配置不阻止启动，outbox 不会丢。
- 配置后重启会继续处理积压 outbox；失败使用指数退避重试。
- 邮件只包含编号、脱敏短摘要和后台链接，不包含联系方式或附件。
- 联调真实 SMTP 前先取得主 agent 确认，并只提交合成测试数据。

## 测试

运行目录：server/feedback

Shell：PowerShell

~~~powershell
python -X utf8 -m unittest discover -s tests -v
~~~

测试使用临时 SQLite 数据库和模拟 SMTP 失败，不会真实发信。

仓库内的 .gitignore 和 .dockerignore 已排除 .env、data、虚拟环境、__pycache__ 和 Python 字节码。主 agent 制作部署临时包时也应排除 .test-venv、.venv、data、__pycache__、*.pyc 与 .env，避免把测试缓存或秘密打进去。

## 备份、恢复与维护

90 天保留期在启动时执行一次，之后每小时再次执行；重启不会跳过维护。过期反馈、联系方式、附件、会话和对应 outbox 会删除。单个反馈最多 4 个附件，解码总量最多 8 MiB；请求体 12 MiB 封顶；默认最多 10000 条、512 MiB，并保留 64 MiB 磁盘余量。

公开提交另有持久化的 UTC 日预算：每个 IP 默认 20 条、16 MiB，全局默认 200 条、64 MiB，描述、联系方式、上下文和附件名称等元数据也计入字节数。额度检查与反馈写入在同一个 SQLite 事务中完成；只有成功提交才扣额度，幂等重放不扣额度，删除反馈也不会返还当天额度。额度耗尽返回 429，并通过 Retry-After 指向下一个 UTC 日。IP 仅以私有盐 HMAC 摘要写入额度表，不保存明文。日预算行最多保留当前和前一 UTC 日，由同一次清理任务删除更旧记录。

备份或恢复时先停容器，避免 SQLite WAL 和附件不一致。

~~~powershell
docker stop gkd-feedback
docker run --rm -v gkd-feedback-data:/data -v "$((Get-Location).Path):/backup" python:3.12.16-slim-bookworm tar -czf /backup/gkd-feedback-data.tar.gz -C /data .
docker start gkd-feedback
~~~

恢复到同名的空数据卷：

~~~powershell
docker stop gkd-feedback
docker volume rm gkd-feedback-data
docker volume create gkd-feedback-data
docker run --rm -v gkd-feedback-data:/data -v "$((Get-Location).Path):/backup" python:3.12.16-slim-bookworm tar -xzf /backup/gkd-feedback-data.tar.gz -C /data
docker start gkd-feedback
~~~

回滚应用时重新运行上一版镜像即可；数据库结构由服务启动时的幂等建表语句初始化。生产升级前仍应先做上述冷备份。

## 接口

- GET /healthz
- POST /api/feedback
- GET /admin
- POST /admin/api/login
- GET /admin/api/session
- POST /admin/api/logout
- GET /admin/api/feedback
- GET/PATCH/DELETE /admin/api/feedback/{id}
- GET /admin/api/feedback/{id}/attachments/{attachmentId}

公开提交使用合同 version 1。description 最长 4000、contact 最长 200；context 只接受 appVersion、systemVersion、page、error 四个字符串，长度上限依次为 200、500、200、4000。附件只接受 image/png、text/plain、application/json；PNG 检查文件签名，application/json 必须是 UTF-8 合法 JSON。服务器只使用随机磁盘文件名；下载始终带 attachment Content-Disposition 和 sandbox CSP。
