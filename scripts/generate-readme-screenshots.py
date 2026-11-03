"""生成 README 用的演示截图。

用合成开屏广告图 + 模拟 GKD 接口，在托管 Firefox 里走一遍真实 UI：
首页、订阅规则库、工作区候选，最后拼一张头图。

运行目录：仓库根目录。

    C:\\Python314\\python.exe scripts/generate-readme-screenshots.py

产物写入 docs/images/（会提交）。中间 profile 在 .scratch/readme-shots/（已忽略）。
"""
import io
import json
import math
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.stdout.reconfigure(encoding="utf-8")
from ruyipage import launch

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "images"
SCRATCH = ROOT / ".scratch" / "readme-shots"
OUT.mkdir(parents=True, exist_ok=True)
SCRATCH.mkdir(parents=True, exist_ok=True)

APP_URL = "http://127.0.0.1:5174"
FIXTURE = "http://127.0.0.1:8771"
FONT_REGULAR = "C:/Windows/Fonts/msyh.ttc"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"

# ---------------------------------------------------------------- 合成开屏广告图


def font(size: int, bold: bool = False):
    return ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, size)


def vertical_gradient(size, top, bottom):
    width, height = size
    image = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(image)
    for y in range(height):
        ratio = y / max(1, height - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line([(0, y), (width, y)], fill=color)
    return image


def make_splash_ad(path: Path) -> None:
    """画一张看起来像短视频 App 开屏广告的 1080x2400 截图。"""
    width, height = 1080, 2400
    image = vertical_gradient((width, height), (18, 24, 38), (8, 11, 17)).convert("RGBA")
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # 背景光斑，模拟广告大图。
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((-260, 260, 760, 1280), fill=(255, 106, 61, 120))
    glow_draw.ellipse((420, 980, 1380, 1980), fill=(64, 196, 255, 90))
    glow_draw.ellipse((180, 1500, 980, 2300), fill=(255, 54, 124, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(150))
    image = Image.alpha_composite(image, glow)
    draw = ImageDraw.Draw(image)

    # 顶部状态栏。
    draw.text((48, 58), "18:42", font=font(40, True), fill=(255, 255, 255, 235))
    for index, level in enumerate([10, 16, 22, 28]):
        bar_x = width - 250 + index * 18
        draw.rounded_rectangle(
            (bar_x, 92 - level, bar_x + 10, 92), radius=3,
            fill=(255, 255, 255, 220 - index * 10),
        )
    draw.rounded_rectangle((width - 178, 66, width - 96, 100), radius=8,
                           outline=(255, 255, 255, 190), width=3)
    draw.rectangle((width - 172, 72, width - 112, 94), fill=(255, 255, 255, 210))
    draw.rounded_rectangle((width - 92, 76, width - 84, 90), radius=3,
                           fill=(255, 255, 255, 200))

    # 「广告」标签。
    draw.rounded_rectangle((48, 132, 168, 194), radius=12, fill=(0, 0, 0, 120))
    draw.text((76, 143), "广告", font=font(34, True), fill=(255, 255, 255, 225))

    # 跳过按钮：与快照节点 860,120-1040,200 对齐。
    draw.rounded_rectangle((860, 120, 1040, 200), radius=32, fill=(0, 0, 0, 145))
    draw.rounded_rectangle((860, 120, 1040, 200), radius=32,
                           outline=(255, 255, 255, 70), width=2)
    draw.text((884, 134), "跳过 3", font=font(38, True), fill=(255, 255, 255, 245))

    # 广告主视觉：抽象产品卡片。
    card = Image.new("RGBA", (760, 900), (0, 0, 0, 0))
    card_draw = ImageDraw.Draw(card)
    card_draw.rounded_rectangle((0, 0, 760, 900), radius=48, fill=(255, 255, 255, 18))
    card_draw.rounded_rectangle((0, 0, 760, 900), radius=48,
                                outline=(255, 255, 255, 60), width=2)
    for x in range(0, 760, 2):
        ratio = x / 760
        card_draw.line([(x, 620), (x, 900)],
                       fill=(int(255 * ratio), int(96 + 90 * ratio), 61, 120))
    card_draw.ellipse((200, 90, 560, 450), fill=(255, 196, 92, 235))
    card_draw.ellipse((300, 190, 460, 350), fill=(255, 128, 74, 245))
    card_draw.rounded_rectangle((250, 520, 510, 590), radius=35,
                                fill=(255, 255, 255, 235))
    card_draw.text((286, 535), "限时 5 折", font=font(36, True), fill=(196, 44, 30, 255))
    card = card.filter(ImageFilter.GaussianBlur(0.6))
    image.alpha_composite(card, (160, 560))

    draw = ImageDraw.Draw(image)
    draw.text((96, 320), "夏日焕新", font=font(118, True), fill=(255, 255, 255, 250))
    draw.text((100, 456), "好物直降 · 先到先得", font=font(48),
              fill=(255, 255, 255, 210))
    draw.line((100, 536, 420, 536), fill=(255, 128, 74, 230), width=7)

    # 底部 CTA。
    draw.rounded_rectangle((150, 2030, 930, 2190), radius=80,
                           fill=(255, 255, 255, 245))
    draw.text((356, 2072), "立即查看", font=font(54, True), fill=(18, 24, 38, 255))
    draw.text((150, 2245), "广告 · 安全下载", font=font(30), fill=(255, 255, 255, 130))

    image.convert("RGB").save(path, format="PNG", optimize=True)
    print(f"生成开屏广告图: {path} ({path.stat().st_size // 1024} KiB)", flush=True)


SPLASH_PNG = SCRATCH / "splash-ad.png"
make_splash_ad(SPLASH_PNG)
SPLASH_BYTES = SPLASH_PNG.read_bytes()

# ---------------------------------------------------------------- 模拟 GKD

SNAPSHOT_APP_ID = "com.ss.android.ugc.aweme"
SNAPSHOT_ID = 7
SNAPSHOT_ACTIVITY = "com.ss.android.ugc.aweme.splash.SplashActivity"
RAW_SNAPSHOT = {
    "id": SNAPSHOT_ID,
    "appId": SNAPSHOT_APP_ID,
    "activityId": SNAPSHOT_ACTIVITY,
    "screenWidth": 1080,
    "screenHeight": 2400,
    "isLandscape": False,
    "appInfo": {
        "id": SNAPSHOT_APP_ID, "name": "抖音",
        "versionCode": 300504, "versionName": "30.5.0",
    },
    "device": {"model": "Pixel 8", "sdkInt": 35, "release": "15"},
    "nodes": [
        {
            "id": 0, "pid": -1, "idQf": False, "textQf": False,
            "attr": {
                "id": None, "vid": None, "name": "android.widget.FrameLayout",
                "text": None, "desc": None, "clickable": False, "focusable": False,
                "checkable": False, "checked": False, "editable": False,
                "longClickable": False, "visibleToUser": True,
                "left": 0, "top": 0, "right": 1080, "bottom": 2400,
                "width": 1080, "height": 2400, "childCount": 1, "index": 0, "depth": 0,
            },
        },
        {
            "id": 1, "pid": 0, "idQf": False, "textQf": False,
            "attr": {
                "id": None, "vid": "tt_splash_container",
                "name": "android.widget.FrameLayout",
                "text": None, "desc": None, "clickable": False, "focusable": False,
                "checkable": False, "checked": False, "editable": False,
                "longClickable": False, "visibleToUser": True,
                "left": 0, "top": 0, "right": 1080, "bottom": 2400,
                "width": 1080, "height": 2400, "childCount": 3, "index": 0, "depth": 1,
            },
        },
        {
            "id": 2, "pid": 1, "idQf": True, "textQf": False,
            "attr": {
                "id": "ad_click_area", "vid": None, "name": "android.view.View",
                "text": None, "desc": None, "clickable": False, "focusable": False,
                "checkable": False, "checked": False, "editable": False,
                "longClickable": False, "visibleToUser": True,
                "left": 0, "top": 0, "right": 1080, "bottom": 2400,
                "width": 1080, "height": 2400, "childCount": 0, "index": 0, "depth": 2,
            },
        },
        {
            "id": 3, "pid": 1, "idQf": False, "textQf": True,
            "attr": {
                "id": None, "vid": "tt_splash_skip_btn",
                "name": "android.widget.TextView",
                "text": "跳过 3", "desc": None, "clickable": True, "focusable": True,
                "checkable": False, "checked": False, "editable": False,
                "longClickable": False, "visibleToUser": True,
                "left": 860, "top": 120, "right": 1040, "bottom": 200,
                "width": 180, "height": 80, "childCount": 0, "index": 1, "depth": 2,
            },
        },
        {
            "id": 4, "pid": 1, "idQf": False, "textQf": False,
            "attr": {
                "id": None, "vid": "tt_ad_cta", "name": "android.widget.Button",
                "text": "立即查看", "desc": None, "clickable": True, "focusable": True,
                "checkable": False, "checked": False, "editable": False,
                "longClickable": False, "visibleToUser": True,
                "left": 150, "top": 2030, "right": 930, "bottom": 2190,
                "width": 780, "height": 160, "childCount": 0, "index": 2, "depth": 2,
            },
        },
    ],
}

SNAPSHOT_SUMMARY = {
    "id": SNAPSHOT_ID,
    "appId": SNAPSHOT_APP_ID,
    "activityId": SNAPSHOT_ACTIVITY,
    "screenWidth": 1080,
    "screenHeight": 2400,
    "isLandscape": False,
    "appInfo": {
        "id": SNAPSHOT_APP_ID, "name": "抖音",
        "versionCode": 300504, "versionName": "30.5.0",
    },
    "appName": "抖音",
    "appVersionName": "30.5.0",
    "appVersionCode": 300504,
}

SUBSCRIPTION = {
    "id": 20261014,
    "name": "社区示例订阅",
    "version": 12,
    "author": "GKD 社区",
    "apps": [
        {
            "id": "com.ss.android.ugc.aweme",
            "name": "抖音",
            "groups": [
                {
                    "key": 0, "name": "开屏广告", "desc": "启动时自动跳过开屏广告。",
                    "enable": True,
                    "rules": [
                        {"key": 10, "matches": '[vid="tt_splash_skip_btn"]'},
                        {"key": 11, "matches": '[text*="跳过"]'},
                    ],
                },
                {
                    "key": 1, "name": "更新弹窗", "desc": "关闭强制更新提示。",
                    "enable": True,
                    "rules": [
                        {"key": 20, "matches": '[text="以后再说"]'},
                        {"key": 21, "matches": '[text="暂不更新"]'},
                    ],
                },
                {
                    "key": 2, "name": "红包弹窗", "desc": "关闭首页活动红包。",
                    "enable": False,
                    "rules": [
                        {"key": 30, "matches": '[text="关闭"]'},
                    ],
                },
            ],
        },
        {
            "id": "com.taobao.taobao",
            "name": "淘宝",
            "groups": [
                {
                    "key": 0, "name": "开屏广告", "desc": "跳过启动页广告。",
                    "enable": True,
                    "rules": [{"key": 10, "matches": '[text*="跳过"]'}],
                },
            ],
        },
    ],
}

SUBSCRIPTION_BYTES = json.dumps(SUBSCRIPTION, ensure_ascii=False).encode("utf-8")


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

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.endswith("subscription.json5"):
            self.send_response(200)
            self.send_header("content-type", "application/json5; charset=utf-8")
            self.send_header("access-control-allow-origin", "*")
            self.send_header("content-length", str(len(SUBSCRIPTION_BYTES)))
            self.end_headers()
            self.wfile.write(SUBSCRIPTION_BYTES)
        else:
            self.reply({}, 404)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        if length:
            self.rfile.read(length)
        path = self.path.split("?")[0].rstrip("/")
        if path.endswith("getServerInfo"):
            self.reply({
                "device": {"model": "Pixel 8", "sdkInt": 35, "release": "15"},
                "gkdAppInfo": {"id": "li.songe.gkd.debug", "name": "GKD", "versionName": "1.9.0"},
            })
        elif path.endswith("getSnapshots"):
            self.reply([SNAPSHOT_SUMMARY])
        elif path.endswith("getSnapshot"):
            self.reply(RAW_SNAPSHOT)
        elif path.endswith("getScreenshot"):
            self.send_response(200)
            self.send_header("content-type", "image/png")
            self.send_header("access-control-allow-origin", "*")
            self.send_header("content-length", str(len(SPLASH_BYTES)))
            self.end_headers()
            self.wfile.write(SPLASH_BYTES)
        elif path.endswith("localRules/append"):
            self.reply({"ok": True, "action": "append", "appId": SNAPSHOT_APP_ID,
                        "addedGroups": 1, "addedRules": 1, "skippedDuplicates": 0})
        else:
            self.reply({}, 404)


server = ThreadingHTTPServer(("127.0.0.1", 8771), FixtureHandler)
threading.Thread(target=server.serve_forever, daemon=True).start()

# ---------------------------------------------------------------- 开发服务器


def server_up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1.5) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def dev_server_ready(url: str, timeout: float) -> bool:
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

# ---------------------------------------------------------------- 浏览器操作

page = launch(headless=True, user_dir=str(SCRATCH / "firefox-profile"),
              window_size=(412, 915))
page.set_viewport(412, 915, device_pixel_ratio=2)
_warmed_up = False


def js(expression):
    return page.run_js("return " + expression + ";")


def wait_js(expression, timeout=25):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if page.run_js("return (() => { try { return Boolean(" + expression +
                       "); } catch { return false; } })();"):
            return
        time.sleep(0.1)
    raise AssertionError("等待失败: " + expression + "\n" +
                         str(page.run_js("return document.body.innerText;")))


def click(selector):
    element = page.ele("css:" + selector)
    assert element, "找不到元素: " + selector
    element.click()


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


def open_app(timeout=300):
    global _warmed_up
    deadline = time.monotonic() + timeout
    while True:
        page.get(APP_URL + "/", wait="none", timeout=20 if _warmed_up else 120)
        try:
            wait_js("document.querySelector('.android-home')",
                    timeout=15 if _warmed_up else 150)
            _warmed_up = True
            return
        except AssertionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(1)


def go_home():
    for _ in range(12):
        if js("Boolean(document.querySelector('.android-home'))"):
            return
        if js("Boolean(document.querySelector('button[aria-label=\"返回应用列表\"]'))"):
            click('button[aria-label="返回应用列表"]')
        elif js("Boolean(document.querySelector('button[aria-label=\"返回首页\"]'))"):
            click('button[aria-label="返回首页"]')
        time.sleep(0.3)
    wait_js("document.querySelector('.android-home')")


def shot(name: str):
    path = OUT / name
    page.screenshot(path=str(path))
    print(f"截图: {path.name} ({path.stat().st_size // 1024} KiB)", flush=True)


def rounded_phone(screenshot: Image.Image, height: int) -> Image.Image:
    width = round(screenshot.width * height / screenshot.height)
    image = screenshot.convert("RGBA").resize((width, height), Image.LANCZOS)
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, width - 1, height - 1),
                                           radius=28, fill=255)
    image.putalpha(mask)
    border = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle((1, 1, width - 2, height - 2),
                                             radius=27,
                                             outline=(120, 220, 235, 90), width=2)
    return Image.alpha_composite(image, border)


