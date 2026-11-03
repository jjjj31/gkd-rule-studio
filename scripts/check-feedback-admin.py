"""Verify the deployed feedback admin UI with synthetic data, then remove it.

Run in the repository root, PowerShell:
python -X utf8 scripts/check-feedback-admin.py

Administrator credentials are read in-process from the local-only JSON file.
They are never printed, copied into the repository, or included in the report.
"""
from __future__ import annotations

import base64
import datetime as dt
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit, urlunsplit
import urllib.request
import uuid
import zlib

from ruyipage import launch


sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
ACCESS_PATH = (
    Path(os.environ["USERPROFILE"])
    / ".config"
    / "gkd-rule-studio"
    / "feedback-admin.local"
)
REPORT_PATH = ROOT / "docs" / "verification" / "user-feedback-admin-checks.json"
SCREENSHOT_PATH = ROOT / "docs" / "verification" / "user-feedback-admin.png"


def make_synthetic_png() -> bytes:
    width, height = 64, 48
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            border = x in {0, width - 1} or y in {0, height - 1}
            checker = ((x // 8) + (y // 8)) % 2
            color = (
                (83, 214, 162, 255)
                if border
                else (18, 26, 32, 255)
                if checker
                else (23, 35, 43, 255)
            )
            raw.extend(color)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


PNG = make_synthetic_png()


class CheckFailure(RuntimeError):
    """A safe, user-facing verification failure."""


def require(condition: Any, message: str) -> None:
    if not condition:
        raise CheckFailure(message)


def normalize_access(access: dict[str, Any]) -> tuple[str, str, str]:
    parsed = urlsplit(access["url"])
    require(parsed.scheme == "https", "管理员 URL 必须使用 HTTPS")
    path = parsed.path.rstrip("/")
    require(path.endswith("/admin"), "管理员 URL 必须以 /admin 结尾")
    prefix = path[: -len("/admin")]
    root_path = (prefix or "") + "/"
    root_url = urlunsplit((parsed.scheme, parsed.netloc, root_path, "", ""))
    admin_url = root_url + "admin"
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return root_url, admin_url, origin


def http_request(
    opener: urllib.request.OpenerDirector,
    url: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request_headers = {"Content-Type": "application/json"} if body is not None else {}
    request_headers.update(headers or {})
    request = urllib.request.Request(
        url,
        data=data,
        headers=request_headers,
        method=method,
    )
    try:
        response = opener.open(request, timeout=30)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        content_type = response.headers.get("Content-Type", "")
        value = (
            json.loads(raw)
            if raw and "application/json" in content_type
            else raw
        )
        return response.status, value, response.headers


def create_synthetic_feedback(
    root_url: str,
    origin: str,
) -> tuple[str, bool, bool]:
    opener = urllib.request.build_opener()
    health_status, health, _ = http_request(opener, root_url + "healthz")
    require(
        health_status == 200 and health.get("status") == "ok",
        f"生产健康检查失败：HTTP {health_status}",
    )

    client_id = str(uuid.uuid4())
    payload = {
        "version": 1,
        "clientId": client_id,
        "category": "tool",
        "description": "[自动验收] 合成后台浏览器反馈；检查结束后自动删除。",
        "contact": "",
        "context": {
            "appVersion": "synthetic-browser",
            "systemVersion": "synthetic",
            "page": "admin-ui",
            "error": "synthetic",
        },
        "attachments": [
            {
                "name": "synthetic-a.png",
                "mimeType": "image/png",
                "data": base64.b64encode(PNG).decode("ascii"),
            },
            {
                "name": "synthetic-b.png",
                "mimeType": "image/png",
                "data": base64.b64encode(PNG).decode("ascii"),
            },
        ],
    }
    status, result, headers = http_request(
        opener,
        root_url + "api/feedback",
        method="POST",
        body=payload,
        headers={
            "Origin": origin,
            "Idempotency-Key": client_id,
        },
    )
    require(status == 201, f"合成反馈创建失败：HTTP {status}")
    feedback_id = result.get("id")
    require(
        isinstance(feedback_id, str) and feedback_id,
        "合成反馈响应缺少 id",
    )
    cors_ok = headers.get("Access-Control-Allow-Origin") == origin
    return feedback_id, bool(health.get("smtp_configured")), cors_ok


def cleanup_synthetic_feedback(
    root_url: str,
    access: dict[str, Any],
    feedback_id: str,
) -> tuple[bool, str]:
    if not feedback_id:
        return True, ""
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))
    try:
        status, _, _ = http_request(
            opener,
            root_url + "admin/api/login",
            method="POST",
            body={
                "username": access["username"],
                "password": access["password"],
            },
        )
        require(status == 200, f"清理登录失败：HTTP {status}")
        status, session, _ = http_request(opener, root_url + "admin/api/session")
        require(status == 200, f"清理会话失败：HTTP {status}")
        csrf = session["csrfToken"]
        detail_url = root_url + "admin/api/feedback/" + quote(feedback_id)
        delete_status, _, _ = http_request(
            opener,
            detail_url,
            method="DELETE",
            headers={"X-CSRF-Token": csrf},
        )
        require(
            delete_status in {204, 404},
            f"合成反馈清理失败：HTTP {delete_status}",
        )
        detail_status, _, _ = http_request(opener, detail_url)
        require(detail_status == 404, "清理后合成反馈仍可读取")
        http_request(
            opener,
            root_url + "admin/api/logout",
            method="POST",
            headers={"X-CSRF-Token": csrf},
        )
        return True, ""
    except Exception as exc:
        return False, safe_exception(exc, access)


def wait_js(
    page: Any,
    script: str,
    message: str,
    *args: Any,
    timeout: float = 30,
) -> Any:
    deadline = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            result = page.run_js(
                "return (() => {" + script + "})();",
                *args,
            )
            if result:
                return result
        except Exception as exc:
            last_error = type(exc).__name__
        time.sleep(0.2)
    suffix = f"（{last_error}）" if last_error else ""
    raise CheckFailure(message + suffix)


def click_text(page: Any, selector: str, text: str, message: str) -> None:
    clicked = page.run_js(
        "return (() => {"
        " const nodes = Array.from(document.querySelectorAll(arguments[0]));"
        " const node = nodes.find((item) => item.textContent.trim() === arguments[1]);"
        " if (!node) return false; node.click(); return true;"
        "})();",
        selector,
        text,
    )
    require(clicked, message)


def inspect_capture(page: Any, admin_url: str, feedback_id: str) -> dict[str, Any]:
    packets = page.capture.steps
    document_packets = [
        packet
        for packet in packets
        if packet.method == "GET"
        and packet.url.startswith(admin_url)
        and packet.status == 200
    ]
    require(document_packets, "未捕获后台 HTML 响应")
    csp = document_packets[0].headers.get("content-security-policy", "")
    require("script-src 'self'" in csp, "CSP 未限制同源脚本")
    require("style-src 'self'" in csp, "CSP 未限制同源样式")
    require("base-uri 'self'" in csp, "CSP base-uri 配置不正确")
    require("img-src" in csp and "'self'" in csp, "CSP 未允许同源图片")

    def status_for(suffix: str, method: str = "GET") -> int:
        for packet in packets:
            if packet.method == method and suffix in packet.url:
                return packet.status
        return 0

    js_status = status_for("/admin/static/admin.js")
    css_status = status_for("/admin/static/admin.css")
    list_status = status_for("/admin/api/feedback?", "GET")
    detail_status = status_for("/admin/api/feedback/" + feedback_id, "GET")
    patch_status = status_for("/admin/api/feedback/" + feedback_id, "PATCH")
    delete_status = status_for("/admin/api/feedback/" + feedback_id, "DELETE")
    image_packets = [
        packet
        for packet in packets
        if packet.method == "GET"
        and "/attachments/" in packet.url
        and packet.status == 200
        and "image/png" in packet.headers.get("content-type", "")
    ]
    require(js_status == 200, f"admin.js 加载失败：HTTP {js_status}")
    require(css_status == 200, f"admin.css 加载失败：HTTP {css_status}")
    require(list_status == 200, f"反馈列表 API 失败：HTTP {list_status}")
    require(detail_status == 200, f"反馈详情 API 失败：HTTP {detail_status}")
    require(patch_status == 200, f"状态修改 API 失败：HTTP {patch_status}")
    require(delete_status == 204, f"反馈删除 API 失败：HTTP {delete_status}")
    require(image_packets, "未捕获成功的 PNG 图片响应")
    return {
        "csp_present": True,
        "admin_js_status": js_status,
        "admin_css_status": css_status,
        "list_api_status": list_status,
        "detail_api_status": detail_status,
        "status_patch": patch_status,
        "delete_status": delete_status,
        "image_status": image_packets[0].status,
        "image_content_type": image_packets[0].headers.get("content-type", ""),
    }


def layout_metrics(page: Any) -> dict[str, Any]:
    return page.run_js(
        "return (() => {"
        " const root = document.documentElement;"
        " const dashboard = document.querySelector('.dashboard');"
        " const overflowing = Array.from(document.body.querySelectorAll('*'))"
        "   .filter((node) => {"
        "     const rect = node.getBoundingClientRect();"
        "     const style = getComputedStyle(node);"
        "     return style.position !== 'fixed' && rect.width > 0"
        "       && (rect.right > window.innerWidth + 2 || rect.left < -2);"
        "   }).length;"
        " return {"
        "   innerWidth: window.innerWidth,"
        "   documentWidth: root.scrollWidth,"
        "   bodyWidth: document.body.scrollWidth,"
        "   overflowing: overflowing,"
        "   dashboardColumns: dashboard ? getComputedStyle(dashboard).gridTemplateColumns : ''"
        " };"
        "})();"
    )


def safe_exception(exc: Exception, access: dict[str, Any] | None = None) -> str:
    message = f"{type(exc).__name__}: {exc}"
    if access:
        for key in ("username", "password"):
            secret = access.get(key)
            if isinstance(secret, str) and secret:
                message = message.replace(secret, "[redacted]")
    return " ".join(message.splitlines())[:500]


def remove_profile(path: Path) -> None:
    if not path.exists():
        return
    for _ in range(10):
        try:
            shutil.rmtree(path)
            return
        except OSError:
            time.sleep(0.3)
    raise CheckFailure("Firefox 临时 profile 清理失败")


def write_report(report: dict[str, Any]) -> None:
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    started = time.monotonic()
    checks: list[str] = []
    access: dict[str, Any] | None = None
    page: Any = None
    feedback_id = ""
    smtp_configured = False
    cleanup_ok = True
    cleanup_error = ""
    failure = ""
    stage = "读取管理员资料"
    scratch = ROOT / ".scratch" / ("feedback-admin-ui-" + uuid.uuid4().hex[:8])
    profile = scratch / "profile"
    captured: dict[str, Any] = {}
    layout_report: dict[str, Any] = {}
    screenshot_written = False
    screenshot_list_visible = False
    ui_deleted = False

    SCREENSHOT_PATH.unlink(missing_ok=True)

    try:
        access = json.loads(ACCESS_PATH.read_text(encoding="utf-8"))
        require(
            all(isinstance(access.get(key), str) and access.get(key) for key in ("url", "username", "password")),
            "管理员资料字段不完整",
        )
        root_url, admin_url, origin = normalize_access(access)

        stage = "创建合成反馈"
        feedback_id, smtp_configured, cors_ok = create_synthetic_feedback(root_url, origin)
        require(cors_ok, "生产公开 API 未返回预期 CORS Origin")
        checks.append("synthetic_feedback_created")

        scratch.mkdir(parents=True, exist_ok=False)
        stage = "启动真实 Firefox"
        page = launch(
            headless=True,
            user_dir=str(profile),
            close_on_exit=True,
            window_size=(1440, 1000),
            timeout_base=15,
            timeout_page_load=45,
            failure_snapshot=False,
        )
        page.console.start()
        page.capture.start_capture(targets=True, collect_bodies=False)

        stage = "打开后台登录页"
        deep_link = admin_url + "?feedback=" + quote(feedback_id)
        page.get(deep_link, wait="complete")
        wait_js(
            page,
            "return !document.querySelector('#loginView').hidden;",
            "后台登录页未显示",
        )
        page.run_js(
            "return (() => {"
            " window.confirm = () => true;"
            " window.alert = () => undefined;"
            " return true;"
            "})();"
        )
        initial = page.run_js(
            "return (() => {"
            " const base = new URL('admin/api/session', document.baseURI);"
            " const login = document.querySelector('#loginView');"
            " return {"
            "  title: document.title,"
            "  baseURI: document.baseURI,"
            "  scriptURLs: Array.from(document.scripts).map((node) => node.src),"
            "  stylesheetURLs: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((node) => node.href),"
            "  stylesheetCount: document.styleSheets.length,"
            "  apiPath: base.pathname,"
            "  loginRadius: login ? getComputedStyle(login).borderRadius : '',"
            "  query: window.location.search"
            " };"
            "})();"
        )
        expected_base = origin + root_url[len(origin) :]
        expected_js = expected_base + "admin/static/admin.js"
        expected_css = expected_base + "admin/static/admin.css"
        expected_api_path = root_url[len(origin) :] + "admin/api/session"
        require(initial["title"] == "GKD 反馈后台", "后台页面标题不正确")
        require(initial["baseURI"] == expected_base, "base 路径没有跟随 PUBLIC_BASE_URL")
        require(expected_js in initial["scriptURLs"], "脚本 URL 未经过正确 base 路径")
        require(expected_css in initial["stylesheetURLs"], "样式 URL 未经过正确 base 路径")
        require(initial["stylesheetCount"] >= 1, "后台样式表未加载")
        require(initial["loginRadius"] not in {"", "0px"}, "后台样式未生效")
        require(initial["apiPath"] == expected_api_path, "admin API 相对路径解析错误")
        require(feedback_id in initial["query"], "登录前丢失 feedback 深链参数")
        checks.append("script_style_base_path")

        stage = "登录管理员后台"
        page.ele("#username").input(access["username"])
        page.ele("#password").input(access["password"])
        page.ele("#loginForm button[type=submit]").click()
        wait_js(
            page,
            "return !document.querySelector('#appView').hidden"
            " && document.querySelector('#loginView').hidden;",
            "管理员登录后未进入后台",
        )
        wait_js(
            page,
            "return document.querySelector('#detailPanel').textContent.includes(arguments[0]);",
            "登录后未恢复 feedback 深链详情",
            feedback_id,
            timeout=30,
        )
        login_state = page.run_js(
            "return {"
            " password: document.querySelector('#password').value,"
            " loginHidden: document.querySelector('#loginView').hidden,"
            " appVisible: !document.querySelector('#appView').hidden,"
            " detailText: document.querySelector('#detailPanel').textContent,"
            " itemCount: document.querySelectorAll('.feedback-item').length,"
            " total: Number(document.querySelector('#totalCount').textContent)"
            "};"
        )
        require(login_state["password"] == "", "登录后密码输入框未清空")
        require(login_state["loginHidden"] and login_state["appVisible"], "登录后视图状态错误")
        require(feedback_id in login_state["detailText"], "详情不是刚创建的合成反馈")
        checks.append("deep_link_restored_after_login")
        checks.append("login_form_cleared")

        stage = "验证按需图片预览"
        preview = page.run_js(
            "return (() => {"
            " const buttons = Array.from(document.querySelectorAll('#detailPanel button'))"
            "  .filter((node) => node.textContent.trim() === '预览图片');"
            " return {"
            "  buttons: buttons.length,"
            "  images: document.querySelectorAll('#detailPanel img.attachment-preview').length"
            " };"
            "})();"
        )
        require(preview["buttons"] >= 2, "两个合成 PNG 未显示预览按钮")
        require(preview["images"] == 0, "图片在点击预览前已自动加载")
        page.run_js(
            "return (() => {"
            " const button = Array.from(document.querySelectorAll('#detailPanel button'))"
            "  .find((node) => node.textContent.trim() === '预览图片');"
            " if (!button) return false; button.click(); return true;"
            "})();"
        )
        wait_js(
            page,
            "const image = document.querySelector('#detailPanel img.attachment-preview');"
            "if (!image) return false;"
            "image.scrollIntoView({block: 'center'});"
            "return image.complete && image.naturalWidth > 0;",
            "点击预览后 PNG 未加载",
        )
        first_preview = page.run_js(
            "return (() => {"
            " const image = document.querySelector('#detailPanel img.attachment-preview');"
            " return {"
            "  count: document.querySelectorAll('#detailPanel img.attachment-preview').length,"
            "  naturalWidth: image ? image.naturalWidth : 0,"
            "  naturalHeight: image ? image.naturalHeight : 0,"
            "  src: image ? image.src : ''"
            " };"
            "})();"
        )
        require(first_preview["count"] == 1, "同一详情出现了多张预览图片")
        require(first_preview["naturalWidth"] > 0, "预览图片 naturalWidth 为 0")

        page.run_js(
            "return (() => {"
            " const buttons = Array.from(document.querySelectorAll('#detailPanel button'))"
            "  .filter((node) => node.textContent.trim() === '预览图片');"
            " if (buttons.length < 2) return false; buttons[1].click(); return true;"
            "})();"
        )
        wait_js(
            page,
            "const image = document.querySelector('#detailPanel img.attachment-preview');"
            "return image && image.complete && image.naturalWidth > 0"
            " && image.src !== arguments[0];",
            "切换第二张预览图片失败",
            first_preview["src"],
        )
        second_count = page.run_js(
            "return document.querySelectorAll('#detailPanel img.attachment-preview').length;"
        )
        require(second_count == 1, "切换图片后同一详情不是最多一张预览")
        checks.append("on_demand_single_image_preview")

        stage = "修改合成反馈状态"
        click_text(page, "#detailPanel button", "标为已解决", "未找到标为已解决按钮")
        wait_js(
            page,
            "const detail = document.querySelector('#detailPanel');"
            "const button = Array.from(detail.querySelectorAll('button'))"
            " .find((node) => node.textContent.trim() === '标为待处理');"
            "const item = document.querySelector('.feedback-item[data-id=\""
            + feedback_id
            + "\"]');"
            "return Boolean(button && item && item.querySelector('.pill.resolved'));",
            "状态没有切换为已解决",
        )
        checks.append("status_changed_to_resolved")

        page.run_js(
            "return (() => {"
            " const button = Array.from(document.querySelectorAll('#detailPanel button'))"
            "  .find((node) => node.textContent.trim() === '预览图片');"
            " if (!button) return false; button.click(); return true;"
            "})();"
        )
        wait_js(
            page,
            "const image = document.querySelector('#detailPanel img.attachment-preview');"
            "if (!image) return false;"
            "image.scrollIntoView({block: 'center'});"
            "return image.complete && image.naturalWidth > 0;",
            "状态更新后图片预览失败",
        )

        stage = "检查桌面和移动布局"
        page.set_viewport(1440, 1000)
        page.wait(0.4)
        desktop = layout_metrics(page)
        require(
            desktop["documentWidth"] <= desktop["innerWidth"] + 2,
            "桌面布局出现水平溢出",
        )
        require(desktop["overflowing"] == 0, "桌面布局存在越界元素")
        page.set_viewport(390, 844)
        page.wait(0.5)
        mobile = layout_metrics(page)
        require(
            mobile["documentWidth"] <= mobile["innerWidth"] + 2,
            "移动布局出现水平溢出",
        )
        require(mobile["overflowing"] == 0, "移动布局存在越界元素")
        require(
            len(mobile["dashboardColumns"].split()) == 1,
            "移动布局未切换为单列",
        )
        page.set_viewport(1440, 1000)
        page.wait(0.4)
        layout_report = {
            "desktop": {
                "width": 1440,
                "horizontal_overflow": False,
                "metrics": desktop,
            },
            "mobile": {
                "width": 390,
                "horizontal_overflow": False,
                "metrics": mobile,
            },
        }
        checks.append("desktop_layout_without_overflow")
        checks.append("mobile_layout_without_overflow")

        stage = "生成脱敏截图"
        screenshot_state = page.run_js(
            "return (() => {"
            "const syntheticId = '"
            + feedback_id
            + "';"
            "const total = Number(document.querySelector('#totalCount').textContent);"
            "const ids = Array.from(document.querySelectorAll('.feedback-item'))"
            " .map((node) => node.dataset.id);"
            "const safeList = total === 1 && ids.length === 1 && ids[0] === syntheticId;"
            "const listPanel = document.querySelector('.list-panel');"
            "if (!safeList && listPanel) {"
            " listPanel.hidden = true;"
            " const dashboard = document.querySelector('.dashboard');"
            " if (dashboard) dashboard.style.gridTemplateColumns = 'minmax(0, 1fr)';"
            "}"
            "window.scrollTo(0, 0);"
            "return {"
            " safeList: safeList,"
            " password: document.querySelector('#password').value,"
            " loginHidden: document.querySelector('#loginView').hidden,"
            " detailContainsSynthetic: document.querySelector('#detailPanel')"
            "   .textContent.includes(syntheticId),"
            " imageCount: document.querySelectorAll('#detailPanel img.attachment-preview').length"
            "};"
            "})();"
        )
        require(screenshot_state["password"] == "", "截图前密码输入框不为空")
        require(screenshot_state["loginHidden"], "截图前登录表单仍可见")
        require(screenshot_state["detailContainsSynthetic"], "截图详情不是合成反馈")
        require(screenshot_state["imageCount"] == 1, "截图前预览图片数量不正确")
        screenshot_list_visible = bool(screenshot_state["safeList"])
        page.screenshot(str(SCREENSHOT_PATH))
        require(
            SCREENSHOT_PATH.exists() and SCREENSHOT_PATH.stat().st_size > 1000,
            "后台验收截图未生成",
        )
        screenshot_written = True
        checks.append("screenshot_contains_only_synthetic_detail")

        stage = "删除合成反馈"
        click_text(page, "#detailPanel button", "彻底删除", "未找到彻底删除按钮")
        wait_js(
            page,
            "const item = document.querySelector('.feedback-item[data-id=\""
            + feedback_id
            + "\"]');"
            "return !item && document.querySelector('#detailPanel').textContent.includes('选择一条反馈');",
            "UI 删除后合成反馈仍在列表或详情中",
        )
        page.run_js(
            "return (() => {"
            "window.__feedbackDeleteStatus = 0;"
            "fetch('admin/api/feedback/"
            + feedback_id
            + "', {credentials: 'same-origin'})"
            ".then((response) => { window.__feedbackDeleteStatus = response.status; });"
            "return true;"
            "})();"
        )
        wait_js(
            page,
            "return window.__feedbackDeleteStatus === 404;",
            "UI 删除后详情 API 未返回 404",
        )
        ui_deleted = True
        checks.append("feedback_deleted_through_ui")

        stage = "汇总网络与控制台检查"
        captured = inspect_capture(page, admin_url, feedback_id)
        console_errors = page.console.get(level="error")
        require(not console_errors, f"浏览器控制台存在 {len(console_errors)} 个错误")
        page.capture.stop()
        page.console.stop()
        checks.append("network_and_console_clean")

        stage = "验证登出失败不假登出"
        intercept_count = {"value": 0}

        def logout_handler(request: Any) -> None:
            if intercept_count["value"] == 0:
                intercept_count["value"] += 1
                request.mock(
                    '{"detail":"synthetic logout failure"}',
                    status_code=500,
                    headers={"content-type": "application/json"},
                )
            else:
                request.continue_request()

        page.intercept.start_requests(
            logout_handler,
            url_patterns=[
                {
                    "type": "string",
                    "pattern": admin_url + "/api/logout",
                },
            ],
        )
        page.ele("#logoutButton").click()
        deadline = time.monotonic() + 10
        while intercept_count["value"] == 0 and time.monotonic() < deadline:
            time.sleep(0.1)
        require(intercept_count["value"] == 1, "未触发模拟登出失败")
        wait_js(
            page,
            "return !document.querySelector('#appView').hidden"
            " && document.querySelector('#loginView').hidden"
            " && !document.querySelector('#logoutButton').disabled;",
            "登出失败后没有保持已登录视图",
            timeout=5,
        )
        failed_logout_state = page.run_js(
            "return {"
            " appVisible: !document.querySelector('#appView').hidden,"
            " loginHidden: document.querySelector('#loginView').hidden,"
            " logoutEnabled: !document.querySelector('#logoutButton').disabled"
            "};"
        )
        require(
            failed_logout_state["appVisible"] and failed_logout_state["loginHidden"],
            "登出失败后错误地显示了登录页",
        )
        require(failed_logout_state["logoutEnabled"], "登出失败后按钮未恢复")
        page.intercept.stop()
        checks.append("logout_failure_keeps_authenticated_view")

        stage = "真实退出登录"
        page.ele("#logoutButton").click()
        wait_js(
            page,
            "return !document.querySelector('#loginView').hidden"
            " && document.querySelector('#appView').hidden;",
            "真实登出后未返回登录页",
        )
        page.run_js(
            "return (() => {"
            "window.__logoutSessionStatus = 0;"
            "fetch('admin/api/session', {credentials: 'same-origin'})"
            ".then((response) => { window.__logoutSessionStatus = response.status; });"
            "return true;"
            "})();"
        )
        wait_js(
            page,
            "return window.__logoutSessionStatus === 401;",
            "真实登出后会话仍有效",
        )
        checks.append("logout_revokes_session")

    except Exception as exc:
        failure = f"{stage}: {safe_exception(exc, access)}"
    finally:
        if page is not None:
            for cleanup_call in (
                lambda: page.intercept.stop() if page.intercept.active else None,
                lambda: page.capture.stop() if page.capture.active else None,
                lambda: page.console.stop() if page.console.listening else None,
                page.quit,
            ):
                try:
                    cleanup_call()
                except Exception:
                    pass

        if access is not None and not ui_deleted:
            try:
                root_url, _, _ = normalize_access(access)
                cleanup_ok, cleanup_error = cleanup_synthetic_feedback(
                    root_url,
                    access,
                    feedback_id,
                )
            except Exception as exc:
                cleanup_ok = False
                cleanup_error = safe_exception(exc, access)
        if not cleanup_ok and not failure:
            failure = "清理合成反馈失败: " + cleanup_error

        try:
            remove_profile(scratch)
        except Exception as exc:
            if not failure:
                failure = safe_exception(exc, access)

        if ui_deleted:
            cleanup_evidence = "ui_delete_http_204"
        elif cleanup_ok and feedback_id:
            cleanup_evidence = "api_cleanup_verified"
        elif feedback_id:
            cleanup_evidence = "cleanup_failed"
        else:
            cleanup_evidence = "nothing_created"

        report = {
            "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "target_url": access.get("url") if access else "",
            "status": "failed" if failure else "passed",
            "smtp_configured": smtp_configured,
            "synthetic_data_removed": cleanup_ok,
            "synthetic_cleanup_evidence": cleanup_evidence,
            "checks": checks,
            "browser": "ruyipage managed Firefox",
            "layout": layout_report,
            "screenshot": "user-feedback-admin.png" if screenshot_written else "",
            "screenshot_list_visible": screenshot_list_visible,
            "network": captured,
            "error": failure,
        }
        write_report(report)
        elapsed = round(time.monotonic() - started, 2)
        if failure:
            print(f"后台浏览器验收失败：{failure}")
        else:
            print(
                f"后台浏览器验收通过：{len(checks)} 项，"
                f"合成反馈已删除，耗时 {elapsed} 秒。"
            )

    return 1 if failure else 0


if __name__ == "__main__":
    raise SystemExit(main())
