import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  HelpCircle,
  RefreshCw,
  ShieldAlert,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  deleteSkipCaptures,
  describeClicked,
  exportSkipCaptures,
  formatBytes,
  formatCapturedAt,
  getSkipCapture,
  getSkipCaptureStatus,
  hasSkipCaptureBridge,
  listSkipCaptures,
  openSkipCaptureSettings,
  outcomeLabel,
  reasonLabel,
  setSkipCaptureEnabled,
  setSkipCaptureScreenshots,
  summarizeSnapshot,
  type SkipCaptureDetail,
  type SkipCaptureStatus,
  type SkipCaptureSummary,
} from "../lib/skipCapture";
import type { GkdTargetChannel } from "../lib/gkdTarget";
import "./SkipCapturePanel.css";

/**
 * 手机端“跳过记录”面板：打开记录、查看命中详情、导出给工作站生成规则。
 * 只展示本机数据，不上传。
 */
export function SkipCapturePanel({
  onClose,
  gkdChannel,
}: {
  onClose: () => void;
  gkdChannel: GkdTargetChannel;
}) {
  const supported = hasSkipCaptureBridge();
  const [status, setStatus] = useState<SkipCaptureStatus | null>(null);
  const [items, setItems] = useState<SkipCaptureSummary[]>([]);
  const [detail, setDetail] = useState<SkipCaptureDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    setError("");
    try {
      const [nextStatus, nextItems] = await Promise.all([
        getSkipCaptureStatus(),
        listSkipCaptures(0, 60),
      ]);
      setStatus(nextStatus);
      setItems(nextItems);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }, [supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 从系统设置启用无障碍服务后返回，自动刷新状态。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const toggleEnabled = async () => {
    if (!status) return;
    setBusy(true);
    setError("");
    try {
      const next = await setSkipCaptureEnabled(!status.enabled);
      setStatus(next);
      if (!next.enabled) {
        setNotice("记录已关闭");
      } else if (!next.serviceConnected) {
        setNotice("已打开记录开关，还需要在系统设置里启用无障碍服务");
      } else {
        setNotice("记录已开启，去其他应用里正常关闭一次广告试试");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const toggleScreenshots = async () => {
    if (!status) return;
    setBusy(true);
    try {
      setStatus(await setSkipCaptureScreenshots(!status.screenshots));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (item: SkipCaptureSummary) => {
    setBusy(true);
    setError("");
    try {
      setDetail(await getSkipCapture(item.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取详情失败");
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await exportSkipCaptures(300, gkdChannel);
      setNotice(`已导出 ${formatBytes(result.bytes)} 到 ${result.path}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败");
    } finally {
      setBusy(false);
    }
  };

  const clearAll = async () => {
    if (!window.confirm("清空本机所有跳过记录？导出过的文件不受影响。")) return;
    setBusy(true);
    setError("");
    try {
      const deleted = await deleteSkipCaptures();
      setNotice(`已清空 ${deleted} 条记录`);
      setDetail(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "清空失败");
    } finally {
      setBusy(false);
    }
  };

  const copySnapshot = async () => {
    if (!detail?.before) return;
    const text = JSON.stringify(detail.before, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制点击前快照 JSON");
    } catch {
      window.GkdAndroidBridge?.copyToClipboard?.(text);
      setNotice("已复制点击前快照 JSON");
    }
  };

  if (!supported) {
    return (
      <section className="skip-capture">
        <Header onClose={onClose} />
        <div className="android-empty">
          <HelpCircle size={18} />
          <strong>当前环境不支持</strong>
          <span>跳过记录只在 Android 版里可用。</span>
        </div>
      </section>
    );
  }

  return (
    <section className="skip-capture">
      <Header onClose={onClose} />

      <div className="skip-capture-card">
        <div className="skip-capture-status">
          <div>
            <strong>{status?.enabled ? "记录已开启" : "记录已关闭"}</strong>
            <span>
              {status?.serviceConnected
                ? "无障碍服务已连接"
                : "无障碍服务未连接，记录不会生效"}
            </span>
          </div>
          <button
            className={status?.enabled ? "skip-toggle skip-toggle-on" : "skip-toggle"}
            type="button"
            disabled={busy || !status}
            onClick={() => void toggleEnabled()}
          >
            {status?.enabled ? "关闭" : "开启"}
          </button>
        </div>

        {status && !status.serviceConnected && (
          <button
            className="skip-capture-primary"
            type="button"
            onClick={openSkipCaptureSettings}
          >
            <ShieldAlert size={15} />
            去系统设置启用无障碍服务
          </button>
        )}

        <p className="skip-capture-hint">
          如果开关是灰的，去“应用信息 → 右上角菜单 → 允许受限制的设置”再回来开启。
          只记录真实控件的点击，画布/网页广告可能抓不到；采集期间建议先关掉 GKD 的自动规则，
          避免把自动点击也记进来。
        </p>

        <div className="skip-capture-metrics">
          <span>记录 {status?.count ?? 0} 条</span>
          <span>占用 {formatBytes(status?.bytes ?? 0)}</span>
          <span>上限 {status?.maxRecords ?? 0} 条</span>
        </div>

        <label className="skip-capture-checkbox">
          <input
            checked={status?.screenshots ?? false}
            disabled={busy || !status}
            type="checkbox"
            onChange={() => void toggleScreenshots()}
          />
          同时保存截图（占用更大，但方便对照）
        </label>

        <div className="skip-capture-actions">
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            type="button"
            disabled={busy || !status?.count}
            onClick={() => void exportAll()}
          >
            <Download size={14} />
            导出
          </button>
          <button
            className="skip-capture-danger"
            type="button"
            disabled={busy || !status?.count}
            onClick={() => void clearAll()}
          >
            <Trash2 size={14} />
            清空
          </button>
        </div>

        {notice && <p className="skip-capture-notice">{notice}</p>}
        {error && <p className="skip-capture-error">{error}</p>}
      </div>

      {items.length === 0 ? (
        <div className="android-empty">
          <HelpCircle size={18} />
          <strong>还没有记录</strong>
          <span>开启后去应用里手动关一次广告，回来刷新看看。</span>
        </div>
      ) : (
        <ul className="skip-capture-list">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => void openDetail(item)}>
                <span className={`skip-outcome skip-outcome-${item.outcome}`}>
                  {item.outcome === "success" ? (
                    <CheckCircle2 size={14} />
                  ) : item.outcome === "failure" ? (
                    <XCircle size={14} />
                  ) : (
                    <HelpCircle size={14} />
                  )}
                  {outcomeLabel(item.outcome)}
                </span>
                <span className="skip-capture-app">{item.appLabel || item.packageName}</span>
                <span className="skip-capture-clicked">{describeClicked(item)}</span>
                <span className="skip-capture-time">{formatCapturedAt(item.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <div className="skip-capture-detail">
          <div className="skip-capture-detail-head">
            <strong>记录 #{detail.id}</strong>
            <button type="button" onClick={() => setDetail(null)}>
              关闭
            </button>
          </div>
          <dl>
            <dt>应用</dt>
            <dd>
              {detail.appLabel || detail.packageName}
              <small>{detail.packageName}</small>
            </dd>
            <dt>Activity</dt>
            <dd>{detail.activityId || "-"}</dd>
            <dt>点击控件</dt>
            <dd>
              {describeClicked(detail)}
              <small>{detail.clickedKey}</small>
            </dd>
            <dt>判定</dt>
            <dd>
              {outcomeLabel(detail.outcome)} · {reasonLabel(detail.reason)}
              <small>点击前来源：{detail.beforeSource || "-"}</small>
            </dd>
            <dt>点击前快照</dt>
            <dd>
              {summarizeSnapshot(detail.before)}
              {detail.hasBeforeScreenshot ? " · 有截图" : ""}
            </dd>
            <dt>点击后快照</dt>
            <dd>
              {summarizeSnapshot(detail.after)}
              {detail.hasAfterScreenshot ? " · 有截图" : ""}
            </dd>
          </dl>
          <button
            className="skip-capture-primary"
            type="button"
            disabled={!detail.before}
            onClick={() => void copySnapshot()}
          >
            复制点击前快照 JSON
          </button>
          <p className="skip-capture-hint">
            导出 zip 后放到电脑上，里面的快照格式与 GKD 快照一致，可直接用于生成规则。
          </p>
        </div>
      )}
    </section>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <header className="skip-capture-head">
      <button aria-label="返回" className="android-icon-button" type="button" onClick={onClose}>
        <ArrowLeft size={16} />
      </button>
      <div>
        <strong>跳过记录</strong>
        <span>抓真实点击，攒规则样本</span>
      </div>
    </header>
  );
}
