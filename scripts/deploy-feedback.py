"""Deploy the confirmed feedback service to my-server2 without printing secrets.

Run from the repository root, PowerShell: python -X utf8 scripts/deploy-feedback.py
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tarfile

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "server" / "feedback"
SCRATCH = ROOT / ".scratch" / "user-feedback-deploy"
SERVER = "my-server2"
REMOTE = "/opt/gkd-feedback"
PUBLIC = "https://120.25.221.144/gkd-feedback/"
# shortcut: this temporary path shares the existing site's origin; move to the independent hostname when DNS and domain admission are ready.
NGINX = "/etc/nginx/sites-available/ai-review-ip"
PRIVATE = Path(os.environ["USERPROFILE"]) / ".config" / "gkd-rule-studio"
ACCESS = PRIVATE / "feedback-admin.local"
STAMP = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
BACKUP = Path(os.environ["USERPROFILE"]) / "skill-backups" / f"gkd-feedback-{STAMP}"


def run(args: list[str], *, script: str | None = None, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(args, input=script.encode("utf-8") if script is not None else None, check=check,
                          capture_output=capture, timeout=900,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def ssh(script: str, *, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    return run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", SERVER, "bash", "-s"],
               script="set -euo pipefail\n" + script, capture=capture, check=check)


def main() -> None:
    import secrets
    SCRATCH.mkdir(parents=True, exist_ok=True)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    BACKUP.mkdir(parents=True, exist_ok=True)
    remote_env_exists = ssh(f"test -f {REMOTE}/.env", capture=True, check=False).returncode == 0
    base_image = "python:3.12.16-slim-bookworm"
    if ssh("docker image inspect python:3.12-slim >/dev/null 2>&1", capture=True, check=False).returncode == 0:
        base_image = "python:3.12-slim"
    if remote_env_exists and not ACCESS.exists():
        raise RuntimeError("服务器已有配置，但本机没有访问资料；请先恢复管理员资料，避免误覆盖。")
    if ACCESS.exists():
        access = json.loads(ACCESS.read_text(encoding="utf-8"))
    else:
        access = {"url": PUBLIC + "admin", "username": "admin", "password": secrets.token_urlsafe(24)}
        ACCESS.write_text(json.dumps(access, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(ACCESS, 0o600)
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", access["password"].encode(), salt, 600000)
    encoded_hash = "pbkdf2_sha256$600000$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()
    env_file = SCRATCH / "feedback.env"
    env_file.write_text(
        "ADMIN_USERNAME=admin\nADMIN_PASSWORD_HASH='" + encoded_hash + "'\n"
        "SESSION_COOKIE_SECURE=true\nFEEDBACK_DATA_DIR=/data\n"
        f"PUBLIC_BASE_URL={PUBLIC}\nALLOWED_ORIGINS=https://120.25.221.144\n"
        "TRUSTED_PROXY_IPS=\nRETENTION_DAYS=90\nMAX_STORAGE_BYTES=536870912\n"
        "SMTP_HOST=\nSMTP_PORT=465\nSMTP_SECURITY=ssl\nSMTP_USERNAME=\nSMTP_PASSWORD=\n"
        "SMTP_FROM=\nSMTP_TO=3428864257@qq.com\n", encoding="utf-8")
    archive = SCRATCH / "feedback.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        for file in sorted(SOURCE.rglob("*")):
            relative = file.relative_to(SOURCE)
            if any(part in {"__pycache__", ".ruff_cache", ".venv", "data", ".env"} for part in relative.parts):
                continue
            if file.is_file() and file.suffix != ".pyc":
                tar.add(file, arcname=str(relative).replace("\\", "/"))
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    remote_archive = f"/tmp/gkd-feedback-{STAMP}.tar.gz"
    release = f"{REMOTE}/releases/{STAMP}"
    image = f"gkd-feedback:{STAMP.lower()}"
    compose_file = SCRATCH / "compose.yaml"
    compose_file.write_text(f"""services:
  feedback:
    image: {image}
    container_name: gkd-feedback
    restart: unless-stopped
    init: true
    ports: ["127.0.0.1:8020:8080"]
    env_file: .env
    volumes: ["feedback-data:/data"]
    read_only: true
    tmpfs: ["/tmp:rw,noexec,nosuid,size=16777216"]
    mem_limit: 256m
    cpus: 0.5
    pids_limit: 128
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    networks: [feedback]
    logging:
      driver: json-file
      options: {{max-size: "5m", max-file: "2"}}
networks:
  feedback:
    external: true
    name: gkd-feedback-network
volumes:
  feedback-data:
    name: gkd-feedback-data
""", encoding="utf-8")
    print("备份当前 Nginx 配置，准备独立反馈服务。", flush=True)
    run(["scp", "-q", f"{SERVER}:{NGINX}", str(BACKUP / "nginx-before.conf")])
    for source_name in ("compose.yaml", ".env"):
        if ssh(f"test -f {REMOTE}/{source_name}", capture=True, check=False).returncode == 0:
            run(["scp", "-q", f"{SERVER}:{REMOTE}/{source_name}", str(BACKUP / source_name)])
    record = BACKUP / f"{BACKUP.name}.md"
    record.write_text(f"""# 反馈服务部署备份

