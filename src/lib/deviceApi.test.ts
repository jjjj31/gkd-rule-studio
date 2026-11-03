import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceApiClient } from "./deviceApi";
import type { DeviceServerInfo } from "../types/gkdSnapshot";
import type { RawSubscriptionDraft } from "./testSubscription";
import type { AppRuleDraft } from "../types/ruleDraft";
import type { SubscriptionApp } from "../types/subscriptionLibrary";

describe("device api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a full subscription to GKD updateSubscription", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/api/getServerInfo")) {
        return jsonResponse({
          device: {},
          gkdAppInfo: { id: "li.songe.gkd", name: "GKD", versionName: "1.10.4" },
        } satisfies DeviceServerInfo);
      }
      if (String(input).endsWith("/api/updateSubscription")) {
        return jsonResponse({ message: "ok" });
      }
      return jsonResponse({});
    });

    const client = await createDeviceApiClient("http://127.0.0.1:8888");
    const subscription: RawSubscriptionDraft = {
      id: 0,
      name: "GKD Rule Studio 测试订阅",
      version: 1,
      author: "local",
      apps: [],
    };
    await client.updateSubscription(subscription);

    const updateCall = calls.find((call) =>
      call.url.endsWith("/api/updateSubscription"),
    );
    expect(updateCall?.init?.method).toBe("POST");
    expect(updateCall?.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(updateCall?.init?.body).toBe(JSON.stringify(subscription));
  });

  it("rejects boolean field type errors before syncing a subscription", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls.push(String(input));
      if (String(input).endsWith("/api/getServerInfo")) {
        return jsonResponse({
          device: {},
          gkdAppInfo: { id: "li.songe.gkd", name: "GKD", versionName: "1.13.0-beta-2" },
        } satisfies DeviceServerInfo);
      }
      return jsonResponse({ message: "ok" });
    });

    const client = await createDeviceApiClient("http://127.0.0.1:8888", "beta");
    await expect(client.updateSubscription({
      id: 0,
      name: "test",
      version: 1,
      author: "local",
      apps: [{
        id: "com.demo",
        name: "Demo",
        groups: [{
          key: 0,
          name: "g",
          rules: [{
            key: 0,
            matches: ['[vid="skip"]'],
            matchRoot: "content_container",
          }],
        }],
      }],
    } as unknown as RawSubscriptionDraft)).rejects.toThrow("rules[0].matchRoot");
    expect(calls.some((url) => url.endsWith("/api/updateSubscription"))).toBe(false);
  });

  const app: AppRuleDraft = { id: "com.demo", name: "Demo", groups: [{
    key: 7, name: "关闭广告", rules: [{ key: 10, matches: ['[text="关闭"]'] }],
  }] };
  const betaInfo = { device: {}, gkdAppInfo: { id: "li.songe.gkd", versionName: "1.13.0-beta-2" } };

  it("appends to official beta local rules and validates the returned groups", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return jsonResponse(String(input).endsWith("getServerInfo") ? betaInfo : app.groups);
    });
    const client = await createDeviceApiClient("http://127.0.0.1:8888", "beta");
    expect(await client.appendLocalRules(app)).toEqual({ ok: true, action: "append", appId: "com.demo",
      appName: "Demo", addedGroups: 1, addedRules: 1, skippedDuplicates: 0 });
    expect(calls[1]).toEqual({ url: "http://127.0.0.1:8888/api/appendRules",
      body: { subsId: -2, groupType: 2, appId: "com.demo", source: JSON.stringify(app.groups[0]) } });
  });

  it("keeps external references, default switches and unknown fields intact", async () => {
    const external: SubscriptionApp = { id: "com.demo", name: "Demo", groups: [{
      key: 9, name: "流程", enable: false, actionCdKey: 10, custom: { keep: true },
      rules: [{ key: 10, anyMatches: "A" }, { key: 30, preKeys: [10], matches: "A" }],
    }] };
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("getServerInfo")) return jsonResponse(betaInfo);
      body = JSON.parse(String(init?.body));
      return jsonResponse(external.groups);
    });
    const client = await createDeviceApiClient("http://127.0.0.1:8888", "beta");
    await client.appendLocalRules(external);
    expect(JSON.parse(String(body.source))).toEqual(external.groups[0]);
    expect(body).not.toHaveProperty("dedupe");
  });

  it("rejects a missing root app id before writing", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResponse(betaInfo));
    const client = await createDeviceApiClient("http://device:8888", "beta");
    await expect(client.appendLocalRules({ ...app, id: "" })).rejects.toThrow("应用包名 id");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps a complete app source when appending multiple groups", async () => {
    const multiGroup: AppRuleDraft = { ...app, groups: [
      app.groups[0],
      { key: 8, name: "弹窗广告", rules: [{ key: 11, matches: ['[text="跳过"]'] }] },
    ] };
    let body: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("getServerInfo")) return jsonResponse(betaInfo);
      body = JSON.parse(String(init?.body));
      return jsonResponse(multiGroup.groups);
    });
    const client = await createDeviceApiClient("http://device:8888", "beta");
    await client.appendLocalRules(multiGroup);
    expect(JSON.parse(String(body.source))).toEqual(multiGroup);
  });

  it("rejects a mismatched release channel or fork before loading or writing", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(betaInfo));
    await expect(createDeviceApiClient("http://device:8888", "stable")).rejects.toThrow("对应版本");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(jsonResponse({ ...betaInfo, gkdAppInfo: { ...betaInfo.gkdAppInfo, id: "li.songe.gkd.debug" } }));
    await expect(createDeviceApiClient("http://device:8888", "beta")).rejects.toThrow("对应版本");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains stable reads and refuses direct writes on the stable path", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      device: {}, gkdAppInfo: { id: "li.songe.gkd", versionName: "1.12.1" },
    }));
    const client = await createDeviceApiClient("http://device:8888", "stable");
    await expect(client.appendLocalRules(app)).rejects.toThrow("复制");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{}, [{ key: 7 }], [], [{ key: 7, rules: [] }]])("does not claim success on an incomplete write response %j", async result => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => jsonResponse(
      String(input).endsWith("getServerInfo") ? betaInfo : result));
    const client = await createDeviceApiClient("http://device:8888", "beta");
    await expect(client.appendLocalRules(app)).rejects.toThrow("核对");
  });

  it("recognizes the official HTTP-200 business error envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async input => jsonResponse(
      String(input).endsWith("getServerInfo") ? betaInfo : { code: "parse-error", message: "规则内容错误" }));
    const client = await createDeviceApiClient("http://device:8888", "beta");
    await expect(client.appendLocalRules(app)).rejects.toThrow("规则内容错误");
  });

  it("does not replay append after losing the response", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      if (String(input).endsWith("getServerInfo")) return jsonResponse(betaInfo);
      throw new TypeError("response lost");
    });
    const client = await createDeviceApiClient("http://device:8888", "beta");
    await expect(client.appendLocalRules(app)).rejects.toThrow("response lost");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
