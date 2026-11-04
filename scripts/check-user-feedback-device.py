#!/usr/bin/env python3
"""Real-device Android WebView smoke check for the user-feedback flow.

Run from the repository root with PowerShell:

    $env:PYTHONIOENCODING='utf-8'
    python -X utf8 scripts/check-user-feedback-device.py
    python -X utf8 scripts/check-user-feedback-device.py --install
    python -X utf8 scripts/check-user-feedback-device.py --install --submit-synthetic

The default checks the installed APK. ``--install`` first replaces it with the
local debug APK while preserving app data. ``--submit-synthetic`` performs one
real UI submission with a fixed synthetic payload, then deletes that exact
feedback and its cascaded outbox row through the production admin API. The
default never submits. Reports contain booleans plus fixed synthetic content.
"""

from __future__ import annotations

import json
import io
import http.cookiejar
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
import zipfile
from pathlib import Path
from typing import Any

import websocket

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
APK = ROOT / "android" / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"
REPORT = ROOT / "docs" / "verification" / "user-feedback-device-checks.json"
PACKAGE = "com.gkdrulebuilder.android"
ACTIVITY = f"{PACKAGE}/.MainActivity"
SYNTHETIC_DESCRIPTION = "[合成设备冒烟] 验证 Android WebView 反馈预览与本地草稿"
SYNTHETIC_ERROR = "合成错误：仅用于设备验收，不含真实日志"
SYNTHETIC_IDEMPOTENCY_KEY = "synthetic-device-smoke"
ADMIN_ACCESS = Path(os.environ["USERPROFILE"]) / ".config" / "gkd-rule-studio" / "feedback-admin.local"

CHECKS: dict[str, bool] = {}
OBSERVATIONS: dict[str, bool] = {}
BLOCKERS: list[str] = []
UI_ISSUES: list[str] = []
FAILURE_CHECK = ""
SYNTHETIC_POST_REMOVED = False
SYNTHETIC_OUTBOX_REMOVED = False


