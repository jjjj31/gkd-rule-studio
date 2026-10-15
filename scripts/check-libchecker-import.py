"""LibChecker 导入与 SDK 上下文的浏览器流程检查。

用脱敏合成导出与合成快照，在托管 Firefox 里跑完整流程：首页入口、导入
（JSON / ZIP）、搜索、详情、删除、重复导入、超限、重启恢复、损坏缓存，
以及连接模拟 GKD 后的工作区摘要。

运行目录：仓库根目录。Shell：PowerShell。

    C:\\Python314\\python.exe scripts/check-libchecker-import.py

脚本自己启动 / 关闭 Vite 开发服务器和模拟 GKD 接口（127.0.0.1:8768），
中间产物写入已忽略的 .scratch/libchecker-sdk-import-browser-check/。
"""
import base64
import io
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
from ruyipage import launch

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = ROOT / ".scratch" / "libchecker-sdk-import-browser-check"
SCRATCH.mkdir(parents=True, exist_ok=True)

APP_URL = "http://127.0.0.1:5174"
FIXTURE = "http://127.0.0.1:8768"
PROFILES_KEY = "gkd-rule-studio-app-sdk-profiles"

# ---------------------------------------------------------------- 合成导出

APPS_JSON = [
    {
        "apkInfo": {
            "packageName": "com.example.video",
            "versionCode": "12345",
            "versionName": "6.6.0",
            "appName": "示例视频",
            "components": {
                "activities": [
                    {"name": "com.byted.pangle.core.SplashAdActivity", "sdk": None},
                    {"name": "com.example.video.ui.MainActivity", "sdk": None},
                ],
                "services": [{"name": "com.qq.e.comm.DownloadService", "sdk": None}],
                "receivers": [{"name": "com.byted.pangle.core.NetworkReceiver", "sdk": None}],
                "providers": [],
            },
            "sdkSummary": [],
        },
        "analyzedAt": "2026-10-13T10:00:00.000Z",
    },
    {
        "apkInfo": {
            "packageName": "com.example.reader",
            "versionCode": "9007199254740993",
            "appName": "示例阅读",
            "components": {
                "activities": [{"name": "com.example.reader.MainActivity", "sdk": None}],
                "services": [],
                "receivers": [],
                "providers": [],
            },
            "sdkSummary": [],
        },
        "analyzedAt": "2026-10-13T10:00:00.000Z",
    },
    {
        "apkInfo": {
            "packageName": "com.example.plain",
            "versionCode": "7",
            "appName": "示例工具",
            "components": {
                "activities": [{"name": "com.example.plain.MainActivity", "sdk": None}],
                "services": [],
                "receivers": [],
                "providers": [],
            },
            "sdkSummary": [],
        },
        "analyzedAt": "2026-10-13T10:00:00.000Z",
    },
]

APPS_JSON_TEXT = json.dumps(APPS_JSON, ensure_ascii=False)


def build_lcapps() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("apps.json", APPS_JSON_TEXT)
        archive.writestr("icons/com.example.video.png", b"\x89PNG\r\n\x1a\n")
    return buffer.getvalue()


LCAPPS_BYTES = build_lcapps()

# 版本失配样本：同一包名、不同 versionCode。
MISMATCH_JSON_TEXT = json.dumps(
    [
        {
            "apkInfo": {
                "packageName": "com.example.video",
                "versionCode": "999",
                "appName": "示例视频（旧版）",
                "components": {
                    "activities": [{"name": "com.byted.pangle.core.SplashAdActivity"}],
                    "services": [],
                    "receivers": [],
                    "providers": [],
                },
                "sdkSummary": [],
            },
            "analyzedAt": "2026-09-01T10:00:00.000Z",
        }
    ],
    ensure_ascii=False,
)

# ---------------------------------------------------------------- 模拟 GKD

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

