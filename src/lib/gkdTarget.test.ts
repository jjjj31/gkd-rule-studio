import { afterEach, describe, expect, it, vi } from "vitest";
import { getGkdChannel, matchesTargetChannel, readStoredTargetChannel, storeTargetChannel } from "./gkdTarget";

afterEach(() => vi.unstubAllGlobals());

describe("official GKD channels", () => {
  it("distinguishes releases by version when their package IDs are identical", () => {
    const stable = { id: "li.songe.gkd", versionName: "1.12.1" };
    const beta = { id: "li.songe.gkd", versionName: "1.13.0-beta-2" };
    expect(matchesTargetChannel(stable, "stable")).toBe(true);
    expect(matchesTargetChannel(stable, "beta")).toBe(false);
    expect(matchesTargetChannel(beta, "beta")).toBe(true);
    expect(matchesTargetChannel(beta, "stable")).toBe(false);
    expect(getGkdChannel({ ...beta, id: "li.songe.gkd.debug" })).toBeNull();
    expect(getGkdChannel({ id: "li.songe.gkd" })).toBeNull();
    expect(getGkdChannel(undefined)).toBeNull();
  });

  it("defaults old fork selections to stable and persists an explicit beta choice", () => {
    const values = new Map([["gkd-rule-studio-target-package", "li.songe.gkd.debug"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    expect(readStoredTargetChannel()).toBe("stable");
    storeTargetChannel("beta");
    expect(readStoredTargetChannel()).toBe("beta");
    expect(values.has("gkd-rule-studio-target-package")).toBe(false);
  });
});
