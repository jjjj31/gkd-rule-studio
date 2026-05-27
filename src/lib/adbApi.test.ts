import { describe, expect, it } from "vitest";
import {
  parseAdbDevicesOutput,
  parseAdbSnapshotFileName,
} from "./adbApi";

describe("ADB API parsing", () => {
  it("parses adb devices output with authorization states", () => {
    expect(
      parseAdbDevicesOutput(`List of devices attached
ABC123\tdevice
DEF456\tunauthorized
GHI789\toffline

`),
    ).toEqual([
      { serial: "ABC123", state: "device" },
      { serial: "DEF456", state: "unauthorized" },
      { serial: "GHI789", state: "offline" },
    ]);
  });

  it("extracts snapshot ids and extensions from common GKD file names", () => {
    expect(parseAdbSnapshotFileName("snapshot-18134826.zip")).toEqual({
      id: 18134826,
      extension: "zip",
    });
    expect(parseAdbSnapshotFileName("18134828.json")).toEqual({
      id: 18134828,
      extension: "json",
    });
    expect(parseAdbSnapshotFileName("screenshot-18134829.png")).toEqual({
      id: 18134829,
      extension: "png",
    });
    expect(parseAdbSnapshotFileName("readme.txt")).toBeNull();
  });
});
