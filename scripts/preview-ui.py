"""Open the browser-only UI preview with synthetic GKD device data.

This script never accesses ADB or a real phone. It serves a local fixture that
implements the small GKD HTTP API surface used by the rule-authoring UI.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
APP_ORIGIN = "http://127.0.0.1:5175"
FIXTURE_ORIGIN = "http://127.0.0.1:8770"


def node(
    node_id: int,
    parent_id: int,
    *,
    name: str = "android.view.View",
    text: str | None = None,
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
            "desc": None,
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


NODES = [
    node(0, -1, name="android.widget.FrameLayout", child_count=4),
    node(
        1,
        0,
        name="android.widget.FrameLayout",
        left=70,
        top=650,
        right=1010,
        bottom=1730,
        child_count=3,
        depth=1,
    ),
    node(
        2,
        1,
        name="android.widget.TextView",
        text="Synthetic launch card",
        left=140,
        top=710,
        right=940,
        bottom=820,
        depth=2,
    ),
    node(
        3,
        1,
        name="android.widget.FrameLayout",
        vid="close_region",
        clickable=True,
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
        text="Close 5",
        left=855,
        top=1662,
        right=965,
        bottom=1698,
        depth=3,
    ),
    node(
        5,
        0,
        name="android.view.View",
        vid="ad_hotspot",
        clickable=True,
        left=760,
        top=1580,
        right=1030,
        bottom=1780,
        index=1,
        depth=1,
    ),
    node(
        6,
        1,
        name="android.widget.Button",
        text="Open details",
        clickable=True,
        left=140,
        top=1310,
        right=940,
        bottom=1440,
        index=2,
        depth=2,
    ),
]


def make_snapshot(snapshot_id: int, activity_id: str) -> dict[str, Any]:
    return {
        "id": snapshot_id,
        "appId": "com.fixture.video",
        "activityId": activity_id,
        "screenWidth": 1080,
        "screenHeight": 2400,
        "isLandscape": False,
        "appInfo": {
            "id": "com.fixture.video",
            "name": "UI Preview",
            "versionCode": 7,
            "versionName": "7.0",
        },
        "device": {"model": "browser-fixture", "sdkInt": 34, "release": "14"},
        "nodes": NODES,
    }


SNAPSHOTS = {
    3001: make_snapshot(3001, "com.fixture.video.MainActivity"),
    3002: make_snapshot(3002, "com.fixture.video.DetailActivity"),
}


def make_screenshot() -> bytes:
    image = Image.new("RGB", (1080, 2400), "#172235")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 1079, 180), fill="#0d1524")
    draw.text((44, 58), "UI PREVIEW", fill="#f2f6ff", font=ImageFont.load_default(30))
    draw.rounded_rectangle((70, 650, 1010, 1730), radius=34, fill="#24334d", outline="#6684ad", width=4)
    draw.text((140, 730), "Synthetic launch card", fill="#f2f6ff", font=ImageFont.load_default(42))
    draw.rounded_rectangle((140, 1310, 940, 1440), radius=24, fill="#386c9d")
    draw.text((455, 1358), "DETAILS", fill="#ffffff", font=ImageFont.load_default(34))
    draw.rounded_rectangle((760, 1580, 1030, 1780), radius=28, fill="#314159")
    draw.rounded_rectangle((820, 1640, 990, 1710), radius=20, fill="#f2f6ff")
    draw.text((850, 1659), "CLOSE 5", fill="#172235", font=ImageFont.load_default(28))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    image.close()
    return buffer.getvalue()


SCREENSHOT_PNG = make_screenshot()


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

    def do_OPTIONS(self) -> None:
        self.reply({})

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/snapshot.png":
            self.reply({}, 404)
            return
        self.send_response(200)
        self.send_header("content-type", "image/png")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("content-length", str(len(SCREENSHOT_PNG)))
        self.end_headers()
        self.wfile.write(SCREENSHOT_PNG)

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"null")
        path = self.path.split("?", 1)[0].rstrip("/")
        if path.endswith("/getServerInfo"):
            self.reply(
                {
                    "device": {"model": "browser-fixture", "sdkInt": 34},
                    "gkdAppInfo": {
                        "id": "li.songe.gkd",
                        "name": "GKD UI Preview",
                        "versionName": "1.12.1",
                    },
                }
            )
        elif path.endswith("/getSnapshots"):
            self.reply([snapshot_summary(SNAPSHOTS[key]) for key in (3001, 3002)])
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
            self.reply({"message": "accepted by browser preview fixture"})
        else:
            self.reply({}, 404)


def server_up(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=1.5) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def start_vite() -> subprocess.Popen[bytes] | None:
    if server_up(APP_ORIGIN):
        raise RuntimeError("Preview port 5175 is occupied; stop the existing preview before starting another.")
    node = shutil.which("node")
    vite = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
    if not node or not vite.exists():
        raise RuntimeError("Vite is unavailable; run pnpm install first.")
    process = subprocess.Popen(
        [node, str(vite), "--host", "127.0.0.1", "--port", "5175", "--strictPort"],
        cwd=ROOT,
        env={**os.environ, "VITE_GKD_PREVIEW_FIXTURE": FIXTURE_ORIGIN},
        creationflags=subprocess.CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Preview Vite process exited before becoming ready.")
        if server_up(APP_ORIGIN):
            return process
        time.sleep(0.4)
    process.terminate()
    raise RuntimeError("Vite did not become ready on port 5175.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    fixture = ThreadingHTTPServer(("127.0.0.1", 8770), FixtureHandler)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    vite_process = start_vite()
    url = f"{APP_ORIGIN}/#android"
    print(f"Browser UI preview: {url}", flush=True)
    print("Close this process or press Ctrl+C to stop the fixture.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        fixture.shutdown()
        fixture.server_close()
        if vite_process and vite_process.poll() is None:
            vite_process.terminate()
            vite_process.wait(timeout=8)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