时间：{STAMP}；服务器：`{SERVER}`。源码包 SHA256：`{checksum}`。
修改：新增 `/gkd-feedback/` 反代和独立容器；管理员资料只保存在本机 `{ACCESS}`。
Nginx 原配置为 `nginx-before.conf`；如已有 Compose/env，则一并备份。

检查（运行目录：任意目录；Shell：PowerShell）：
```powershell
ssh {SERVER} 'docker ps --filter name=gkd-feedback; nginx -t'
```

恢复路由（运行目录：本目录；Shell：PowerShell）：
```powershell
scp ./nginx-before.conf {SERVER}:{NGINX}
ssh {SERVER} 'nginx -t && systemctl reload nginx'
```

停止反馈容器（运行目录：任意目录；Shell：PowerShell，不删除持久数据）：
```powershell
ssh {SERVER} 'cd {REMOTE} && docker compose stop'
```

更新：在仓库根目录、PowerShell 中运行 `python -X utf8 scripts/deploy-feedback.py`。
如需回退镜像，将备份 compose.yaml 放回 `{REMOTE}/compose.yaml` 后执行 `docker compose up -d`；保留 data volume。
""", encoding="utf-8")
    try:
        ssh(f"mkdir -p {shlex.quote(release)} {REMOTE}/backups\nchmod 700 {REMOTE}\ncp {NGINX} {release}/nginx-before.conf")
        run(["scp", "-q", str(archive), f"{SERVER}:{remote_archive}"])
        if not remote_env_exists:
            run(["scp", "-q", str(env_file), f"{SERVER}:{REMOTE}/.env"])
        run(["scp", "-q", str(compose_file), f"{SERVER}:{release}/compose.yaml"])
        nginx_location = """
    # BEGIN gkd-feedback
    location = /gkd-feedback { return 308 /gkd-feedback/; }
    location ^~ /gkd-feedback/ {
        client_max_body_size 12m;
        proxy_pass http://127.0.0.1:8020/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_redirect off;
        proxy_read_timeout 45s;
        proxy_send_timeout 45s;
    }
    # END gkd-feedback
"""
        env_patch = """import os, pathlib, re
p=pathlib.Path('/opt/gkd-feedback/.env')
text=p.read_text()
text=re.sub(r'^TRUSTED_PROXY_IPS=.*$', 'TRUSTED_PROXY_IPS='+os.environ['FEEDBACK_GATEWAY']+'/32', text, flags=re.M)
if 'TRUSTED_PROXY_IPS=' not in text: text+='\\nTRUSTED_PROXY_IPS='+os.environ['FEEDBACK_GATEWAY']+'/32\\n'
p.write_text(text)
os.chmod(p,0o600)
"""
        nginx_patch = """import pathlib, re
n=pathlib.Path('/etc/nginx/sites-available/ai-review-ip')
text=n.read_text()
location=LOCATION
if '# BEGIN gkd-feedback' in text:
 text=re.sub(r'\\n    # BEGIN gkd-feedback.*?# END gkd-feedback\\n', '', text, flags=re.S)
needle='    server_name 120.25.221.144;'
if text.count(needle)!=1: raise SystemExit('Nginx IP server block does not match; left unchanged')
n.write_text(text.replace(needle,needle+'\\n'+location,1))
""".replace("LOCATION", repr(nginx_location))
        remote_script = f"""echo {shlex.quote(checksum + '  ' + remote_archive)} | sha256sum -c -
tar -xzf {remote_archive} -C {release} --no-same-owner
rm -f {remote_archive}
docker build --pull=false --build-arg PYTHON_IMAGE={base_image} -t {image} {release}
if ! docker network inspect gkd-feedback-network >/dev/null 2>&1; then docker network create gkd-feedback-network; fi
export FEEDBACK_GATEWAY=$(docker network inspect gkd-feedback-network --format '{{{{(index .IPAM.Config 0).Gateway}}}}')
python3 - <<'PY'
{env_patch}
PY
cp {release}/compose.yaml {REMOTE}/compose.yaml
cd {REMOTE}
docker compose up -d
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8020/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8020/healthz
python3 - <<'PY'
{nginx_patch}
PY
if ! nginx -t; then cp {release}/nginx-before.conf {NGINX}; exit 1; fi
systemctl reload nginx
for attempt in $(seq 1 15); do
  if curl -fsS https://120.25.221.144/gkd-feedback/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done
curl --fail --silent --show-error https://120.25.221.144/gkd-feedback/healthz
echo
docker ps --filter name=gkd-feedback --format '{{{{.Names}}}} {{{{.Status}}}} {{{{.Ports}}}}'
"""
        ssh(remote_script)
        (SCRATCH / "deployment.json").write_text(json.dumps({"time": STAMP, "image": image,
            "sha256": checksum, "base_image": base_image, "backup": str(BACKUP), "admin_url": PUBLIC + "admin"}, indent=2), encoding="utf-8")
        print(f"反馈后台已部署：{PUBLIC}admin\n管理员资料：{ACCESS}\n配置备份：{BACKUP}", flush=True)
    finally:
        env_file.unlink(missing_ok=True)
        archive.unlink(missing_ok=True)
        compose_file.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
