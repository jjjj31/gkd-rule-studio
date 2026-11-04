"""Exercise the deployed service using synthetic data, then remove it.

Run in the repository root, PowerShell: python -X utf8 scripts/check-feedback-service.py
The local administrator file is read in-process; credentials are never printed.
"""
from __future__ import annotations

import base64
import datetime as dt
import http.cookiejar
import io
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid
import zipfile

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
ACCESS = Path(os.environ["USERPROFILE"]) / ".config" / "gkd-rule-studio" / "feedback-admin.local"
REPORT = ROOT / "docs" / "verification" / "user-feedback-service-checks.json"


def main() -> None:
    access = json.loads(ACCESS.read_text(encoding="utf-8"))
    base = access["url"].rsplit("/admin", 1)[0] + "/"
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
    checks: list[str] = []
    feedback_id = ""
    csrf = ""

    def request(path: str, method: str = "GET", body=None, headers=None, *, anonymous=False):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request_headers = {"Content-Type": "application/json"} if body is not None else {}
        request_headers.update(headers or {})
        req = urllib.request.Request(base + path, data=data, headers=request_headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=30) if anonymous else opener.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            value = json.loads(raw) if "application/json" in response.headers.get("Content-Type", "") and raw else raw
            return response.status, value, response.headers

    try:
        status, health, _ = request("healthz")
        assert status == 200 and health["status"] == "ok"
        checks.append("public_https_health")
        status, _, headers = request("api/feedback", "OPTIONS", headers={
            "Origin": "null", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,idempotency-key"}, anonymous=True)
        assert status == 204 and headers.get("Access-Control-Allow-Origin") == "null"
        checks.append("android_null_origin_preflight")
        assert request("admin/api/feedback", anonymous=True)[0] == 401
        checks.append("anonymous_inbox_denied")
        assert request("admin/api/login", "POST", {"username": access["username"], "password": access["password"]})[0] == 200
        status, session, _ = request("admin/api/session")
        assert status == 200
        csrf = session["csrfToken"]
        assert all(cookie.secure for cookie in cookies)
        checks.append("administrator_login_secure_cookie")
        client_id = str(uuid.uuid4())
        png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdosAAAAASUVORK5CYII=")
        diagnostic_buffer = io.BytesIO()
        with zipfile.ZipFile(diagnostic_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "matching-diagnostics/synthetic/diagnostic.json",
                json.dumps({"versionName": "1.13.0-beta-5", "trackingComplete": True}),
            )
        diagnostic_zip = diagnostic_buffer.getvalue()
        payload = {"version": 1, "clientId": client_id, "category": "feature",
            "description": "[自动验收] 合成功能建议与 GKD 诊断材料：此条会在检查结束后删除。", "contact": "",
            "context": {
                "appVersion": "synthetic",
                "systemVersion": "synthetic",
                "gkdVersion": "1.13.0-beta-5 (97)",
                "gkdChannel": "测试版",
                "page": "smoke-test",
                "error": "synthetic error",
            },
            "attachments": [
                {"name": "synthetic.png", "mimeType": "image/png", "data": base64.b64encode(png).decode()},
                {"name": "synthetic-diagnostics.zip", "mimeType": "application/zip",
                 "data": base64.b64encode(diagnostic_zip).decode()},
            ]}
        status, result, headers = request("api/feedback", "POST", payload, {"Origin": "null", "Idempotency-Key": client_id}, anonymous=True)
        assert status == 201 and headers.get("Access-Control-Allow-Origin") == "null"
        feedback_id = result["id"]
        status, duplicate, _ = request("api/feedback", "POST", payload, {"Origin": "null"}, anonymous=True)
        assert status == 200 and duplicate["id"] == feedback_id
        changed = dict(payload, description="different synthetic payload")
        assert request("api/feedback", "POST", changed, anonymous=True)[0] == 409
        checks.append("persistent_idempotent_submission_and_conflict")
        path = "admin/api/feedback/" + feedback_id
        status, detail, _ = request(path)
        assert status == 200 and detail["description"] == payload["description"]
        assert detail["category"] == "feature"
        assert detail["context"]["gkdChannel"] == "测试版"
        assert detail["context"]["gkdVersion"] == "1.13.0-beta-5 (97)"
        attachments = {item["name"]: item for item in detail["attachments"]}
        assert set(attachments) == {"synthetic.png", "synthetic-diagnostics.zip"}
        image_path = path + "/attachments/" + attachments["synthetic.png"]["id"]
        zip_path = path + "/attachments/" + attachments["synthetic-diagnostics.zip"]["id"]
        assert request(image_path, anonymous=True)[0] == 401
        status, image, headers = request(image_path)
        assert status == 200 and image == png and "attachment" in headers.get("Content-Disposition", "")
        status, archived_diagnostics, headers = request(zip_path)
        assert status == 200 and archived_diagnostics == diagnostic_zip
        assert "attachment" in headers.get("Content-Disposition", "")
        checks.append("feature_zip_and_gkd_contract")
        checks.append("authenticated_attachment_and_anonymous_denial")
        assert request(path, "PATCH", {"status": "resolved"})[0] == 403
        assert request(path, "PATCH", {"status": "resolved"}, {"X-CSRF-Token": csrf})[0] == 200
        assert request(path)[1]["status"] == "resolved"
        checks.append("csrf_and_status_transition")
        assert request(path, "DELETE", headers={"X-CSRF-Token": csrf})[0] == 204
        assert request(path)[0] == 404
        assert request(image_path)[0] == 404 and request(zip_path)[0] == 404
        feedback_id = ""
        checks.append("permanent_feedback_and_attachment_deletion")
        assert request("admin/api/logout", "POST", headers={"X-CSRF-Token": csrf})[0] == 204
        csrf = ""
        assert request("admin/api/session")[0] == 401
        checks.append("logout_revokes_session")
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps({"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "base_url": base, "status": "passed", "smtp_configured": health["smtp_configured"],
            "synthetic_data_removed": True, "checks": checks}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"公网反馈服务检查通过：{len(checks)} 项；合成反馈已删除。邮件配置：{health['smtp_configured']}")
    finally:
        if feedback_id and csrf:
            request("admin/api/feedback/" + feedback_id, "DELETE", headers={"X-CSRF-Token": csrf})
        if csrf:
            request("admin/api/logout", "POST", headers={"X-CSRF-Token": csrf})


if __name__ == "__main__":
    main()
