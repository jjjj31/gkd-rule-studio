/** 内置 AI 候选面板（桌面版）。显示 AI 生成的候选、测试、反馈。安卓版同功能在 AndroidAiPanel。 */
import {
  Bot,
  ClipboardPaste,
  Copy,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  TestTube,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CollapsiblePanel } from "./CollapsiblePanel";
import {
  buildAiFeedbackMessages,
  buildAiGenerateMessages,
  requestAiCandidates,
  parseAiCandidates,
  shouldRetryTextOnlyAfterMultimodalError,
  stripAiMessageImages,
  aiMessagesHaveImage,
  withAiGenerationTimeout,
  type AiFeedbackResult,
  type AiMode,
  type AiModelConfig,
  type AiRuleCandidate,
} from "../lib/aiModel";
import {
  addAiSession,
  setAiSessionCandidates,
  startAiCandidateTest,
  deleteAiSession,
  filterAiSessionsByMode,
  type InlineAiSession,
  type InlineRuleTestingState,
} from "../lib/inlineRuleTesting";
import {
  addAppDraftToTestSubscription,
  type TestSubscriptionDraft,
} from "../lib/testSubscription";
import { copyTextToClipboard } from "../lib/clipboard";
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";

interface AiCandidatesPanelProps {
  mode: AiMode;
  config: AiModelConfig;
  prompt: string;
  imageUrl?: string;
  snapshot: ParsedGkdSnapshot | null;
  inlineTesting: InlineRuleTestingState;
  onInlineTestingChange: (state: InlineRuleTestingState) => void;
  onTestSubscriptionChange: (draft: TestSubscriptionDraft | ((current: TestSubscriptionDraft) => TestSubscriptionDraft)) => void;
}

type FeedbackResultOption = { value: AiFeedbackResult | "flow-note"; label: string };

const FEEDBACK_RESULT_OPTIONS: FeedbackResultOption[] = [
  { value: "success", label: "成功" },
  { value: "not-triggered", label: "未触发" },
  { value: "triggered-no-close", label: "触发但未关闭" },
  { value: "mistouch", label: "误触" },
  { value: "other", label: "其他" },
];

