#!/usr/bin/env python3
"""Browser acceptance for UserFeedbackPanel using synthetic data only.

Run from the repository root with PowerShell:

    C:\\Python314\\python.exe scripts/check-user-feedback.py

The script owns its Firefox profile, feedback fixture on port 8786, and Vite
process when it starts one. Browser fetch is replaced only for the exact
production feedback URL; no feedback request reaches the real endpoint.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")
from ruyipage import Keys, launch

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = ROOT / ".scratch" / "user-feedback-browser"
APP_URL = "http://127.0.0.1:5174"
FIXTURE = "http://127.0.0.1:8786"
PRODUCTION_ENDPOINT = "https://120.25.221.144/gkd-feedback/api/feedback"
REPORT = ROOT / "docs" / "verification" / "user-feedback-browser-checks.json"
MOBILE_SCREENSHOT = ROOT / "docs" / "verification" / "user-feedback-mobile.png"
AI_CONFIG_KEY = "gkd-rule-studio-ai-config"
AI_KEY = "sk-browser-FEEDBACK-PRIVATE-6d8c91"
NODE_TEXT = "node-private-7788"
NODE_DESC = "desc-private-4411"
NODE_RESOURCE = "com.fixture:id/private-7788"
NODE_VID = "private-vid-7788"
VISUAL_SECRET = "VISUAL-MASK-9911"
SYNTHETIC_RECEIPT = "uf-browser-20261029-ok"
RULE_FILE_NAME = "fixture-rules.json5"
RULE_FILE_TEXT = json.dumps(
    {
        "name": "反馈规则样本",
        "apiKey": AI_KEY,
        "rules": [{"matches": ["com.fixture.feedback"]}],
    },
    ensure_ascii=False,
    indent=2,
)
RULE_PASTE_SUFFIX = "\n// manually-pasted-7788\n"
DIAGNOSTIC_ZIP_NAME = "gkd-log-fixture.zip"
CHECK = {"id": "bootstrap", "title": "浏览器验收启动"}
checks: list[dict[str, Any]] = []
state: dict[str, Any] = {"requests": []}


def node(
    node_id: int,
    parent_id: int,
    *,
    name: str = "android.view.View",
    text: str | None = None,
    desc: str | None = None,
    resource_id: str | None = None,
    vid: str | None = None,
    clickable: bool = False,
    left: int = 0,
    top: int = 0,
    right: int = 1080,
    bottom: int = 2400,
    index: int = 0,
    depth: int = 0,
    child_count: int = 0,
) -> dict[str, Any]:
    return {
        "id": node_id,
        "pid": parent_id,
        "idQf": bool(resource_id),
        "textQf": text is not None,
        "attr": {
            "id": resource_id,
            "vid": vid,
            "name": name,
            "text": text,
            "desc": desc,
            "clickable": clickable,
            "focusable": clickable,
            "checkable": False,
            "checked": False,
            "editable": False,
            "longClickable": False,
            "visibleToUser": True,
            "left": left,
            "top": top,
            "right": right,
            "bottom": bottom,
            "width": right - left,
            "height": bottom - top,
            "childCount": child_count,
            "index": index,
            "depth": depth,
        },
    }


FIXTURE_SNAPSHOT = {
    "id": 4101,
    "appId": "com.fixture.feedback",
    "activityId": "com.fixture.feedback.MainActivity",
    "screenWidth": 1080,
    "screenHeight": 2400,
    "isLandscape": False,
    "appInfo": {
        "id": "com.fixture.feedback",
        "name": "反馈验收样本",
        "versionCode": 41,
        "versionName": "4.1",
    },
    "device": {
        "model": "synthetic-feedback",
        "manufacturer": "fixture",
        "sdkInt": 34,
        "release": "14",
    },
    "nodes": [
        node(0, -1, name="android.widget.FrameLayout", child_count=3),
        node(
            1,
            0,
            name="android.widget.TextView",
            text=NODE_TEXT,
            desc=f"{NODE_DESC} api_key={AI_KEY}",
            resource_id=NODE_RESOURCE,
            vid=NODE_VID,
            left=150,
            top=960,
            right=930,
            bottom=1120,
            index=0,
            depth=1,
        ),
        node(
            2,
            0,
            name="android.widget.Button",
            text="普通按钮",
            resource_id="com.fixture:id/normal",
            vid="normal_button",
            clickable=True,
            left=190,
            top=1640,
            right=890,
            bottom=1780,
            index=1,
            depth=1,
        ),
        node(
            3,
            0,
            name="android.widget.TextView",
            text=VISUAL_SECRET,
            left=80,
            top=290,
            right=1000,
            bottom=560,
            index=2,
            depth=1,
        ),
    ],
}


def snapshot_summary(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": raw["id"],
        "appId": raw["appId"],
        "activityId": raw["activityId"],
        "screenWidth": raw["screenWidth"],
        "screenHeight": raw["screenHeight"],
        "isLandscape": raw["isLandscape"],
        "appInfo": raw["appInfo"],
        "appName": raw["appInfo"]["name"],
    }


def screenshot_image() -> Image.Image:
    image = Image.new("RGB", (540, 720), "#172235")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 539, 58), fill="#0c1422")
    draw.text((24, 18), "FEEDBACK FIXTURE", fill="#e9f2ff", font=ImageFont.load_default(24))
    draw.rounded_rectangle((26, 92, 514, 194), radius=18, fill="#8f2347", outline="#ff9fbd", width=3)
    draw.text((52, 118), VISUAL_SECRET, fill="#fff3f7", font=ImageFont.load_default(24))
    draw.rounded_rectangle((70, 278, 470, 344), radius=16, fill="#28405f")
    draw.text((92, 297), NODE_TEXT, fill="#f4f8ff", font=ImageFont.load_default(22))
    draw.text((92, 321), "private account", fill="#9fc8ec", font=ImageFont.load_default(14))
    draw.rounded_rectangle((90, 520, 450, 580), radius=16, fill="#376b9a")
    draw.text((235, 540), "NORMAL", fill="#ffffff", font=ImageFont.load_default(20))
    return image


SCREENSHOT_IMAGE = screenshot_image()
SCREENSHOT_BUFFER = io.BytesIO()
SCREENSHOT_IMAGE.save(SCREENSHOT_BUFFER, format="PNG", optimize=False)
SCREENSHOT_PNG = SCREENSHOT_BUFFER.getvalue()
DIAGNOSTIC_BUFFER = io.BytesIO()
with zipfile.ZipFile(DIAGNOSTIC_BUFFER, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr(
        "matching-diagnostics/fixture/diagnostic.json",
        json.dumps(
            {
                "appId": "com.fixture.feedback",
                "versionName": "1.13.0",
                "trackingComplete": True,
            },
            ensure_ascii=False,
        ),
    )
DIAGNOSTIC_ZIP = DIAGNOSTIC_BUFFER.getvalue()


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_: Any) -> None:
        return

    def reply_json(self, value: Any, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type, idempotency-key")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def reply_png(self) -> None:
        self.send_response(200)
        self.send_header("content-type", "image/png")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(SCREENSHOT_PNG)))
        self.end_headers()
        self.wfile.write(SCREENSHOT_PNG)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] == "/":
            self.reply_json({"ok": True})
        elif self.path.split("?", 1)[0] == "/snapshot.png":
            self.reply_png()
        else:
            self.reply_json({}, 404)

    def do_OPTIONS(self) -> None:
        self.reply_json({})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        path = self.path.split("?", 1)[0].rstrip("/")
        body = json.loads(raw or b"null")
        state["requests"].append({"path": path, "body": body})
        if path.endswith("/getServerInfo"):
            self.reply_json({
                "device": {"model": "synthetic-feedback", "sdkInt": 34, "release": "14"},
                "gkdAppInfo": {
                    "id": "li.songe.gkd",
                    "name": "GKD Feedback Fixture",
                    "versionName": "1.13.0",
                    "versionCode": 1130,
                },
            })
        elif path.endswith("/getSnapshots"):
            self.reply_json([snapshot_summary(FIXTURE_SNAPSHOT)])
        elif path.endswith("/getSnapshot"):
            self.reply_json(FIXTURE_SNAPSHOT)
        elif path.endswith("/getScreenshot"):
            self.reply_png()
        else:
            self.reply_json({}, 404)


def server_up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1.5) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def dev_ready(timeout: float = 120) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server_up(APP_URL + "/") and server_up(APP_URL + "/src/main.tsx"):
            return True
        time.sleep(0.4)
    return False


def port_is_listening(port: int) -> bool:
    command = (
        "$item = Get-NetTCPConnection -LocalPort %d -State Listen -ErrorAction SilentlyContinue; "
        "if ($item) { '1' } else { '0' }"
    ) % port
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True,
        text=True,
        timeout=8,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return completed.stdout.strip() == "1"


def stop_owned_vite_listener(port: int = 5174) -> None:
    command = (
        "$listeners = Get-NetTCPConnection -LocalPort %d -State Listen "
        "-ErrorAction SilentlyContinue; "
        "foreach ($listener in $listeners) { "
        "$process = Get-CimInstance Win32_Process "
        "-Filter \"ProcessId = $($listener.OwningProcess)\"; "
        "if ($process.CommandLine -like '*gkd-rule-builder*' "
        "-and $process.CommandLine -like '*vite*' "
        "-and $process.CommandLine -like '*--port %d*') { "
        "Stop-Process -Id $listener.OwningProcess -Force "
        "} }"
    ) % (port, port)
    subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True,
        text=True,
        timeout=8,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def close_process_tree(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    subprocess.run(
        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
        capture_output=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


def add_check(check_id: str, title: str, detail: str, status: str = "passed") -> None:
    checks.append({"id": check_id, "title": title, "status": status, "detail": detail})
    print(f"{status.upper()}: {check_id} {title}", flush=True)


def start_check(check_id: str, title: str) -> None:
    CHECK.update({"id": check_id, "title": title})


dev_process: subprocess.Popen[bytes] | None = None
dev_started_here = False
fixture_server: ThreadingHTTPServer | None = None
page = None


def wait_js(expression: str, timeout: float = 25) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.run_js(
            "return (() => { try { return Boolean(" + expression + "); } catch { return false; } })();"
        ):
            return
        time.sleep(0.1)
    body = page.run_js("return document.body.innerText") if page is not None else ""
    raise AssertionError("等待失败：" + expression + "\n" + str(body)[:3000])


def js(expression: str) -> Any:
    return page.run_js("return " + expression + ";")


def click_css(selector: str) -> None:
    element = page.ele("css:" + selector)
    assert element, "找不到元素：" + selector
    element.click()


def click_button(text: str, root_selector: str = "document") -> None:
    root = "document" if root_selector == "document" else "document.querySelector(" + repr(root_selector) + ")"
    clicked = page.run_js(
        "return (() => { const root = " + root + "; if (!root) return false;"
        " const button = Array.from(root.querySelectorAll('button')).find((item) => item.textContent.trim() === "
        + repr(text) + "); if (!button) return false; button.click(); return true; })();"
    )
    assert clicked, "找不到按钮：" + text


def set_value(selector: str, value: str) -> None:
    changed = page.run_js(
        """(selector, value) => {
          const input = document.querySelector(selector);
          if (!input) return false;
          const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
            : input instanceof HTMLSelectElement ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }""",
        selector,
        value,
    )
    assert changed, "找不到输入：" + selector


def set_file_input(selector: str, name: str, mime_type: str, content: bytes) -> None:
    changed = page.run_js(
        """(selector, name, mimeType, encoded) => {
          const input = document.querySelector(selector);
          if (!(input instanceof HTMLInputElement) || input.type !== "file") return false;
          const binary = atob(encoded);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          const transfer = new DataTransfer();
          transfer.items.add(new File([bytes], name, { type: mimeType }));
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }""",
        selector,
        name,
        mime_type,
        base64.b64encode(content).decode("ascii"),
    )
    assert changed, "找不到文件输入：" + selector


def click_checkbox_label(text: str) -> None:
    clicked = page.run_js(
        """(text) => {
          const label = Array.from(document.querySelectorAll(".user-feedback-panel label"))
            .find((item) => item.textContent.includes(text));
          const input = label?.querySelector('input[type="checkbox"]');
          if (!input) return false;
          if (!input.checked) input.click();
          return input.checked;
        }""",
        text,
    )
    assert clicked, "找不到或无法勾选：" + text


def install_feedback_stub(mode: str, reset: bool = False) -> None:
    installed = page.run_js(
        """(endpoint, mode, reset, receipt) => {
          const auditKey = "__syntheticFeedbackAudit";
          if (reset) sessionStorage.removeItem(auditKey);
          if (!window.__feedbackFetchPatched) {
            const nativeFetch = window.fetch.bind(window);
            window.fetch = async (input, init = {}) => {
              const rawUrl = typeof input === "string" ? input : input.url;
              const url = new URL(rawUrl, location.href).href;
              if (url !== endpoint) return nativeFetch(input, init);
              const body = init.body ? JSON.parse(String(init.body)) : null;
              const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
              const audit = JSON.parse(sessionStorage.getItem(auditKey) || "[]");
              audit.push({ url, mode: window.__feedbackMockMode, body, headers });
              sessionStorage.setItem(auditKey, JSON.stringify(audit));
              if (window.__feedbackMockMode === "offline") {
                throw new TypeError("synthetic offline");
              }
              return new Response(JSON.stringify({ id: receipt }), {
                status: 201,
                headers: { "content-type": "application/json" },
              });
            };
            window.__feedbackFetchPatched = true;
          }
          window.__feedbackMockMode = mode;
          return true;
        }""",
        PRODUCTION_ENDPOINT,
        mode,
        reset,
        SYNTHETIC_RECEIPT,
    )
    assert installed, "无法安装浏览器反馈 fetch 替身"


def feedback_audit() -> list[dict[str, Any]]:
    value = js("JSON.parse(sessionStorage.getItem('__syntheticFeedbackAudit') || '[]')")
    return value if isinstance(value, list) else []


def read_draft_state() -> bool:
    return bool(page.run_js(
        """(() => {
          return new Promise((resolve) => {
            const request = indexedDB.open("gkd-rule-builder-feedback", 1);
            request.onerror = () => resolve(false);
            request.onsuccess = () => {
              const db = request.result;
              try {
                const tx = db.transaction("drafts", "readonly");
                const get = tx.objectStore("drafts").get("latest");
                get.onsuccess = () => resolve(Boolean(get.result));
                get.onerror = () => resolve(false);
                tx.oncomplete = () => db.close();
              } catch {
                db.close();
                resolve(false);
              }
            };
          });
        })()"""
    ))


def read_draft_client_id() -> str | None:
    value = page.run_js(
        """(() => {
          return new Promise((resolve) => {
            const request = indexedDB.open("gkd-rule-builder-feedback", 1);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
              const db = request.result;
              try {
                const tx = db.transaction("drafts", "readonly");
                const get = tx.objectStore("drafts").get("latest");
                get.onsuccess = () => resolve(get.result?.payload?.clientId || null);
                get.onerror = () => resolve(null);
                tx.oncomplete = () => db.close();
              } catch {
                db.close();
                resolve(null);
              }
            };
          });
        })()"""
    )
    return str(value) if value else None


def read_draft_payload() -> dict[str, Any]:
    value = page.run_js(
        """(() => {
          return new Promise((resolve) => {
            const request = indexedDB.open("gkd-rule-builder-feedback", 1);
            request.onerror = () => resolve(null);
            request.onsuccess = () => {
              const db = request.result;
              try {
                const tx = db.transaction("drafts", "readonly");
                const get = tx.objectStore("drafts").get("latest");
                get.onsuccess = () => resolve(get.result?.payload || null);
                get.onerror = () => resolve(null);
                tx.oncomplete = () => db.close();
              } catch {
                db.close();
                resolve(null);
              }
            };
          });
        })()"""
    )
    assert isinstance(value, dict), "IndexedDB 中找不到反馈草稿"
    return value


def write_corrupt_draft() -> None:
    written = page.run_js(
        """(() => {
          return new Promise((resolve) => {
            const request = indexedDB.open("gkd-rule-builder-feedback", 1);
            request.onupgradeneeded = () => {
              if (!request.result.objectStoreNames.contains("drafts")) {
                request.result.createObjectStore("drafts");
              }
            };
            request.onerror = () => resolve(false);
            request.onsuccess = () => {
              const db = request.result;
              const tx = db.transaction("drafts", "readwrite");
              tx.objectStore("drafts").put({
                payload: { version: 2, clientId: "broken-draft" },
                savedAt: 1,
              }, "latest");
              tx.oncomplete = () => { db.close(); resolve(true); };
              tx.onerror = () => { db.close(); resolve(false); };
            };
          });
        })()"""
    )
    assert written, "无法写入损坏 IndexedDB 草稿"


def decode_attachment(body: dict[str, Any], name: str) -> bytes:
    attachments = body.get("attachments") or []
    attachment = next((item for item in attachments if item.get("name") == name), None)
    assert attachment is not None, "请求缺少附件：" + name
    return base64.b64decode(attachment["data"], validate=True)


MASK_EDITOR_SELECTOR = '[role="dialog"][aria-label="截图打码"]'
MASK_CANVAS_SELECTOR = 'canvas[aria-label="拖动框选截图打码区域"]'


def canvas_drag_points() -> tuple[tuple[int, int], tuple[int, int]]:
    geometry = js(
        f"""(() => {{
          const canvas = document.querySelector({MASK_EDITOR_SELECTOR!r})
            ?.querySelector({MASK_CANVAS_SELECTOR!r});
          if (!canvas) return null;
          const r = canvas.getBoundingClientRect();
          return {{ left: r.left, top: r.top, width: r.width, height: r.height }};
        }})()"""
    )
    assert geometry, "找不到打码画布"
    left, top = float(geometry["left"]), float(geometry["top"])
    width, height = float(geometry["width"]), float(geometry["height"])
    return (
        (int(round(left + width * 30 / 540)), int(round(top + height * 70 / 720))),
        (int(round(left + width * 510 / 540)), int(round(top + height * 210 / 720))),
    )


def mask_status(expected: int) -> None:
    wait_js(
        f"document.querySelector({MASK_EDITOR_SELECTOR!r})"
        f"?.innerText.includes('手动框选 {expected} 处')"
    )


def open_mask_editor() -> None:
    click_button("打码", ".user-feedback-panel")
    wait_js(f"document.querySelector({MASK_EDITOR_SELECTOR!r})")
    wait_js(
        f"document.querySelector({MASK_EDITOR_SELECTOR!r})"
        f"?.querySelector({MASK_CANVAS_SELECTOR!r})?.getBoundingClientRect().width > 0"
    )


def close_mask_editor(label: str) -> None:
    click_button(label, MASK_EDITOR_SELECTOR)
    wait_js(f"!document.querySelector({MASK_EDITOR_SELECTOR!r})")


def open_home_feedback() -> None:
    clicked = page.run_js(
        """return (() => {
          const button = Array.from(document.querySelectorAll(".android-support-entry"))
            .find((item) => item.textContent.trim().includes("反馈"));
          if (!button) return false;
          button.click();
          return true;
        })();"""
    )
    assert clicked, "首页找不到反馈按钮"
    wait_js("document.querySelector('.user-feedback-panel')")


def report_payload(status: str, error: dict[str, Any] | None = None) -> dict[str, Any]:
    audit: list[dict[str, Any]] = []
    if page is not None:
        try:
            audit = feedback_audit()
        except Exception:
            pass
    calls = []
    for item in audit:
        body = item.get("body") or {}
        body_text = json.dumps(body, ensure_ascii=False, sort_keys=True)
        calls.append({
            "mode": item.get("mode"),
            "url": item.get("url"),
            "clientId": body.get("clientId"),
            "idempotencyKey": (item.get("headers") or {}).get("idempotency-key"),
            "bodySha256": hashlib.sha256(body_text.encode("utf-8")).hexdigest(),
            "attachmentNames": [attachment.get("name") for attachment in body.get("attachments", [])],
        })
    return {
        "version": 1,
        "scope": "real Firefox against synthetic GKD and feedback data; not Android device acceptance",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "viewport": {"width": 412, "height": 915, "pixelRatio": 1},
        "appUrl": APP_URL,
        "fixture": FIXTURE,
        "protectedProductionEndpoint": PRODUCTION_ENDPOINT,
        "fixtureSnapshot": snapshot_summary(FIXTURE_SNAPSHOT),
        "checks": checks,
        "feedbackCalls": calls,
        "screenshot": "docs/verification/user-feedback-mobile.png" if MOBILE_SCREENSHOT.exists() else None,
        "failure": error,
        "findings": [{
            "id": error["checkId"] if error else "none",
            "status": "open" if error else "closed",
            "observed": error["message"] if error else "All requested browser checks passed.",
        }],
    }


def write_report(status: str, error: dict[str, Any] | None = None) -> None:
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(
        json.dumps(report_payload(status, error), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


try:
    SCRATCH.mkdir(parents=True, exist_ok=True)
    for name in ("failure.png", "failure.html", "failure.json", "firefox-profile"):
        target = (SCRATCH / name).resolve()
        if SCRATCH.resolve() not in target.parents:
            raise AssertionError("拒绝清理 scratch 外路径：" + str(target))
        if target.is_dir():
            shutil.rmtree(target, ignore_errors=True)
        else:
            target.unlink(missing_ok=True)

    fixture_server = ThreadingHTTPServer(("127.0.0.1", 8786), FixtureHandler)
    threading.Thread(target=fixture_server.serve_forever, daemon=True).start()

    start_check("environment", "真实 Firefox、合成 fixture 与 Vite")
    if not server_up(APP_URL):
        node_executable = shutil.which("node")
        vite_entry = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
        if not node_executable or not vite_entry.exists():
            raise AssertionError("找不到 node 或 node_modules/vite/bin/vite.js")
        dev_process = subprocess.Popen(
            [node_executable, str(vite_entry), "--host", "127.0.0.1", "--port", "5174"],
            cwd=ROOT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        dev_started_here = True
        if not dev_ready():
            raise AssertionError("Vite 未在 120 秒内就绪")
    page = launch(
        headless=True,
        user_dir=str(SCRATCH / "firefox-profile"),
        window_size=(412, 915),
    )
    page.set_viewport(412, 915, device_pixel_ratio=1)
    page.set_prompt_handler(confirm="accept")
    page.get(APP_URL + "/", wait="none", timeout=30)
    wait_js("document.querySelector('.android-home')", 120)
    page.run_js("(() => { localStorage.clear(); sessionStorage.clear(); return true; })()")
    ai_config = {
        "baseURL": "https://api.invalid/v1",
        "apiKey": AI_KEY,
        "model": "fixture-model",
        "temperature": 0.2,
        "timeoutMs": 30000,
    }
    page.run_js(
        "(key, value) => { localStorage.setItem(key, value); return true; }",
        AI_CONFIG_KEY,
        json.dumps(ai_config),
    )
    page.refresh()
    wait_js("document.querySelector('.android-home')", 30)
    add_check(
        "environment",
        "真实 Firefox、合成 fixture 与 Vite",
        "Firefox 以 412×915 运行；Vite 复用或由本脚本隐藏启动；fixture 监听 8786",
    )

    start_check("connect", "连接 GKD HTTP fixture 并读取快照")
    set_value(".android-device-form input", FIXTURE)
    click_css(".android-device-form button")
    wait_js("document.querySelectorAll('.android-snapshot-check-row').length === 1")
    assert any(item["path"].endswith("/getServerInfo") for item in state["requests"])
    assert any(item["path"].endswith("/getSnapshots") for item in state["requests"])
    add_check(
        "connect",
        "连接 GKD HTTP fixture 并读取快照",
        "页面显示 1 张 fixture 快照，服务端实际收到 getServerInfo 与 getSnapshots",
    )

    start_check("feedback-entry-controls", "首页反馈入口、功能建议与 GKD 版本")
    home_feedback_text = js(
        """Array.from(document.querySelectorAll(".android-support-entry"))
          .find((item) => item.textContent.includes("反馈"))?.textContent.trim()"""
    )
    assert home_feedback_text == "反馈", home_feedback_text
    open_home_feedback()
    panel_text = js("document.querySelector('.user-feedback-panel').innerText")
    assert "反馈问题" not in panel_text
    assert "正式版 · 1.13.0 (1130)" in panel_text
    assert js("!document.querySelector('.user-feedback-panel details').open")
    assert "诊断采集" not in panel_text
    assert js("""[...document.querySelectorAll(
      'textarea[aria-label="问题描述"], input[aria-label="反馈联系方式"]'
    )].every(field => !field.placeholder)""")
    click_css(".user-feedback-panel details > summary")
    click_css(".user-feedback-diagnostic-upload summary")
    wait_js("document.querySelector('.user-feedback-panel').innerText.includes('设置 → 诊断 → 诊断采集')")
    category_options = js(
        """Array.from(document.querySelector(".user-feedback-panel select").options)
          .map((option) => ({ value: option.value, text: option.textContent.trim() }))"""
    )
    assert {"value": "feature", "text": "希望有的功能"} in category_options
    add_check(
        "feedback-entry-controls",
        "首页反馈入口、功能建议与 GKD 版本",
        "首页和面板标题均为“反馈”；分类含“希望有的功能”；连接 fixture 后显示"
        "版本“正式版 · 1.13.0 (1130)”；材料默认折叠，展开后可查看诊断导出指引",
    )

    start_check("feedback-file-inputs", "规则文件上传、直接粘贴与诊断 ZIP")
    click_checkbox_label("当前规则")
    wait_js("document.querySelector('.user-feedback-panel input[type=file][accept*=\".json\"]')")
    set_file_input(
        ".user-feedback-panel input[type=file][accept*='.json']",
        RULE_FILE_NAME,
        "application/json",
        RULE_FILE_TEXT.encode("utf-8"),
    )
    wait_js(
        f"document.querySelector('textarea[aria-label=\"反馈规则内容\"]')?.value.includes('反馈规则样本')"
        f" && document.querySelector('.user-feedback-panel').innerText.includes({RULE_FILE_NAME!r})"
    )
    set_value("textarea[aria-label='反馈规则内容']", RULE_FILE_TEXT + RULE_PASTE_SUFFIX)
    set_file_input(
        ".user-feedback-panel input[type=file][accept*='.zip']",
        DIAGNOSTIC_ZIP_NAME,
        "application/zip",
        DIAGNOSTIC_ZIP,
    )
    wait_js(
        f"document.querySelector('.user-feedback-panel').innerText.includes({DIAGNOSTIC_ZIP_NAME!r})"
    )
    set_value(".user-feedback-panel select", "feature")
    set_value(
        "textarea[aria-label='问题描述']",
        "希望增加按功能建议分类筛选反馈的能力。",
    )
    click_button("预览并保存草稿", ".user-feedback-panel")
    wait_js("document.querySelector('.user-feedback-meta')")
    new_fields_payload = read_draft_payload()
    assert new_fields_payload["category"] == "feature", new_fields_payload["category"]
    assert new_fields_payload["context"]["gkdChannel"] == "正式版"
    assert new_fields_payload["context"]["gkdVersion"] == "1.13.0 (1130)"
    uploaded_rules = decode_attachment(new_fields_payload, "rules.txt").decode("utf-8")
    assert "反馈规则样本" in uploaded_rules
    assert "manually-pasted-7788" in uploaded_rules
    assert AI_KEY not in uploaded_rules
    uploaded_diagnostics = decode_attachment(new_fields_payload, DIAGNOSTIC_ZIP_NAME)
    assert uploaded_diagnostics == DIAGNOSTIC_ZIP, "诊断 ZIP 在整理时被改写"
    add_check(
        "feedback-file-inputs",
        "规则文件上传、直接粘贴与诊断 ZIP",
        "规则文件可读取后继续粘贴编辑；诊断 ZIP 由用户手动选择；预览 payload 为"
        "功能建议分类，带真实 GKD 版本，规则凭据已脱敏，ZIP 字节保持不变",
    )
    click_button("返回整理", ".user-feedback-panel")
    wait_js("document.querySelector('.user-feedback-draft')")
    page.run_js("(() => { window.confirm = () => true; return true; })()")
    click_button("删除草稿", ".user-feedback-panel")
    deadline = time.monotonic() + 5
    while read_draft_state() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not read_draft_state(), "新增控件验收后草稿未清理"
    click_css("button[aria-label='关闭反馈']")
    wait_js("!document.querySelector('.user-feedback-panel')")

    start_check("home-snapshot-selection", "首页反馈可选择快照并启用截图/节点材料")
    open_home_feedback()
    click_css(".user-feedback-panel details > summary")
    wait_js("document.querySelector('select[aria-label=\"反馈现场快照\"]')")
    set_value(
        "select[aria-label='反馈现场快照']",
        str(FIXTURE_SNAPSHOT["id"]),
    )
    wait_js(
        "(() => { const checks = Array.from(document.querySelectorAll("
        "'.user-feedback-panel fieldset input[type=\"checkbox\"]')).map((input) => ({"
        " text: input.parentElement?.textContent || '', disabled: input.disabled }));"
        " const snapshotChecks = checks.filter((item) =>"
        " item.text.includes('当前截图') || item.text.includes('当前节点树'));"
        " return snapshotChecks.length === 2 && snapshotChecks.every((item) => !item.disabled); })()"
    )
    assert any(item["path"].endswith("/getSnapshot") for item in state["requests"])
    assert any(item["path"].endswith("/getScreenshot") for item in state["requests"])
    add_check(
        "home-snapshot-selection",
        "首页反馈可选择快照并启用截图/节点材料",
        "首页反馈显示快照选择器；选择 fixture 后实际读取 getSnapshot/getScreenshot，"
        "截图与节点树复选框解除禁用",
    )
    click_css("button[aria-label='关闭反馈']")
    wait_js("!document.querySelector('.user-feedback-panel')")

    page.ele("css:.android-snapshot-check-row input[type=checkbox]").click()
    wait_js(
        "document.querySelector('.android-snapshot-check-row input[type=checkbox]')?.checked"
    )

    start_check("home-snapshot-autoload", "首页已勾选快照会带入反馈")
    open_home_feedback()
    wait_js(
        "document.querySelector('select[aria-label=\"反馈现场快照\"]')?.value === "
        + repr(str(FIXTURE_SNAPSHOT["id"]))
    )
    wait_js(
        "(() => { const checks = Array.from(document.querySelectorAll("
        "'.user-feedback-panel fieldset input[type=\"checkbox\"]')).map((input) => ({"
        " text: input.parentElement?.textContent || '', disabled: input.disabled }));"
        " const snapshotChecks = checks.filter((item) =>"
        " item.text.includes('当前截图') || item.text.includes('当前节点树'));"
        " return snapshotChecks.length === 2 && snapshotChecks.every((item) => !item.disabled); })()"
    )
    add_check(
        "home-snapshot-autoload",
        "首页已勾选快照会带入反馈",
        "首页只勾选一张快照时，打开反馈会预选并加载该快照，截图与节点树直接可选",
    )
    click_css("button[aria-label='关闭反馈']")
    wait_js("!document.querySelector('.user-feedback-panel')")

    open_home_feedback()
    wait_js("document.querySelector('.user-feedback-panel input[aria-label=\"反馈现场快照\"]') || document.querySelector('.user-feedback-panel select[aria-label=\"反馈现场快照\"]')")
    wait_js("Array.from(document.querySelectorAll('.user-feedback-panel fieldset input[type=checkbox]')).filter((item) => !item.disabled).length >= 2")

    start_check("default-attachments", "反馈材料默认均未勾选")
    material = js(
        """Array.from(document.querySelectorAll(".user-feedback-panel fieldset .user-feedback-check"))
          .map((label) => ({ text: label.innerText, checked: label.querySelector("input").checked }))"""
    )
    assert len(material) == 3, material
    assert all(not item["checked"] for item in material), material
    add_check(
        "default-attachments",
        "反馈材料默认均未勾选",
        "当前规则、当前截图、当前节点树三项均默认为 false",
    )

    start_check("inputs", "填写描述、凭据与敏感节点")
    click_css(".user-feedback-panel details > summary")
    set_value(
        "textarea[aria-label='问题描述']",
        f"合成反馈 {NODE_TEXT}；已知密钥 {AI_KEY}；视觉区域 {VISUAL_SECRET}",
    )
    set_value("input[aria-label='反馈联系方式']", "fixture@example.invalid")
    set_value(
        "textarea[aria-label='反馈错误信息']",
        f"synthetic diagnostic api_key={AI_KEY}\nvisual={VISUAL_SECRET}",
    )
    click_checkbox_label("当前截图")
    click_checkbox_label("当前节点树")
    wait_js(
        "Array.from(document.querySelectorAll('.user-feedback-panel button'))"
        ".some((button) => button.textContent.trim() === '打码')"
    )
    assert js("!document.querySelector('.user-feedback-panel canvas')")
    wait_js(
        "document.querySelector('.user-feedback-screenshot-preview')"
        "?.complete && document.querySelector('.user-feedback-screenshot-preview').naturalWidth > 0"
    )
    clicked_node = page.run_js(
        """(needle) => {
          const details = Array.from(document.querySelectorAll(".user-feedback-panel details"))
            .find((item) => item.querySelector("summary")?.textContent.includes("手动隐藏节点文字"));
          if (!details) return false;
          details.open = true;
          const label = Array.from(details.querySelectorAll("label"))
            .find((item) => item.textContent.includes(needle));
          const input = label?.querySelector('input[type="checkbox"]');
          if (!input) return false;
          if (!input.checked) input.click();
          return input.checked;
        }""",
        NODE_TEXT,
    )
    assert clicked_node, "无法选择敏感节点"
    set_value(
        "textarea[aria-label='敏感文字']",
        "\n".join([NODE_TEXT, NODE_DESC, VISUAL_SECRET]),
    )
    add_check(
        "inputs",
        "填写描述、凭据与敏感节点",
        "localStorage 注入合成 API key；描述与错误均含已知密钥；截图与节点树已勾选，敏感节点已手动选择",
    )

    start_check("fullscreen-mask-entry", "截图默认只读，打码进入独立全屏层")
    assert js(
        "(() => { const panel = document.querySelector('.user-feedback-panel');"
        " return panel && !panel.inert && !panel.querySelector('canvas'); })()"
    )
    open_mask_editor()
    editor_box = js(
        f"""(() => {{
          const editor = document.querySelector({MASK_EDITOR_SELECTOR!r});
          const rect = editor.getBoundingClientRect();
          return {{ x: rect.left, y: rect.top, width: rect.width, height: rect.height,
            viewportWidth: innerWidth, viewportHeight: innerHeight,
            panelInert: document.querySelector('.user-feedback-panel').inert,
            focused: Boolean(document.activeElement.closest({MASK_EDITOR_SELECTOR!r})) }};
        }})()"""
    )
    assert abs(editor_box["x"]) <= 2 and abs(editor_box["y"]) <= 2, editor_box
    assert abs(editor_box["width"] - editor_box["viewportWidth"]) <= 2, editor_box
    assert abs(editor_box["height"] - editor_box["viewportHeight"]) <= 2, editor_box
    assert editor_box["panelInert"] and editor_box["focused"], editor_box
    add_check(
        "fullscreen-mask-entry",
        "截图默认只读，打码进入独立全屏层",
        "材料区仅显示静态截图和“打码”按钮；全屏层覆盖 412×915 视口，底层表单 inert，焦点进入编辑器",
    )

    start_check("pointer-mask", "轻触不落框，拖动才绘制，撤销和整图遮挡可撤回")
    page.run_js(
        f"""(() => {{
          document.querySelector({MASK_EDITOR_SELECTOR!r})
            .querySelector({MASK_CANVAS_SELECTOR!r}).scrollIntoView({{ block: "center" }});
          return true;
        }})()"""
    )
    time.sleep(0.3)
    page.run_js(
        f"""(() => {{
          const canvas = document.querySelector({MASK_EDITOR_SELECTOR!r})
            .querySelector({MASK_CANVAS_SELECTOR!r});
          const rect = canvas.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const fire = (type, pointerId, isPrimary, dx, dy, buttons = 1) => canvas.dispatchEvent(
            new PointerEvent(type, {{ bubbles: true, cancelable: true, pointerId, pointerType: "touch",
              isPrimary, button: 0, buttons, clientX: x + dx, clientY: y + dy }}));
          fire("pointerdown", 91, true, 0, 0);
          fire("pointermove", 91, true, 3, 3);
          fire("pointerup", 91, true, 3, 3, 0);
          fire("pointerdown", 92, true, 0, 0);
          fire("pointerdown", 93, false, 60, 60);
          fire("pointermove", 93, false, 80, 80);
          fire("pointercancel", 92, true, 0, 0, 0);
          fire("pointerup", 93, false, 80, 80, 0);
          return true;
        }})()"""
    )
    time.sleep(0.25)
    mask_status(0)
    canvas_box = js(
        f"""(() => {{
          const rect = document.querySelector({MASK_EDITOR_SELECTOR!r})
            .querySelector({MASK_CANVAS_SELECTOR!r}).getBoundingClientRect();
          return {{ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }};
        }})()"""
    )
    page.actions.click((int(canvas_box["x"]), int(canvas_box["y"]))).perform()
    time.sleep(0.25)
    mask_status(0)
    start, end = canvas_drag_points()
    page.actions.drag_to(start, end, duration=500, steps=20).perform()
    mask_status(1)
    click_button("撤销", MASK_EDITOR_SELECTOR)
    mask_status(0)
    click_button("遮住整张截图", MASK_EDITOR_SELECTOR)
    mask_status(1)
    click_button("撤销", MASK_EDITOR_SELECTOR)
    mask_status(0)
    page.actions.drag_to(start, end, duration=500, steps=20).perform()
    mask_status(1)
    page.actions.press(Keys.ESCAPE).perform()
    wait_js(f"!document.querySelector({MASK_EDITOR_SELECTOR!r})")
    wait_js("document.querySelector('.user-feedback-panel').innerText.includes('手动框选 0 处')")
    assert js("document.activeElement?.textContent.trim() === '打码'")
    open_mask_editor()
    mask_status(0)
    start, end = canvas_drag_points()
    page.actions.drag_to(start, end, duration=500, steps=20).perform()
    mask_status(1)
    add_check(
        "pointer-mask",
        "轻触不落框，拖动才绘制，撤销和整图遮挡可撤回",
        f"微小拖动、第二指针与 pointercancel 均为 0 处；真实 pointer 从 {start} 拖到 {end} 后为 1 处；撤销、整图遮挡、再撤销均恢复正确；Escape 回滚并归还“打码”焦点",
    )

    start_check("small-screen-mask", "360×640 窄屏仍可完整编辑")
    page.set_viewport(360, 640, device_pixel_ratio=1)
    small_editor = js(
        f"""(() => {{
          const editor = document.querySelector({MASK_EDITOR_SELECTOR!r});
          const editorRect = editor.getBoundingClientRect();
          const canvasRect = editor.querySelector({MASK_CANVAS_SELECTOR!r}).getBoundingClientRect();
          const complete = Array.from(editor.querySelectorAll('button'))
            .find((button) => button.textContent.trim() === '完成').getBoundingClientRect();
          return {{ width: editorRect.width, height: editorRect.height,
            canvasInside: canvasRect.left >= -1 && canvasRect.top >= -1
              && canvasRect.right <= innerWidth + 1 && canvasRect.bottom <= innerHeight + 1,
            completeInside: complete.left >= -1 && complete.top >= -1
              && complete.right <= innerWidth + 1 && complete.bottom <= innerHeight + 1 }};
        }})()"""
    )
    assert abs(small_editor["width"] - 360) <= 2 and abs(small_editor["height"] - 640) <= 2, small_editor
    assert small_editor["canvasInside"] and small_editor["completeInside"], small_editor
    page.set_viewport(412, 915, device_pixel_ratio=1)
    add_check(
        "small-screen-mask",
        "360×640 窄屏仍可完整编辑",
        "全屏层随视口变为 360×640；画布与“完成”按钮均在可视范围内；随后恢复 412×915",
    )

    close_mask_editor("完成")
    wait_js("document.querySelector('.user-feedback-panel').innerText.includes('手动框选 1 处')")
    wait_js("document.querySelectorAll('.user-feedback-screenshot-masks rect').length >= 3")
    assert js("document.querySelector('.user-feedback-screenshot-masks rect')?.getAttribute('fill') === '#000'")

    start_check("reenter-undo", "重新进入后可以撤销已保存的手动框")
    open_mask_editor()
    mask_status(1)
    assert js(
        f"""(() => {{
          const editor = document.querySelector({MASK_EDITOR_SELECTOR!r});
          const undo = Array.from(editor.querySelectorAll('button'))
            .find((button) => button.textContent.trim() === '撤销');
          return Boolean(undo && !undo.disabled);
        }})()"""
    )
    click_button("撤销", MASK_EDITOR_SELECTOR)
    mask_status(0)
    close_mask_editor("取消")
    wait_js("document.querySelector('.user-feedback-panel').innerText.includes('手动框选 1 处')")
    open_mask_editor()
    click_button("撤销", MASK_EDITOR_SELECTOR)
    mask_status(0)
    close_mask_editor("完成")
    wait_js("document.querySelector('.user-feedback-panel').innerText.includes('手动框选 0 处')")
    open_mask_editor()
    start, end = canvas_drag_points()
    page.actions.drag_to(start, end, duration=500, steps=20).perform()
    mask_status(1)
    close_mask_editor("完成")
    wait_js("document.querySelector('.user-feedback-panel').innerText.includes('手动框选 1 处')")
    add_check(
        "reenter-undo",
        "重新进入后可以撤销已保存的手动框",
        "再次进入时撤销按钮可用；撤销后取消恢复原框；再次撤销并完成会清除已保存遮罩；可重新画框",
    )

    start_check("snapshot-mask-isolation", "更换快照清空旧遮罩与节点选择")
    set_value("select[aria-label='反馈现场快照']", "")
    wait_js("document.querySelector('select[aria-label=\"反馈现场快照\"]')?.value === ''")
    wait_js(
        "Array.from(document.querySelectorAll('.user-feedback-panel label'))"
        ".find((label) => label.textContent.includes('当前截图'))"
        "?.querySelector('input[type=\"checkbox\"]').disabled === true"
    )
    set_value("select[aria-label='反馈现场快照']", str(FIXTURE_SNAPSHOT["id"]))
    wait_js(
        "document.querySelector('.user-feedback-screenshot-preview')"
        "?.complete && document.querySelector('.user-feedback-screenshot-preview').naturalWidth > 0"
    )
    wait_js("document.querySelector('.user-feedback-panel').innerText.includes('手动框选 0 处')")
    panel_text = js("document.querySelector('.user-feedback-panel').innerText")
    assert "手动隐藏节点文字（已选 0 个）" in panel_text, panel_text
    add_check(
        "snapshot-mask-isolation",
        "更换快照清空旧遮罩与节点选择",
        "先取消快照再重新选择；旧图的 1 处手动画框与已选节点均归零，新截图重新加载",
    )

    start_check("preview-without-mask-editor", "不进入打码编辑器也可预览截图")
    click_button("预览并保存草稿", ".user-feedback-panel")
    wait_js("document.querySelector('.user-feedback-meta') && document.querySelector('.user-feedback-final-image')")
    assert not js(f"document.querySelector({MASK_EDITOR_SELECTOR!r})")
    add_check(
        "preview-without-mask-editor",
        "不进入打码编辑器也可预览截图",
        "重新选择快照后直接整理材料，预览页仍生成脱敏截图，无需打开全屏编辑器",
    )
    click_button("返回整理", ".user-feedback-panel")
    wait_js("!document.querySelector('.user-feedback-meta')")
    open_mask_editor()
    mask_status(0)
    start, end = canvas_drag_points()
    page.actions.drag_to(start, end, duration=500, steps=20).perform()
    mask_status(1)
    close_mask_editor("完成")
    wait_js("document.querySelector('.user-feedback-panel').innerText.includes('手动框选 1 处')")

    start_check("preview-save", "预览脱敏材料并保存 IndexedDB 草稿")
    click_button("预览并保存草稿", ".user-feedback-panel")
    wait_js("document.querySelector('.user-feedback-meta') && document.querySelector('.user-feedback-final-image')")
    assert read_draft_state(), "预览出现但 IndexedDB 没有 latest 草稿"
    assert page.ele("css:.user-feedback-final-image")
    page.run_js(
        """(() => {
          document.querySelector(".user-feedback-final-image")
            .scrollIntoView({ block: "center" });
          return true;
        })()"""
    )
    time.sleep(0.4)
    page.screenshot(path=str(MOBILE_SCREENSHOT))
    overflow = js(
        """({ documentWidth: document.documentElement.scrollWidth, innerWidth: innerWidth,
          panelWidth: document.querySelector(".user-feedback-panel").scrollWidth,
          panelClientWidth: document.querySelector(".user-feedback-panel").clientWidth })"""
    )
    assert overflow["documentWidth"] <= overflow["innerWidth"] + 1, overflow
    assert overflow["panelWidth"] <= overflow["panelClientWidth"] + 1, overflow
    add_check(
        "preview-save",
        "预览脱敏材料并保存 IndexedDB 草稿",
        "预览显示合成截图与节点 JSON；IndexedDB 草稿已存在；手机视口无横向溢出",
    )

    start_check("offline-failure", "首次提交模拟断网并保留草稿")
    install_feedback_stub("offline", reset=True)
    click_checkbox_label("我已检查")
    click_button("提交反馈", ".user-feedback-panel")
    wait_js(
        "sessionStorage.getItem('__syntheticFeedbackAudit')"
        " && JSON.parse(sessionStorage.getItem('__syntheticFeedbackAudit')).length === 1"
    )
    wait_js("document.querySelector('.user-feedback-notice')?.innerText.includes('已保留脱敏草稿')")
    assert js("getComputedStyle(document.querySelector('.user-feedback-notice')).position === 'fixed'")
    audit = feedback_audit()
    first = audit[0]
    assert first["url"] == PRODUCTION_ENDPOINT
    assert first["mode"] == "offline"
    assert read_draft_state(), "断网失败后草稿不存在"
    add_check(
        "offline-failure",
        "首次提交模拟断网并保留草稿",
        "只拦截生产反馈 URL；未发真实请求；页面显示已保留脱敏草稿，IndexedDB latest 仍存在",
    )

    start_check("request-privacy", "请求体凭据、节点与图片打码")
    first_body = first["body"]
    first_text = json.dumps(first_body, ensure_ascii=False)
    leaked = [
        item
        for item in (AI_KEY, NODE_TEXT, NODE_DESC, NODE_RESOURCE, NODE_VID, VISUAL_SECRET)
        if item in first_text
    ]
    assert not leaked, "请求体泄漏：" + repr(leaked)
    assert first["headers"].get("idempotency-key") == first_body["clientId"]
    nodes_bytes = decode_attachment(first_body, "nodes.json")
    nodes_payload = json.loads(nodes_bytes.decode("utf-8"))
    sensitive_node = next(item for item in nodes_payload["nodes"] if item["id"] == 1)
    assert all(
        sensitive_node["attr"][key] is None
        for key in ("text", "desc", "id", "vid")
    ), sensitive_node
    png_bytes = decode_attachment(first_body, "screenshot.png")
    with Image.open(io.BytesIO(png_bytes)) as submitted_image:
        submitted_image.load()
        assert submitted_image.size == (540, 720), submitted_image.size
        assert submitted_image.convert("RGB").getpixel((200, 145)) == (0, 0, 0)
    source_pixel = SCREENSHOT_IMAGE.convert("RGB").getpixel((200, 145))
    assert source_pixel != (0, 0, 0)
    add_check(
        "request-privacy",
        "请求体凭据、节点与图片打码",
        "生产端点替身收到 2 个附件；正文与 nodes.json 不含已知 key/节点文字/资源 ID；PNG (200,145) 从原图像素变为纯黑",
    )

    start_check("source-unchanged", "脱敏不修改工作区源节点")
    click_button("返回整理", ".user-feedback-panel")
    wait_js("!document.querySelector('.user-feedback-meta')")
    page.run_js(
        """(() => {
          const details = Array.from(document.querySelectorAll(".user-feedback-panel details"))
            .find((item) => item.querySelector("summary")?.textContent.includes("手动隐藏节点文字"));
          if (details) details.open = true;
          return Boolean(details);
        })()"""
    )
    source_text = js("document.querySelector('.user-feedback-panel').innerText")
    assert NODE_TEXT in source_text
    assert NODE_VID in source_text
    add_check(
        "source-unchanged",
        "脱敏不修改工作区源节点",
        "返回整理后节点列表仍显示原 text/vid；仅预览 payload 被脱敏",
    )

    start_check("unchanged-repreview", "内容不变再次预览复用草稿 clientId")
    page.run_js("(() => { window.confirm = () => true; return true; })()")
    click_button("预览并保存草稿", ".user-feedback-panel")
    wait_js("document.querySelector('.user-feedback-meta')")
    reused_client_id = read_draft_client_id()
    assert reused_client_id == first_body["clientId"], (
        "再次预览生成了新 clientId：",
        first_body["clientId"],
        reused_client_id,
    )
    add_check(
        "unchanged-repreview",
        "内容不变再次预览复用草稿 clientId",
        "返回整理后未修改材料，confirm 合成放行后再次预览保存；IndexedDB 草稿仍使用首次 clientId",
    )

    start_check("offline-repreview-idempotency", "再次离线重试保持同 body 与 clientId")
    click_checkbox_label("我已检查")
    click_button("提交反馈", ".user-feedback-panel")
    wait_js("JSON.parse(sessionStorage.getItem('__syntheticFeedbackAudit')).length === 2")
    wait_js("document.querySelector('.user-feedback-notice')?.innerText.includes('已保留脱敏草稿')")
    audit = feedback_audit()
    second_retry = audit[1]
    assert second_retry["mode"] == "offline"
    assert second_retry["body"] == first_body, "再次预览后请求体发生变化"
    assert second_retry["body"]["clientId"] == first_body["clientId"], "再次预览后 clientId 发生变化"
    assert second_retry["headers"].get("idempotency-key") == first["headers"].get("idempotency-key")
    add_check(
        "offline-repreview-idempotency",
        "再次离线重试保持同 body 与 clientId",
        "第二次离线请求的完整 body、clientId 和 Idempotency-Key 与首轮一致",
    )

    start_check("reload-draft", "整页 reload 后从首页继续同一草稿")
    page.refresh()
    wait_js("document.querySelector('.android-home')", 30)
    install_feedback_stub("success")
    open_home_feedback()
    wait_js(
        "Array.from(document.querySelectorAll('.user-feedback-panel button'))"
        ".some((item) => item.textContent.trim() === '继续草稿')"
    )
    click_button("继续草稿", ".user-feedback-panel")
    wait_js("document.querySelector('.user-feedback-meta')")
    consent_before_retry = js(
        """Array.from(document.querySelectorAll(".user-feedback-panel label"))
          .find((item) => item.textContent.includes("我已检查"))
          ?.querySelector('input[type="checkbox"]').checked"""
    )
    assert consent_before_retry is False
    add_check(
        "reload-draft",
        "整页 reload 后从首页继续同一草稿",
        "reload 后首页反馈入口显示继续草稿；打开后恢复预览，发送同意框回到未勾选",
    )

    start_check("retry-success", "手动重试成功后清理草稿")
    click_checkbox_label("我已检查")
    click_button("提交反馈", ".user-feedback-panel")
    wait_js(
        f"document.querySelector('.user-feedback-receipt code')?.innerText === {SYNTHETIC_RECEIPT!r}"
    )
    wait_js("JSON.parse(sessionStorage.getItem('__syntheticFeedbackAudit')).length === 3")
    audit = feedback_audit()
    first_body = audit[0]["body"]
    success_body = audit[2]["body"]
    assert audit[1]["mode"] == "offline" and audit[2]["mode"] == "success"
    assert first_body == audit[1]["body"] == success_body, "三次请求 payload 不一致"
    assert all(
        item["headers"].get("idempotency-key") == success_body["clientId"]
        for item in audit
    )
    deadline = time.monotonic() + 5
    while read_draft_state() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not read_draft_state(), "提交成功后 latest 草稿仍存在"
    add_check(
        "retry-success",
        "手动重试成功后清理草稿",
        f"合成回执 {SYNTHETIC_RECEIPT}；三次 clientId/body 完全一致，"
        "Idempotency-Key 等于 clientId；成功后草稿已清除",
    )

    start_check("draft-cleared-ui", "成功回执后可再次打开且无旧草稿")
    click_button("完成", ".user-feedback-panel")
    wait_js("document.querySelector('.android-home')")
    open_home_feedback()
    wait_js("document.querySelector('.user-feedback-panel')")
    wait_js("!document.querySelector('.user-feedback-draft')", 5)
    add_check(
        "draft-cleared-ui",
        "成功回执后可再次打开且无旧草稿",
        "重新打开反馈面板未显示继续草稿或删除草稿入口",
    )

    start_check("corrupt-draft", "损坏 IndexedDB 草稿可删除")
    click_css("button[aria-label='关闭反馈']")
    wait_js("!document.querySelector('.user-feedback-panel')")
    write_corrupt_draft()
    open_home_feedback()
    wait_js("document.querySelector('.user-feedback-notice')?.innerText.includes('无法读取本地草稿')")
    wait_js(
        "Array.from(document.querySelectorAll('.user-feedback-panel button'))"
        ".some((item) => item.textContent.includes('删除本地草稿'))"
    )
    page.run_js("(() => { window.confirm = () => true; return true; })()")
    click_button("删除本地草稿", ".user-feedback-panel")
    wait_js("document.querySelector('.user-feedback-notice')?.innerText.includes('本地草稿已删除')")
    assert not read_draft_state()
    add_check(
        "corrupt-draft",
        "损坏 IndexedDB 草稿可删除",
        "注入 schema 损坏记录后页面给出可删除提示；删除按钮清理 IndexedDB latest",
    )

    start_check("workspace-mask-back", "工作区打开打码时返回只退出编辑器")
    click_css("button[aria-label='关闭反馈']")
    wait_js("!document.querySelector('.user-feedback-panel')")
    set_value(".android-device-form input", FIXTURE)
    click_css(".android-device-form button")
    wait_js("document.querySelectorAll('.android-snapshot-check-row').length === 1")
    if not js("document.querySelector('.android-snapshot-check-row input[type=checkbox]')?.checked"):
        clicked = page.run_js(
            """(() => {
              const input = document.querySelector(".android-snapshot-check-row input[type=checkbox]");
              if (!input) return false;
              input.click();
              return true;
            })()"""
        )
        assert clicked, "首页找不到可勾选的 fixture 快照"
    wait_js("document.querySelector('.android-snapshot-check-row input[type=checkbox]')?.checked")
    open_home_feedback()
    click_css(".user-feedback-panel details > summary")
    wait_js("Array.from(document.querySelectorAll('.user-feedback-panel fieldset input[type=checkbox]')).filter((item) => !item.disabled).length >= 2")
    click_checkbox_label("当前截图")
    wait_js(
        "Array.from(document.querySelectorAll('.user-feedback-panel button'))"
        ".some((button) => button.textContent.trim() === '打码')"
    )
    page.run_js("document.querySelector('.android-snapshot-chooser > .android-button-primary').click()")
    wait_js("document.querySelector('.android-workspace-shell')")
    wait_js("history.state?.gkdRuleBuilderView === 'workspace'")
    open_mask_editor()
    page.run_js("history.back()")
    wait_js(f"!document.querySelector({MASK_EDITOR_SELECTOR!r})")
    assert js(
        "Boolean(document.querySelector('.user-feedback-panel')"
        " && document.querySelector('.android-workspace-shell')"
        " && !document.querySelector('.android-home'))"
    )
    assert js("history.state?.gkdRuleBuilderView === 'workspace'"
              " && !history.state?.gkdFeedbackMaskEditorBase")
    add_check(
        "workspace-mask-back",
        "工作区打开打码时返回只退出编辑器",
        "从工作区 history entry 进入全屏打码后回退；编辑器关闭、反馈面板保留、工作区不跳回首页，临时 history 标记已清理",
    )
    click_css("button[aria-label='关闭反馈']")
    wait_js("!document.querySelector('.user-feedback-panel')")
    page.run_js("window.__GkdAndroidBack?.()")
    wait_js("document.querySelector('.android-home')")
    open_home_feedback()

    start_check("escape-close", "Escape 可关闭反馈对话框")
    page.actions.press(Keys.ESCAPE).perform()
    wait_js("!document.querySelector('.user-feedback-panel')", 5)
    add_check(
        "escape-close",
        "Escape 可关闭反馈对话框",
        "真实 Firefox 键盘 Escape 触发面板卸载",
    )

    start_check("horizontal-overflow", "最终手机视口无横向溢出")
    overflow = js("({ documentWidth: document.documentElement.scrollWidth, innerWidth: innerWidth })")
    assert overflow["documentWidth"] <= overflow["innerWidth"] + 1, overflow
    add_check(
        "horizontal-overflow",
        "最终手机视口无横向溢出",
        "收尾首页 document.scrollWidth 不超过 412px 视口",
    )

    write_report("passed")
    print("PASSED:", len(checks), "checks", flush=True)
except Exception as exc:
    failure = {
        "checkId": CHECK["id"],
        "title": CHECK["title"],
        "message": str(exc),
        "traceback": traceback.format_exc(),
    }
    add_check(CHECK["id"], CHECK["title"], str(exc), status="failed")
    if page is not None:
        try:
            page.screenshot(path=str(SCRATCH / "failure.png"))
            (SCRATCH / "failure.html").write_text(page.html, encoding="utf-8")
            (SCRATCH / "failure.json").write_text(
                json.dumps(failure, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            pass
    write_report("failed", failure)
    print("FAILED:", CHECK["id"], str(exc), flush=True)
    raise
finally:
    if page is not None:
        try:
            page.quit()
        except Exception:
            pass
    close_process_tree(dev_process)
    if fixture_server is not None:
        fixture_server.shutdown()
        fixture_server.server_close()
    profile = (SCRATCH / "firefox-profile").resolve()
    if SCRATCH.resolve() in profile.parents:
        shutil.rmtree(profile, ignore_errors=True)
    if dev_started_here:
        deadline = time.monotonic() + 3
        while port_is_listening(5174) and time.monotonic() < deadline:
            time.sleep(0.1)
    if dev_started_here and port_is_listening(5174):
        # Some Windows shims exit after spawning a child Vite listener.
        stop_owned_vite_listener()
        deadline = time.monotonic() + 3
        while port_is_listening(5174) and time.monotonic() < deadline:
            time.sleep(0.1)
    leaked_vite = dev_started_here and port_is_listening(5174)
    leaked_fixture = port_is_listening(8786)
    if leaked_vite or leaked_fixture:
        raise AssertionError(
            f"验收进程清理失败：5174={leaked_vite}, 8786={leaked_fixture}"
        )
