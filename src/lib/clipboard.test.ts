import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

describe("clipboard helper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the Android WebView bridge when available", async () => {
    const copyToClipboard = vi.fn();
    vi.stubGlobal("window", {
      GkdAndroidBridge: {
        copyToClipboard,
      },
    });

    await copyTextToClipboard("hello");

    expect(copyToClipboard).toHaveBeenCalledWith("hello");
  });

  it("falls back to navigator clipboard outside Android WebView", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText,
      },
    });

    await copyTextToClipboard("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
  });
});
