import copy
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
from ruyipage import launch

ROOT = Path(__file__).resolve().parents[1] / ".scratch" / "subscription-library-browser-check"
ROOT.mkdir(parents=True, exist_ok=True)
FIXTURE = "http://127.0.0.1:8767"
state = {"versions": {"a": 1, "b": 1, "c": 1}, "gkd_version": "1.13.2", "fail": set(), "update_fail": False, "append_partial": False, "pause_c": threading.Event(), "requests": [], "updates": [], "appends": [], "local_groups": []}

def subscription(key):
    version = state["versions"][key]
    data = {"id": 123, "name": f"测试订阅 {key.upper()}", "version": version, "author": "测试作者", "apps": [{
        "id": "com.demo.library", "name": "淘宝", "groups": [{
            "key": 0, "name": "关闭更新弹窗", "desc": "两步关闭，仅导入这个功能。", "enable": False,
            "actionCdKey": 10, "actionMaximumKey": 30, "customField": {"retained": True},
            "rules": [{"key": 10, "matches": f'[text="关闭 {key}{version}"]'},
                      {"key": 30, "anyMatches": '[text="确认"]', "preKeys": [10], "actionCdKey": 10}],
        }],
    }]}
    if key == "a" and version >= 2:
        data["apps"][0]["groups"].append({"key": 3, "name": "缺依赖的规则组", "rules": {"matches": "A", "preKeys": [999]}})
    return data

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
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
    def do_OPTIONS(self): self.reply({})
    def do_GET(self):
        state["requests"].append(self.path)
        key = self.path.strip("/").split(".")[0]
        if key == "c": state["pause_c"].wait(10)
        if key in state["versions"]:
            self.reply(subscription(key), 503 if key in state["fail"] else 200)
        elif key == "invalid": self.reply("not a subscription")
        else: self.reply({}, 404)
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        if self.path.endswith("getServerInfo"):
            self.reply({"device": {}, "gkdAppInfo": {"id": "li.songe.gkd", "name": "GKD", "versionName": state["gkd_version"]}})
        elif self.path.endswith("getSnapshots"): self.reply([])
        elif self.path.endswith("updateSubscription"):
            if state["update_fail"]: self.reply({"error": "fixture failure"}, 500)
            else:
                state["updates"].append(data)
                self.reply({"message": "ok"})
        elif self.path.endswith("appendRules"):
            state["appends"].append(data)
            assert data["subsId"] == -2 and data["groupType"] == 2
            source = json.loads(data["source"])
            assert data["appId"] == "com.demo.library"
            assert "id" not in source and isinstance(source.get("rules"), list)
            imported_groups = []
            for raw in [source]:
                group = copy.deepcopy(raw)
                if state["append_partial"]: group["rules"] = group["rules"][:1]
                group["key"] = max([g["key"] for g in state["local_groups"]], default=-1) + 1
                for i, rule in enumerate(group["rules"]): rule["key"] = i
                state["local_groups"].append(group)
                imported_groups.append(group)
            self.reply(imported_groups)
        else: self.reply({}, 404)

