import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceApiClient } from "./deviceApi";
import type { DeviceServerInfo } from "../types/gkdSnapshot";
import type { RawSubscriptionDraft } from "./testSubscription";

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
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
