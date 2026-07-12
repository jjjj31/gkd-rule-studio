/** 内联测试管理面板（桌面版右侧）。显示当前所有 inline test items 的状态。安卓版同功能在 AndroidInlineTestManagerPage。 */
import {
  CheckCircle2,
  Circle,
  Clock,
  Filter,
  MessageSquare,
  Play,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import {
  buildActiveTestSubscription,
  createEmptyInlineRuleTestingState,
  deleteAiSession,
  deleteInlineTestItem,
  markInlineTestItemResult,
  type InlineAiSession,
  type InlineRuleTestItem,
  type InlineRuleTestingState,
  type InlineTestSource,
  type InlineTestStatus,
} from "../lib/inlineRuleTesting";
import type { TestSubscriptionDraft } from "../lib/testSubscription";

interface InlineTestingPanelProps {
  state: InlineRuleTestingState;
  mode: "single" | "flow";
  onStateChange: (state: InlineRuleTestingState) => void;
  onTestSubscriptionChange: (draft: TestSubscriptionDraft) => void;
}

type SourceFilter = "all" | InlineTestSource;

const SOURCE_LABELS: Record<InlineTestSource, string> = {
  "offline-selector": "离线候选",
  "ai-candidate": "AI 候选",
  flow: "流程",
};

const STATUS_LABELS: Record<InlineTestStatus, string> = {
  idle: "空闲",
  testing: "测试中",
  tested: "已测试",
  ended: "已结束",
  valid: "有效",
  invalid: "无效",
  mistouch: "误触",
  other: "其他",
};

const SOURCE_ORDER: InlineTestSource[] = [
  "offline-selector",
  "ai-candidate",
  "flow",
];

export function InlineTestingPanel({
  state,
  mode,
  onStateChange,
  onTestSubscriptionChange,
}: InlineTestingPanelProps) {
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [message, setMessage] = useState<string | null>(null);

  const stats = useMemo(() => {
    const items = state.items;
    return {
      total: items.length,
      testing: items.filter((item) => item.status === "testing").length,
      valid: items.filter(
        (item) => item.status === "valid" || item.status === "tested",
      ).length,
      invalid: items.filter(
        (item) => item.status === "invalid" || item.status === "mistouch",
      ).length,
    };
  }, [state.items]);

  const groupedItems = useMemo(() => {
    const filtered =
      sourceFilter === "all"
        ? state.items
        : state.items.filter((item) => item.source === sourceFilter);

    const groups = new Map<InlineTestSource, InlineRuleTestItem[]>();
    for (const source of SOURCE_ORDER) {
      const items = filtered.filter((item) => item.source === source);
      if (items.length > 0) {
        groups.set(source, items);
      }
    }
    return groups;
  }, [state.items, sourceFilter]);

  const relevantSessions = useMemo(() => {
    const activeItemSessionIds = new Set(
      state.items
        .filter((item) => item.status === "testing")
        .map((item) => item.aiSessionId)
        .filter(Boolean),
    );
    return state.aiSessions.filter(
      (session) =>
        session.mode === mode &&
        (activeItemSessionIds.has(session.id) ||
          session.candidateIds.some((id) =>
            state.items.some((item) => item.id === id && item.status === "testing"),
          )),
    );
  }, [state.items, state.aiSessions, mode]);

  function markResult(
    itemId: string,
    status: "valid" | "invalid" | "mistouch" | "other",
  ) {
    onStateChange(markInlineTestItemResult(state, itemId, status));
  }

  function removeItem(itemId: string) {
    onStateChange(deleteInlineTestItem(state, itemId));
  }

  function removeSession(sessionId: string) {
    onStateChange(deleteAiSession(state, sessionId));
  }

  function buildTestSubscription() {
    const draft = buildActiveTestSubscription(state);
    if (draft.apps.length === 0) {
      setMessage("没有处于测试中的项目可编译。");
      return;
    }
    onTestSubscriptionChange(draft);
    setMessage(
      `已编译 ${draft.apps.length} 个应用的测试订阅，包含 ${draft.apps.reduce((s, a) => s + a.groups.reduce((g, r) => g + r.rules.length, 0), 0)} 条规则。`,
    );
  }

  function clearAll() {
    onStateChange(createEmptyInlineRuleTestingState());
    setMessage("已清空所有内联测试项目。");
  }

  return (
    <CollapsiblePanel
      actions={
        <div className="preview-actions">
          <button
            className="copy-button"
            disabled={stats.testing === 0}
            type="button"
            onClick={buildTestSubscription}
          >
            <Play size={15} />
            <span>编译测试订阅 ({stats.testing})</span>
          </button>
          <button
            className="copy-button"
            disabled={state.items.length === 0}
            type="button"
            onClick={clearAll}
          >
            <Trash2 size={15} />
            <span>清空</span>
          </button>
        </div>
      }
      className="test-subscription-panel"
      defaultCollapsed={state.items.length === 0 && state.aiSessions.length === 0}
      title="内联规则测试"
    >
      <div className="test-zone-summary">
        <span>
          <small>总项目</small>
          <strong>{stats.total}</strong>
        </span>
        <span>
          <small>测试中</small>
          <strong>{stats.testing}</strong>
        </span>
        <span>
          <small>有效</small>
          <strong>{stats.valid}</strong>
        </span>
        <span>
          <small>无效/误触</small>
          <strong>{stats.invalid}</strong>
        </span>
      </div>

      {message && <p className="test-zone-message">{message}</p>}

      <div className="inline-test-filter-row">
        <Filter size={13} />
        <button
          className={`inline-test-filter-chip${sourceFilter === "all" ? " active" : ""}`}
          type="button"
          onClick={() => setSourceFilter("all")}
        >
          全部
        </button>
        {SOURCE_ORDER.map((source) => (
          <button
            key={source}
            className={`inline-test-filter-chip${sourceFilter === source ? " active" : ""}`}
            type="button"
            onClick={() => setSourceFilter(source)}
          >
            {SOURCE_LABELS[source]}
          </button>
        ))}
      </div>

      {groupedItems.size === 0 ? (
        <p className="muted">还没有内联测试项目。</p>
      ) : (
        <div className="inline-test-list manager">
          {SOURCE_ORDER.map((source) => {
            const items = groupedItems.get(source);
            if (!items) return null;
            return (
              <section key={source} className="inline-test-group">
                <div className="inline-test-group-header">
                  <strong>{SOURCE_LABELS[source]}</strong>
                  <small>{items.length} 项</small>
                </div>
                {items.map((item) => (
                  <InlineTestItemRow
                    key={item.id}
                    item={item}
                    onMarkResult={markResult}
                    onRemove={removeItem}
                  />
                ))}
              </section>
            );
          })}
        </div>
      )}

      {relevantSessions.length > 0 && (
        <section className="test-zone-imported">
          <div className="test-zone-section-title">
            <strong>AI 会话</strong>
            <small>{relevantSessions.length} 个活跃会话</small>
          </div>
          {relevantSessions.map((session) => (
            <AiSessionCard
              key={session.id}
              session={session}
              items={state.items}
              onDelete={removeSession}
            />
          ))}
        </section>
      )}
    </CollapsiblePanel>
  );
}

function InlineTestItemRow({
  item,
  onMarkResult,
  onRemove,
}: {
  item: InlineRuleTestItem;
  onMarkResult: (
    id: string,
    status: "valid" | "invalid" | "mistouch" | "other",
  ) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="inline-test-item manager">
      <span
        className={`inline-test-status status-${item.status}`}
        title={STATUS_LABELS[item.status]}
      >
        {statusIcon(item.status)}
      </span>
      <div className="inline-test-main">
        <strong>{item.title}</strong>
        <small>{item.summary}</small>
        <small>
          <Clock size={10} /> {formatTime(item.createdAt)}
          {item.appName && ` · ${item.appName}`}
        </small>
      </div>
      <div className="inline-test-actions">
        <button
          title="标记有效"
          type="button"
          onClick={() => onMarkResult(item.id, "valid")}
        >
          <ThumbsUp size={12} />
        </button>
        <button
          title="标记无效"
          type="button"
          onClick={() => onMarkResult(item.id, "invalid")}
        >
          <ThumbsDown size={12} />
        </button>
        <button
          title="标记误触"
          type="button"
          onClick={() => onMarkResult(item.id, "mistouch")}
        >
          <Zap size={12} />
        </button>
        <button
          title="标记其他"
          type="button"
          onClick={() => onMarkResult(item.id, "other")}
        >
          <Circle size={12} />
        </button>
        <button
          className="inline-test-delete"
          title="删除"
          type="button"
          onClick={() => onRemove(item.id)}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function AiSessionCard({
  session,
  items,
  onDelete,
}: {
  session: InlineAiSession;
  items: InlineRuleTestItem[];
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sessionItems = useMemo(
    () => items.filter((item) => item.aiSessionId === session.id),
    [items, session.id],
  );
  const activeCount = sessionItems.filter(
    (item) => item.status === "testing",
  ).length;

  return (
    <div className="test-zone-item">
      <div className="test-zone-item-head">
        <strong
          role="button"
          style={{ cursor: "pointer" }}
          onClick={() => setExpanded((v) => !v)}
        >
          <MessageSquare size={12} /> {session.title}
          {activeCount > 0 && (
            <span className="inline-test-status status-testing">
              {activeCount} 测试中
            </span>
          )}
        </strong>
        <button
          className="text-link-button danger"
          type="button"
          onClick={() => onDelete(session.id)}
        >
          删除会话
        </button>
      </div>
      <span>{session.contextSummary}</span>
      {session.candidates.length > 0 && (
        <small>
          {session.candidates.length} 个候选
          {sessionItems.length > 0 && ` · ${sessionItems.length} 个已启动测试`}
        </small>
      )}
      {expanded && session.feedbackHistory.length > 0 && (
        <div className="inline-test-feedback-list">
          {session.feedbackHistory.map((entry, index) => (
            <div key={index} className="inline-test-feedback-entry">
              <small>{formatTime(entry.at)}</small>
              <span>{entry.note}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function statusIcon(status: InlineTestStatus) {
  switch (status) {
    case "testing":
      return <Play size={11} />;
    case "valid":
      return <ThumbsUp size={11} />;
    case "tested":
      return <CheckCircle2 size={11} />;
    case "invalid":
      return <ThumbsDown size={11} />;
    case "mistouch":
      return <XCircle size={11} />;
    case "ended":
      return <Circle size={11} />;
    default:
      return <Circle size={11} />;
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
