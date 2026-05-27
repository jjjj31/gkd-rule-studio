import { Camera, RefreshCw, Smartphone } from "lucide-react";
import { useState } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import {
  createDeviceApiClient,
  formatServerTitle,
  formatSnapshotOption,
} from "../lib/deviceApi";
import type {
  DeviceSnapshotSummary,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { DeviceApiClient } from "../lib/deviceApi";

interface DeviceSnapshotPanelProps {
  onSnapshotLoaded: (snapshot: ParsedGkdSnapshot) => void;
  onError: (message: string) => void;
}

export function DeviceSnapshotPanel({
  onSnapshotLoaded,
  onError,
}: DeviceSnapshotPanelProps) {
  const [initiallyCollapsed] = useState(
    () => Boolean(localStorage.getItem("gkd-rule-builder-device-url")),
  );
  const [deviceUrl, setDeviceUrl] = useState(
    () => localStorage.getItem("gkd-rule-builder-device-url") ?? "",
  );
  const [client, setClient] = useState<DeviceApiClient | null>(null);
  const [snapshots, setSnapshots] = useState<DeviceSnapshotSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);

  async function connect(): Promise<void> {
    setLoading(true);
    try {
      const nextClient = await createDeviceApiClient(deviceUrl);
      const nextSnapshots = await nextClient.getSnapshots();
      setClient(nextClient);
      setSnapshots(nextSnapshots);
      setSelectedId(nextSnapshots[0]?.id ? String(nextSnapshots[0].id) : "");
      localStorage.setItem("gkd-rule-builder-device-url", nextClient.origin);
      setDeviceUrl(nextClient.origin);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "连接设备失败");
    } finally {
      setLoading(false);
    }
  }

  async function refreshSnapshots(): Promise<void> {
    if (!client) {
      await connect();
      return;
    }

    setLoading(true);
    try {
      const nextSnapshots = await client.getSnapshots();
      setSnapshots(nextSnapshots);
      setSelectedId((current) => {
        if (nextSnapshots.some((snapshot) => String(snapshot.id) === current)) {
          return current;
        }
        return nextSnapshots[0]?.id ? String(nextSnapshots[0].id) : "";
      });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "刷新快照失败");
    } finally {
      setLoading(false);
    }
  }

  async function captureSnapshot(): Promise<void> {
    if (!client) return;

    setLoading(true);
    try {
      const snapshot = await client.captureSnapshot();
      const nextSnapshots = await client.getSnapshots();
      setSnapshots(nextSnapshots);
      setSelectedId(String(snapshot.id));
      await loadSnapshot(String(snapshot.id), client);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "捕获快照失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadSnapshot(
    id = selectedId,
    targetClient = client,
  ): Promise<void> {
    if (!targetClient || !id) return;

    setLoadingSnapshot(true);
    try {
      const snapshot = await targetClient.loadSnapshot(Number(id));
      onSnapshotLoaded(snapshot);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "加载快照失败");
    } finally {
      setLoadingSnapshot(false);
    }
  }

  return (
    <CollapsiblePanel
      defaultCollapsed={initiallyCollapsed}
      subtitle="连接手机 HTTP 服务，或刷新已保存快照"
      title="设备快照"
    >
      <div className="device-grid">
        <label>
          <span>手机 HTTP 服务地址</span>
          <div className="input-row">
            <input
              placeholder="例如 192.168.1.23:8080"
              value={deviceUrl}
              onChange={(event) => setDeviceUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void connect();
              }}
            />
            <button disabled={loading} type="button" onClick={() => void connect()}>
              <Smartphone size={15} />
              连接
            </button>
          </div>
          <small>手机和电脑需要在同一网络，地址来自 GKD 的 HTTP 服务。</small>
        </label>

        {client && (
          <>
            <div className="device-status">{formatServerTitle(client.serverInfo)}</div>
            <label>
              <span>选择快照</span>
              <div className="input-row">
                <select
                  value={selectedId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setSelectedId(id);
                    void loadSnapshot(id);
                  }}
                >
                  {snapshots.length === 0 ? (
                    <option value="">没有快照</option>
                  ) : (
                    snapshots.map((snapshot) => (
                      <option key={snapshot.id} value={snapshot.id}>
                        {formatSnapshotOption(snapshot)}
                      </option>
                    ))
                  )}
                </select>
                <button
                  disabled={loading || loadingSnapshot}
                  type="button"
                  onClick={() => void refreshSnapshots()}
                >
                  <RefreshCw size={15} />
                  刷新
                </button>
              </div>
              <small>选择后会加载对应截图和节点树，下面继续点目标生成规则。</small>
            </label>
            <button
              className="wide-button"
              disabled={loading || loadingSnapshot}
              type="button"
              onClick={() => void captureSnapshot()}
            >
              <Camera size={15} />
              捕获当前手机界面快照
            </button>
          </>
        )}
      </div>
    </CollapsiblePanel>
  );
}
