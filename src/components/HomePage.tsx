import {
  Camera,
  ClipboardCopy,
  ChevronRight,
  RefreshCw,
  Search,
  Settings,
  Smartphone,
  Stethoscope,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  canCreateSnapshotFlow,
  getSelectedFlowSnapshotIds,
} from "../lib/flowSteps";
import {
  createAdbApiClient,
  getAdbStatus,
} from "../lib/adbApi";
import type { AdbApiClient, AdbDevice, AdbStatusResponse } from "../lib/adbApi";
import {
  createDeviceApiClient,
  extractDeviceOrigins,
  formatServerTitle,
  probeDeviceOrigin,
  runDeviceDiagnostics,
} from "../lib/deviceApi";
import type {
  DeviceSnapshotSummary,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { DeviceApiClient } from "../lib/deviceApi";
import type { DeviceAddressProbe, DeviceDiagnosticStep } from "../lib/deviceApi";
import { SnapshotLoader } from "./SnapshotLoader";

interface HomePageProps {
  loadingFile: boolean;
  onError: (message: string | null) => void;
  onFileSelected: (file: File) => void;
  onOpenSettings: () => void;
  onOpenSnapshot: (snapshot: ParsedGkdSnapshot) => void;
  onOpenSnapshotsAsFlow: (snapshots: ParsedGkdSnapshot[]) => void;
}

export function HomePage({
  loadingFile,
  onError,
  onFileSelected,
  onOpenSettings,
  onOpenSnapshot,
  onOpenSnapshotsAsFlow,
}: HomePageProps) {
  const [deviceUrl, setDeviceUrl] = useState(
    () => localStorage.getItem("gkd-rule-builder-device-url") ?? "",
  );
  const [client, setClient] = useState<DeviceApiClient | null>(null);
  const [adbClient, setAdbClient] = useState<AdbApiClient | null>(null);
  const [connectMode, setConnectMode] = useState<"http" | "adb">("http");
  const [adbStatus, setAdbStatus] = useState<AdbStatusResponse | null>(null);
  const [adbDevices, setAdbDevices] = useState<AdbDevice[]>([]);
  const [selectedAdbSerial, setSelectedAdbSerial] = useState("");
  const [snapshots, setSnapshots] = useState<DeviceSnapshotSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [openingId, setOpeningId] = useState<number | null>(null);
  const [openingFlow, setOpeningFlow] = useState(false);
  const [selectedSnapshotIds, setSelectedSnapshotIds] = useState<Set<number>>(
    new Set(),
  );
  const [diagnostics, setDiagnostics] = useState<DeviceDiagnosticStep[]>([]);
  const [addressProbes, setAddressProbes] = useState<DeviceAddressProbe[]>([]);
  const [operationLog, setOperationLog] = useState<string[]>([]);

  const filteredSnapshots = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return snapshots;
    return snapshots.filter((snapshot) => {
      return [
        snapshot.appInfo?.name,
        snapshot.appName,
        snapshot.appId,
        snapshot.activityId,
        snapshot.appVersionName,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword));
    });
  }, [query, snapshots]);
  const canCreateFlow = canCreateSnapshotFlow({
    hasHttpClient: Boolean(client),
    hasAdbClient: Boolean(adbClient),
    selectedCount: selectedSnapshotIds.size,
    openingFlow,
  });

  async function connect(): Promise<void> {
    setLoading(true);
    onError(null);
    try {
      const origin = await resolveConnectOrigin(deviceUrl, setAddressProbes);
      const nextClient = await createDeviceApiClient(origin);
      const nextSnapshots = await nextClient.getSnapshots();
      setClient(nextClient);
      setAdbClient(null);
      setConnectMode("http");
      setSnapshots(nextSnapshots);
      setDeviceUrl(nextClient.origin);
      localStorage.setItem("gkd-rule-builder-device-url", nextClient.origin);
      appendOperation(`连接成功: ${formatServerTitle(nextClient.serverInfo)}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "连接设备失败";
      appendOperation(`连接失败: ${message}`);
      onError(message);
    } finally {
      setLoading(false);
    }
  }

  async function detectAdb(): Promise<void> {
    setLoading(true);
    onError(null);
    try {
      const status = await getAdbStatus();
      setAdbStatus(status);
      setAdbDevices(status.devices);
      const firstUsable = status.devices.find((device) => device.state === "device");
      setSelectedAdbSerial((current) => current || firstUsable?.serial || "");
      appendOperation(
        `ADB 检测完成: ${status.devices.length} 台设备 / ${
          status.ok ? "可用" : "需处理授权或环境"
        }`,
      );
      if (!status.ok) {
        onError(status.diagnostics.map((item) => item.message).join("\n"));
      }
    } catch (cause) {
      const message =
        cause instanceof TypeError
          ? "ADB 辅助服务未启动。请用“启动工具.cmd”启动，或单独运行 pnpm run adb-helper。"
          : cause instanceof Error
            ? cause.message
            : "ADB 检测失败";
      appendOperation(`ADB 检测失败: ${message}`);
      onError(message);
    } finally {
      setLoading(false);
    }
  }

  async function connectAdb(): Promise<void> {
    const serial =
      selectedAdbSerial ||
      adbDevices.find((device) => device.state === "device")?.serial ||
      "";
    if (!serial) {
      onError("请先检测 ADB 设备，并选择已授权设备。");
      return;
    }

    setLoading(true);
    onError(null);
    try {
      const nextClient = await createAdbApiClient(serial);
      const nextSnapshots = await nextClient.getSnapshots();
      setAdbClient(nextClient);
      setClient(null);
      setConnectMode("adb");
      setSnapshots(nextSnapshots);
      appendOperation(`ADB 读取快照成功: ${nextSnapshots.length} 条`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "ADB 读取快照失败";
      appendOperation(`ADB 读取快照失败: ${message}`);
      onError(message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshSnapshots(): Promise<void> {
    const activeClient = connectMode === "adb" ? adbClient : client;
    if (!activeClient) {
      if (connectMode === "adb") {
        await connectAdb();
      } else {
        await connect();
      }
      return;
    }

    setLoading(true);
    onError(null);
    try {
      const nextSnapshots = await activeClient.getSnapshots();
      setSnapshots(nextSnapshots);
      appendOperation(`刷新快照成功: ${nextSnapshots.length} 条`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "刷新快照失败";
      appendOperation(`刷新快照失败: ${message}`);
      onError(message);
    } finally {
      setLoading(false);
    }
  }

  async function captureSnapshot(): Promise<void> {
    if (!client) return;

    setLoading(true);
    onError(null);
    try {
      const snapshot = await client.captureSnapshot();
      setSnapshots(await client.getSnapshots());
      appendOperation(`捕获快照成功: ${snapshot.id}`);
      await openSnapshot(snapshot.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "捕获快照失败";
      appendOperation(`捕获快照失败: ${message}`);
      onError(message);
    } finally {
      setLoading(false);
    }
  }

  async function openSnapshot(id: number): Promise<void> {
    const activeClient = connectMode === "adb" ? adbClient : client;
    if (!activeClient) return;

    setOpeningId(id);
    onError(null);
    try {
      onOpenSnapshot(await activeClient.loadSnapshot(id));
      appendOperation(`打开快照成功: ${id}`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "加载快照失败";
      appendOperation(`打开快照失败: ${id} / ${message}`);
      onError(message);
    } finally {
      setOpeningId(null);
    }
  }

  async function openSelectedSnapshotsAsFlow(): Promise<void> {
    const activeClient = connectMode === "adb" ? adbClient : client;
    if (!activeClient || selectedSnapshotIds.size === 0) return;

    setOpeningFlow(true);
    onError(null);
    try {
      const selectedIds = getSelectedFlowSnapshotIds(snapshots, selectedSnapshotIds);
      const loadedSnapshots: ParsedGkdSnapshot[] = [];
      for (const id of selectedIds) {
        loadedSnapshots.push(await activeClient.loadSnapshot(id));
      }
      onOpenSnapshotsAsFlow(loadedSnapshots);
      appendOperation(`创建流程成功: ${loadedSnapshots.length} 个快照`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "创建流程失败";
      appendOperation(`创建流程失败: ${message}`);
      onError(message);
    } finally {
      setOpeningFlow(false);
    }
  }

  function toggleSnapshotSelected(id: number): void {
    setSelectedSnapshotIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAllFilteredSnapshots(): void {
    setSelectedSnapshotIds((current) => {
      const filteredIds = filteredSnapshots.map((snapshot) => snapshot.id);
      const allSelected =
        filteredIds.length > 0 && filteredIds.every((id) => current.has(id));
      if (allSelected) {
        const next = new Set(current);
        filteredIds.forEach((id) => next.delete(id));
        return next;
      }
      return new Set([...current, ...filteredIds]);
    });
  }

  async function runDiagnostics(): Promise<void> {
    setTesting(true);
    onError(null);
    try {
      const result = await runDeviceDiagnostics(deviceUrl);
      setDiagnostics(result);
      appendOperation(
        `连接诊断完成: ${result.filter((step) => step.status === "pass").length}/${
          result.length
        } 通过`,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "诊断失败";
      appendOperation(`连接诊断失败: ${message}`);
      onError(message);
    } finally {
      setTesting(false);
    }
  }

  async function testDeviceAddresses(): Promise<void> {
    const origins = extractDeviceOrigins(deviceUrl);
    if (origins.length === 0) {
      onError("没有识别到可测试的设备地址");
      return;
    }

    setTesting(true);
    onError(null);
    try {
      const results = await Promise.all(
        origins.map((origin) => probeDeviceOrigin(origin)),
      );
      setAddressProbes(results);
      const best = results.find((result) => result.status === "pass");
      if (best) {
        setDeviceUrl(best.origin);
        localStorage.setItem("gkd-rule-builder-device-url", best.origin);
        appendOperation(
          `地址测试完成: 自动选择 ${best.origin} / ${best.channel ?? "unknown"}`,
        );
      } else {
        appendOperation(`地址测试完成: ${results.length} 个地址都不可用`);
      }
    } finally {
      setTesting(false);
    }
  }

  async function copyDiagnostics(): Promise<void> {
    const lines = [
      `deviceUrl: ${deviceUrl}`,
      ...addressProbes.map((probe) => {
        return `[${probe.status}] 地址测试 ${probe.origin} (${probe.durationMs}ms): ${
          probe.channel ? `${probe.channel} / ` : ""
        }${probe.detail}`;
      }),
      ...diagnostics.map((step) => {
        const duration = step.durationMs === undefined ? "" : ` (${step.durationMs}ms)`;
        return `[${step.status}] ${step.name}${duration}: ${step.detail}`;
      }),
      ...(adbStatus?.diagnostics.map((item) => {
        return `[${item.status}] ADB: ${item.message}`;
      }) ?? []),
      ...operationLog.map((line) => `[operation] ${line}`),
    ];
    await navigator.clipboard.writeText(lines.join("\n"));
  }

  function appendOperation(message: string): void {
    setOperationLog((current) => [
      `${new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })} ${message}`,
      ...current,
    ].slice(0, 12));
  }

  return (
    <section className="home-shell">
      <header className="home-topbar">
        <div className="brand-block">
          <div className="brand-mark">G</div>
          <div>
            <h1>GKD Rule Studio</h1>
            <p>在 GKD 审查工具流程上增加规则生成、验证和写入订阅仓库。</p>
          </div>
        </div>
        <div className="top-actions">
          <SnapshotLoader loading={loadingFile} onFileSelected={onFileSelected} />
          <button className="header-button" type="button" onClick={onOpenSettings}>
            <Settings size={16} />
            <span>设置</span>
          </button>
        </div>
      </header>

      <div className="home-status-strip" aria-label="首页状态概览">
        <div>
          <span>连接方式</span>
          <strong>{connectMode === "http" ? "HTTP 服务" : "ADB 数据线"}</strong>
        </div>
        <div>
          <span>可用快照</span>
          <strong>{snapshots.length}</strong>
        </div>
        <div>
          <span>已选流程快照</span>
          <strong>{selectedSnapshotIds.size}</strong>
        </div>
        <div>
          <span>设备状态</span>
          <strong>{client || adbClient ? "已连接" : "待连接"}</strong>
        </div>
      </div>

      <div className="home-grid">
        <section className="panel home-connect-panel">
          <div className="panel-title-row">
            <div className="panel-heading">
              <h2>连接手机</h2>
              <p className="panel-subtitle">
                HTTP 服务不稳定时，可以用 USB 数据线 + ADB 读取手机上保存的快照。
              </p>
            </div>
            <span
              className={
                client || adbClient ? "status-badge success" : "status-badge muted"
              }
            >
              {client ? "HTTP 已连接" : adbClient ? "ADB 已连接" : "未连接"}
            </span>
          </div>
          <div className="mode-switch home-mode-switch" aria-label="连接方式">
            <button
              className={connectMode === "http" ? "mode-switch-active" : ""}
              type="button"
              onClick={() => setConnectMode("http")}
            >
              HTTP 服务
            </button>
            <button
              className={connectMode === "adb" ? "mode-switch-active" : ""}
              type="button"
              onClick={() => setConnectMode("adb")}
            >
              ADB 数据线
            </button>
          </div>

          {connectMode === "http" ? (
            <>
              <div className="home-device-form">
                <input
                  placeholder="可粘贴多个地址，例如 192.168.1.23:8080 192.168.49.1:8888"
                  value={deviceUrl}
                  onChange={(event) => setDeviceUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void connect();
                  }}
                />
                <button
                  className="header-button"
                  disabled={loading}
                  type="button"
                  onClick={() => void connect()}
                >
                  <Smartphone size={15} />
                  <span>连接 / 刷新</span>
                </button>
              </div>
              <div className="home-actions-row">
                <button
                  className="wide-button"
                  disabled={testing}
                  type="button"
                  onClick={() => void testDeviceAddresses()}
                >
                  <Stethoscope size={15} />
                  批量测试地址
                </button>
                <button
                  className="wide-button"
                  disabled={testing}
                  type="button"
                  onClick={() => void runDiagnostics()}
                >
                  <Stethoscope size={15} />
                  连接诊断
                </button>
              </div>
            </>
          ) : (
            <div className="device-grid">
              <div className="home-actions-row">
                <button
                  className="wide-button"
                  disabled={loading}
                  type="button"
                  onClick={() => void detectAdb()}
                >
                  <Stethoscope size={15} />
                  检测 ADB
                </button>
                <button
                  className="wide-button primary-button"
                  disabled={loading || !selectedAdbSerial}
                  type="button"
                  onClick={() => void connectAdb()}
                >
                  <Smartphone size={15} />
                  读取快照
                </button>
              </div>
              <label>
                <span>ADB 设备</span>
                <select
                  value={selectedAdbSerial}
                  onChange={(event) => setSelectedAdbSerial(event.target.value)}
                >
                  <option value="">请选择设备</option>
                  {adbDevices.map((device) => (
                    <option key={device.serial} value={device.serial}>
                      {device.serial} · {device.state}
                      {device.model ? ` · ${device.model}` : ""}
                    </option>
                  ))}
                </select>
                <small>
                  需要先开启 USB 调试并在手机弹窗允许授权；ADB 只读取已保存的
                  GKD 快照。
                </small>
              </label>
              {adbStatus && (
                <div className="diagnostics-list">
                  {adbStatus.diagnostics.map((item) => (
                    <div key={item.message} className="diagnostic-row">
                      <span className={`diagnostic-dot diagnostic-${item.status}`} />
                      <div>
                        <strong>ADB</strong>
                        <p>{item.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {(client || adbClient) && (
            <>
              <div className="device-status">
                {formatServerTitle((adbClient ?? client)!.serverInfo)}
              </div>
              <div className="home-actions-row">
                <button
                  className="wide-button"
                  disabled={loading}
                  type="button"
                  onClick={() => void refreshSnapshots()}
                >
                  <RefreshCw size={15} />
                  刷新快照
                </button>
                {client && (
                  <button
                    className="wide-button primary-button"
                    disabled={loading}
                    type="button"
                    onClick={() => void captureSnapshot()}
                  >
                    <Camera size={15} />
                    捕获当前界面
                  </button>
                )}
              </div>
            </>
          )}
          <div className="home-actions-row">
            <button
              className="wide-button"
              disabled={
                addressProbes.length === 0 &&
                diagnostics.length === 0 &&
                operationLog.length === 0 &&
                !adbStatus
              }
              type="button"
              onClick={() => void copyDiagnostics()}
            >
              <ClipboardCopy size={15} />
              复制诊断结果
            </button>
          </div>
          {(diagnostics.length > 0 || operationLog.length > 0) && (
            <DeviceDiagnosticsPanel
              addressProbes={addressProbes}
              diagnostics={diagnostics}
              operationLog={operationLog}
            />
          )}
        </section>

        <section className="panel home-guide-panel">
          <h2>工作流</h2>
          <div className="workflow-list">
            <span>连接手机或导入 zip</span>
            <span>选择一个快照进入工作区</span>
            <span>点击截图目标节点</span>
            <span>生成 selector 和 JSON5 规则</span>
            <span>写入订阅仓库并按需撤回</span>
          </div>
        </section>
      </div>

      <section className="panel home-snapshot-panel">
        <div className="panel-title-row">
          <div className="panel-heading">
            <h2>快照列表</h2>
            <p className="panel-subtitle">
              单个快照可直接进入工作区；多步骤规则可先勾选多个快照创建流程。
            </p>
          </div>
          <div className="panel-header-actions">
            <span className="status-badge neutral">{filteredSnapshots.length} 条</span>
            <button
              className="copy-button primary-button"
              disabled={!canCreateFlow}
              type="button"
              onClick={() => void openSelectedSnapshotsAsFlow()}
            >
              创建流程 ({selectedSnapshotIds.size})
            </button>
          </div>
        </div>
        <div className="home-search-row">
          <Search size={15} />
          <input
            placeholder="搜索应用名称、包名或 Activity"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {filteredSnapshots.length === 0 ? (
          <div className="empty-state">
            {client ? "手机上暂时没有可用快照" : "先连接手机，或拖入 / 导入快照 zip"}
          </div>
        ) : (
          <div className="snapshot-table">
            <div className="snapshot-row snapshot-head">
              <span className="snapshot-select-cell">
                <input
                  aria-label="选择当前筛选快照"
                  checked={
                    filteredSnapshots.length > 0 &&
                    filteredSnapshots.every((snapshot) =>
                      selectedSnapshotIds.has(snapshot.id),
                    )
                  }
                  type="checkbox"
                  onChange={toggleAllFilteredSnapshots}
                />
              </span>
              <span>时间</span>
              <span>应用</span>
              <span>包名</span>
              <span>Activity</span>
              <span>操作</span>
            </div>
            {filteredSnapshots.map((snapshot) => (
              <div
                key={snapshot.id}
                className="snapshot-row snapshot-data-row"
              >
                <span className="snapshot-select-cell">
                  <input
                    aria-label={`选择快照 ${snapshot.id}`}
                    checked={selectedSnapshotIds.has(snapshot.id)}
                    disabled={openingId !== null || openingFlow}
                    type="checkbox"
                    onChange={() => toggleSnapshotSelected(snapshot.id)}
                  />
                </span>
                <span>{formatSnapshotTime(snapshot.id)}</span>
                <strong>{snapshot.appInfo?.name ?? snapshot.appName ?? "-"}</strong>
                <code>{snapshot.appId}</code>
                <code>{shortActivity(snapshot.activityId)}</code>
                <button
                  className="snapshot-open-cell snapshot-open-button"
                  disabled={openingId !== null || openingFlow}
                  type="button"
                  onClick={() => void openSnapshot(snapshot.id)}
                >
                  {openingId === snapshot.id ? "加载中" : "进入"}
                  <ChevronRight size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

async function resolveConnectOrigin(
  input: string,
  onProbes: (results: DeviceAddressProbe[]) => void,
): Promise<string> {
  const origins = extractDeviceOrigins(input);
  if (origins.length <= 1) {
    return origins[0] ?? input;
  }

  const results = await Promise.all(origins.map((origin) => probeDeviceOrigin(origin)));
  onProbes(results);
  const best = results.find((result) => result.status === "pass");
  if (!best) {
    throw new Error("粘贴的多个设备地址都无法连接，请先运行批量测试地址查看原因。");
  }

  return best.origin;
}

function DeviceDiagnosticsPanel({
  addressProbes,
  diagnostics,
  operationLog,
}: {
  addressProbes: DeviceAddressProbe[];
  diagnostics: DeviceDiagnosticStep[];
  operationLog: string[];
}) {
  return (
    <div className="diagnostics-panel">
      {addressProbes.length > 0 && (
        <div className="diagnostics-list">
          {addressProbes.map((probe) => (
            <div key={probe.origin} className="diagnostic-row">
              <span className={`diagnostic-dot diagnostic-${probe.status}`} />
              <div>
                <strong>{probe.origin}</strong>
                <p>
                  {probe.channel ? `${probe.channel} / ` : ""}
                  {probe.detail}
                </p>
              </div>
              <code>{probe.durationMs}ms</code>
            </div>
          ))}
        </div>
      )}
      {diagnostics.length > 0 && (
        <div className="diagnostics-list">
          {diagnostics.map((step) => (
            <div key={step.id} className="diagnostic-row">
              <span className={`diagnostic-dot diagnostic-${step.status}`} />
              <div>
                <strong>{step.name}</strong>
                <p>{step.detail}</p>
              </div>
              {step.durationMs !== undefined && <code>{step.durationMs}ms</code>}
            </div>
          ))}
        </div>
      )}
      {operationLog.length > 0 && (
        <div className="operation-log">
          <span>操作记录</span>
          {operationLog.map((line) => (
            <code key={line}>{line}</code>
          ))}
        </div>
      )}
    </div>
  );
}

function formatSnapshotTime(id: number): string {
  const date = new Date(id);
  if (Number.isNaN(date.getTime())) return String(id);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortActivity(activityId: string): string {
  return activityId.split(".").slice(-2).join(".");
}
