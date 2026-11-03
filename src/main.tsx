import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { debugLog } from "./lib/debugLog";
import { loadAiConfig, loadAiProfileStore } from "./lib/aiModel";
import { UserFeedbackPanel } from "./components/UserFeedbackPanel";
import "./styles.css";

/**
 * 渲染层兜底：React 渲染抛出未捕获异常时会卸载整棵组件树，页面变成空白/黑屏（
 * WebView 只保留深色背景），用户完全无法恢复。这里拦下所有渲染错误，给出可
 * 点击重载的提示页，并把错误写进调试日志。
 */
class RenderErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null; feedbackOpen: boolean }
> {
  state: { error: Error | null; feedbackOpen: boolean } = { error: null, feedbackOpen: false };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error): void {
    void error;
  }

  render(): ReactNode {
    if (this.state.error) {
      try {
        debugLog(
          "error",
          "render:unhandled",
          String(this.state.error.message || this.state.error),
        );
      } catch {
        // 调试日志本身失败时不再阻止错误页渲染
      }
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            boxSizing: "border-box",
            background: "#0e131a",
            color: "#e5e7eb",
            fontFamily: "system-ui, -apple-system, sans-serif",
            padding: 24,
            textAlign: "center",
          }}
        >
          <h1 style={{ margin: 0, fontSize: 20 }}>界面渲染出错</h1>
          <p
            style={{
              margin: 0,
              opacity: 0.75,
              wordBreak: "break-all",
              maxWidth: 560,
              fontSize: 13,
            }}
          >
            {String(this.state.error.message || this.state.error)}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8,
              padding: "8px 20px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.25)",
              background: "transparent",
              color: "inherit",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            重新加载
          </button>
          <button type="button" className="android-button" onClick={() => this.setState({ feedbackOpen: true })}>反馈问题</button>
          {this.state.feedbackOpen && <UserFeedbackPanel snapshot={null} ruleText="" page="界面错误页"
            errors={String(this.state.error.stack || this.state.error.message).slice(-4000)}
            secrets={configuredFeedbackSecrets()} onClose={() => this.setState({ feedbackOpen: false })} />}
        </div>
      );
    }
    return this.props.children;
  }
}

function configuredFeedbackSecrets(): string[] {
  try { return [loadAiConfig().apiKey, ...loadAiProfileStore().profiles.map((profile) => profile.config.apiKey)].filter(Boolean); }
  catch { return []; }
}

window.addEventListener("error", (event) => {
  if (event.message) debugLog("error", "window:unhandled", event.message.slice(0, 2000));
});
window.addEventListener("unhandledrejection", (event) => {
  const message = event.reason instanceof Error ? event.reason.message : String(event.reason ?? "未知异步异常");
  debugLog("error", "promise:unhandled", message.slice(0, 2000));
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RenderErrorBoundary>
      <App />
    </RenderErrorBoundary>
  </StrictMode>,
);