SNAPSHOT_APP_ID = "com.example.video"
SNAPSHOT_ID = 42
RAW_SNAPSHOT = {
    "id": SNAPSHOT_ID,
    "appId": SNAPSHOT_APP_ID,
    "activityId": "com.example.video.ui.SplashActivity",
    "screenWidth": 1080,
    "screenHeight": 2400,
    "isLandscape": False,
    "appInfo": {"id": SNAPSHOT_APP_ID, "name": "示例视频", "versionCode": 12345, "versionName": "6.6.0"},
    "device": {"model": "fixture", "sdkInt": 34, "release": "14"},
    "nodes": [
        {
            "id": 0,
            "pid": -1,
            "idQf": False,
            "textQf": False,
            "attr": {
                "id": None,
                "vid": None,
                "name": "android.widget.FrameLayout",
                "text": None,
                "desc": None,
                "clickable": False,
                "focusable": False,
                "checkable": False,
                "checked": False,
                "editable": False,
                "longClickable": False,
                "visibleToUser": True,
                "left": 0,
                "top": 0,
                "right": 1080,
                "bottom": 2400,
                "width": 1080,
                "height": 2400,
                "childCount": 2,
                "index": 0,
                "depth": 0,
            },
        },
        {
            "id": 1,
            "pid": 0,
            "idQf": False,
            "textQf": False,
            "attr": {
                "id": None,
                "vid": "tt_splash_container",
                "name": "android.widget.FrameLayout",
                "text": None,
                "desc": None,
                "clickable": False,
                "focusable": False,
                "checkable": False,
                "checked": False,
                "editable": False,
                "longClickable": False,
                "visibleToUser": True,
                "left": 0,
                "top": 0,
                "right": 1080,
                "bottom": 2400,
                "width": 1080,
                "height": 2400,
                "childCount": 2,
                "index": 0,
                "depth": 1,
            },
        },
        {
            "id": 2,
            "pid": 1,
            "idQf": False,
            "textQf": True,
            "attr": {
                "id": None,
                "vid": "tt_splash_skip_btn",
                "name": "android.widget.ImageView",
                "text": "跳过 3",
                "desc": None,
                "clickable": True,
                "focusable": True,
                "checkable": False,
                "checked": False,
                "editable": False,
                "longClickable": False,
                "visibleToUser": True,
                "left": 860,
                "top": 120,
                "right": 1040,
                "bottom": 200,
                "width": 180,
                "height": 80,
                "childCount": 0,
                "index": 0,
                "depth": 2,
            },
        },
        {
            "id": 3,
            "pid": 1,
            "idQf": True,
            "textQf": False,
            "attr": {
                "id": "ad_click_area",
                "vid": None,
                "name": "android.view.View",
                "text": None,
                "desc": None,
                "clickable": False,
                "focusable": False,
                "checkable": False,
                "checked": False,
                "editable": False,
                "longClickable": False,
                "visibleToUser": True,
                "left": 0,
                "top": 0,
                "right": 1080,
                "bottom": 2400,
                "width": 1080,
                "height": 2400,
                "childCount": 0,
                "index": 1,
                "depth": 2,
            },
        },
    ],
}

SNAPSHOT_SUMMARY = {
    "id": SNAPSHOT_ID,
    "appId": SNAPSHOT_APP_ID,
    "activityId": "com.example.video.ui.SplashActivity",
    "screenWidth": 1080,
    "screenHeight": 2400,
    "isLandscape": False,
    "appInfo": {"id": SNAPSHOT_APP_ID, "name": "示例视频", "versionCode": 12345},
    "appName": "示例视频",
    "appVersionName": "6.6.0",
    "appVersionCode": 12345,
}


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.reply({})

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        if length:
            self.rfile.read(length)
        path = self.path.split("?")[0].rstrip("/")
        if path.endswith("getServerInfo"):
            self.reply(
                {
                    "device": {"model": "fixture", "sdkInt": 34, "release": "14"},
                    "gkdAppInfo": {"id": "li.songe.gkd.debug", "name": "GKD", "versionName": "fixture"},
                }
            )
        elif path.endswith("getSnapshots"):
            self.reply([SNAPSHOT_SUMMARY])
        elif path.endswith("getSnapshot"):
            self.reply(RAW_SNAPSHOT)
        elif path.endswith("getScreenshot"):
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("access-control-allow-origin", "*")
            self.send_header("content-length", str(len(PNG_1X1)))
            self.end_headers()
            self.wfile.write(PNG_1X1)
        else:
            self.reply({}, 404)