export function AiCandidatesPanel({
  mode,
  config,
  prompt,
  imageUrl,
  snapshot,
  inlineTesting,
  onInlineTestingChange,
  onTestSubscriptionChange,
}: AiCandidatesPanelProps) {
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [feedbackCandidateId, setFeedbackCandidateId] = useState<string | null>(null);
  const [feedbackResult, setFeedbackResult] = useState<AiFeedbackResult>("not-triggered");
  const [feedbackNote, setFeedbackNote] = useState("");
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const sessions = filterAiSessionsByMode(inlineTesting, mode);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    setElapsed(0);
    const start = Date.now();
    timerRef.current = setInterval(() => {
      if (!mountedRef.current) return;
      setElapsed(Math.round((Date.now() - start) / 1000));
    }, 1000);
  }, [stopTimer]);

  const handleGenerate = useCallback(async () => {
    if (loading) return;
    if (!prompt.trim()) {
      setMessage("请先填写上下文 prompt。");
      return;
    }

    setLoading(true);
    setMessage(null);
    setDebugLogs([]);
    startTimer();

    const sessionState = addAiSession(inlineTesting, {
      mode,
      snapshotId: snapshot?.id,
      title: "AI 生成",
      originalPrompt: prompt,
      contextSummary: prompt.slice(0, 120),
      appName: snapshot?.appInfo?.name,
    });
    const newSession = sessionState.aiSessions[0]!;
    onInlineTestingChange(sessionState);

    try {
      const messages = buildAiGenerateMessages({ mode, prompt, imageUrl });
      let candidates: AiRuleCandidate[];

      try {
        candidates = await requestAiCandidates({
          config: withAiGenerationTimeout(config),
          messages,
          onDebugLog: (line) => {
            if (mountedRef.current) setDebugLogs((prev) => [...prev, line]);
          },
        });
      } catch (cause) {
        if (
          aiMessagesHaveImage(messages) &&
          shouldRetryTextOnlyAfterMultimodalError(cause)
        ) {
          if (mountedRef.current) {
            setDebugLogs((prev) => [
              ...prev,
              "retry:text-only after multimodal error",
            ]);
          }
          candidates = await requestAiCandidates({
            config: withAiGenerationTimeout(config),
            messages: stripAiMessageImages(messages),
            onDebugLog: (line) => {
              if (mountedRef.current) setDebugLogs((prev) => [...prev, line]);
            },
          });
        } else {
          throw cause;
        }
      }

      if (!mountedRef.current) return;
      onInlineTestingChange(
        setAiSessionCandidates(inlineTesting, newSession.id, candidates),
      );
      setMessage(null);
    } catch (cause) {
      if (!mountedRef.current) return;
      setMessage(cause instanceof Error ? cause.message : "AI 请求失败");
    } finally {
      stopTimer();
      if (mountedRef.current) setLoading(false);
    }
  }, [
    loading,
    prompt,
    mode,
    config,
    imageUrl,
    snapshot,
    inlineTesting,
    onInlineTestingChange,
    startTimer,
    stopTimer,
  ]);

  const handlePasteImport = useCallback(() => {
    if (!pasteText.trim()) return;
    try {
      const parsed = parseAiCandidates(pasteText);
      if (parsed.length === 0) {
        setMessage("未能从粘贴内容中解析出候选规则。");
        return;
      }
      const sessionState = addAiSession(inlineTesting, {
        mode,
        snapshotId: snapshot?.id,
        title: "粘贴导入",
        originalPrompt: pasteText,
        contextSummary: pasteText.slice(0, 120),
        appName: snapshot?.appInfo?.name,
      });
      const newSession = sessionState.aiSessions[0]!;
      onInlineTestingChange(
        setAiSessionCandidates(sessionState, newSession.id, parsed),
      );
      setPasteText("");
      setMessage(null);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "解析粘贴内容失败");
    }
  }, [pasteText, mode, snapshot, inlineTesting, onInlineTestingChange]);

  const handleTest = useCallback(
    (sessionId: string, candidate: AiRuleCandidate) => {
      onInlineTestingChange(
        startAiCandidateTest(inlineTesting, sessionId, candidate),
      );
    },
    [inlineTesting, onInlineTestingChange],
  );

  const handleImport = useCallback(
    (candidate: AiRuleCandidate) => {
      onTestSubscriptionChange((current: TestSubscriptionDraft) =>
        addAppDraftToTestSubscription(current, candidate.app),
      );
    },
    [onTestSubscriptionChange],
  );

  const handleSendFeedback = useCallback(
    async (session: InlineAiSession, candidate: AiRuleCandidate) => {
      if (loading) return;
      setLoading(true);
      setMessage(null);
      setDebugLogs([]);
      startTimer();

      try {
        const messages = buildAiFeedbackMessages({
          mode,
          originalPrompt: session.originalPrompt,
          candidate,
          result: feedbackResult,
          note: feedbackNote,
          imageUrl,
        });
        let candidates: AiRuleCandidate[];

        try {
          candidates = await requestAiCandidates({
            config: withAiGenerationTimeout(config),
            messages,
            onDebugLog: (line) => {
              if (mountedRef.current) setDebugLogs((prev) => [...prev, line]);
            },
          });
        } catch (cause) {
          if (
            aiMessagesHaveImage(messages) &&
            shouldRetryTextOnlyAfterMultimodalError(cause)
          ) {
            candidates = await requestAiCandidates({
              config: withAiGenerationTimeout(config),
              messages: stripAiMessageImages(messages),
              onDebugLog: (line) => {
                if (mountedRef.current) setDebugLogs((prev) => [...prev, line]);
              },
            });
          } else {
            throw cause;
          }
        }

        if (!mountedRef.current) return;

        let nextState = setAiSessionCandidates(
          inlineTesting,
          session.id,
          candidates,
        );
        const feedbackEntry = {
          at: Date.now(),
          note: `[${feedbackResult}] ${feedbackNote}`.trim(),
        };
        nextState = {
          ...nextState,
          aiSessions: nextState.aiSessions.map((s) =>
            s.id === session.id
              ? {
                  ...s,
                  feedbackHistory: [...s.feedbackHistory, feedbackEntry],
                  updatedAt: Date.now(),
                }
              : s,
          ),
        };
        onInlineTestingChange(nextState);
        setFeedbackCandidateId(null);
        setFeedbackResult("not-triggered");
        setFeedbackNote("");
        setMessage(null);
      } catch (cause) {
        if (!mountedRef.current) return;
        setMessage(cause instanceof Error ? cause.message : "AI 反馈请求失败");
      } finally {
        stopTimer();
        if (mountedRef.current) setLoading(false);
      }
    },
    [
      loading,
      mode,
      config,
      imageUrl,
      inlineTesting,
      feedbackResult,
      feedbackNote,
      onInlineTestingChange,
      startTimer,
      stopTimer,
    ],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      onInlineTestingChange(deleteAiSession(inlineTesting, sessionId));
      if (expandedSessionId === sessionId) setExpandedSessionId(null);
    },
    [inlineTesting, onInlineTestingChange, expandedSessionId],
  );

  const handleCopyCandidate = useCallback((candidate: AiRuleCandidate) => {
    void copyTextToClipboard(JSON.stringify(candidate.app, null, 2));
  }, []);

  return (
    <CollapsiblePanel
      title="AI 规则候选"
      className="candidates-panel"
      actions={
        <div className="preview-actions">
          <button
            className="copy-button primary-button"
            disabled={loading || !prompt.trim()}
            type="button"
            onClick={() => void handleGenerate()}
          >
            {loading ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Bot size={15} />
            )}
            <span>{loading ? `${elapsed}s` : "生成候选"}</span>
          </button>
        </div>
      }
    >
      {/* Error / status message */}
      {message && <p className="test-zone-message">{message}</p>}

      {/* Loading indicator */}
      {loading && (
        <div className="android-ai-busy">
          <Loader2 className="spin" size={16} />
          <span>AI 正在生成规则候选... 已用时 {elapsed} 秒</span>
        </div>
      )}

      {/* Paste area */}
      <div className="custom-scenario-box" style={{ marginBottom: 10 }}>
        <textarea
          className="test-zone-textarea"
          placeholder="粘贴外部 AI 返回的 JSON5 候选结果..."
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          style={{ marginBottom: 6, minHeight: 64 }}
        />
        <button
          className="copy-button"
          disabled={!pasteText.trim() || loading}
          type="button"
          onClick={handlePasteImport}
        >
          <ClipboardPaste size={15} />
          <span>解析粘贴内容</span>
        </button>
      </div>

      {/* Debug logs */}
      {debugLogs.length > 0 && (
        <div className="android-ai-debug" style={{ marginBottom: 10 }}>
          <div className="android-ai-debug-head">
            <strong>调试日志 ({debugLogs.length})</strong>
            <div>
              <button
                className="text-link-button"
                type="button"
                onClick={() => setShowDebug((v) => !v)}
              >
                {showDebug ? "收起" : "展开"}
              </button>
              <button
                className="text-link-button danger"
                type="button"
                onClick={() => {
                  setDebugLogs([]);
                  setShowDebug(false);
                }}
              >
                清空
              </button>
            </div>
          </div>
          {showDebug && (
            <pre>{debugLogs.join("\n")}</pre>
          )}
        </div>
      )}

      {/* Session history */}
      {sessions.length > 0 ? (
        <div className="history-block">
          <div className="history-title">
            <span>会话历史</span>
            <span>{sessions.length}</span>
          </div>
          <div className="candidate-list">
            {sessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                inlineTesting={inlineTesting}
                expanded={expandedSessionId === session.id}
                feedbackCandidateId={feedbackCandidateId}
                feedbackResult={feedbackResult}
                feedbackNote={feedbackNote}
                loading={loading}
                onToggleExpand={() =>
                  setExpandedSessionId((prev) =>
                    prev === session.id ? null : session.id,
                  )
                }
                onDelete={() => handleDeleteSession(session.id)}
                onTest={(candidate) => handleTest(session.id, candidate)}
                onImport={handleImport}
                onCopy={handleCopyCandidate}
                onFeedbackSelect={(candidateId) => setFeedbackCandidateId(candidateId)}
                onFeedbackResultChange={setFeedbackResult}
                onFeedbackNoteChange={setFeedbackNote}
                onSendFeedback={(candidate) =>
                  void handleSendFeedback(session, candidate)
                }
                onCancelFeedback={() => {
                  setFeedbackCandidateId(null);
                  setFeedbackResult("not-triggered");
                  setFeedbackNote("");
                }}
              />
            ))}
          </div>
        </div>
      ) : (
        !loading && (
          <p className="muted">还没有 AI 会话。点击"生成候选"开始。</p>
        )
      )}
    </CollapsiblePanel>
  );
}

