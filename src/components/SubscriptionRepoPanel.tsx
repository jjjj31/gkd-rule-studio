/** 桌面版订阅仓库面板：把规则写入本地 GKD 订阅仓库的文件系统。安卓版无此功能。 */
import { Check, GitBranch, RotateCcw, UploadCloud } from "lucide-react";
import { useState } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import {
  selectFallbackCandidates,
} from "../lib/ruleDraft";
import {
  isFileSystemAccessSupported,
  loadImportHistory,
  pickSubscriptionRepo,
  rollbackImportRecord,
  saveImportHistory,
  updateSubscriptionRule,
  type ConnectedSubscriptionRepo,
  type SubscriptionImportRecord,
} from "../lib/subscriptionRepo";
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { SelectorCandidate } from "../types/ruleDraft";

interface SubscriptionRepoPanelProps {
  snapshot: ParsedGkdSnapshot | null;
  candidate: SelectorCandidate | null;
  candidates?: SelectorCandidate[];
}

export function SubscriptionRepoPanel({
  snapshot,
  candidate,
  candidates = [],
}: SubscriptionRepoPanelProps) {
  const [repo, setRepo] = useState<ConnectedSubscriptionRepo | null>(null);
  const [history, setHistory] = useState<SubscriptionImportRecord[]>(
    () => loadImportHistory(),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const supported = isFileSystemAccessSupported();

  async function connectRepo(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const nextRepo = await pickSubscriptionRepo();
      setRepo(nextRepo);
      setMessage(`已连接 ${nextRepo.name}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "连接订阅仓库失败");
    } finally {
      setBusy(false);
    }
  }

  async function writeCurrentRule(): Promise<void> {
    if (!repo || !snapshot || !candidate) return;

    setBusy(true);
    setMessage(null);
    try {
      const result = await updateSubscriptionRule({
        repo,
        snapshot,
        candidate,
        fallbackCandidates: selectFallbackCandidates(candidate, candidates),
      });
      const nextHistory = [result.record, ...history].slice(0, 30);
      setHistory(nextHistory);
      saveImportHistory(nextHistory);
      setMessage(
        `${result.action === "create" ? "已创建" : "已追加"} ${result.filePath}`,
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "写入订阅仓库失败");
    } finally {
      setBusy(false);
    }
  }

  async function rollbackRecord(record: SubscriptionImportRecord): Promise<void> {
    if (!repo || record.revertedAt) return;
    const confirmed = window.confirm(
      `撤回这次导入？\n${record.filePath}\n${record.groupName}`,
    );
    if (!confirmed) return;

    setBusy(true);
    setMessage(null);
    try {
      const reverted = await rollbackImportRecord(repo, record);
      const nextHistory = history.map((item) =>
        item.id === record.id ? reverted : item,
      );
      setHistory(nextHistory);
      saveImportHistory(nextHistory);
      setMessage(`已撤回 ${record.filePath}`);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "撤回失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CollapsiblePanel
      actions={
        repo ? (
          <span className="status-badge success">
            <Check size={13} />
            {repo.name}
          </span>
        ) : (
          <span className="status-badge muted">未连接</span>
        )
      }
      className="subscription-panel"
      title="订阅仓库"
    >
      <div className="repo-guide">
        <strong>写入要求</strong>
        <span>Windows 便携版请用 Edge / Chrome 打开本机地址。</span>
        <span>连接时选择订阅仓库根目录，需要包含 package.json 和 src/apps。</span>
      </div>

      <div className="repo-actions">
        <button
          className="wide-button"
          disabled={!supported || busy}
          type="button"
          onClick={() => void connectRepo()}
        >
          <GitBranch size={15} />
          连接本地订阅仓库
        </button>
        <button
          className="wide-button primary-button"
          disabled={!repo || !snapshot || !candidate || busy}
          type="button"
          onClick={() => void writeCurrentRule()}
        >
          <UploadCloud size={15} />
          写入当前规则
        </button>
      </div>

      {!supported && (
        <p className="repo-message repo-error">
          当前浏览器不支持目录写入，需要在 Windows 上使用 Chromium / Edge，并通过
          127.0.0.1 本地地址打开工具。
        </p>
      )}
      {message && <p className="repo-message">{message}</p>}

      <div className="history-block">
        <div className="history-title">
          <span>历史导入记录</span>
          <span>{history.length}</span>
        </div>
        {history.length === 0 ? (
          <p className="muted">暂无记录</p>
        ) : (
          <div className="history-list">
            {history.map((record) => (
              <article
                key={record.id}
                className={[
                  "history-item",
                  record.revertedAt ? "history-reverted" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <div className="history-main">
                  <strong>{record.groupName}</strong>
                  <span>{record.appName}</span>
                  <code>{record.filePath}</code>
                  <small>
                    {formatTime(record.createdAt)} / {formatAction(record.action)} / score{" "}
                    {record.score}
                  </small>
                </div>
                <button
                  className="copy-button"
                  disabled={!repo || busy || Boolean(record.revertedAt)}
                  type="button"
                  onClick={() => void rollbackRecord(record)}
                >
                  <RotateCcw size={14} />
                  <span>{record.revertedAt ? "已撤回" : "撤回"}</span>
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </CollapsiblePanel>
  );
}

function formatAction(action: SubscriptionImportRecord["action"]): string {
  return action === "create" ? "新建" : "追加";
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