server = ThreadingHTTPServer(("127.0.0.1", 8768), FixtureHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()

# ---------------------------------------------------------------- 开发服务器


def server_up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1.5) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def dev_server_ready(url: str, timeout: float) -> bool:
    """等 Vite 能返回入口模块，避免首次预构建依赖时页面暂时空白。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server_up(url + "/") and server_up(url + "/src/main.tsx"):
            return True
        time.sleep(0.5)
    return False


dev_process = None
if not server_up(APP_URL):
    print("启动 Vite 开发服务器…", flush=True)
    dev_process = subprocess.Popen(
        "pnpm run dev",
        cwd=ROOT,
        shell=True,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if not dev_server_ready(APP_URL, 120):
        raise SystemExit("Vite 开发服务器未能在 120 秒内就绪")

# ---------------------------------------------------------------- 浏览器检查

page = launch(headless=True, user_dir=str(SCRATCH / "firefox-profile"), window_size=(412, 915))
# Firefox 窗口有最小宽度，window_size 拿不到 412 CSS 像素的视口，这里显式设视口。
page.set_viewport(412, 915, device_pixel_ratio=1)
checks = []


def wait_js(expression, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if page.run_js("return (() => { try { return Boolean(" + expression + "); } catch { return false; } })();"):
            return
        time.sleep(0.1)
    raise AssertionError("等待失败: " + expression + "\n" + str(page.run_js("return document.body.innerText;")))


def js(expression):
    return page.run_js("return " + expression + ";")


def click(selector):
    element = page.ele("css:" + selector)
    assert element, "找不到元素: " + selector
    element.click()


def check(name):
    checks.append(name)
    print("PASS:", name, flush=True)


def profiles():
    return js("JSON.parse(localStorage.getItem(%r) || 'null')" % PROFILES_KEY)


def notice_text():
    return js("(document.querySelector('.library-notice') || {}).textContent || ''") or ""


def inject_file(name, mime, payload_b64):
    return js(
        "(() => {"
        "  const input = document.querySelector('.ad-sdk-file-input');"
        "  const binary = atob(%r);"
        "  const bytes = new Uint8Array(binary.length);"
        "  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);"
        "  const dt = new DataTransfer();"
        "  dt.items.add(new File([bytes], %r, { type: %r }));"
        "  input.files = dt.files;"
        "  input.dispatchEvent(new Event('change', { bubbles: true }));"
        "  return true;"
        "})()" % (payload_b64, name, mime)
    )


def set_input(selector, value):
    return js(
        "(() => {"
        "  const input = document.querySelector(%r);"
        "  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;"
        "  setter.call(input, %r);"
        "  input.dispatchEvent(new Event('input', { bubbles: true }));"
        "  return true;"
        "})()" % (selector, value)
    )


def inject_oversized_file():
    """33 MiB 文件在页面里直接构造，避免把几十 MB 传进 run_js。"""
    return js(
        "(() => {"
        "  const input = document.querySelector('.ad-sdk-file-input');"
        "  const bytes = new Uint8Array(33 * 1024 * 1024);"
        "  const dt = new DataTransfer();"
        "  dt.items.add(new File([bytes], 'huge.json', { type: 'application/json' }));"
        "  input.files = dt.files;"
        "  input.dispatchEvent(new Event('change', { bubbles: true }));"
        "  return true;"
        "})()"
    )


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


_warmed_up = False


def open_app(timeout=300):
    """打开首页并等 React 挂载。

    首页引用了外网字体样式表，离线环境里首次导航要等这个请求超时（约 40-50 秒）
    React 才挂载，之后浏览器会记住失败结果，导航和挂载都只要几百毫秒。所以首次
    导航给足超时，后续用短超时；万一真的没挂载起来，整页重试兜底。
    """
    global _warmed_up
    deadline = time.monotonic() + timeout
    last_error = None
    while True:
        page.get(APP_URL + "/", wait="none", timeout=10 if _warmed_up else 120)
        try:
            wait_js(
                "document.querySelector('.android-home')",
                timeout=10 if _warmed_up else 150,
            )
            _warmed_up = True
            return
        except AssertionError as error:
            last_error = error
            print("首页未就绪，重试…", flush=True)
        if time.monotonic() >= deadline:
            raise AssertionError("首页未能在 %d 秒内就绪\n%s" % (timeout, last_error))
        time.sleep(1)


try:
    open_app()
    # 复用持久 profile，先清掉上次运行留下的本地状态，保证从零开始。
    js("localStorage.clear()")
    open_app()

    # 1. 首页入口
    assert js("Boolean(document.querySelector('.library-entry'))"), "首页没有入口卡片"
    assert "SDK 信息" in js("document.querySelector('.android-home').innerText"), "首页没有 SDK 信息入口"
    check("首页显示 SDK 信息入口，无需设备与 AI 配置")

    # 2. 打开面板 → 空状态
    click(".library-entry:nth-of-type(2)")
    wait_js("document.querySelector('.app-sdk-panel')")
    assert "还没有导入应用信息" in js("document.querySelector('.app-sdk-panel').innerText"), "空状态文案缺失"
    check("面板打开显示空状态，未连接设备也可用")

    # 3. 非法文件（快照备份结构）被拒绝且保留旧记录
    inject_file("backup.json", "application/json", b64(json.dumps({"apps": []}).encode()))
    wait_js("document.querySelector('.library-notice')")
    assert "请选择 LibChecker 应用信息导出文件" in notice_text(), "非法文件提示不符: " + notice_text()
    assert profiles() is None, "非法文件不应写入存储"
    check("非 LibChecker 文件被拒绝，缓存保持不变")

    # 4. JSON 导入
    inject_file("apps.json", "application/json", b64(APPS_JSON_TEXT.encode()))
    wait_js("(document.querySelector('.library-notice') || {}).textContent && "
            "document.querySelector('.library-notice').textContent.includes('已导入')")
    text = notice_text()
    assert "已导入 3 个应用" in text, "导入计数不符: " + text
    assert "1 个匹配到受支持的 SDK" in text, "匹配计数不符: " + text
    assert len(profiles()["profiles"]) == 3, "存储中的应用数量不符"
    check("apps.json 导入成功，计数与存储一致")

    # 5. 同一数据的 ZIP 不产生重复
    inject_file("export.lcapps", "application/octet-stream", b64(LCAPPS_BYTES))
    wait_js("(document.querySelector('.library-notice') || {}).textContent.includes('当前共 3 个应用')")
    assert len(profiles()["profiles"]) == 3, "ZIP 重复导入产生了重复应用"
    check("ZIP 与 JSON 导入同一数据按包名替换，不产生重复")

    # 6. 搜索
    set_input('input[aria-label="搜索应用名或包名"]', "reader")
    wait_js("document.querySelectorAll('.library-app-button').length === 1")
    assert "com.example.reader" in js("document.querySelector('.library-app-button').innerText")
    set_input('input[aria-label="搜索应用名或包名"]', "示例工具")
    wait_js("document.querySelectorAll('.library-app-button').length === 1")
    assert "com.example.plain" in js("document.querySelector('.library-app-button').innerText")
    set_input('input[aria-label="搜索应用名或包名"]', "不存在的应用")
    wait_js("document.querySelector('.library-empty')")
    assert "未找到应用" in js("document.querySelector('.library-empty').innerText")
    set_input('input[aria-label="搜索应用名或包名"]', "")
    wait_js("document.querySelectorAll('.library-app-button').length === 3")
    check("按包名与应用名搜索，未命中显示空提示")
    assert js("document.documentElement.scrollWidth <= window.innerWidth"), "SDK 面板横向溢出"
    js("window.scrollTo(0, 0);")
    page.screenshot(path=str(SCRATCH / "sdk-panel-mobile.png"))
    check("SDK 面板移动端布局无横向溢出")

    # 7. 详情：SDK 证据与版本
    set_input('input[aria-label="搜索应用名或包名"]', "video")
    wait_js("document.querySelectorAll('.library-app-button').length === 1")
    click(".library-app-button")
    wait_js("document.querySelector('.ad-sdk-meta')")
    # 证据默认折叠，展开后再断言可见文本。
    js("document.querySelectorAll('.app-sdk-panel .ad-sdk-detail').forEach((item) => { item.open = true; });")
    wait_js("document.querySelector('.app-sdk-panel').innerText.includes('前缀 com.byted.pangle')")
    detail = js("document.querySelector('.app-sdk-panel').innerText")
    assert "包名：com.example.video" in detail, detail
    assert "6.6.0" in detail, detail
    assert "穿山甲" in detail and "优量汇" in detail, detail
    assert "前缀 com.byted.pangle" in detail, detail
    check("详情显示版本、SDK 名单与匹配前缀")

    # 8. 超安全整数版本码
    click('button[aria-label="返回应用列表"]')
    wait_js("document.querySelector('.library-search')")
    set_input('input[aria-label="搜索应用名或包名"]', "reader")
    wait_js("document.querySelectorAll('.library-app-button').length === 1")
    click(".library-app-button")
    wait_js("document.querySelector('.ad-sdk-meta')")
    detail = js("document.querySelector('.app-sdk-panel').innerText")
    assert "9007199254740993" in detail, detail
    assert "未识别到受支持的 SDK" in detail, detail
    check("超出安全整数的版本码完整保留，零匹配应用显示未识别")

    # 9. 删除应用
    click(".library-actions .android-button")
    wait_js("(document.querySelector('.library-notice') || {}).textContent.includes('已删除')")
    assert len(profiles()["profiles"]) == 2, "删除后存储未同步"
    assert "com.example.reader" not in js(
        "JSON.stringify(JSON.parse(localStorage.getItem(%r)).profiles)" % PROFILES_KEY
    )
    check("按应用删除后列表与本地存储同步")

    # 10. 重复选择同一文件
    click('button[aria-label="返回首页"]')
    wait_js("document.querySelector('.android-home')")
    click(".library-entry:nth-of-type(2)")
    wait_js("document.querySelector('.ad-sdk-file-input')")
    inject_file("apps.json", "application/json", b64(APPS_JSON_TEXT.encode()))
    wait_js("(document.querySelector('.library-notice') || {}).textContent.includes('当前共 3 个应用')")
    inject_file("apps.json", "application/json", b64(APPS_JSON_TEXT.encode()))
    wait_js("(document.querySelector('.library-notice') || {}).textContent.includes('当前共 3 个应用')")
    assert len(profiles()["profiles"]) == 3, "重复选择同一文件后数量异常"
    check("取消后再选同一文件可重复导入")

    # 11. 超限文件
    inject_oversized_file()
    wait_js("(document.querySelector('.library-notice') || {}).textContent.includes('32 MiB')")
    assert len(profiles()["profiles"]) == 3, "超限文件不应改动存储"
    check("超过 32 MiB 的文件被拒绝且保留旧记录")

    # 12. 重启恢复（离线）
    open_app()
    click(".library-entry:nth-of-type(2)")
    wait_js("document.querySelector('.app-sdk-panel')")
    assert "3 个应用" in js("document.querySelector('.app-sdk-panel').innerText"), "重启后档案未恢复"
    check("重启后离线恢复已导入档案")

    # 13. 连接模拟 GKD 并打开快照
    click('button[aria-label="返回首页"]')
    wait_js("document.querySelector('.android-device-form')")
    set_input(".android-device-form .android-input", FIXTURE)
    page.ele("css:.android-device-form .android-button").click()
    wait_js("document.querySelector('.android-snapshot-chooser')")
    wait_js("document.querySelectorAll('.android-snapshot-check-row').length === 1")
    page.ele("css:.android-snapshot-check-toggle input").click()
    page.ele("css:.android-snapshot-chooser .android-button-primary").click()
    wait_js("document.querySelector('.android-workspace-stage')")
    check("连接模拟 GKD 并进入工作区")

    # 14. 工作区摘要区分两类来源
    wait_js("document.querySelector('.ad-sdk-summary')")
    js("document.querySelectorAll('.ad-sdk-summary .ad-sdk-detail').forEach((item) => { item.open = true; });")
    wait_js("document.querySelector('.ad-sdk-summary').innerText.includes('tt_splash_skip_btn')")
    summary = js("document.querySelector('.ad-sdk-summary').innerText")
    assert "应用 SDK" in summary and "页面特征" in summary, summary
    assert "版本核对：相符" in summary, summary
    assert "穿山甲" in summary and "优量汇" in summary, summary
    assert "tt_splash_skip_btn" in summary, summary
    check("工作区摘要区分清单与页面证据，版本相符")
    assert js("document.documentElement.scrollWidth <= window.innerWidth"), "工作区摘要横向溢出"
    js("window.scrollTo(0, 0);")
    page.screenshot(path=str(SCRATCH / "workspace-summary-mobile.png"))
    check("工作区摘要移动端布局无横向溢出")

    # 15. 版本失配时名单折叠
    open_app()
    click(".library-entry:nth-of-type(2)")
    wait_js("document.querySelector('.ad-sdk-file-input')")
    inject_file("mismatch.json", "application/json", b64(MISMATCH_JSON_TEXT.encode()))
    wait_js("(document.querySelector('.library-notice') || {}).textContent.includes('已导入')")
    click('button[aria-label="返回首页"]')
    wait_js("document.querySelector('.android-device-form')")
    set_input(".android-device-form .android-input", FIXTURE)
    page.ele("css:.android-device-form .android-button").click()
    wait_js("document.querySelectorAll('.android-snapshot-check-row').length === 1")
    page.ele("css:.android-snapshot-check-toggle input").click()
    page.ele("css:.android-snapshot-chooser .android-button-primary").click()
    wait_js("document.querySelector('.ad-sdk-summary')")
    summary = js("document.querySelector('.ad-sdk-summary').innerText")
    assert "版本核对：导入信息与快照版本不同" in summary, summary
    assert "版本失配，查看导入清单" in summary, summary
    assert "穿山甲" not in js(
        "document.querySelector('.ad-sdk-block').innerText"
    ), "失配名单不应直接展示"
    check("版本失配时提示状态并折叠名单")

    # 16. 损坏缓存
    js("localStorage.setItem(%r, '{ broken')" % PROFILES_KEY)
    open_app()
    click(".library-entry:nth-of-type(2)")
    wait_js("document.querySelector('.app-sdk-panel')")
    assert "读取本地应用 SDK 档案失败" in js("document.querySelector('.app-sdk-panel').innerText"), \
        js("document.querySelector('.app-sdk-panel').innerText")
    assert js("localStorage.getItem(%r)" % PROFILES_KEY) == "{ broken", "加载过程不应覆盖损坏缓存"
    check("缓存损坏时提示错误且不覆盖原值")

    js("localStorage.removeItem(%r)" % PROFILES_KEY)
    (SCRATCH / "browser-qa.json").write_text(
        json.dumps(
            {
                "passed": checks,
                "viewport": {
                    "width": js("window.innerWidth"),
                    "height": js("window.innerHeight"),
                    "pixelRatio": js("window.devicePixelRatio"),
                },
                "hardware": "simulated GKD service at 127.0.0.1:8768; no adb device; synthetic LibChecker export",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
finally:
    try:
        page.quit()
    except Exception:
        pass
    server.shutdown()
    if dev_process is not None:
        try:
            os.kill(dev_process.pid, signal.CTRL_BREAK_EVENT)
        except Exception:
            subprocess.run(
                ["taskkill", "/T", "/F", "/PID", str(dev_process.pid)],
                capture_output=True,
            )

print("\n全部通过：%d 项" % len(checks), flush=True)
