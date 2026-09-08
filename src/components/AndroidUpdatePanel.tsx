import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, ShieldAlert, X } from "lucide-react";
import {
  type DownloadProgress,
  type UpdateManifest,
  UpdateBridgeError,
  downloadApk,
  fetchUpdateManifest,
  getAppVersionInfo,
  hasInstallPermission,
  installApk,
  isUpdateAvailable,
  openInstallSettings,
} from "../lib/androidUpdater";

type UpdatePhase =
  | "idle"
  | "checking"
  | "checkFailed"
  | "upToDate"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "installFailed"
  | "permissionDenied";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Android 软件内更新面板:检查 → 下载(含进度)→ 安装。
 * 首次打开会自动检查一次;下载完成后若未开"未知来源"权限,引导去系统设置。
 */
export default function AndroidUpdatePanel({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [currentName, setCurrentName] = useState("0.0.0");
  const [manifest, setManifest] = useState<UpdateManifest | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    void checkForUpdate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function checkForUpdate(): Promise<void> {
    setPhase("checking");
    setErrorMessage(null);
    try {
      const [info, remote] = await Promise.all([
        getAppVersionInfo(),
        fetchUpdateManifest(),
      ]);
      setCurrentName(info.versionName);
      if (isUpdateAvailable(remote, info)) {
        setManifest(remote);
        setPhase("available");
      } else {
        setPhase("upToDate");
      }
    } catch (cause) {
      setErrorMessage(
        cause instanceof UpdateBridgeError ? cause.message : "检查更新失败",
      );
      setPhase("checkFailed");
    }
  }

  async function startDownload(): Promise<void> {
    if (!manifest) return;
    setPhase("downloading");
    setProgress(null);
    setErrorMessage(null);
    try {
      const path = await downloadApk(manifest, (update) => {
        setProgress({ ...update });
      });
      setDownloadedPath(path);
      setPhase("downloaded");
    } catch (cause) {
      setErrorMessage(
        cause instanceof UpdateBridgeError ? cause.message : "下载失败",
      );
      setPhase("checkFailed");
    }
  }

  async function startInstall(): Promise<void> {
    if (!downloadedPath) return;
    setPhase("installing");
    setErrorMessage(null);
    try {
      const allowed = await hasInstallPermission();
      if (!allowed) {
        setPhase("permissionDenied");
        return;
      }
      await installApk(downloadedPath);
      // 安装器接管系统界面;回到 App 后由下次检查决定是否已是最新。
      onClose();
    } catch (cause) {
      if (cause instanceof UpdateBridgeError && cause.needPermission) {
        setPhase("permissionDenied");
      } else {
        setErrorMessage(
          cause instanceof UpdateBridgeError ? cause.message : "安装失败",
        );
        setPhase("installFailed");
      }
    }
  }

  function goInstall() {
    void startInstall();
  }

  const busy = phase === "checking" || phase === "downloading" || phase === "installing";

  return (
    <div className="android-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="android-dialog">
        <div className="android-dialog-head">
          <div>
            <h2>软件更新</h2>
            <span>
              当前版本 {currentName}
              {manifest ? ` · 最新版本 ${manifest.versionName}` : ""}
            </span>
          </div>
          {!busy && !manifest?.forced && (
            <button
              aria-label="关闭"
              className="android-icon-button"
              type="button"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          )}
        </div>

        {phase === "idle" && (
          <div className="android-update-body">
            <p>检查 GKD Rule Studio 是否有新版本。</p>
            <button
              className="android-button android-button-primary"
              type="button"
              onClick={() => void checkForUpdate()}
              disabled={busy}
            >
              <Download size={16} />
              检查更新
            </button>
          </div>
        )}

        {phase === "checking" && (
          <div className="android-update-body">
            <p>正在检查更新…</p>
          </div>
        )}

        {phase === "checkFailed" && (
          <div className="android-update-body">
            <p className="android-update-error">
              <AlertTriangle size={14} />
              {errorMessage ?? "检查更新失败"}
            </p>
            <button
              className="android-button"
              type="button"
              onClick={() => void checkForUpdate()}
            >
              重试
            </button>
          </div>
        )}

        {phase === "upToDate" && (
          <div className="android-update-body">
            <p>已是最新版本。</p>
          </div>
        )}

        {phase === "available" && manifest && (
          <div className="android-update-body">
            {manifest.notes ? (
              <pre className="android-update-notes">{manifest.notes}</pre>
            ) : (
              <p>发现新版本 {manifest.versionName}。</p>
            )}
            <div className="android-update-actions">
              <button
                className="android-button android-button-primary"
                type="button"
                onClick={() => void startDownload()}
              >
                <Download size={16} />
                下载并安装
              </button>
            </div>
          </div>
        )}

        {phase === "downloading" && (
          <div className="android-update-body">
            <p>
              正在下载…{progress && progress.percent >= 0
                ? ` ${progress.percent}%`
                : ""}
            </p>
            {progress && (
              <div className="android-progress-track">
                <div
                  className={
                    progress.percent >= 0
                      ? "android-progress-fill"
                      : "android-progress-fill android-progress-indeterminate"
                  }
                  style={
                    progress.percent >= 0
                      ? { width: `${progress.percent}%` }
                      : undefined
                  }
                />
              </div>
            )}
            {progress && (
              <span className="android-update-meta">
                {formatBytes(progress.received)}
                {progress.total > 0
                  ? ` / ${formatBytes(progress.total)}`
                  : ""}
              </span>
            )}
          </div>
        )}

        {phase === "downloaded" && (
          <div className="android-update-body">
            <p>下载完成,校验通过。</p>
            <button
              className="android-button android-button-primary"
              type="button"
              onClick={goInstall}
            >
              <Download size={16} />
              立即安装
            </button>
          </div>
        )}

        {phase === "installing" && (
          <div className="android-update-body">
            <p>正在请求安装…</p>
          </div>
        )}

        {phase === "installFailed" && (
          <div className="android-update-body">
            <p className="android-update-error">
              <AlertTriangle size={14} />
              {errorMessage ?? "安装失败"}
            </p>
            <button
              className="android-button"
              type="button"
              onClick={goInstall}
            >
              重试
            </button>
          </div>
        )}

        {phase === "permissionDenied" && (
          <div className="android-update-body">
            <p className="android-update-error">
              <ShieldAlert size={14} />
              需要允许本应用"安装未知应用",才能完成更新。
            </p>
            <div className="android-update-actions">
              <button
                className="android-button"
                type="button"
                onClick={() => openInstallSettings()}
              >
                去系统设置开启
              </button>
              <button
                className="android-button android-button-primary"
                type="button"
                onClick={goInstall}
              >
                已开启,继续安装
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}