"""T03 rule-authoring browser checks against a simulated GKD HTTP service.

Run from the repository root with PowerShell:

    C:\\Python314\\python.exe scripts/check-rule-authoring.py

The script starts Vite only when 127.0.0.1:5174 is not already serving, and
always terminates the child it starts. It uses synthetic snapshots and a
hidden Firefox. Results describe browser behavior, not device acceptance.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")
from ruyipage import launch

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = ROOT / ".scratch" / "rule-authoring-browser-check"
SCRATCH.mkdir(parents=True, exist_ok=True)
APP_URL = "http://127.0.0.1:5174"
FIXTURE = "http://127.0.0.1:8770"
PNG = ROOT / "docs" / "verification" / "rule-authoring-browser-checks.png"
JSON_REPORT = ROOT / "docs" / "verification" / "rule-authoring-browser-checks.json"
MD_REPORT = ROOT / "docs" / "verification" / "rule-authoring-browser-checks.md"


def node(
    node_id: int,
    parent_id: int,
    *,
    name: str = "android.view.View",
    text: str | None = None,
    desc: str | None = None,
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
        "idQf": False,
        "textQf": text is not None,
        "attr": {
            "id": None,
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


def snapshot(snapshot_id: int, activity: str, nodes: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": snapshot_id,
        "appId": "com.fixture.video",
        "activityId": activity,
        "screenWidth": 1080,
        "screenHeight": 2400,
        "isLandscape": False,
        "appInfo": {
            "id": "com.fixture.video",
            "name": "规则验收样本",
            "versionCode": 7,
            "versionName": "7.0",
        },
        "device": {"model": "synthetic-fixture", "sdkInt": 34, "release": "14"},
        "nodes": nodes,
    }


FIXTURE_NODES = [
    node(0, -1, name="android.widget.FrameLayout", child_count=3),
    node(
        1,
        0,
        name="android.widget.FrameLayout",
        left=70,
        top=650,
        right=1010,
        bottom=1730,
        child_count=3,
        index=0,
        depth=1,
    ),
    node(
        2,
        1,
        name="android.widget.TextView",
        text="会员限时优惠",
        left=140,
        top=710,
        right=940,
        bottom=820,
        index=0,
        depth=2,
    ),
    node(
        3,
        1,
        name="android.widget.FrameLayout",
        clickable=True,
        vid="close_region",
        left=820,
        top=1640,
        right=990,
        bottom=1710,
        index=1,
        depth=2,
        child_count=1,
    ),
    node(
        4,
        3,
        name="android.widget.TextView",
        text="关闭 5",
        left=855,
        top=1662,
        right=965,
        bottom=1698,
        index=0,
        depth=3,
    ),
    node(
        5,
        0,
        name="android.view.View",
        clickable=True,
        vid="ad_hotspot",
        left=760,
        top=1580,
        right=1030,
        bottom=1780,
        index=1,
        depth=1,
    ),
    node(
        6,
        0,
        name="android.widget.Button",
        text="立即购买",
        clickable=True,
        left=140,
        top=1310,
        right=940,
        bottom=1440,
        index=2,
        depth=1,
    ),
    node(
        7,
        1,
        name="android.widget.TextView",
        text="3 秒后可关闭",
        left=140,
        top=870,
        right=940,
        bottom=930,
        index=1,
        depth=2,
    ),
]

POSITIVE = snapshot(3001, "com.fixture.video.MainActivity", FIXTURE_NODES)
COUNTEREXAMPLE = snapshot(
    3002,
    "com.fixture.video.MainActivity",
    [item for item in FIXTURE_NODES if item["id"] in {0, 1, 2, 6, 7}],
)
POSITIVE_SECONDARY = snapshot(
    3003,
    "com.fixture.video.OtherActivity",
    FIXTURE_NODES,
)
SNAPSHOTS = {3001: POSITIVE, 3002: COUNTEREXAMPLE, 3003: POSITIVE_SECONDARY}


def summary(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": raw["id"],
        "appId": raw["appId"],
        "activityId": raw["activityId"],
        "screenWidth": raw["screenWidth"],
        "screenHeight": raw["screenHeight"],
        "isLandscape": False,
        "appInfo": raw["appInfo"],
        "appName": raw["appInfo"]["name"],
    }


state: dict[str, Any] = {"requests": [], "updates": [], "fail_next_update": False}


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_: Any) -> None:
        return

    def reply(self, value: Any, status: int = 200) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/snapshot.png":
            self.reply({}, 404)
            return
        body = SCREENSHOT_PNG
        self.send_response(200)
        self.send_header("content-type", "image/png")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.reply({})

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"null")
        path = self.path.split("?", 1)[0].rstrip("/")
        state["requests"].append({"path": path, "body": body})
        if path.endswith("/getServerInfo"):
            self.reply(
                {
                    "device": {"model": "synthetic-fixture", "sdkInt": 34},
                    "gkdAppInfo": {
                        "id": "li.songe.gkd.debug",
                        "name": "GKD Fixture",
                        "versionName": "1.12.1",
                    },
                }
            )
        elif path.endswith("/getSnapshots"):
            self.reply([summary(SNAPSHOTS[key]) for key in (3003, 3002, 3001)])
        elif path.endswith("/getSnapshot"):
            self.reply(SNAPSHOTS[int(body["id"])])
        elif path.endswith("/getScreenshot"):
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("access-control-allow-origin", "*")
            self.send_header("content-length", str(len(SCREENSHOT_PNG)))
            self.end_headers()
            self.wfile.write(SCREENSHOT_PNG)
        elif path.endswith("/updateSubscription"):
            if state["fail_next_update"]:
                state["fail_next_update"] = False
                self.reply({"message": "synthetic fixture rejected update"}, 503)
            else:
                state["updates"].append(body)
                self.reply({"message": "accepted"})
        else:
            self.reply({}, 404)


def screenshot_image() -> bytes:
    image = Image.new("RGB", (1080, 2400), "#172235")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 1079, 180), fill="#0d1524")
    draw.text((44, 58), "FIXTURE VIDEO", fill="#f2f6ff", font=ImageFont.load_default(30))
    draw.rounded_rectangle((70, 650, 1010, 1730), radius=34, fill="#24334d", outline="#6684ad", width=4)
    draw.text((140, 730), "Synthetic launch card", fill="#f2f6ff", font=ImageFont.load_default(42))
    draw.text((140, 880), "3 seconds", fill="#9fc8ec", font=ImageFont.load_default(28))
    draw.rounded_rectangle((140, 1310, 940, 1440), radius=24, fill="#386c9d")
    draw.text((455, 1358), "BUY", fill="#ffffff", font=ImageFont.load_default(34))
    draw.rounded_rectangle((760, 1580, 1030, 1780), radius=28, fill="#314159")
    draw.rounded_rectangle((820, 1640, 990, 1710), radius=20, fill="#f2f6ff")
    draw.text((850, 1659), "CLOSE 5", fill="#172235", font=ImageFont.load_default(28))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    image.close()
    return buffer.getvalue()


SCREENSHOT_PNG = screenshot_image()


def server_up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1.5) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def dev_ready(url: str, timeout: float = 120) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server_up(url + "/") and server_up(url + "/src/main.tsx"):
            return True
        time.sleep(0.4)
    return False


def stop_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


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
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    return completed.stdout.strip() == "1"


def close_process_tree(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    subprocess.run(
        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
        capture_output=True,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass


fixture_server = ThreadingHTTPServer(("127.0.0.1", 8770), FixtureHandler)
threading.Thread(target=fixture_server.serve_forever, daemon=True).start()
dev_process: subprocess.Popen[bytes] | None = None
page = None
checks: list[dict[str, Any]] = []


def wait_js(expression: str, timeout: float = 20) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.run_js(
            "return (() => { try { return Boolean(" + expression + "); } catch { return false; } })();"
        ):
            return
        time.sleep(0.1)
    raise AssertionError(
        "等待失败：" + expression + "\n" + str(page.run_js("return document.body.innerText;"))
    )


def js(expression: str) -> Any:
    return page.run_js("return " + expression + ";")


def click(selector: str) -> None:
    element = page.ele("css:" + selector)
    assert element, "找不到元素：" + selector
    element.click()


def click_button(text: str, root: str = "document") -> None:
    clicked = js(
        "(() => { const root = %s;"
        " if (!root) return false; const button = Array.from(root.querySelectorAll('button'))"
        ".find((item) => item.textContent.trim() === %r);"
        " if (!button) return false; button.click(); return true; })()"
        % (root, text)
    )
    assert clicked, "找不到按钮：" + text


def set_dom_value(selector: str, value: str) -> None:
    changed = js(
        "(() => { const input = document.querySelector(%r); if (!input) return false;"
        " const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype :"
        " input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;"
        " const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;"
        " setter.call(input, %r); input.dispatchEvent(new Event('input', { bubbles: true }));"
        " input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()"
        % (selector, value)
    )
    assert changed, "找不到输入：" + selector


def click_select_option(selector: str, value: str) -> None:
    changed = js(
        "(() => { const select = document.querySelector(%r); if (!select) return false;"
        " const option = Array.from(select.options).find((item) => item.value === %r);"
        " if (!option) return false; select.focus(); option.selected = true;"
        " select.dispatchEvent(new Event('input', { bubbles: true }));"
        " select.dispatchEvent(new Event('change', { bubbles: true })); return select.value === %r; })()"
        % (selector, value, value)
    )
    assert changed, "找不到 select 选项：" + selector + " = " + value


def snapshot_client_point(snapshot_x: int, snapshot_y: int) -> tuple[int, int]:
    point = js(
        "(() => { const img = document.querySelector('.screenshot-image');"
        " if (!img) return null; const r = img.getBoundingClientRect();"
        " const nw = img.naturalWidth || r.width || 1; const nh = img.naturalHeight || r.height || 1;"
        " const cr = r.width / r.height; const ir = nw / nh;"
        " const boxW = cr > ir ? r.height * ir : r.width;"
        " const boxH = cr > ir ? r.height : r.width / ir;"
        " const offX = (r.width - boxW) / 2; const offY = (r.height - boxH) / 2;"
        " return { left: r.left + offX, top: r.top + offY, width: boxW, height: boxH }; })()"
    )
    assert point, "找不到截图图片"
    return (
        int(round(point["left"] + point["width"] * (snapshot_x / 1080))),
        int(round(point["top"] + point["height"] * (snapshot_y / 2400))),
    )


def set_condition_value(value: str) -> None:
    changed = js(
        "(() => { const editor = document.querySelector('.condition-editor');"
        " if (!editor) return false; const input = editor.querySelector('input[aria-label^=\"点击目标条件\"][aria-label$=\"值\"]');"
        " if (!input) return false;"
        " const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
        " setter.call(input, %r); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()"
        % value
    )
    assert changed, "找不到条件值输入"


def body_text() -> str:
    return js("document.body.innerText") or ""


def open_app() -> None:
    page.get(APP_URL + "/", wait="none", timeout=30)
    wait_js("document.querySelector('.android-home')", 120)


def add_check(check_id: str, title: str, status: str, detail: str) -> None:
    checks.append({"id": check_id, "title": title, "status": status, "detail": detail})
    print(f"{status.upper()}: {check_id} {title}", flush=True)


def stop_started_dev_server() -> None:
    global dev_process
    close_process_tree(dev_process)
    dev_process = None


def clean_scratch_artifacts() -> None:
    for name in ("failure.png", "failure.html", "workspace-top.png", "authoring-panels.png", "firefox-profile"):
        target = (SCRATCH / name).resolve()
        if SCRATCH.resolve() not in target.parents:
            raise AssertionError(f"拒绝清理 scratch 外路径：{target}")
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink(missing_ok=True)


try:
    clean_scratch_artifacts()
    dev_started_here = False
    if not server_up(APP_URL):
        print("启动隐藏 Vite 子进程…", flush=True)
        node_executable = shutil.which("node")
        vite_entry = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
        if not node_executable or not vite_entry.exists():
            raise AssertionError("找不到 node 或 node_modules/vite/bin/vite.js")
        dev_process = subprocess.Popen(
            [node_executable, str(vite_entry), "--host", "127.0.0.1", "--port", "5174"],
            cwd=ROOT,
            creationflags=subprocess.CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        dev_started_here = True
        if not dev_ready(APP_URL):
            raise AssertionError("Vite 未在 120 秒内就绪")

    page = launch(
        headless=True,
        user_dir=str(SCRATCH / "firefox-profile"),
        window_size=(412, 915),
    )
    page.set_viewport(412, 915, device_pixel_ratio=1)
    open_app()
    js("localStorage.clear()")
    open_app()
    js(
        "window.__fixtureCopiedTexts = [];"
        " window.GkdAndroidBridge = {"
        " copyToClipboard: (value) => { window.__fixtureCopiedTexts.push(String(value)); }"
        " }; true"
    )

    assert "HTTP 服务" in js("document.querySelector('.android-home').innerText")
    add_check("home", "首页设备连接入口可用", "passed", "观察到 HTTP 服务输入框和连接按钮")

    url_input = page.ele("css:.android-device-form input")
    assert url_input
    url_input.click()
    js(
        "(() => { const input = document.querySelector('.android-device-form input');"
        " const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
        " setter.call(input, %r); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()"
        % FIXTURE
    )
    click(".android-device-form button")
    wait_js("document.querySelectorAll('.android-snapshot-check-row').length === 3")
    assert "已连接" in js("document.body.innerText")
    add_check("connect", "外部 fixture 连接并返回三张快照", "passed", "getServerInfo 与 getSnapshots 均实际请求")

    checks_boxes = page.eles("css:.android-snapshot-check-row input[type=checkbox]")
    assert len(checks_boxes) == 3
    checks_boxes[0].click()
    wait_js("document.querySelectorAll('.android-snapshot-check-row input:checked').length === 1")
    click(".android-snapshot-chooser > .android-button-primary")
    wait_js("document.querySelector('.android-workspace-shell') && document.querySelector('.screenshot-stage')")
    assert "未选择快照" not in js("document.querySelector('.android-workspace-stage').innerText")
    add_check("workspace", "勾选快照后进入真实截图工作区", "passed", "打开 fixture 快照 3001")

    x, y = snapshot_client_point(905, 1675)
    start_x, start_y = snapshot_client_point(540, 1200)
    page.actions.drag_to((start_x, start_y), (x, y), duration=500, steps=20).perform()
    wait_js("document.querySelector('.node-selection-panel') && !document.querySelector('.node-selection-empty')")
    panel_text = js("document.querySelector('.node-selection-panel').innerText")
    assert "目标节点" in panel_text or "这里有多个节点" in panel_text, panel_text
    add_check("pointer", "实际 pointer 在截图选中节点并打开选择面板", "passed", f"视口坐标 ({x},{y})；{panel_text.splitlines()[-2:]}")

    options = page.eles("css:.node-selection-option")
    option_text = js("Array.from(document.querySelectorAll('.node-selection-option')).map((item) => item.innerText)")
    option_labels = "\n".join(option_text)
    assert len(options) >= 3, f"重叠点应列出至少 3 个节点，实际 {len(options)}：{option_labels}"
    assert all(value in option_labels for value in ("关闭 5", "close_region", "ad_hotspot")), option_labels
    assert "855,1662 · 110×36" in option_labels, option_labels
    node_panel_text = js("document.querySelector('.node-selection-panel').innerText")
    assert "可能点击：" in node_panel_text, node_panel_text
    assert "实际点击：" not in node_panel_text, node_panel_text
    assert "点击目标" in option_labels, option_labels
    picked_before = js("document.querySelector('.node-selection-option.is-picked').innerText")
    alternate = next((item for item in options if "ad_hotspot" in item.text), None)
    assert alternate is not None
    alternate.click()
    wait_js("document.querySelector('.node-selection-option.is-picked').innerText.includes('ad_hotspot')")
    picked_after = js("document.querySelector('.node-selection-option.is-picked').innerText")
    assert picked_before != picked_after
    add_check(
        "node-list",
        "节点列表可切换目标并更新范围标签",
        "passed",
        "真实拖拽命中关闭文字、可点父节点与广告热区；列表显示范围与“点击目标”，切换后 is-picked 同步更新",
    )

    wait_js("document.querySelector('[aria-label=\"规则验证\"]')")
    preview_text = js("document.querySelector('[aria-label=\"规则验证\"]').innerText")
    assert "当前快照" in preview_text or "未完整验证" in preview_text or "不满足" in preview_text
    assert "快照验证不代表设备测试有效" in preview_text
    add_check("summary", "规则摘要与点击范围同时可见", "passed", preview_text.splitlines()[0])

    wait_js("document.querySelector('.android-candidate-item')")
    candidate = page.ele("css:.android-candidate-item")
    assert candidate
    candidate.click()
    click(".android-workspace-tabs button:nth-child(2)")
    wait_js("document.querySelector('.android-candidate-item')")
    candidate = page.ele("css:.android-candidate-item")
    assert candidate
    candidate.click()
    detail_button = next((item for item in candidate.eles("css:button") if item.text.strip() == "查看详情"), None)
    assert detail_button is not None
    detail_button.click()
    wait_js("document.querySelector('.android-candidate-details')")
    details_text = js("document.querySelector('.android-candidate-details').innerText")
    assert "复制 JSON5" in details_text
    assert "{" in details_text and "matches" in details_text
    copy_button = js("(() => { const button = Array.from(document.querySelectorAll('.android-candidate-details button'))"
        ".find((item) => item.textContent.trim() === '复制 JSON5'); if (!button) return null;"
        " window.__fixtureCopiedTexts = []; window.__fixtureCopyClicks = 0;"
        " window.GkdAndroidBridge = { copyToClipboard: (value) => { window.__fixtureCopiedTexts.push(String(value)); } };"
        " button.addEventListener('click', () => { window.__fixtureCopyClicks += 1; });"
        " const r = button.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()")
    assert copy_button is not None
    page.actions.click((int(copy_button["x"]), int(copy_button["y"]))).perform()
    try:
        wait_js("window.__fixtureCopiedTexts.length === 1 && Array.from(document.querySelectorAll('.android-candidate-details button')).some((item) => item.innerText.includes('已复制 JSON5'))")
    except AssertionError:
        bridge_diag = js("({ bridge: Boolean(window.GkdAndroidBridge), copy: typeof window.GkdAndroidBridge?.copyToClipboard, values: window.__fixtureCopiedTexts, clicks: window.__fixtureCopyClicks, buttons: Array.from(document.querySelectorAll('.android-candidate-details button')).map((item) => item.innerText), elements: document.elementsFromPoint(%d, %d).map((item) => item.className || item.tagName) })" % (int(copy_button["x"]), int(copy_button["y"])))
        raise AssertionError(f"JSON5 复制 seam 未完成：{bridge_diag}")
    copied_json5 = js("window.__fixtureCopiedTexts[0]")
    assert "matches" in copied_json5 and "groups" in copied_json5, copied_json5[:500]
    add_check("candidate-details", "候选详情可查看 selector 与复制 JSON5 路径", "passed", "候选卡保持简短；详情可复制，并捕获到含 matches/groups 的完整 AppRule JSON5")

    test_button = page.ele("css:.android-candidate-add")
    if test_button:
        state["fail_next_update"] = True
        test_button.click()
        wait_js("document.querySelector('.android-message')")
        failure_message = js("document.querySelector('.android-message').innerText")
        assert "updateSubscription 503" in failure_message or "synthetic fixture rejected update" in failure_message
        add_check("send-failure", "fixture 拒绝测试订阅时显示真实错误", "passed", failure_message)
        end_test = next((item for item in page.eles("css:.android-candidate-item:first-child button") if item.text.strip() == "结束测试"), None)
        assert end_test
        end_test.click()
        wait_js("Array.from(document.querySelectorAll('.android-candidate-item:first-child button')).some((item) => item.textContent.trim() === '重新测试')")
        retest = next((item for item in page.eles("css:.android-candidate-item:first-child button") if item.text.strip() == "重新测试"), None)
        assert retest
        retest.click()
        wait_js("document.querySelector('.android-message').innerText.includes('已加入当前测试集合')")
        subscription = state["updates"][-1] if state["updates"] else None
        assert subscription is not None
        assert subscription.get("id") == 0
        assert "GKD Rule Studio" in subscription.get("name", "")
        add_check("test-identity", "重试后发送完整测试订阅身份", "passed", "fixture 收到 id=0、完整 subscription 与规则")
    else:
        add_check("test-identity", "加入测试后发送完整测试订阅身份", "pending", "当前页面未显示加入测试按钮")

    js("(() => { const item = document.querySelector('.android-candidate-item');"
       " const button = Array.from(item.querySelectorAll('button')).find((item) => item.textContent.trim() === '编辑条件');"
       " if (!button) return false; button.click(); return true; })()")
    wait_js("document.querySelector('.condition-editor')")
    editor_text = js("document.querySelector('.condition-editor').innerText")
    assert "应用条件" in editor_text and "取消编辑" in editor_text
    set_condition_value("不存在的文字")
    wait_js("document.querySelector('.condition-editor-validation').innerText.includes('末项点击目标未命中')")
    cancel_buttons = page.eles("css:.condition-editor .condition-editor-actions button")
    cancel = next((item for item in cancel_buttons if item.text.strip() == "取消编辑"), None)
    assert cancel
    cancel.click()
    try:
        wait_js("!document.querySelector('.condition-editor')", 3)
        add_check("condition-cancel", "编辑条件输入可验证，取消后保留原候选", "passed", "条件改为不存在文字后显示未命中；取消后编辑器卸载")
    except AssertionError:
        add_check("condition-cancel", "编辑条件输入可验证，取消后保留原候选", "failed", "点击“取消编辑”后 .condition-editor 仍存在；已用 DOM click 复现")
        js("location.reload()")
        open_app()
        wait_js("document.querySelector('.android-home')")
        click(".android-device-form button")
        wait_js("document.querySelectorAll('.android-snapshot-check-row').length === 3")
        page.eles("css:.android-snapshot-check-row input[type=checkbox]")[0].click()
        click(".android-snapshot-chooser > .android-button-primary")
        wait_js("document.querySelector('.screenshot-stage')")
        stage = page.ele("css:.screenshot-stage")
        left, top = stage.rect.viewport_location
        width, height = stage.rect.size
        page.actions.click((int(left + width * 0.84), int(top + height * 0.70))).perform()
        wait_js("document.querySelector('.android-candidate-item')")
        click(".android-workspace-tabs button:nth-child(2)")
        wait_js("document.querySelector('.android-candidate-item')")

    js("(() => { const item = document.querySelector('.android-candidate-item');"
       " const button = Array.from(item.querySelectorAll('button')).find((item) => item.textContent.trim() === '编辑条件');"
       " if (!button) return false; button.click(); return true; })()")
    wait_js("document.querySelector('.condition-editor')")
    set_condition_value("close_region")
    wait_js("document.querySelector('.condition-editor-validation').innerText.includes('当前快照命中 1 个点击目标')")
    assert not js("document.querySelector('.condition-editor .condition-editor-actions button:last-child').disabled")
    click_button("应用条件", "document.querySelector('.condition-editor')")
    try:
        wait_js("!document.querySelector('.condition-editor')", 3)
        add_check("condition-apply", "应用编辑后的规则并更新候选摘要", "passed", "修改原条件值且应用按钮可用，应用后编辑器卸载")
    except AssertionError:
        add_check("condition-apply", "应用编辑后的规则并更新候选摘要", "failed", "修改原条件值且应用按钮可用，但点击后编辑器仍存在")

    summaries = page.eles("css:details > summary")
    multi = next((item for item in summaries if item.text.strip() == "多快照验证"), None)
    assert multi is not None
    multi.click()
    wait_js("document.querySelector('.multi-snapshot-panel')")
    click_button("添加当前快照为正例", "document.querySelector('.multi-snapshot-panel')")
    wait_js("document.querySelector('.multi-snapshot-sample')")
    assert "正例：应匹配" in js("document.querySelector('.multi-snapshot-panel').innerText")
    add_check("multi-snapshot-add", "规则可加入当前快照正例并逐张验证", "passed", "details 展开并显示一张正例结果")

    available_values = js("Array.from(document.querySelector('.multi-snapshot-device-picker select').options).map((item) => item.value)")
    assert "3002" in available_values, "多快照候选为空：" + str(available_values)
    initial_multi_text = js("document.querySelector('.multi-snapshot-panel').innerText")
    assert "#3003" in initial_multi_text and "正例：应匹配" in initial_multi_text
    click(".android-workspace-tabs button:nth-child(2)")
    wait_js("document.querySelector('.android-candidate-item')")
    second_candidate = js("(() => { const card = document.querySelectorAll('.android-candidate-item')[1];"
        " if (!card) return null; const button = Array.from(card.querySelectorAll('button'))"
        ".find((item) => item.textContent.trim() === '编辑条件');"
        " return { text: card.innerText, enabled: Boolean(button) }; })()")
    assert second_candidate and second_candidate["enabled"], second_candidate
    second_candidate_button = page.ele("css:.android-candidate-item:nth-child(2) .android-candidate-detail")
    assert second_candidate_button is not None
    second_candidate_button.click()
    wait_js("document.querySelector('.condition-editor')")
    click_button("取消编辑", "document.querySelector('.condition-editor')")
    wait_js("!document.querySelector('.condition-editor')")
    selected_candidate_text = js("document.querySelector('.android-candidate-item.android-candidate-active').innerText")
    selected_strategy = js("document.querySelector('.android-candidate-item.android-candidate-active .android-candidate-strategy').innerText")
    second_strategy = second_candidate["text"].splitlines()[0]
    assert selected_strategy == second_strategy, (second_strategy, selected_strategy, selected_candidate_text)
    preserved_samples = js("Array.from(document.querySelectorAll('.multi-snapshot-sample')).map((item) => item.innerText)")
    assert len(preserved_samples) == 1
    preserved_text = preserved_samples[0]
    assert "#3003" in preserved_text and "正例按预期命中" in preserved_text, preserved_text
    add_check(
        "edit-cancel-preserves-selection",
        "取消非首选候选编辑后恢复被编辑候选",
        "passed",
        "第二张候选卡进入编辑后取消，候选仍保持激活，已有正例样例未丢失",
    )
    click(".android-workspace-tabs button:nth-child(2)")
    wait_js("document.querySelector('.android-candidate-item')")
    if not js("document.querySelector('.multi-snapshot-panel')"):
        multi = next((item for item in page.eles("css:details > summary") if item.text.strip() == "多快照验证"), None)
        assert multi is not None
        multi.click()
        wait_js("document.querySelector('.multi-snapshot-panel')")
    click_select_option('.multi-snapshot-device-picker select', "3002")
    click_select_option('.multi-snapshot-device-picker select[aria-label="新样例预期"]', "negative")
    click_button("添加设备快照", "document.querySelector('.multi-snapshot-panel')")
    time.sleep(1)
    snapshot_requests = [item for item in state["requests"] if item["path"].endswith("/getSnapshot")]
    assert any(item["body"] == {"id": 3002} for item in snapshot_requests)
    wait_js("document.querySelectorAll('.multi-snapshot-sample').length === 2", 8)
    multi_text = js("document.querySelector('.multi-snapshot-panel').innerText")
    assert "#3003" in multi_text and "#3002" in multi_text
    assert "反例：不应匹配" in multi_text
    assert "反例未被误触，符合预期。" in multi_text, multi_text
    sample_verdicts = js("Array.from(document.querySelectorAll('.multi-snapshot-sample')).map((item) => item.innerText)")
    assert len(sample_verdicts) == 2
    assert all("符合预期" in item for item in sample_verdicts), sample_verdicts
    add_check("multi-snapshot", "同 app 正反例逐张展示", "passed", "正例 #3003 与无关闭节点的反例 #3002 均显示“符合预期”")

    click(".android-workspace-tabs button:nth-child(2)")
    wait_js("document.querySelector('.android-candidate-item')")
    js("(() => { const item = document.querySelector('.android-candidate-item');"
       " const button = Array.from(item.querySelectorAll('button')).find((item) => item.textContent.trim() === '编辑条件');"
       " if (!button) return false; button.click(); return true; })()")
    wait_js("document.querySelector('.condition-editor')")
    set_condition_value("不存在的文字")
    wait_js("document.querySelector('.condition-editor-validation').innerText.includes('末项点击目标未命中')")
    assert js("document.querySelector('.condition-editor .condition-editor-actions button:last-child').disabled")
    wait_js("document.querySelectorAll('.multi-snapshot-sample').length === 2")
    edited_multi_text = js("document.querySelector('.multi-snapshot-panel').innerText")
    edited_samples = js("Array.from(document.querySelectorAll('.multi-snapshot-sample')).map((item) => item.innerText)")
    assert len(edited_samples) == 2
    assert "#3003" in edited_multi_text and "#3002" in edited_multi_text
    assert any("不符合预期" in item for item in edited_samples), edited_samples
    click_button("取消编辑", "document.querySelector('.condition-editor')")
    wait_js("!document.querySelector('.condition-editor')")
    wait_js("document.querySelectorAll('.multi-snapshot-sample').length === 2")
    restored_multi_text = js("document.querySelector('.multi-snapshot-panel').innerText")
    restored_samples = js("Array.from(document.querySelectorAll('.multi-snapshot-sample')).map((item) => item.innerText)")
    assert len(restored_samples) == 2
    assert "反例未被误触，符合预期。" in restored_multi_text
    assert all("符合预期" in item for item in restored_samples), restored_samples
    add_check(
        "multi-snapshot-editing",
        "编辑零命中时保留正反例且取消后恢复规则",
        "passed",
        "已有 2 项时编辑为不存在值：应用禁用、正例重算失败但两项保留；取消后两项按原规则恢复通过",
    )

    feedback = next((item for item in page.eles("css:details > summary") if item.text.strip() == "反馈与修复"), None)
    assert feedback is not None
    feedback.click()
    wait_js("document.querySelector('[aria-label=\"失败反馈\"]')")
    feedback_text = js("document.querySelector('[aria-label=\"失败反馈\"]').innerText")
    assert "复制反馈 prompt" in feedback_text
    assert "快照验证和用户反馈不等同于设备测试有效" in feedback_text
    click_select_option('[aria-label="失败反馈"] select', "node-unavailable")
    wait_js("document.querySelector('[aria-label=\"失败反馈\"] select').value === 'node-unavailable'")
    before_feedback_copy = js("window.__fixtureCopiedTexts.length")
    click_button("复制反馈 prompt", "document.querySelector('[aria-label=\"失败反馈\"]')")
    try:
        wait_js("Array.from(document.querySelectorAll('[aria-label=\"失败反馈\"] button')).some((item) => item.innerText === '已复制 prompt')", 5)
        feedback_copy_state = "已复制 prompt"
    except AssertionError:
        feedback_copy_state = "复制失败，重试" if "复制失败，重试" in js("document.querySelector('[aria-label=\"失败反馈\"]').innerText") else "未确认"
    assert feedback_copy_state == "已复制 prompt", feedback_copy_state
    assert js("window.__fixtureCopiedTexts.length") == before_feedback_copy + 1
    feedback_prompt = js("window.__fixtureCopiedTexts[window.__fixtureCopiedTexts.length - 1]")
    for evidence in (
        "节点不可用",
        "测试版",
        "close_region",
        "重新抓取快照，并改用稳定的上下文。",
        "以上各测试版的测试结果如下：",
    ):
        assert evidence in feedback_prompt, f"反馈 prompt 缺少 {evidence}：{feedback_prompt}"
    add_check(
        "feedback",
        "反馈与修复面板可展开并保留修复证据",
        "passed",
        "外部剪贴板 seam 捕获到当前规则、close_region 条件、节点不可用分类与修复限制；按钮进入“已复制 prompt”",
    )

    page.run_js("window.scrollTo(0, 0);")
    assert js("document.documentElement.scrollWidth <= window.innerWidth")
    first_frame = SCRATCH / "workspace-top.png"
    page.screenshot(path=str(first_frame))
    page.run_js("document.querySelector('.multi-snapshot-panel').scrollIntoView({ block: 'start' });")
    time.sleep(0.2)
    second_frame = SCRATCH / "authoring-panels.png"
    page.screenshot(path=str(second_frame))
    images = [Image.open(first_frame), Image.open(second_frame)]
    combined = Image.new(
        "RGB",
        (sum(image.width for image in images), max(image.height for image in images)),
        "#0e131a",
    )
    left_offset = 0
    for image in images:
        combined.paste(image.convert("RGB"), (left_offset, 0))
        left_offset += image.width
    combined.save(PNG)
    for image in images:
        image.close()
    combined.close()
    first_frame.unlink(missing_ok=True)
    second_frame.unlink(missing_ok=True)
    add_check("mobile-layout", "移动端视口无横向溢出", "passed", "412×915")

    failed_checks = [item for item in checks if item["status"] != "passed"]
    closed_finding = {
        "id": "multi-snapshot-async-response-dropped",
        "status": "closed",
        "observed": "Previously getSnapshot/getScreenshot succeeded but React StrictMode discarded the second snapshot response.",
        "closed_evidence": "MultiSnapshotValidationPanel now uses runRef updated only when appKey changes; fixture #3003 plus #3002 rendered as two passing samples in this run.",
        "check_ids": ["multi-snapshot", "multi-snapshot-editing"],
    }
    findings = [closed_finding] if not failed_checks else [{
        "id": "browser-check-not-passed",
        "status": "open",
        "observed": "; ".join(f"{item['id']}: {item['detail']}" for item in failed_checks),
        "next_step": "Inspect failure screenshot and rerun after the affected browser flow is fixed.",
    }]
    result = {
        "scope": "browser fixture; not Android device acceptance",
        "viewport": {"width": 412, "height": 915, "pixelRatio": 1},
        "fixture": FIXTURE,
        "snapshots": [summary(raw) for raw in SNAPSHOTS.values()],
        "checks": checks,
        "requests": state["requests"],
        "subscriptionUpdates": len(state["updates"]),
        "screenshot": "docs/verification/rule-authoring-browser-checks.png",
        "findings": findings,
    }
    JSON_REPORT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    rows = "\n".join(
        f"| {item['title']} | {item['status']} | {item['detail']} |" for item in checks
    )
    finding_lines = "\n".join(
        f"- `{item['id']}`（{item['status']}）：{item.get('closed_evidence') or item['observed']}"
        for item in findings
    )
    MD_REPORT.write_text(
        "# T03 规则制作浏览器验收\n\n"
        "运行目录：仓库根目录；Shell：PowerShell\n\n"
        "```powershell\nC:\\Python314\\python.exe scripts/check-rule-authoring.py\n```\n\n"
        "本轮使用外部设备 HTTP fixture、真实浏览器 pointer 和真实 selector/装配代码；"
        "未注入 React state。模拟服务回执不等同 Android 设备验收。\n\n"
        "| 检查 | 状态 | 证据 |\n| --- | --- | --- |\n"
        + rows
        + "\n\n截图：![浏览器验收](" + PNG.name + ")\n\n"
        "## Findings\n\n" + finding_lines + "\n\n"
        "## 边界\n\n"
        "本记录是浏览器 fixture 行为，不是 Android WebView 或真机验收，也没有证明 GKD 设备执行成功。"
        "复制路径通过页面公开的 `window.GkdAndroidBridge.copyToClipboard` seam 捕获 payload，并核对 AppRule JSON5 及反馈分类、条件、修复提示；"
        "这是浏览器 seam 验证，不是 Android 系统剪贴板或真机执行验收。\n",
        encoding="utf-8",
    )
    print("ALL OBSERVATIONS RECORDED:", len(checks), flush=True)
    stop_started_dev_server()
    if failed_checks:
        raise SystemExit(1)
except Exception:
    if page is not None:
        try:
            page.screenshot(path=str(SCRATCH / "failure.png"))
            (SCRATCH / "failure.html").write_text(page.html, encoding="utf-8")
        except Exception:
            pass
    raise
finally:
    if page is not None:
        try:
            page.quit()
        except Exception:
            pass
    stop_started_dev_server()
    fixture_server.shutdown()
    fixture_server.server_close()

    leaked_dev_port = dev_started_here and port_is_listening(5174)
    leaked_fixture_port = port_is_listening(8770)
    if leaked_dev_port or leaked_fixture_port:
        raise AssertionError(
            "验收进程清理失败："
            + f"5174={leaked_dev_port}, 8770={leaked_fixture_port}"
        )
