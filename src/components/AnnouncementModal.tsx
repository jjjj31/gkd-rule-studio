import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Download,
  Megaphone,
  Sparkles,
  X,
} from "lucide-react";
import {
  type Announcement,
  announcementToUpdateManifest,
  parseTextWithLinks,
  setStoredLastReadId,
} from "../lib/announcement";
import {
  type DownloadProgress,
  UpdateBridgeError,
  downloadApk,
  hasInstallPermission,
  installApk,
  openInstallSettings,
} from "../lib/androidUpdater";
import "./AnnouncementModal.css";

interface AnnouncementModalProps {
  announcement: Announcement;
  onClose: () => void;
  onAcknowledge?: (announcement: Announcement) => void;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function AnnouncementModal({
  announcement,
  onClose,
  onAcknowledge,
}: AnnouncementModalProps) {
  const isUpdate = announcement.type === "update";
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const isAndroidBridgeAvailable =
    typeof window !== "undefined" &&
    typeof window.GkdAndroidBridge?.getAppUpdateInfo === "function";

  // 键盘 Esc 关闭监听
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !announcement.forced && !downloading) {
        handleDismiss();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [announcement.forced, downloading]);

  function handleDismiss() {
    setStoredLastReadId(announcement.id);
    onAcknowledge?.(announcement);
    onClose();
  }

  async function handleStartUpdate() {
    if (!isAndroidBridgeAvailable) {
      if (announcement.apkUrl) {
        window.open(announcement.apkUrl, "_blank", "noopener,noreferrer");
      }
      handleDismiss();
      return;
    }

    // 启动下载
    setDownloading(true);
    setErrorMessage(null);
    setProgress(null);
    setPermissionDenied(false);

    try {
      const manifest = announcementToUpdateManifest(announcement);
      const path = await downloadApk(manifest, (p) => {
        setProgress({ ...p });
      });
      setDownloadedPath(path);
      setDownloading(false);

      // 下载完成，检查安装权限并尝试安装
      const hasPerm = await hasInstallPermission();
      if (!hasPerm) {
        setPermissionDenied(true);
        return;
      }
      await installApk(path);
      handleDismiss();
    } catch (err) {
      setDownloading(false);
      if (err instanceof UpdateBridgeError && err.needPermission) {
        setPermissionDenied(true);
      } else {
        setErrorMessage(err instanceof Error ? err.message : "下载或安装失败，请检查网络后重试");
      }
    }
  }

  async function handleRetryInstall() {
    if (!downloadedPath) {
      void handleStartUpdate();
      return;
    }
    try {
      const hasPerm = await hasInstallPermission();
      if (!hasPerm) {
        await openInstallSettings();
        return;
      }
      await installApk(downloadedPath);
      handleDismiss();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "安装失败");
    }
  }

  const tokens = parseTextWithLinks(announcement.content);

  return (
    <div
      className="announcement-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="announcement-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !announcement.forced && !downloading) {
          handleDismiss();
        }
      }}
    >
      <div className="announcement-modal-dialog">
        <div className="announcement-modal-head">
          <div className="announcement-modal-title-row">
            <div className={`announcement-modal-icon-badge ${isUpdate ? "update" : "notice"}`}>
              {isUpdate ? <Sparkles size={20} /> : <Megaphone size={20} />}
            </div>
            <div className="announcement-modal-title-text">
              <h2 id="announcement-title">{announcement.title}</h2>
              <div className="announcement-modal-badges">
                {isUpdate && announcement.versionName && (
                  <span className="announcement-tag update">
                    v{announcement.versionName}
                  </span>
                )}
                {announcement.forced && (
                  <span className="announcement-tag forced">重要通知</span>
                )}
                {announcement.updatedAt && (
                  <span className="announcement-tag time">{announcement.updatedAt}</span>
                )}
              </div>
            </div>
          </div>
          {!announcement.forced && !downloading && (
            <button
              aria-label="关闭公告"
              className="android-icon-button"
              type="button"
              onClick={handleDismiss}
            >
              <X size={18} />
            </button>
          )}
        </div>

        <div className="announcement-modal-body">
          {tokens.map((token, index) =>
            token.url ? (
              <a
                key={index}
                className="announcement-link"
                href={token.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {token.text}
              </a>
            ) : (
              <span key={index}>{token.text}</span>
            )
          )}
        </div>

        {downloading && (
          <div className="announcement-progress-container">
            <div className="announcement-progress-bar-bg">
              <div
                className="announcement-progress-bar-fill"
                style={{ width: `${Math.max(5, progress?.percent ?? 0)}%` }}
              />
            </div>
            <div className="announcement-progress-text">
              <span>
                {progress && progress.percent >= 0
                  ? `正在下载更新… ${progress.percent}%`
                  : "正在连接下载地址…"}
              </span>
              {progress && progress.total > 0 && (
                <span>
                  {formatBytes(progress.received)} / {formatBytes(progress.total)}
                </span>
              )}
            </div>
          </div>
        )}

        {errorMessage && (
          <div className="android-update-error" style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <AlertTriangle size={15} />
            <span>{errorMessage}</span>
          </div>
        )}

        {permissionDenied && (
          <div className="android-update-error" style={{ fontSize: 13 }}>
            <p>已下载完成，需要开启“允许安装未知来源应用”权限才能继续安装。</p>
          </div>
        )}

        <div className="announcement-modal-actions">
          {/* 附加自定义链接按钮 */}
          {announcement.actionUrl && !downloading && (
            <a
              className="announcement-btn announcement-btn-secondary"
              href={announcement.actionUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>{announcement.actionText || "查看详情"}</span>
              <ArrowUpRight size={14} />
            </a>
          )}

          {/* 权限被拒引导 */}
          {permissionDenied ? (
            <>
              {!announcement.forced && (
                <button
                  className="announcement-btn announcement-btn-secondary"
                  type="button"
                  onClick={handleDismiss}
                >
                  稍后再说
                </button>
              )}
              <button
                className="announcement-btn announcement-btn-primary"
                type="button"
                onClick={() => void handleRetryInstall()}
              >
                去开启安装权限
              </button>
            </>
          ) : isUpdate ? (
            <>
              {!announcement.forced && !downloading && (
                <button
                  className="announcement-btn announcement-btn-secondary"
                  type="button"
                  onClick={handleDismiss}
                >
                  稍后再说
                </button>
              )}
              <button
                className="announcement-btn announcement-btn-primary"
                type="button"
                disabled={downloading}
                onClick={() => void handleStartUpdate()}
              >
                <Download size={15} />
                <span>{downloading ? "正在下载…" : "立即更新"}</span>
              </button>
            </>
          ) : (
            <button
              className="announcement-btn announcement-btn-primary"
              type="button"
              onClick={handleDismiss}
            >
              我知道了
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
