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

  it("posts an app draft to GKD localRules append beta api", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/api/getServerInfo")) {
        return jsonResponse({
          device: {},
          gkdAppInfo: { id: "li.songe.gkd", name: "GKD", versionName: "1.12.1" },
        } satisfies DeviceServerInfo);
      }
      if (String(input).endsWith("/api/localRules/append")) {
        return jsonResponse({
          ok: true,
          action: "append",
          appId: "com.demo",
          appName: "Demo",
          addedGroups: 1,
          addedRules: 1,
          skippedDuplicates: 0,
        });
      }
      return jsonResponse({});
    });

    const client = await createDeviceApiClient("http://127.0.0.1:8888");
    const appDraft: AppRuleDraft = {
      id: "com.demo",
      name: "Demo",
      groups: [
        {
          key: 0,
          name: "开屏广告",
          rules: [{ key: 0, name: "自动跳过", matches: ['[vid="skip"]'] }],
        },
      ],
    };
    const result = await client.appendLocalRules(appDraft);

    const appendCall = calls.find((call) =>
      call.url.endsWith("/api/localRules/append"),
    );
    expect(appendCall?.init?.method).toBe("POST");
    expect(appendCall?.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(appendCall?.init?.body).toBe(
      JSON.stringify({ app: appDraft, dedupe: true }),
    );
    expect(result).toEqual({
      ok: true,
      action: "append",
      appId: "com.demo",
      appName: "Demo",
      addedGroups: 1,
      addedRules: 1,
      skippedDuplicates: 0,
    });
  });

  it("sends a complete external group without selector deduplication or field loss", async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("getServerInfo")) return jsonResponse({ device: {}, gkdAppInfo: { id: "li.songe.gkd.debug", name: "GKD" } });
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true, action: "append", appId: "com.demo", addedGroups: 1, addedRules: 2, skippedDuplicates: 0 });
    });
    const client = await createDeviceApiClient("http://127.0.0.1:8888");
    const app: SubscriptionApp = { id: "com.demo", name: "Demo", groups: [{
      key: 9, name: "流程", actionCdKey: 0, unknownField: { keep: true },
      rules: [{ key: 0, anyMatches: "A" }, { key: 1, preKeys: [0], matches: "A", actionCd: 5000 }],
    }] };
    await client.appendLocalRules(app, { dedupe: false });
    expect(bodies).toEqual([{ app, dedupe: false }]);
  });

  it("rejects incomplete write responses without claiming a successful import", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("getServerInfo")
      ? jsonResponse({ device: {} }) : jsonResponse({ ok: true }));
    const client = await createDeviceApiClient("http://127.0.0.1:8888");
    await expect(client.appendLocalRules({ id: "com.demo", name: "Demo", groups: [] })).rejects.toThrow("核对");
  });

  it("accepts a complete response when the serializer omits default success fields", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).endsWith("getServerInfo")
      ? jsonResponse({ device: {} }) : jsonResponse({ appId: "com.demo", addedGroups: 1, addedRules: 2, skippedDuplicates: 0 }));
    const client = await createDeviceApiClient("http://127.0.0.1:8888");
    await expect(client.appendLocalRules({ id: "com.demo", name: "Demo", groups: [] })).resolves.toMatchObject({ ok: true, action: "append", addedRules: 2 });
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