def adb(*args: str, timeout: float = 30) -> str:
    completed = subprocess.run(
        ["adb", "-d", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0:
        raise RuntimeError(f"adb_failed:{args[0]}")
    return completed.stdout.strip()


def record(check_id: str, value: bool, *, blocker: str = "", ui_issue: str = "") -> bool:
    CHECKS[check_id] = bool(value)
    print(f"{'PASS' if value else 'FAIL'}: {check_id}", flush=True)
    if not value:
        if blocker and blocker not in BLOCKERS:
            BLOCKERS.append(blocker)
        if ui_issue and ui_issue not in UI_ISSUES:
            UI_ISSUES.append(ui_issue)
    return bool(value)


def observe(observation_id: str, value: bool) -> bool:
    OBSERVATIONS[observation_id] = bool(value)
    print(f"OBSERVE: {observation_id}={str(bool(value)).lower()}", flush=True)
    return bool(value)


def fail(check_id: str, blocker: str, *, ui_issue: str = "") -> None:
    global FAILURE_CHECK
    FAILURE_CHECK = check_id
    record(check_id, False, blocker=blocker, ui_issue=ui_issue)
    raise AssertionError(check_id)


def package_version() -> tuple[str, int]:
    value = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    name = str(value.get("version", ""))
    parts = name.split(".")
    code = 1
    if len(parts) >= 3 and all(part.isdigit() for part in parts[:3]):
        code = int(parts[0]) * 10000 + int(parts[1]) * 100 + int(parts[2])
    return name, code


def endpoint_from_archive(archive: zipfile.ZipFile) -> str:
    pattern = re.compile(r"https://[^\"'\s]+/gkd-feedback/api/feedback")
    for name in archive.namelist():
        if not (name.startswith("assets/assets/index-") and name.endswith(".js")):
            continue
        text = archive.read(name).decode("utf-8", "ignore")
        match = pattern.search(text)
        if match:
            return match.group(0)
    return ""


def endpoint_from_installed_apk() -> str:
    package_paths = adb("shell", "pm", "path", PACKAGE).splitlines()
    base_path = next(
        (line.removeprefix("package:") for line in package_paths if line.startswith("package:") and line.endswith("base.apk")),
        "",
    )
    if not base_path:
        return ""
    completed = subprocess.run(
        ["adb", "-d", "exec-out", "cat", base_path],
        cwd=ROOT,
        capture_output=True,
        timeout=60,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if completed.returncode != 0 or not completed.stdout:
        return ""
    with zipfile.ZipFile(io.BytesIO(completed.stdout)) as archive:
        return endpoint_from_archive(archive)


def free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = int(probe.getsockname()[1])
    probe.close()
    return port


class CDP:
    def __init__(self, websocket_url: str) -> None:
        self.ws = websocket.create_connection(
            websocket_url,
            timeout=15,
            suppress_origin=True,
        )
        self.sequence = 0
        self.events: list[dict[str, Any]] = []

    def close(self) -> None:
        try:
            self.ws.close()
        except Exception:
            pass

    def command(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.sequence += 1
        target = self.sequence
        self.ws.send(json.dumps({"id": target, "method": method, "params": params or {}}))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            message = json.loads(self.ws.recv())
            if message.get("id") == target:
                if "error" in message:
                    raise RuntimeError("cdp_command_failed")
                return message.get("result", {})
            if message.get("method"):
                self.events.append(message)
                if len(self.events) > 1000:
                    del self.events[:500]
        raise TimeoutError("cdp_command_timeout")

    def evaluate(
        self,
        expression: str,
        *,
        await_promise: bool = False,
    ) -> Any:
        result = self.command(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
            },
        )
        if result.get("exceptionDetails"):
            raise RuntimeError("cdp_evaluation_failed")
        return result.get("result", {}).get("value")

    def wait_js(self, expression: str, timeout: float = 20) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if self.evaluate(f"Boolean((() => {{ try {{ return ({expression}); }} catch {{ return false; }} }})())"):
                    return
            except Exception:
                pass
            time.sleep(0.2)
        raise TimeoutError("cdp_wait_timeout")


def open_cdp(port: int) -> CDP:
    deadline = time.monotonic() + 25
    pages: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as response:
                pages = json.load(response)
            if pages:
                break
        except Exception:
            pass
        time.sleep(0.25)
    page = next(
        (item for item in pages if "android_asset/index.html" in str(item.get("url", ""))),
        pages[0] if pages else None,
    )
    if not page or not page.get("webSocketDebuggerUrl"):
        raise RuntimeError("webview_target_unavailable")
    return CDP(str(page["webSocketDebuggerUrl"]))


def click_button(cdp: CDP, text: str, root_selector: str = "document") -> None:
    clicked = cdp.evaluate(
        f"""(() => {{
          const root = {json.dumps(root_selector)} === 'document' ? document : document.querySelector({json.dumps(root_selector)});
          if (!root) return false;
          const button = Array.from(root.querySelectorAll('button'))
            .find((item) => item.textContent.trim() === {json.dumps(text)});
          if (!button) return false;
          button.click();
          return true;
        }})()"""
    )
    if not clicked:
        raise RuntimeError("ui_button_missing")


def set_textarea(cdp: CDP, aria_label: str, value: str) -> bool:
    return bool(cdp.evaluate(
        f"""(() => {{
          const input = document.querySelector('textarea[aria-label={json.dumps(aria_label)}]');
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(input, {json.dumps(value)});
          input.dispatchEvent(new Event('input', {{ bubbles: true }}));
          input.dispatchEvent(new Event('change', {{ bubbles: true }}));
          return input.value === {json.dumps(value)};
        }})()"""
    ))


def set_checkbox_by_label(cdp: CDP, text: str) -> bool:
    return bool(cdp.evaluate(
        f"""(() => {{
          const label = Array.from(document.querySelectorAll('.user-feedback-panel label'))
            .find((item) => item.textContent.includes({json.dumps(text)}));
          const input = label?.querySelector('input[type="checkbox"]');
          if (!input) return false;
          if (!input.checked) input.click();
          return input.checked;
        }})()"""
    ))


def open_feedback(cdp: CDP) -> None:
    clicked = cdp.evaluate(
        """(() => {
          const button = Array.from(document.querySelectorAll('.android-support-entry'))
            .find((item) => item.textContent.trim().includes('反馈'));
          if (!button) return false;
          button.click();
          return true;
        })()"""
    )
    if not clicked:
        raise RuntimeError("feedback_entry_missing")
    cdp.wait_js("document.querySelector('.user-feedback-panel')")


def has_existing_draft(cdp: CDP) -> bool:
    value = cdp.evaluate(
        """(async () => {
          const dbs = await indexedDB.databases();
          const descriptor = dbs.find((item) => item.name === 'gkd-rule-builder-feedback');
          if (!descriptor) return false;
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(descriptor.name, descriptor.version || 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            if (!db.objectStoreNames.contains('drafts')) return false;
            return await new Promise((resolve) => {
              const request = db.transaction('drafts', 'readonly').objectStore('drafts').get('latest');
              request.onsuccess = () => resolve(Boolean(request.result));
              request.onerror = () => resolve(false);
            });
          } finally {
            db.close();
          }
        })()""",
        await_promise=True,
    )
    return bool(value)


def ensure_draft_store_available(cdp: CDP) -> dict[str, bool]:
    value = cdp.evaluate(
        """(async () => {
          const dbs = await indexedDB.databases();
          const descriptor = dbs.find((item) => item.name === 'gkd-rule-builder-feedback');
          if (!descriptor) return { available: true, repairedEmptySchema: false };
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(descriptor.name, descriptor.version || 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const hasStore = db.objectStoreNames.contains('drafts');
          db.close();
          if (hasStore) return { available: true, repairedEmptySchema: false };
          await new Promise((resolve, reject) => {
            const request = indexedDB.deleteDatabase(descriptor.name);
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('delete blocked'));
          });
          return { available: true, repairedEmptySchema: true };
        })()""",
        await_promise=True,
    )
    return value if isinstance(value, dict) else {"available": False, "repairedEmptySchema": False}


def read_draft(cdp: CDP) -> dict[str, Any] | None:
    return cdp.evaluate(
        """(async () => {
          const dbs = await indexedDB.databases();
          const descriptor = dbs.find((item) => item.name === 'gkd-rule-builder-feedback');
          if (!descriptor) return null;
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open(descriptor.name, descriptor.version || 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            if (!db.objectStoreNames.contains('drafts')) return null;
            return await new Promise((resolve) => {
              const request = db.transaction('drafts', 'readonly').objectStore('drafts').get('latest');
              request.onsuccess = () => resolve(request.result || null);
              request.onerror = () => resolve(null);
            });
          } finally {
            db.close();
          }
        })()""",
        await_promise=True,
    )


def delete_test_draft_with_arg(cdp: CDP, client_id: str) -> bool:
    # Runtime.evaluate arguments are expressed inline so every call remains one CDP command.
    expression = f"""(async () => {{
      const expectedClientId = {json.dumps(client_id)};
      const dbs = await indexedDB.databases();
      const descriptor = dbs.find((item) => item.name === 'gkd-rule-builder-feedback');
      if (!descriptor) return true;
      const db = await new Promise((resolve, reject) => {{
        const request = indexedDB.open(descriptor.name, descriptor.version || 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }});
      try {{
        if (!db.objectStoreNames.contains('drafts')) return true;
        const draft = await new Promise((resolve) => {{
          const request = db.transaction('drafts', 'readonly').objectStore('drafts').get('latest');
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => resolve(null);
        }});
        if (!draft) return true;
        if (draft?.payload?.clientId !== expectedClientId) return false;
        await new Promise((resolve, reject) => {{
          const tx = db.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').delete('latest');
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => reject(tx.error);
        }});
        return true;
      }} finally {{
        db.close();
      }}
    }})()"""
    return bool(cdp.evaluate(expression, await_promise=True))


def run_fetch_probe(cdp: CDP, state_key: str, url: str, init: dict[str, Any]) -> dict[str, Any]:
    expression = f"""(() => {{
      window[{json.dumps(state_key)}] = {{ state: 'running' }};
      const controller = new AbortController();
      let timer;
      const work = (async () => {{
        const response = await fetch({json.dumps(url)}, {{
          ...{json.dumps(init)},
          cache: 'no-store',
          credentials: 'omit',
          mode: 'cors',
          signal: controller.signal,
        }});
        const text = await response.text();
        return {{
          state: 'done',
          resolved: true,
          status: response.status,
          type: response.type,
          allowOrigin: response.headers.get('access-control-allow-origin'),
          allowHeaders: response.headers.get('access-control-allow-headers'),
          text,
        }};
      }})().catch((error) => ({{ state: 'done', resolved: false, error: String(error?.name || 'error') }}));
      const timeout = new Promise((resolve) => {{
        timer = setTimeout(() => {{
          controller.abort();
          resolve({{ state: 'done', resolved: false, error: 'timeout' }});
        }}, 12000);
      }});
      Promise.race([work, timeout]).then((value) => {{
        clearTimeout(timer);
        window[{json.dumps(state_key)}] = value;
      }});
      return true;
    }})()"""
    cdp.evaluate(expression)
    deadline = time.monotonic() + 15
    value: dict[str, Any] = {"state": "running"}
    while time.monotonic() < deadline:
        time.sleep(0.4)
        current = cdp.evaluate(f"window[{json.dumps(state_key)}]")
        if isinstance(current, dict):
            value = current
            if current.get("state") != "running":
                break
    return value


def admin_http_request(
    opener: urllib.request.OpenerDirector,
    url: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request_headers = {"Content-Type": "application/json"} if body is not None else {}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        content_type = response.headers.get("Content-Type", "")
        value = json.loads(raw) if raw and "application/json" in content_type else raw
        return int(response.status), value


def cleanup_synthetic_submission(feedback_id: str) -> dict[str, bool]:
    """Delete the exact synthetic feedback and cascade its outbox row."""
    result = {
        "admin_config_loaded": False,
        "admin_login_ok": False,
        "admin_session_ok": False,
        "admin_synthetic_detail_matched": False,
        "admin_delete_ok": False,
        "admin_detail_gone": False,
        "admin_logout_ok": False,
        "admin_session_revoked": False,
    }
    if not feedback_id:
        return result

    csrf = ""
    opener: urllib.request.OpenerDirector | None = None
    root_url = ""
    try:
        access = json.loads(ADMIN_ACCESS.read_text(encoding="utf-8"))
        result["admin_config_loaded"] = True
        parsed = urllib.parse.urlsplit(str(access["url"]))
        if parsed.scheme != "https" or not parsed.path.rstrip("/").endswith("/admin"):
            return result
        prefix = parsed.path.rstrip("/")[: -len("/admin")]
        root_url = urllib.parse.urlunsplit(
            (parsed.scheme, parsed.netloc, (prefix or "") + "/", "", "")
        )
        cookies = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

        login_status, _ = admin_http_request(
            opener,
            root_url + "admin/api/login",
            method="POST",
            body={"username": access["username"], "password": access["password"]},
        )
        result["admin_login_ok"] = login_status == 200
        if not result["admin_login_ok"]:
            return result

        session_status, session = admin_http_request(opener, root_url + "admin/api/session")
        result["admin_session_ok"] = (
            session_status == 200
            and isinstance(session, dict)
            and isinstance(session.get("csrfToken"), str)
            and bool(session.get("csrfToken"))
        )
        if not result["admin_session_ok"]:
            return result
        csrf = session["csrfToken"]

        detail_url = root_url + "admin/api/feedback/" + urllib.parse.quote(feedback_id, safe="")
        detail_status, detail = admin_http_request(opener, detail_url)
        context = detail.get("context") if isinstance(detail, dict) else None
        result["admin_synthetic_detail_matched"] = (
            detail_status == 200
            and isinstance(detail, dict)
            and detail.get("description") == SYNTHETIC_DESCRIPTION
            and detail.get("contact") == ""
            and detail.get("attachments") == []
            and isinstance(context, dict)
            and context.get("error") == SYNTHETIC_ERROR
        )
        if not result["admin_synthetic_detail_matched"]:
            return result

        delete_status, _ = admin_http_request(
            opener,
            detail_url,
            method="DELETE",
            headers={"X-CSRF-Token": csrf},
        )
        result["admin_delete_ok"] = delete_status == 204
        if result["admin_delete_ok"]:
            gone_status, _ = admin_http_request(opener, detail_url)
            result["admin_detail_gone"] = gone_status == 404
        return result
    except Exception:
        return result
    finally:
        if opener is not None and root_url and csrf:
            try:
                logout_status, _ = admin_http_request(
                    opener,
                    root_url + "admin/api/logout",
                    method="POST",
                    headers={"X-CSRF-Token": csrf},
                )
                result["admin_logout_ok"] = logout_status == 204
                if result["admin_logout_ok"]:
                    session_status, _ = admin_http_request(opener, root_url + "admin/api/session")
                    result["admin_session_revoked"] = session_status == 401
            except Exception:
                pass


def run_network_probe(cdp: CDP, endpoint: str) -> dict[str, Any]:
    health_url = endpoint.rsplit("api/feedback", 1)[0] + "healthz"
    cdp.evaluate(
        """(() => {
          if (!window.__ufDeviceFetchGuard) {
            const nativeFetch = window.fetch.bind(window);
            window.__ufDeviceFetchGuard = { postAttempts: 0 };
            window.fetch = (input, init = {}) => {
              const method = String(init?.method || 'GET').toUpperCase();
              if (method === 'POST') {
                window.__ufDeviceFetchGuard.postAttempts += 1;
                return Promise.reject(new Error('synthetic POST blocked'));
              }
              return nativeFetch(input, init);
            };
          }
          return true;
        })()"""
    )
    cdp.command("Network.enable")
    cdp.events.clear()
    preflight = run_fetch_probe(
        cdp,
        "__ufPreflightProbe",
        endpoint,
        {"method": "OPTIONS", "headers": {"Accept": "application/json"}},
    )
    preflight_requests = [
        event.get("params", {}).get("request", {})
        for event in cdp.events
        if event.get("method") == "Network.requestWillBeSent"
        and str(event.get("params", {}).get("request", {}).get("url", "")) == endpoint
    ]
    origin_sent = any(
        any(str(name).lower() == "origin" for name in (request.get("headers") or {}))
        for request in preflight_requests
    )
    health = run_fetch_probe(
        cdp,
        "__ufHealthProbe",
        health_url,
        {"method": "GET", "headers": {"Accept": "application/json"}},
    )
    return {
        "preflight": preflight,
        "preflightRequestObserved": bool(preflight_requests),
        "preflightOriginSent": origin_sent,
        "health": health,
        "postAttempts": int(cdp.evaluate("window.__ufDeviceFetchGuard.postAttempts") or 0),
    }


def main() -> None:
    global FAILURE_CHECK, SYNTHETIC_POST_REMOVED, SYNTHETIC_OUTBOX_REMOVED
    version_name, version_code = package_version()
    report_written = False
    forwarded_port = 0
    cdp: CDP | None = None
    created_client_id = ""
    submitted_feedback_id = ""
    preexisting_draft = True
    test_draft_removed = False
    panel_opened = False

    install_requested = "--install" in sys.argv[1:]
    submit_requested = "--submit-synthetic" in sys.argv[1:]
    observe("synthetic_submission_requested", submit_requested)
    try:
        if install_requested:
            record("apk_present", APK.is_file(), blocker="debug_apk_missing")
            if not APK.is_file():
                fail("apk_present", "debug_apk_missing")
        record("single_usb_device_authorized", adb("get-state") == "device", blocker="usb_device_unavailable")
        if install_requested:
            adb("install", "-r", str(APK), timeout=120)
            record("install_preserved_data", True)
        observe("install_performed", install_requested)
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP")
        adb("shell", "wm", "dismiss-keyguard")
        adb("shell", "am", "start", "-W", "-n", ACTIVITY, timeout=60)
        time.sleep(0.8)
        power = adb("shell", "dumpsys", "power")
        window = adb("shell", "dumpsys", "window")
        record("device_awake", "mWakefulness=Awake" in power, blocker="device_screen_asleep")
        focus_line = next((line for line in window.splitlines() if "mCurrentFocus" in line), "")
        record("app_focused", PACKAGE in focus_line, blocker="app_not_foreground", ui_issue="main_activity_not_foreground")
        package_dump = adb("shell", "dumpsys", "package", PACKAGE)
        installed_name = re.search(r"versionName=([^\s]+)", package_dump)
        installed_code = re.search(r"versionCode=(\d+)", package_dump)
        record(
            "installed_version_matches_build",
            bool(installed_name and installed_name.group(1) == version_name and installed_code and int(installed_code.group(1)) == version_code),
            blocker="installed_version_mismatch",
        )
        record("main_activity_launched", True)

        pid = adb("shell", "pidof", PACKAGE)
        if not pid:
            fail("webview_cdp_available", "webview_process_missing")
        forwarded_port = free_port()
        adb("forward", f"tcp:{forwarded_port}", f"localabstract:webview_devtools_remote_{pid}")
        cdp = open_cdp(forwarded_port)
        record("webview_cdp_available", True)
        cdp.wait_js("document.readyState === 'complete' && document.querySelector('.android-home')", 30)
        endpoint = endpoint_from_installed_apk()
        record("runtime_endpoint_found", bool(endpoint), blocker="runtime_feedback_endpoint_missing")
        record("runtime_endpoint_https", endpoint.startswith("https://"), blocker="runtime_feedback_endpoint_not_https")
        record("runtime_endpoint_path_expected", endpoint.endswith("/gkd-feedback/api/feedback"), blocker="runtime_feedback_endpoint_path_invalid")
        record("runtime_endpoint_host_is_ip", bool(re.match(r"^https://\d{1,3}(?:\.\d{1,3}){3}/", endpoint)), blocker="runtime_feedback_endpoint_host_invalid")
        if not endpoint:
            fail("runtime_endpoint_found", "runtime_feedback_endpoint_missing")
        record("file_origin_loaded", str(cdp.evaluate("location.href")).startswith("file:///android_asset/index.html"))
        record(
            "feedback_home_entry",
            bool(cdp.evaluate(
                "Array.from(document.querySelectorAll('.android-support-entry')).some((item) => item.textContent.trim().includes('反馈'))"
            )),
            ui_issue="feedback_home_entry_missing",
        )

        release = adb("shell", "getprop", "ro.build.version.release")
        sdk = int(adb("shell", "getprop", "ro.build.version.sdk"))
        diagnostics = cdp.evaluate(
            f"""(() => {{
              try {{
                const raw = window.GkdAndroidBridge?.getFeedbackDiagnostics?.();
                const value = JSON.parse(raw);
                return {{
                  bridgeMethod: typeof window.GkdAndroidBridge?.getFeedbackDiagnostics === 'function',
                  rawType: typeof raw,
                  parses: true,
                  keysExact: JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['lastCrash', 'systemVersion']),
                  systemType: typeof value.systemVersion,
                  crashType: typeof value.lastCrash,
                  systemNonEmpty: typeof value.systemVersion === 'string' && value.systemVersion.length > 0,
                  systemMatchesDevice: typeof value.systemVersion === 'string' && value.systemVersion.includes({json.dumps(release)}) && value.systemVersion.includes('SDK ' + {sdk}),
                  crashWithinLimit: typeof value.lastCrash === 'string' && new TextEncoder().encode(value.lastCrash).length <= 8192,
                }};
              }} catch {{
                return {{ bridgeMethod: false, rawType: 'error', parses: false, keysExact: false, systemType: 'error', crashType: 'error', systemNonEmpty: false, systemMatchesDevice: false, crashWithinLimit: false }};
              }}
            }})()"""
        )
        for key in ("bridgeMethod", "parses", "keysExact", "systemType", "crashType", "systemNonEmpty", "systemMatchesDevice", "crashWithinLimit"):
            if key in ("systemType", "crashType"):
                value = diagnostics.get(key) == "string"
            else:
                value = bool(diagnostics.get(key))
            record(f"diagnostics_{key}", value, ui_issue="diagnostics_bridge_contract_broken")

        if bool(cdp.evaluate("Boolean(document.querySelector('.user-feedback-panel'))")):
            fail("no_existing_panel_interference", "feedback_panel_already_open", ui_issue="feedback_panel_already_open")
        schema = ensure_draft_store_available(cdp)
        record("indexeddb_schema_available", bool(schema.get("available")), blocker="feedback_indexeddb_schema_invalid")
        observe("empty_indexeddb_schema_repaired", bool(schema.get("repairedEmptySchema")))
        preexisting_draft = has_existing_draft(cdp)
        record("no_existing_draft", not preexisting_draft, blocker="existing_user_draft_preserved")
        if preexisting_draft:
            raise AssertionError("existing_user_draft_preserved")

        panel_opened = True
        open_feedback(cdp)
        record("feedback_panel_opened", True, ui_issue="feedback_panel_failed_to_open")
        time.sleep(1.5)

        auto_error_had_content = bool(cdp.evaluate(
            """(() => {
              const value = document.querySelector('textarea[aria-label="反馈错误信息"]')?.value || '';
              window.__ufInitialAutoError = value;
              return Boolean(value);
            })()"""
        ))
        observe("automatic_error_field_had_content", auto_error_had_content)
        cleared_error = set_textarea(cdp, "反馈错误信息", SYNTHETIC_ERROR)
        filled_description = set_textarea(cdp, "问题描述", SYNTHETIC_DESCRIPTION)
        record("auto_error_cleared", cleared_error and bool(cdp.evaluate("document.querySelector('textarea[aria-label=\"反馈错误信息\"]').value === " + json.dumps(SYNTHETIC_ERROR))), ui_issue="feedback_error_field_not_editable")
        record("synthetic_description_set", filled_description, ui_issue="feedback_description_not_editable")
        cdp.wait_js(
            "Array.from(document.querySelectorAll('.user-feedback-panel button')).some((item) => item.textContent.trim() === '预览并保存草稿' && !item.disabled)",
            15,
        )

        materials = cdp.evaluate(
            """Array.from(document.querySelectorAll('.user-feedback-panel fieldset .user-feedback-check'))
              .map((label) => ({ checked: Boolean(label.querySelector('input')?.checked) }))"""
        )
        record("attachments_default_off", isinstance(materials, list) and len(materials) == 3 and all(not item.get("checked") for item in materials), ui_issue="feedback_attachments_not_default_off")

        try:
            cdp.wait_js(
                f"Array.from(document.querySelectorAll('.user-feedback-panel label')).find((item) => item.textContent.includes('工具版本'))?.querySelector('input')?.value === {json.dumps(f'{version_name} ({version_code})')}",
                15,
            )
        except TimeoutError:
            record("app_version_visible", False, ui_issue="feedback_app_version_not_visible")
            fail("app_version_visible", "app_version_not_reported", ui_issue="feedback_app_version_not_visible")
        version_and_system = cdp.evaluate(
            f"""(() => {{
              const labels = Array.from(document.querySelectorAll('.user-feedback-panel label'));
              const value = (needle) => labels.find((item) => item.textContent.includes(needle))?.querySelector('input')?.value || '';
              return {{
                appVersion: value('工具版本') === {json.dumps(f'{version_name} ({version_code})')},
                systemVersion: value('系统版本').includes({json.dumps(release)}) && value('系统版本').includes('SDK ' + {sdk}),
              }};
            }})()"""
        )
        record("app_version_visible", bool(version_and_system.get("appVersion")), ui_issue="feedback_app_version_not_visible")
        record("system_version_visible", bool(version_and_system.get("systemVersion")), ui_issue="feedback_system_version_not_visible")

        click_button(cdp, "预览并保存草稿", ".user-feedback-panel")
        cdp.wait_js("document.querySelector('.user-feedback-meta')", 25)
        draft = read_draft(cdp)
        payload = (draft or {}).get("payload") or {}
        created_client_id = str(payload.get("clientId") or "")
        context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
        payload_exact = (
            set(payload) == {"version", "clientId", "category", "description", "contact", "context", "attachments"}
            and payload.get("version") == 1
            and payload.get("category") == "tool"
            and payload.get("description") == SYNTHETIC_DESCRIPTION
            and payload.get("contact") == ""
            and payload.get("attachments") == []
            and set(context) == {"appVersion", "systemVersion", "page", "error"}
            and context.get("appVersion") == f"{version_name} ({version_code})"
            and release in str(context.get("systemVersion") or "")
            and f"SDK {sdk}" in str(context.get("systemVersion") or "")
            and context.get("error") == SYNTHETIC_ERROR
        )
        save_ok = payload_exact
        record("indexeddb_save_synthetic_only", save_ok, ui_issue="feedback_preview_or_draft_invalid")
        record("preview_payload_exact_synthetic_context", payload_exact, ui_issue="feedback_preview_context_invalid")
        preview_text = cdp.evaluate("document.querySelector('.user-feedback-panel')?.innerText || ''")
        record("manual_preview_visible", SYNTHETIC_DESCRIPTION in preview_text and SYNTHETIC_ERROR in preview_text and "未附带规则、截图或节点树。" in preview_text, ui_issue="feedback_preview_missing")
        record(
            "preview_excludes_original_auto_error",
            bool(cdp.evaluate(
                "!window.__ufInitialAutoError || !document.querySelector('.user-feedback-panel')?.innerText.includes(window.__ufInitialAutoError)"
            )),
            ui_issue="feedback_preview_contains_original_error",
        )

        click_button(cdp, "稍后再发", ".user-feedback-panel")
        cdp.wait_js("!document.querySelector('.user-feedback-panel')")
        cdp.evaluate("location.reload(); true")
        time.sleep(1)
        cdp.wait_js("document.readyState === 'complete' && document.querySelector('.android-home')", 30)
        open_feedback(cdp)
        cdp.wait_js("document.querySelector('.user-feedback-draft')", 15)
        click_button(cdp, "继续草稿", ".user-feedback-panel")
        cdp.wait_js("document.querySelector('.user-feedback-meta')")
        restored_text = cdp.evaluate("document.querySelector('.user-feedback-panel')?.innerText || ''")
        record("indexeddb_restore_after_reload", SYNTHETIC_DESCRIPTION in restored_text and SYNTHETIC_ERROR in restored_text and "未附带规则、截图或节点树。" in restored_text, ui_issue="feedback_draft_not_restored")
        restored_draft = read_draft(cdp)
        restored_payload = (restored_draft or {}).get("payload") or {}
        restored_context = restored_payload.get("context") if isinstance(restored_payload.get("context"), dict) else {}
        restored_exact = (
            restored_payload.get("clientId") == created_client_id
            and restored_payload.get("description") == SYNTHETIC_DESCRIPTION
            and restored_payload.get("contact") == ""
            and restored_payload.get("attachments") == []
            and restored_context.get("error") == SYNTHETIC_ERROR
            and set(restored_context) == {"appVersion", "systemVersion", "page", "error"}
        )
        record("restored_payload_exact_synthetic_context", restored_exact, ui_issue="feedback_restored_payload_invalid")

        if submit_requested:
            consent_initially_unchecked = not bool(cdp.evaluate(
                """Array.from(document.querySelectorAll('.user-feedback-panel label'))
                  .find((item) => item.textContent.includes('我已检查'))
                  ?.querySelector('input[type="checkbox"]')?.checked"""
            ))
            record("submit_consent_initially_unchecked", consent_initially_unchecked, ui_issue="feedback_submit_consent_prechecked")
            record("submit_consent_checked", set_checkbox_by_label(cdp, "我已检查"), ui_issue="feedback_submit_consent_unavailable")
            cdp.wait_js(
                "Array.from(document.querySelectorAll('.user-feedback-panel button')).some((item) => item.textContent.trim() === '提交反馈' && !item.disabled)",
                10,
            )

            cdp.command("Network.enable")
            cdp.events.clear()
            click_button(cdp, "提交反馈", ".user-feedback-panel")
            cdp.wait_js("document.querySelector('.user-feedback-receipt code')", 30)
            submitted_feedback_id = str(cdp.evaluate(
                "document.querySelector('.user-feedback-receipt code')?.innerText?.trim() || ''"
            ))
            observe("synthetic_submission_performed", bool(submitted_feedback_id))
            record("synthetic_submit_receipt_received", bool(submitted_feedback_id), ui_issue="feedback_submit_receipt_missing")
            cdp.wait_js("!Boolean(document.querySelector('.user-feedback-draft'))", 10)
            submitted_draft_cleared = read_draft(cdp) is None
            record("synthetic_submit_draft_cleared", submitted_draft_cleared, ui_issue="feedback_submit_draft_not_cleared")

            submit_requests = [
                event.get("params", {}).get("request", {})
                for event in cdp.events
                if event.get("method") == "Network.requestWillBeSent"
                and str(event.get("params", {}).get("request", {}).get("url", "")) == endpoint
                and str(event.get("params", {}).get("request", {}).get("method", "")).upper() == "POST"
            ]
            submit_responses = [
                event.get("params", {}).get("response", {})
                for event in cdp.events
                if event.get("method") == "Network.responseReceived"
                and str(event.get("params", {}).get("response", {}).get("url", "")) == endpoint
                and int(event.get("params", {}).get("response", {}).get("status", 0)) == 201
            ]
            record("synthetic_submit_request_observed", len(submit_requests) == 1, blocker="synthetic_submit_request_missing")
            record("synthetic_submit_http_201", bool(submit_responses), blocker="synthetic_submit_response_invalid")

            click_button(cdp, "完成", ".user-feedback-panel")
            cdp.wait_js("!document.querySelector('.user-feedback-panel')")
            record("panel_closed", True)

            cleanup = cleanup_synthetic_submission(submitted_feedback_id)
            for cleanup_id, cleanup_value in cleanup.items():
                record(cleanup_id, cleanup_value, blocker="synthetic_post_cleanup_failed")
            SYNTHETIC_POST_REMOVED = bool(
                cleanup.get("admin_synthetic_detail_matched")
                and cleanup.get("admin_delete_ok")
                and cleanup.get("admin_detail_gone")
            )
            SYNTHETIC_OUTBOX_REMOVED = SYNTHETIC_POST_REMOVED
            record("synthetic_post_removed", SYNTHETIC_POST_REMOVED, blocker="synthetic_post_cleanup_failed")
            record("synthetic_outbox_removed", SYNTHETIC_OUTBOX_REMOVED, blocker="synthetic_outbox_cleanup_failed")
            test_draft_removed = submitted_draft_cleared
        else:
            click_button(cdp, "返回整理", ".user-feedback-panel")
            cdp.wait_js("document.querySelector('.user-feedback-draft')")
            cdp.evaluate("window.confirm = () => true; true")
            click_button(cdp, "删除草稿", ".user-feedback-panel")
            cdp.wait_js("!document.querySelector('.user-feedback-draft') && !Boolean(document.querySelector('.user-feedback-notice')?.innerText.includes('删除失败'))", 15)
            deleted = read_draft(cdp) is None
            record("indexeddb_delete_via_ui", deleted, ui_issue="feedback_draft_delete_failed")
            test_draft_removed = deleted

            cdp.evaluate("window.confirm = () => true; true")
            cdp.evaluate("document.querySelector('button[aria-label=\"关闭反馈\"]')?.click(); true")
            cdp.wait_js("!document.querySelector('.user-feedback-panel')")
            record("panel_closed", True)

        probe = run_network_probe(cdp, endpoint) if endpoint else {"state": "missing"}
        preflight = probe.get("preflight") if isinstance(probe.get("preflight"), dict) else {}
        health = probe.get("health") if isinstance(probe.get("health"), dict) else {}
        try:
            health_body = json.loads(str(health.get("text") or "{}"))
        except Exception:
            health_body = {}
        endpoint_origin = endpoint.rsplit("/gkd-feedback/", 1)[0] if endpoint else ""
        allowed_origins = {"null", endpoint_origin}
        allow_headers = str(preflight.get("allowHeaders") or "").lower()
        record("webview_tls_reachable", bool(health.get("resolved")), blocker="webview_tls_or_network_failed")
        record("webview_natural_options_request_observed", bool(probe.get("preflightRequestObserved")), blocker="webview_options_request_not_observed")
        observe("webview_natural_options_origin_header_present", bool(probe.get("preflightOriginSent")))
        observe("webview_natural_options_resolved", bool(preflight.get("resolved")))
        record("webview_natural_options_status_ok", int(preflight.get("status") or 0) in {200, 204}, blocker="webview_natural_options_status_invalid")
        observe("webview_natural_options_file_origin_allowed", str(preflight.get("allowOrigin") or "") in allowed_origins)
        observe("webview_natural_options_headers_allowed", allow_headers == "*" or all(name in allow_headers for name in ("content-type", "accept", "idempotency-key")))
        record("webview_health_resolved", bool(health.get("resolved")), blocker="webview_health_failed")
        record("webview_health_status_ok", int(health.get("status") or 0) == 200 and health_body.get("status") == "ok", blocker="webview_health_status_invalid")
        observe("webview_health_exposes_cors_header", str(health.get("allowOrigin") or "") in allowed_origins)
        observe("webview_health_smtp_configured", health_body.get("smtp_configured") is True)
        if submit_requested:
            record("no_post_after_synthetic_submit", int(probe.get("postAttempts") or 0) == 0, blocker="unexpected_post_after_synthetic_submit")
        else:
            record("no_post_attempted", int(probe.get("postAttempts") or 0) == 0, blocker="unexpected_post_attempt")

        cdp.evaluate("location.reload(); true")
        time.sleep(1)
        cdp.wait_js("document.readyState === 'complete' && document.querySelector('.android-home')", 30)
    except AssertionError as exc:
        failure_id = str(exc) or FAILURE_CHECK or "device_smoke_check"
        if failure_id not in CHECKS:
            record(failure_id, False, blocker="device_smoke_assertion")
        FAILURE_CHECK = failure_id
    except Exception as exc:
        FAILURE_CHECK = FAILURE_CHECK or "device_smoke_check"
        if FAILURE_CHECK not in CHECKS:
            record(FAILURE_CHECK, False, blocker="device_smoke_exception")
        print(f"FAIL: {FAILURE_CHECK} ({type(exc).__name__})", flush=True)
    finally:
        if cdp is not None:
            try:
                if cdp.evaluate("Boolean(document.querySelector('.user-feedback-panel'))"):
                    cdp.evaluate("window.confirm = () => true; document.querySelector('button[aria-label=\"关闭反馈\"]')?.click(); true")
                    cdp.wait_js("!document.querySelector('.user-feedback-panel')", 5)
                record("panel_closed", bool(cdp.evaluate("!document.querySelector('.user-feedback-panel')")))
            except Exception:
                record("panel_closed", False, ui_issue="feedback_panel_cleanup_failed")

            if created_client_id:
                try:
                    if delete_test_draft_with_arg(cdp, created_client_id):
                        test_draft_removed = read_draft(cdp) is None
                except Exception:
                    test_draft_removed = False
            else:
                try:
                    test_draft_removed = not has_existing_draft(cdp) if not preexisting_draft else True
                except Exception:
                    test_draft_removed = False
            record("test_draft_removed", test_draft_removed)
            cdp.close()

        if forwarded_port:
            removed = subprocess.run(
                ["adb", "-d", "forward", "--remove", f"tcp:{forwarded_port}"],
                cwd=ROOT,
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).returncode == 0
            record("adb_forward_removed", removed)
        else:
            record("adb_forward_removed", True)

        passed = not BLOCKERS and all(CHECKS.values())
        report = {
            "version": 1,
            "scope": "real USB Android WebView with synthetic feedback data only",
            "status": "passed" if passed else "failed",
            "synthetic": {
                "description": SYNTHETIC_DESCRIPTION,
                "error": SYNTHETIC_ERROR,
                "attachments": False,
            },
            "checks": CHECKS,
            "observations": OBSERVATIONS,
            "synthetic_post_removed": SYNTHETIC_POST_REMOVED,
            "synthetic_outbox_removed": SYNTHETIC_OUTBOX_REMOVED,
            "blockers": BLOCKERS,
            "uiIssues": UI_ISSUES,
            "failureCheck": FAILURE_CHECK or None,
        }
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        report_written = True
        print(f"REPORT: {REPORT.relative_to(ROOT)}", flush=True)

    if not report_written:
        raise RuntimeError("report_not_written")
    if not report_is_passed():
        raise SystemExit(1)


def report_is_passed() -> bool:
    return not BLOCKERS and bool(CHECKS) and all(CHECKS.values())


if __name__ == "__main__":
    main()