def compose_hero(names, out_name="hero.png"):
    screens = [Image.open(OUT / name) for name in names]
    height = 760
    gap = 46
    phones = [rounded_phone(screen, height) for screen in screens]
    total_width = sum(phone.width for phone in phones) + gap * (len(phones) - 1)
    canvas_width, canvas_height = 1440, 840
    canvas = vertical_gradient((canvas_width, canvas_height),
                               (12, 20, 30), (5, 8, 12)).convert("RGBA")

    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((-200, 40, 720, 760), fill=(0, 220, 255, 46))
    glow_draw.ellipse((720, 220, 1660, 980), fill=(255, 74, 120, 34))
    canvas = Image.alpha_composite(canvas, glow.filter(ImageFilter.GaussianBlur(160)))

    x = (canvas_width - total_width) // 2
    y = (canvas_height - height) // 2
    for phone in phones:
        shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle(
            (x + 6, y + 18, x + phone.width + 6, y + height + 24),
            radius=32, fill=(0, 0, 0, 150),
        )
        canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(18)))
        canvas.alpha_composite(phone, (x, y))
        x += phone.width + gap

    path = OUT / out_name
    canvas.convert("RGB").save(path, format="PNG", optimize=True)
    print(f"头图: {path.name} ({path.stat().st_size // 1024} KiB)", flush=True)


