import { describe, expect, it } from "vitest";
import {
  describeUnsupportedGkdApp,
  getGkdChannel,
  isOfficialGkdImportTarget,
  isSupportedGkdApp,
} from "./gkdTarget";

describe("official GKD 1.13+ version support", () => {
  it("accepts official GKD 1.13+ stable and beta releases and rejects older or forked builds", () => {
    const stable113 = { id: "li.songe.gkd", versionName: "1.13.2" };
    const beta113 = { id: "li.songe.gkd", versionName: "1.13.0-beta-2" };
    const stable114 = { id: "li.songe.gkd", versionName: "v1.14.0" };
    const oldStable = { id: "li.songe.gkd", versionName: "1.12.1" };
    const fork = { id: "li.songe.gkd.debug", versionName: "1.13.2" };

    expect(isSupportedGkdApp(stable113)).toBe(true);
    expect(isSupportedGkdApp(beta113)).toBe(true);
    expect(isSupportedGkdApp(stable114)).toBe(true);
    expect(isSupportedGkdApp(oldStable)).toBe(false);
    expect(isSupportedGkdApp(fork)).toBe(false);
    expect(isSupportedGkdApp({ id: "li.songe.gkd" })).toBe(false);
    expect(isSupportedGkdApp(undefined)).toBe(false);

    expect(describeUnsupportedGkdApp(oldStable)).toContain("1.13.0");
    expect(describeUnsupportedGkdApp(oldStable)).toContain("升级");
    expect(describeUnsupportedGkdApp(fork)).toContain("li.songe.gkd");
  });

  it("still detects release channel for feedback diagnostics", () => {
    expect(getGkdChannel({ id: "li.songe.gkd", versionName: "1.13.2" })).toBe("stable");
    expect(getGkdChannel({ id: "li.songe.gkd", versionName: "1.13.0-beta-2" })).toBe("beta");
    expect(getGkdChannel({ id: "li.songe.gkd.debug", versionName: "1.13.0-beta-2" })).toBeNull();
    expect(getGkdChannel({ id: "li.songe.gkd" })).toBeNull();
    expect(getGkdChannel(undefined)).toBeNull();
  });

  it("treats official package ID and historical official channels as the same import target", () => {
    expect(isOfficialGkdImportTarget("li.songe.gkd")).toBe(true);
    expect(isOfficialGkdImportTarget("beta")).toBe(true);
    expect(isOfficialGkdImportTarget("stable")).toBe(true);
    expect(isOfficialGkdImportTarget("li.songe.gkd.debug")).toBe(false);
  });
});
