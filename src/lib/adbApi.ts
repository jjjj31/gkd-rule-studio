/** ADB 辅助工具：通过 adb helper 脚本（scripts/adb-helper.mjs）在 PC 端操作 GKD。仅桌面版可用。 */
import type {
  DeviceServerInfo,
  DeviceSnapshotSummary,
  ParsedGkdSnapshot,
  RawGkdSnapshot,
} from "../types/gkdSnapshot";
import {
  DEBUG_GKD_PACKAGE,
  OFFICIAL_GKD_PACKAGE,
  type GkdTargetPackage,
} from "./gkdTarget";
import { normalizeSnapshot } from "./snapshotZip";

const ADB_HELPER_ORIGIN = "http://127.0.0.1:18741";

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

export interface AdbSnapshotFile {
  id: number;
  extension: "json" | "png" | "zip";
}

export interface AdbDiagnostic {
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface AdbStatusResponse {
  ok: boolean;
  adbVersion?: string;
  devices: AdbDevice[];
  diagnostics: AdbDiagnostic[];
}

export interface AdbSnapshotPayload {
  snapshot: RawGkdSnapshot;
  screenshotBase64: string;
  sourceName: string;
}

export interface AdbApiClient {
  origin: string;
  serverInfo: DeviceServerInfo;
  getSnapshots: () => Promise<DeviceSnapshotSummary[]>;
  loadSnapshot: (id: number) => Promise<ParsedGkdSnapshot>;
}

export function parseAdbDevicesOutput(output: string): AdbDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"))
    .map((line) => {
      const [serial, state] = line.split(/\s+/);
      return { serial, state };
    })
    .filter((device) => Boolean(device.serial && device.state));
}

export function parseAdbSnapshotFileName(
  fileName: string,
): AdbSnapshotFile | null {
  const match = fileName.match(/(?:snapshot-|screenshot-)?(\d+)\.(json|png|zip)$/i);
  if (!match) return null;
  return {
    id: Number(match[1]),
    extension: match[2].toLowerCase() as AdbSnapshotFile["extension"],
  };
}

export async function getAdbStatus(): Promise<AdbStatusResponse> {
  return getJson<AdbStatusResponse>("/api/adb/status");
}

export async function createAdbApiClient(
  serial: string,
  packageId: GkdTargetPackage = OFFICIAL_GKD_PACKAGE,
): Promise<AdbApiClient> {
  const packageQuery = `packageId=${encodeURIComponent(packageId)}`;
  const status = await getJson<AdbStatusResponse>(
    `/api/adb/status?serial=${encodeURIComponent(serial)}&${packageQuery}`,
  );
  const selectedDevice =
    status.devices.find((device) => device.serial === serial) ?? status.devices[0];
  const serverInfo: DeviceServerInfo = {
    device: {
      manufacturer: "ADB",
      model: selectedDevice?.model ?? selectedDevice?.serial ?? "Android",
      release: "?",
    },
    gkdAppInfo: {
      id: packageId,
      name: packageId === DEBUG_GKD_PACKAGE ? "GKD Debug" : "GKD",
      versionName: "ADB",
    },
  };

  return {
    origin: ADB_HELPER_ORIGIN,
    serverInfo,
    getSnapshots: async () => {
      return getJson<DeviceSnapshotSummary[]>(
        `/api/adb/snapshots?serial=${encodeURIComponent(serial)}&${packageQuery}`,
      );
    },
    loadSnapshot: async (id) => {
      const payload = await getJson<AdbSnapshotPayload>(
        `/api/adb/snapshot?serial=${encodeURIComponent(serial)}&id=${id}&${packageQuery}`,
      );
      const screenshot = base64ToArrayBuffer(payload.screenshotBase64);
      const screenshotUrl = URL.createObjectURL(
        new Blob([screenshot], { type: "image/png" }),
      );
      return normalizeSnapshot(payload.snapshot, screenshotUrl, payload.sourceName);
    },
  };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${ADB_HELPER_ORIGIN}${path}`);
  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    throw new Error(error?.message ?? `ADB 辅助服务错误: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