try:
    open_app()
    js("localStorage.clear()")
    open_app()

    # 1. 首页
    wait_js("document.querySelector('.library-entry')")
    js("window.scrollTo(0, 0);")
    time.sleep(0.4)
    shot("home.png")

    # 2. 订阅规则库
    click(".library-entry:nth-of-type(1)")
    wait_js("document.querySelector('.rule-library')")
    if not js("document.querySelector('.library-sources').open"):
        click(".library-sources > summary")
    set_input('input[aria-label="订阅文件链接"]', FIXTURE + "/subscription.json5")
    click("form.library-form button[type=submit]")
    wait_js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-sources') || '[]').length === 1")
    wait_js("document.querySelectorAll('.library-app-button').length >= 2")
    set_input('input[aria-label="搜索应用名或包名"]', "抖音")
    wait_js("document.querySelectorAll('.library-app-button').length === 1")
    click(".library-app-button")
    wait_js("document.querySelectorAll('.library-group').length === 3")
    js("window.scrollTo(0, 0);")
    time.sleep(0.5)
    shot("library.png")
    go_home()

    # 3. 工作区：连接模拟 GKD → 选快照 → 拖动选中跳过按钮
    set_input(".android-device-form .android-input", FIXTURE)
    click(".android-device-form .android-button")
    wait_js("document.querySelector('.android-snapshot-chooser')")
    wait_js("document.querySelectorAll('.android-snapshot-check-row').length === 1")
    click(".android-snapshot-check-toggle input")
    click(".android-snapshot-chooser .android-button-primary")
    wait_js("document.querySelector('.android-workspace-stage')")
    wait_js("document.querySelector('.screenshot-stage img') && document.querySelector('.screenshot-stage img').complete")
    time.sleep(0.8)

    box = js(
        "(() => {"
        "  const stage = document.querySelector('.screenshot-stage');"
        "  const img = stage.querySelector('img');"
        "  const s = stage.getBoundingClientRect();"
        "  const scale = Math.min(s.width / img.naturalWidth, s.height / img.naturalHeight);"
        "  const iw = img.naturalWidth * scale;"
        "  const ih = img.naturalHeight * scale;"
        "  return {ix: s.x + (s.width - iw) / 2, iy: s.y + (s.height - ih) / 2,"
        "          iw: iw, ih: ih, sx: s.x, sy: s.y, sw: s.width, sh: s.height};"
        "})()"
    )
    assert box and box["iw"] > 100, box
    start = (box["ix"] + box["iw"] / 2, box["iy"] + box["ih"] / 2)
    target = (box["ix"] + box["iw"] * (950 / 1080),
              box["iy"] + box["ih"] * (160 / 2400))
    print(f"拖动选区: {start} -> {target}", flush=True)
    page.actions.drag(
        (round(start[0]), round(start[1])),
        (round(target[0]), round(target[1])),
        duration=700,
        steps=24,
    ).perform()
    wait_js("document.querySelectorAll('.android-candidate-item').length > 0")
    page.ele("css:.android-tab-active")
    # 等放大镜自动隐藏，滚动到候选卡片顶部。
    time.sleep(2.4)
    js("window.scrollTo(0, 0);")
    time.sleep(0.4)
    shot("workspace.png")

    compose_hero(["home.png", "workspace.png", "library.png"])
    print("所有截图完成", flush=True)
finally:
    try:
        page.quit()
    except Exception:
        pass
    server.shutdown()
    if dev_process is not None:
        dev_process.terminate()