server = ThreadingHTTPServer(("127.0.0.1", 8767), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
page = None
checks = []

def wait_js(expression, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if page.run_js("return (() => { try { return Boolean(" + expression + "); } catch { return false; } })();"): return
        time.sleep(.1)
    raise AssertionError("等待失败: " + expression + "\n" + str(page.run_js("return document.body.innerText;")))

def js(expression): return page.run_js("return " + expression + ";")
def click(selector):
    element = page.ele("css:" + selector)
    assert element, selector
    element.click()
def check(name):
    checks.append(name)
    print("PASS:", name, flush=True)
def sources(): return js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-sources') || '[]')")
def records(): return js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-imports') || '[]')")
def ensure_sources():
    if not js("document.querySelector('.library-sources').open"): click(".library-sources > summary")
def add(key):
    ensure_sources()
    page.ele('css:input[aria-label="订阅文件链接"]').input(f"{FIXTURE}/{key}.json5")
    click("form.library-form button[type=submit]")
    wait_js(f"JSON.parse(localStorage.getItem('gkd-rule-studio-library-sources') || '[]').some(s => s.url.endsWith('/{key}.json5'))")
    wait_js("!document.querySelector('input[aria-label=\"订阅文件链接\"]').disabled")
def inject_bridge():
    page.run_js("window.GkdAndroidBridge = {copyToClipboard(text) {window.__copiedRule = text;}, setBackVisible() {}}; window.__qaErrors = []; window.addEventListener('error', e => window.__qaErrors.push(e.message)); window.addEventListener('unhandledrejection', e => window.__qaErrors.push(String(e.reason)));")
def open_app():
    page.ele('css:input[aria-label="搜索应用名或包名"]').input(" 淘宝 ")
    wait_js("document.querySelectorAll('.library-app-button').length === 1")
    assert "com.demo.library" not in js("document.querySelector('.library-app-button').innerText")
    assert js("document.querySelector('.library-app-button').title === 'com.demo.library'")
    click(".library-app-button")
    wait_js("document.querySelectorAll('.library-group').length >= 2")
def group_button(group_index, button_index):
    elements = page.eles("css:.library-group")
    button = elements[group_index].ele(f"css:.library-actions button:nth-child({button_index})")
    assert button
    button.click()
def home():
    for _ in range(10):
        if js("Boolean(document.querySelector('.android-connect-card'))"): break
        if js("Boolean(document.querySelector('button[aria-label=\"返回应用列表\"]'))"):
            click('button[aria-label="返回应用列表"]')
        elif js("Boolean(document.querySelector('button[aria-label=\"返回首页\"]'))"):
            click('button[aria-label="返回首页"]')
        time.sleep(.2)
    wait_js("document.querySelector('.android-connect-card')")
def library_app():
    click(".library-entry")
    wait_js("document.querySelector('.rule-library')")
    assert not js("Boolean(document.querySelector('.library-connection'))")
    open_app()

try:
    page = launch(headless=True, user_dir=str(ROOT / "firefox-profile"), window_size=(412, 915))
    page.set_viewport(412, 915)
    # External fonts must not block the offline, synthetic UI checks.
    page.intercept.start(lambda req: req.mock("", headers={"content-type": "text/css"}), url_patterns=[{"type": "pattern", "protocol": "https", "hostname": "fonts.googleapis.com"}], phases=["beforeRequestSent"])
    page.get("http://127.0.0.1:5174/", wait="none")
    wait_js("document.querySelector('.library-entry')")
    generated = {"version": 1, "items": [{
        "id": "ordinary", "source": "offline-selector", "mode": "single", "sourceKey": "ordinary", "title": "普通候选", "summary": "原测试", "status": "testing", "canImport": False, "createdAt": 1, "updatedAt": 1,
        "app": {"id": "com.demo.library", "name": "淘宝", "groups": [{"key": 7, "name": "关闭更新弹窗", "rules": [{"key": 0, "matches": ['[text="普通候选"]']}]}]},
    }], "aiSessions": []}
    page.run_js("localStorage.clear(); localStorage.setItem('gkd-rule-builder-device-url', " + json.dumps(FIXTURE) + "); localStorage.setItem('gkd-rule-studio-inline-testing', " + json.dumps(json.dumps(generated, ensure_ascii=False)) + ");")
    page.refresh()
    wait_js("document.querySelector('.library-entry')")
    inject_bridge()
    click(".library-entry")
    wait_js("document.querySelector('.rule-library')")
    check("独立入口，无设备或快照门槛")
    ensure_sources()
    click("form.library-form button[type=submit]")
    wait_js("document.querySelector('#library-link-error')")
    wait_js("document.activeElement === document.querySelector('#library-link')")
    assert js("document.activeElement === document.querySelector('.library-form input')")
    assert js("document.querySelector('.library-form input').getAttribute('aria-invalid') === 'true'")
    assert not js("Boolean(document.querySelector('.library-notice'))")
    field = page.ele('css:input[aria-label="订阅文件链接"]')
    field.input("not-a-subscription-url")
    assert not js("Boolean(document.querySelector('#library-link-error'))")
    click("form.library-form button[type=submit]")
    wait_js("document.querySelector('#library-link-error')")
    wait_js("document.activeElement === document.querySelector('#library-link')")
    assert js("document.activeElement.value === 'not-a-subscription-url'")
    assert not any(path.endswith(".json5") for path in state["requests"])
    field.input(f"{FIXTURE}/missing.json5")
    click("form.library-form button[type=submit]")
    wait_js("document.querySelector('#library-link-error')?.innerText.includes('404')")
    wait_js("document.activeElement === document.querySelector('#library-link')")
    assert js("document.activeElement.value.endsWith('/missing.json5')")
    field.input(f"{FIXTURE}/invalid.json5")
    click("form.library-form button[type=submit]")
    wait_js("document.querySelector('#library-link-error')")
    wait_js("document.activeElement === document.querySelector('#library-link')")
    assert js("document.activeElement.value.endsWith('/invalid.json5')")
    check("必填、链接格式和下载失败在字段旁提示、保留内容并聚焦，修改后清除")
    add("a")
    assert not js("Boolean(document.querySelector('#library-link-error'))")
    add("b")
    assert len(sources()) == 2
    ensure_sources()
    page.ele('css:input[aria-label="订阅文件链接"]').input(f"{FIXTURE}/c.json5")
    click("form.library-form button[type=submit]")
    wait_js("document.querySelector('input[aria-label=\"订阅文件链接\"]').disabled")
    click('button[aria-label="返回首页"]')
    wait_js("document.querySelector('.library-entry')")
    click(".library-entry")
    wait_js("document.querySelector('.rule-library')")
    assert js("document.querySelector('input[aria-label=\"订阅文件链接\"]').disabled")
    state["pause_c"].set()
    wait_js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-sources')).length === 3")
    wait_js("!document.querySelector('input[aria-label=\"订阅文件链接\"]').disabled")
    ensure_sources()
    page.eles("css:.library-sources .library-source")[2].ele("css:.library-actions button:nth-child(2)").click()
    wait_js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-sources')).length === 2")
    check("下载中往返首页保留任务状态及来源，避免跨页面覆盖")
    open_app()
    check("多个来源、同名组独立展示")
    rule_search = page.ele('css:input[aria-label="搜索规则名称"]')
    rule_search.input(" 更新 ")
    wait_js("document.querySelectorAll('.library-group').length === 2")
    rule_search.input("不存在的规则")
    wait_js("document.querySelectorAll('.library-group').length === 0")
    assert "未找到规则" in js("document.body.innerText")
    rule_search.input("")
    wait_js("document.querySelectorAll('.library-group').length === 2")
    check("应用内按规则名搜索，保留跨来源同名组，清空恢复全部规则")
    group_button(0, 2)
    wait_js("window.__copiedRule")
    copied = js("window.__copiedRule")
    assert "com.demo.library" in copied and "preKeys" in copied and "10" in copied and "customField" in copied
    assert copied.count("关闭更新弹窗") == 1
    check("未连接、未测试也能复制完整规则组")

    home()
    click(".android-device-form button")
    wait_js("document.querySelector('.android-connection-indicator.connected')")
    library_app()
    check("规则库不重复提供连接设置，测试和导入复用首页连接")
    heading_before_import = js("document.querySelector('.library-heading').getBoundingClientRect().top")
    group_button(0, 3)
    wait_js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-imports') || '[]').length === 1")
    wait_js("document.querySelector('.library-notice').innerText.includes('已导入')")
    assert js("getComputedStyle(document.querySelector('.library-notice')).position === 'fixed'")
    assert not js("Boolean(document.querySelector('.android-main-toast:not(.library-notice)'))")
    assert abs(js("document.querySelector('.library-heading').getBoundingClientRect().top") - heading_before_import) < 1
    page.screenshot(path=str(ROOT / "rule-library-bottom-toast.png"))
    append_request = state["appends"][0]
    assert append_request["subsId"] == -2 and append_request["groupType"] == 2
    assert "groups" not in json.loads(append_request["source"])
    assert state["local_groups"][0]["rules"][1]["preKeys"] == [10]
    assert state["local_groups"][0]["actionCdKey"] == 10
    assert state["local_groups"][0]["actionMaximumKey"] == 30
    assert state["local_groups"][0]["enable"] is False
    assert records()[0]["app"]["groups"][0]["rules"][1]["preKeys"] == [10]
    check("未测试直接导入，保留官方 beta 原规则引用且保存固定原副本")

    wait_js("document.querySelectorAll('.library-group')[0].querySelector('.library-imported-button').disabled")
    assert js("document.querySelectorAll('.library-group')[0].querySelector('.library-imported-button').innerText.trim() === '已导入'")
    appends_after_import = len(state["appends"])
    time.sleep(.3)
    assert len(state["appends"]) == appends_after_import
    check("导入成功后固定为已导入，不再提供再次追加入口")

    page.run_js("window.__originalStorageSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key,value) {if(key === 'gkd-rule-studio-library-imports') throw new DOMException('quota','QuotaExceededError'); return window.__originalStorageSetItem.call(this,key,value);};")
    group_button(1, 3)
    wait_js("document.querySelector('.library-notice').innerText.includes('GKD 已写入')")
    assert len(state["appends"]) == 2
    time.sleep(.3)
    assert len(state["appends"]) == 2
    page.run_js("Storage.prototype.setItem = window.__originalStorageSetItem;")
    check("设备已写入但记录保存失败时明确提示，不自动重复写入")

    page.refresh()
    wait_js("document.querySelector('.library-entry')")
    inject_bridge()
    click(".android-device-form button")
    wait_js("document.querySelector('.android-connection-indicator.connected')")
    library_app()
    state["append_partial"] = True
    group_button(1, 3)
    wait_js("document.querySelector('.library-notice').innerText.includes('导入结果不完整')")
    assert len(records()) == 1
    assert "已导入固定副本" not in js("document.querySelectorAll('.library-group')[1].innerText")
    check("接口返回不完整时明确报错，不保存假完整记录")
    state["append_partial"] = False

    wait_js("!document.querySelectorAll('.library-group')[0].querySelector('button').disabled")
    group_button(0, 1)
    wait_js("document.querySelector('.library-active-test').innerText.includes('测试中')")
    wait_js("document.querySelector('.android-main-toast:not(.library-notice)').innerText.includes('所选规则组已发送')")
    assert js("getComputedStyle(document.querySelector('.android-main-toast:not(.library-notice)')).position === 'fixed'")
    assert not js("Boolean(document.querySelector('.library-notice'))")
    heading_with_test_toast = js("document.querySelector('.library-heading').getBoundingClientRect().top")
    wait_js("!document.querySelector('.android-main-toast:not(.library-notice)')")
    assert abs(js("document.querySelector('.library-heading').getBoundingClientRect().top") - heading_with_test_toast) < 1
    groups = state["updates"][-1]["apps"][0]["groups"]
    assert len(groups) == 2 and groups[0]["rules"][0]["matches"] == ['[text="普通候选"]']
    assert groups[1]["key"] != groups[0]["key"] and groups[1]["enable"] is True
    assert groups[1]["rules"][1]["preKeys"] == [10]
    check("完整规则库测试并入现有集合，不合并同名组、不丢普通候选")
    group_button(1, 1)
    wait_js("document.querySelector('.library-active-test').innerText.includes('测试订阅 B')")
    wait_js("document.querySelector('.library-active-test').innerText.includes('测试中')")
    groups = state["updates"][-1]["apps"][0]["groups"]
    assert len(groups) == 2 and "b1" in groups[1]["rules"][0]["matches"]
    assert "a1" not in json.dumps(groups, ensure_ascii=False)
    check("切换规则组退出旧测试，仅一组规则库测试运行")
    click(".library-active-test .library-actions button:nth-child(1)")
    wait_js("!document.querySelector('.library-active-test')")
    wait_js("!document.querySelectorAll('.library-group')[0].querySelector('button').disabled")
    assert len(state["updates"][-1]["apps"][0]["groups"]) == 1
    check("手动有效反馈结束当前组，保留原候选测试")

    state["update_fail"] = True
    group_button(0, 1)
    wait_js("document.querySelector('.library-active-test').innerText.includes('未同步')")
    check("同步失败如实显示，未自动判定有效")
    state["update_fail"] = False
    retry = page.ele("text:重试同步当前测试集合")
    retry.click()
    wait_js("document.querySelector('.library-active-test').innerText.includes('测试中')")
    click(".library-active-test .library-actions button:nth-child(3)")
    wait_js("!document.querySelector('.library-active-test')")
    check("失败后可重新同步并结束测试")

    wait_js("!document.querySelectorAll('.library-group')[0].querySelector('button').disabled")
    before_mismatch = len(state["updates"])
    home()
    state["gkd_version"] = "1.12.1"
    click(".android-device-form button")
    wait_js("document.querySelector('.android-connection-indicator.disconnected')")
    library_app()
    assert js("document.querySelectorAll('.library-group')[0].querySelector('button').disabled")
    time.sleep(.3)
    assert len(state["updates"]) == before_mismatch
    home()
    state["gkd_version"] = "1.13.2"
    click(".android-device-form button")
    wait_js("document.querySelector('.android-connection-indicator.connected')")
    library_app()
    wait_js("!document.querySelectorAll('.library-group')[0].querySelector('button').disabled")
    check("低于 1.13 的旧版 GKD 被拒绝且不写入，重连 1.13+ 可正常同步")

    click('button[aria-label="返回应用列表"]')
    wait_js("document.querySelector('.library-app-list')")
    ensure_sources()
    state["fail"].add("a")
    click(".library-source .library-actions button:nth-child(1)")
    wait_js("document.querySelector('.library-sources').innerText.includes('503')")
    assert sources()[0]["subscription"]["version"] == 1
    state["versions"]["b"] = 2
    page.eles("css:.library-sources .library-source")[1].ele("css:.library-actions button:nth-child(1)").click()
    wait_js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-sources'))[1].subscription.version === 2")
    assert sources()[0]["subscription"]["version"] == 1
    state["fail"].clear()
    state["versions"]["a"] = 2
    click(".library-source .library-actions button:nth-child(1)")
    wait_js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-sources'))[0].subscription.version === 2")
    assert records()[0]["version"] == 1
    assert "a1" in records()[0]["app"]["groups"][0]["rules"][0]["matches"]
    check("手动刷新失败保留旧缓存，刷新成功不改固定副本")

    before = len(state["requests"])
    state["fail"] = {"a", "b"}
    page.refresh()
    wait_js("document.querySelector('.library-entry')")
    inject_bridge()
    click(".library-entry")
    wait_js("document.querySelector('.library-app-list')")
    open_app()
    group_button(0, 2)
    wait_js("window.__copiedRule")
    assert "a2" in js("window.__copiedRule")
    assert len(state["requests"]) == before
    check("重启／来源离线仍可搜索复制，打开页面不自动刷新")
    assert js("Array.from(document.querySelectorAll('.library-group')[1].querySelectorAll('.library-actions button')).every(b => b.disabled)")
    assert "999" in js("document.querySelectorAll('.library-group')[1].innerText")
    page.eles("css:.library-group")[1].ele("css:.library-raw > summary").click()
    assert "preKeys" in page.eles("css:.library-group")[1].ele("css:pre").text
    check("缺依赖组可浏览原文，测试／复制／导入均阻止不完整交付")
    assert js("document.documentElement.scrollWidth <= window.innerWidth"), "mobile overflow"
    page.run_js("window.scrollTo(0,0);")
    page.screenshot(path=str(ROOT / "rule-library-mobile.png"))
    check("移动端布局无横向溢出")

    home()
    library_app()
    group_button(0, 2)
    wait_js("document.querySelector('.library-notice').innerText.includes('已复制')")
    check("未连接设备时也能直接复制所选完整片段手动添加")
    click('button[aria-label="返回应用列表"]')
    wait_js("document.querySelector('.library-sources')")
    ensure_sources()
    posts_before = len(state["appends"])
    click(".library-source .library-actions button:nth-child(2)")
    wait_js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-sources')).length === 1")
    click(".library-source .library-actions button:nth-child(2)")
    wait_js("JSON.parse(localStorage.getItem('gkd-rule-studio-library-sources')).length === 0")
    assert len(records()) == 1 and len(state["appends"]) == posts_before
    check("删除来源不修改 GKD 或固定副本记录")
    assert js("window.__qaErrors.length === 0"), js("window.__qaErrors")
    home()
    page.run_js("localStorage.setItem('gkd-rule-studio-library-sources', 'corrupt-cache');")
    page.refresh()
    wait_js("document.querySelector('.library-entry')")
    click(".android-device-form button")
    wait_js("document.querySelector('.android-main-toast:not(.library-notice)')")
    click(".library-entry")
    wait_js("document.querySelector('.library-notice')")
    assert not js("Boolean(document.querySelector('.android-main-toast:not(.library-notice)'))")
    check("首次打开时缓存错误清除首页浮层，两个提示不重叠")
    (ROOT / "browser-qa.json").write_text(json.dumps({"passed": checks, "viewport": {"width": js("window.innerWidth"), "height": js("window.innerHeight"), "pixelRatio": js("window.devicePixelRatio")}, "sourceRequests": state["requests"], "memoryWrites": len(state["updates"]), "localWrites": len(state["appends"]), "hardware": "simulated GKD fork; no adb device"}, ensure_ascii=False, indent=2), encoding="utf-8")
    print("ALL PASSED:", len(checks), flush=True)
except Exception:
    if page:
        try:
            page.screenshot(path=str(ROOT / "failure.png"))
            (ROOT / "failure.html").write_text(page.html, encoding="utf-8")
        except Exception: pass
    raise
finally:
    if page: page.quit()
    server.shutdown()
