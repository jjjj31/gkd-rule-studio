import { afterEach, expect, it, vi } from "vitest";
import { enhancedFetch } from "./networkExtension";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("does not restart an explicitly cancelled request through the extension", async () => {
  const controller = new AbortController();
  const extension = vi.fn();
  vi.stubGlobal("window", { __NetworkExtension__: { GM_xmlhttpRequest: extension } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    controller.abort();
    throw new DOMException("cancelled", "AbortError");
  });
  await expect(enhancedFetch("https://example.com/sub.json5", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(extension).not.toHaveBeenCalled();
});