/* ── Session card sub-component ── */

interface SessionCardProps {
  session: InlineAiSession;
  inlineTesting: InlineRuleTestingState;
  expanded: boolean;
  feedbackCandidateId: string | null;
  feedbackResult: AiFeedbackResult;
  feedbackNote: string;
  loading: boolean;
  onToggleExpand: () => void;
  onDelete: () => void;
  onTest: (candidate: AiRuleCandidate) => void;
  onImport: (candidate: AiRuleCandidate) => void;
  onCopy: (candidate: AiRuleCandidate) => void;
  onFeedbackSelect: (candidateId: string | null) => void;
  onFeedbackResultChange: (result: AiFeedbackResult) => void;
  onFeedbackNoteChange: (note: string) => void;
  onSendFeedback: (candidate: AiRuleCandidate) => void;
  onCancelFeedback: () => void;
}

function SessionCard({
  session,
  inlineTesting,
  expanded,
  feedbackCandidateId,
  feedbackResult,
  feedbackNote,
  loading,
  onToggleExpand,
  onDelete,
  onTest,
  onImport,
  onCopy,
  onFeedbackSelect,
  onFeedbackResultChange,
  onFeedbackNoteChange,
  onSendFeedback,
  onCancelFeedback,
}: SessionCardProps) {
  const candidateCount = session.candidates.length;
  const testedCount = inlineTesting.items.filter(
    (item) => item.aiSessionId === session.id && item.status !== "idle",
  ).length;

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  return (
    <div className={`candidate-item ${expanded ? "candidate-active" : ""}`}>
      {/* Header row */}
      <div className="candidate-heading">
        <MessageSquare size={18} />
        <strong
          onClick={onToggleExpand}
          style={{ cursor: "pointer" }}
          title={session.contextSummary}
        >
          {session.title} - {formatTime(session.createdAt)}
        </strong>
        <div className="candidate-inline-actions">
          <span title={`${candidateCount} 个候选, ${testedCount} 个已测试`}>
            {candidateCount} 候选 / {testedCount} 已测
          </span>
          <button
            className="icon-button"
            type="button"
            title="删除会话"
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Feedback history */}
      {session.feedbackHistory.length > 0 && (
        <div className="candidate-desc">
          {session.feedbackHistory.map((entry, i) => (
            <div key={i} style={{ marginBottom: 2 }}>
              [{formatTime(entry.at)}] {entry.note}
            </div>
          ))}
        </div>
      )}

      {/* Expanded: candidate list */}
      {expanded && session.candidates.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {session.candidates.map((candidate) => {
            const testItem = inlineTesting.items.find(
              (item) =>
                item.aiSessionId === session.id &&
                item.selectorIndex === candidate.id,
            );
            const isFeedbackTarget = feedbackCandidateId === candidate.id;

            return (
              <div
                key={candidate.id}
                className="android-ai-candidate-card"
                style={{ gap: 7, padding: 10 }}
              >
                {/* Candidate header */}
                <div className="android-ai-candidate-head">
                  <div>
                    <strong>{candidate.title}</strong>
                    <span>{candidate.summary}</span>
                  </div>
                  {candidate.risk && (
                    <em className="status-badge medium">{candidate.risk}</em>
                  )}
                </div>

                {/* Action buttons */}
                <div className="android-candidate-actions">
                  <button
                    className="android-candidate-add"
                    type="button"
                    onClick={() => onTest(candidate)}
                  >
                    <TestTube size={13} />
                    <span>测试</span>
                  </button>
                  <button
                    className="android-candidate-add"
                    type="button"
                    onClick={() => onImport(candidate)}
                  >
                    <Plus size={13} />
                    <span>导入测试区</span>
                  </button>
                  <button
                    className="android-candidate-detail"
                    type="button"
                    onClick={() => onCopy(candidate)}
                  >
                    <Copy size={13} />
                    <span>复制</span>
                  </button>
                  <button
                    className="android-candidate-detail"
                    type="button"
                    onClick={() =>
                      onFeedbackSelect(isFeedbackTarget ? null : candidate.id)
                    }
                  >
                    <MessageSquare size={13} />
                    <span>反馈</span>
                  </button>
                </div>

                {/* Test status badge */}
                {testItem && (
                  <div className="inline-test-status-group">
                    <span
                      className={`inline-test-status status-${testItem.status}`}
                    >
                      {testStatusLabel(testItem.status)}
                    </span>
                    {testItem.note && (
                      <span className="candidate-desc">{testItem.note}</span>
                    )}
                  </div>
                )}

                {/* Feedback form */}
                {isFeedbackTarget && (
                  <div className="android-ai-feedback">
                    <div className="android-ai-feedback-row">
                      <div className="android-ai-feedback-check">
                        <strong>测试结果</strong>
                      </div>
                      <select
                        value={feedbackResult}
                        onChange={(e) =>
                          onFeedbackResultChange(
                            e.target.value as AiFeedbackResult,
                          )
                        }
                      >
                        {FEEDBACK_RESULT_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <textarea
                      className="android-ai-note test-zone-textarea"
                      placeholder="补充说明（可选）"
                      value={feedbackNote}
                      onChange={(e) => onFeedbackNoteChange(e.target.value)}
                      style={{ minHeight: 52 }}
                    />
                    <div className="android-candidate-actions">
                      <button
                        className="android-candidate-add"
                        type="button"
                        disabled={loading}
                        onClick={() => onSendFeedback(candidate)}
                      >
                        {loading ? (
                          <Loader2 className="spin" size={13} />
                        ) : (
                          <Play size={13} />
                        )}
                        <span>发送反馈并重新生成</span>
                      </button>
                      <button
                        className="android-candidate-detail"
                        type="button"
                        disabled={loading}
                        onClick={onCancelFeedback}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function testStatusLabel(status: string): string {
  switch (status) {
    case "testing":
      return "测试中";
    case "tested":
      return "已测试";
    case "valid":
      return "有效";
    case "invalid":
      return "无效";
    case "mistouch":
      return "误触";
    case "other":
      return "其他";
    default:
      return status;
  }
}
