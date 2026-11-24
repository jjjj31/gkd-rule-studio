import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Check, MessageSquareWarning, Trash2, Undo2, X } from "lucide-react";
import { version as webVersion } from "../../package.json";
import { getAppVersionInfo } from "../lib/androidUpdater";
import type { GkdTargetChannel } from "../lib/gkdTarget";
import {
  createFeedbackId, deleteFeedbackDraft, loadFeedbackDraft,
  redactFeedbackNodes, renderRedactedScreenshot, sanitizeFeedbackText,
  saveFeedbackDraft, submitUserFeedback,
  type FeedbackAttachment, type FeedbackCategory, type FeedbackDraft,
  type FeedbackPayload, type FeedbackRect,
} from "../lib/userFeedback";
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import "./UserFeedbackPanel.css";

interface Props {
  snapshot: ParsedGkdSnapshot | null;
  snapshotOptions?: Array<{ id: number; label: string }>;
  selectedSnapshotId?: number | null;
  snapshotLoading?: boolean;
  snapshotError?: string;
  ruleText: string;
  errors: string;
  page: string;
  gkdVersion?: string;
  gkdChannel?: GkdTargetChannel | "";
  secrets: string[];
  onSnapshotSelect?: (id: number | null) => void;
  onClose: () => void;
}

function encodeText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return encodeBytes(bytes);
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decodeText(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
}

const MAX_RULES_FILE_BYTES = 512 * 1024;
const MAX_DIAGNOSTIC_FILE_BYTES = 8 * 1024 * 1024;
const RULE_FILE_ACCEPT = ".json,.json5,.txt,application/json,text/plain";
const DIAGNOSTIC_FILE_ACCEPT = ".zip,application/zip,application/x-zip-compressed";
const MASK_MIN_DRAG_SCREEN_PX = 6;
const MASK_HISTORY_BASE = "gkdFeedbackMaskEditorBase";

function fileName(value: string): string {
  return value.replace(/[\\/]/g, "_").trim().slice(0, 255);
}

function gkdChannelLabel(channel: GkdTargetChannel | ""): string {
  if (channel === "beta") return "测试版";
  if (channel === "stable") return "正式版";
  return "未确认";
}

export function UserFeedbackPanel({
  snapshot,
  snapshotOptions = [],
  selectedSnapshotId = null,
  snapshotLoading = false,
  snapshotError = "",
  ruleText,
  errors,
  page,
  gkdVersion: initialGkdVersion = "",
  gkdChannel: initialGkdChannel = "",
  secrets,
  onSnapshotSelect,
  onClose,
}: Props) {
  const [category, setCategory] = useState<FeedbackCategory>(snapshot || ruleText ? "rule" : "tool");
  const [description, setDescription] = useState("");
  const [descriptionChecked, setDescriptionChecked] = useState(false);
  const descriptionInvalid = descriptionChecked && !description.trim();
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const [contact, setContact] = useState("");
  const [rules, setRules] = useState(ruleText);
  const [rulesFileName, setRulesFileName] = useState("");
  const rulesFileInput = useRef<HTMLInputElement>(null);
  const [errorText, setErrorText] = useState(errors.slice(-4000));
  const [appVersion, setAppVersion] = useState(webVersion);
  const [systemVersion, setSystemVersion] = useState(navigator.userAgent.slice(0, 500));
  const [gkdVersion, setGkdVersion] = useState(initialGkdVersion);
  const [gkdChannel, setGkdChannel] = useState<GkdTargetChannel | "">(initialGkdChannel);
  const [includeRules, setIncludeRules] = useState(false);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [includeNodes, setIncludeNodes] = useState(false);
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [diagnosticFile, setDiagnosticFile] = useState<File | null>(null);
  const diagnosticInput = useRef<HTMLInputElement>(null);
  const [fileNotice, setFileNotice] = useState("");
  const [hiddenIds, setHiddenIds] = useState<number[]>([]);
  const [sensitive, setSensitive] = useState("");
  const [nodeFilter, setNodeFilter] = useState("");
  const [rects, setRects] = useState<FeedbackRect[]>([]);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [imageError, setImageError] = useState("");
  const [maskEditorOpen, setMaskEditorOpen] = useState(false);
  const [saved, setSaved] = useState<FeedbackDraft | null>(null);
  const [preview, setPreview] = useState<FeedbackPayload | null>(null);
  const [receipt, setReceipt] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [draftBroken, setDraftBroken] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const maskButton = useRef<HTMLButtonElement>(null);
  const sending = useRef(false);
  const closeRef = useRef<() => void>(() => {});
  const maskEditorOpenRef = useRef(false);
  const maskHistoryRef = useRef<{ originalState: unknown } | null>(null);
  const maskCloseResultRef = useRef<{ commit: FeedbackRect[] } | { cancel: true } | null>(null);
  const maskClosingRef = useRef(false);
  const materialCount = Number(includeRules && Boolean(rules.trim())) + Number(includeScreenshot && Boolean(snapshot))
    + Number(includeNodes && Boolean(snapshot)) + Number(Boolean(diagnosticFile));

  useEffect(() => {
    if (preview || receipt) title.current?.focus();
  }, [preview, receipt]);

  useEffect(() => {
    let active = true;
    const previousFocus = document.activeElement;
    const oldOverflow = document.body.style.overflow;
    const oldBack = window.__GkdAndroidBack;
    window.__GkdAndroidBack = () => closeRef.current();
    window.GkdAndroidBridge?.setBackVisible?.(true);
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    void loadFeedbackDraft().then((value) => { if (active) setSaved(value); })
      .catch(() => { if (active) { setDraftBroken(true); setNotice("无法读取本地草稿。可删除损坏草稿，或检查设备存储后重试。"); } })
      .finally(() => { if (active) setReady(true); });
    if (window.GkdAndroidBridge?.getAppUpdateInfo) {
      void getAppVersionInfo().then((value) => { if (active) setAppVersion(`${value.versionName} (${value.versionCode})`); }).catch(() => {});
    }
    try {
      const raw = window.GkdAndroidBridge?.getFeedbackDiagnostics?.();
      if (raw) {
        const diagnostics: { systemVersion?: string; lastCrash?: string } = JSON.parse(raw);
        if (diagnostics.systemVersion) setSystemVersion(diagnostics.systemVersion.slice(0, 500));
        if (diagnostics.lastCrash) setErrorText((value) => `${value.slice(-900)}\n最近一次应用异常：\n${diagnostics.lastCrash?.slice(0, 3000)}`.slice(0, 4000));
      }
    } catch { /* 诊断信息不可用时仍允许反馈。 */ }
    return () => {
      active = false;
      document.body.style.overflow = oldOverflow;
      window.__GkdAndroidBack = oldBack;
      window.GkdAndroidBridge?.setBackVisible?.(page !== "首页" && page !== "界面错误页");
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (initialGkdVersion) setGkdVersion(initialGkdVersion);
    if (initialGkdChannel) setGkdChannel(initialGkdChannel);
  }, [initialGkdVersion, initialGkdChannel]);

  useEffect(() => {
    let active = true;
    setImageSize({ width: 0, height: 0 });
    setImageError("");
    setRects([]);
    setHiddenIds([]);
    if (!snapshot?.screenshotUrl) return;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 24000000) {
        setImageError("截图尺寸过大，无法安全预览。");
        return;
      }
      setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      if (active) setImageError("截图加载失败，请重新打开快照，或取消截图附件。");
    };
    image.src = snapshot.screenshotUrl;
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [snapshot?.id, snapshot?.screenshotUrl]);

  useEffect(() => {
    function handleMaskPopState(): void {
      if (!maskEditorOpenRef.current || !window.history.state?.[MASK_HISTORY_BASE]) return;
      const originalState = maskHistoryRef.current?.originalState ?? null;
      const result = maskCloseResultRef.current;
      maskHistoryRef.current = null;
      maskCloseResultRef.current = null;
      maskClosingRef.current = false;
      maskEditorOpenRef.current = false;
      setMaskEditorOpen(false);
      window.history.replaceState(originalState, "", window.location.href);
      if (result && "commit" in result) setRects(result.commit);
      window.requestAnimationFrame(() => maskButton.current?.focus());
    }
    window.addEventListener("popstate", handleMaskPopState);
    return () => window.removeEventListener("popstate", handleMaskPopState);
  }, []);

  const nodes = useMemo(() => (snapshot?.nodes ?? []).filter((node) =>
    [node.attr.text, node.attr.desc, node.attr.id, node.attr.vid].some(Boolean)), [snapshot]);
  const filteredNodes = useMemo(() => nodes.filter((node) =>
    [node.attr.text, node.attr.desc, node.attr.id, node.attr.vid].join(" ").includes(nodeFilter)), [nodes, nodeFilter]);
  const automaticRects = useMemo(() => {
    if (!snapshot || !imageSize.width || !imageSize.height) return [];
    const words = sensitive.split("\n").map((word) => word.trim()).filter(Boolean);
    return snapshot.nodes.filter((node) => hiddenIds.includes(node.id) ||
      [node.attr.text, node.attr.desc, node.attr.id, node.attr.vid].some((value) =>
        value && sanitizeFeedbackText(value, secrets, words) !== value))
      .filter((node) => node.attr.right > node.attr.left && node.attr.bottom > node.attr.top)
      .map((node) => ({ x: node.attr.left * imageSize.width / snapshot.screenWidth,
        y: node.attr.top * imageSize.height / snapshot.screenHeight,
        width: (node.attr.right - node.attr.left) * imageSize.width / snapshot.screenWidth,
        height: (node.attr.bottom - node.attr.top) * imageSize.height / snapshot.screenHeight }));
  }, [snapshot, imageSize, hiddenIds, sensitive, secrets]);

  async function selectRulesFile(file: File | null): Promise<void> {
    if (!file) return;
    const lowerName = file.name.toLowerCase();
    if (![".json", ".json5", ".txt"].some((extension) => lowerName.endsWith(extension))) {
      setFileNotice("规则文件只支持 JSON、JSON5 或 TXT。");
      return;
    }
    if (file.size > MAX_RULES_FILE_BYTES) {
      setFileNotice("规则文件不能超过 512 KiB。");
      return;
    }
    try {
      const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));
      if (!text.trim()) {
        setFileNotice("规则文件为空，请选择包含规则内容的文件。");
        return;
      }
      setRules(text);
      setRulesFileName(fileName(file.name));
      setIncludeRules(true);
      setFileNotice("");
    } catch {
      setFileNotice("无法读取规则文件，请重新选择。");
    }
  }

  function selectDiagnosticFile(file: File | null): void {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      setFileNotice("GKD 诊断材料请选择 ZIP 压缩包。");
      return;
    }
    if (file.size > MAX_DIAGNOSTIC_FILE_BYTES) {
      setFileNotice("GKD 诊断压缩包不能超过 8 MiB。");
      return;
    }
    setDiagnosticFile(file);
    setFileNotice("");
  }

  async function diagnosticAttachment(): Promise<FeedbackAttachment | null> {
    if (!diagnosticFile) return null;
    if (diagnosticFile.size > MAX_DIAGNOSTIC_FILE_BYTES) {
      throw new Error("GKD 诊断压缩包不能超过 8 MiB。");
    }
    const bytes = new Uint8Array(await diagnosticFile.arrayBuffer());
    return {
      name: fileName(diagnosticFile.name) || "gkd-diagnostics.zip",
      mimeType: "application/zip",
      data: encodeBytes(bytes),
    };
  }

  function openMaskEditor(): void {
    if (!snapshot || maskEditorOpenRef.current) return;
    const originalState = window.history.state;
    const state = typeof originalState === "object" && originalState ? originalState : {};
    const baseState = { ...state, [MASK_HISTORY_BASE]: true };
    maskHistoryRef.current = { originalState };
    maskCloseResultRef.current = null;
    maskClosingRef.current = false;
    window.history.replaceState(baseState, "", window.location.href);
    window.history.pushState({ ...baseState, gkdFeedbackMaskEditor: true }, "", window.location.href);
    maskEditorOpenRef.current = true;
    setMaskEditorOpen(true);
  }

  function requestMaskClose(commit?: FeedbackRect[]): void {
    if (!maskEditorOpenRef.current || maskClosingRef.current) return;
    maskClosingRef.current = true;
    maskCloseResultRef.current = commit ? { commit: [...commit] } : { cancel: true };
    if (maskHistoryRef.current) {
      window.history.back();
      return;
    }
    maskClosingRef.current = false;
    maskEditorOpenRef.current = false;
    setMaskEditorOpen(false);
    if (commit) setRects(commit);
  }

  function close() {
    if (maskEditorOpenRef.current) {
      requestMaskClose();
      return;
    }
    if (sending.current || busy) return;
    if (!receipt && !preview && (description || contact || rects.length || sensitive
      || rulesFileName || diagnosticFile)
      && !window.confirm("尚未预览保存的修改会丢失，确定关闭吗？")) return;
    onClose();
  }
  closeRef.current = close;

  async function preparePreview() {
    if (busy || !ready) return;
    setDescriptionChecked(true);
    if (!description.trim()) {
      descriptionInput.current?.focus();
      return;
    }
    setFileNotice("");
    if (saved && !window.confirm("保存这次反馈会替换已有的本地草稿，继续吗？")) return;
    setBusy(true);
    setNotice("");
    try {
      const words = sensitive.split("\n").map((word) => word.trim()).filter(Boolean);
      const allRects = [...rects, ...automaticRects];
      const nodeRects = snapshot && imageSize.width && imageSize.height ? allRects.map((rect) => ({
        x: rect.x * snapshot.screenWidth / imageSize.width,
        y: rect.y * snapshot.screenHeight / imageSize.height,
        width: rect.width * snapshot.screenWidth / imageSize.width,
        height: rect.height * snapshot.screenHeight / imageSize.height,
      })) : [];
      const redacted = snapshot ? redactFeedbackNodes(snapshot, nodeRects, hiddenIds, secrets, words) : null;
      const allSensitive = [...words, ...(redacted?.sensitiveTexts ?? [])];
      const sanitize = (value: string) => sanitizeFeedbackText(value, secrets, allSensitive);
      const attachments: FeedbackAttachment[] = [];
      if (includeRules && rules) attachments.push({ name: "rules.txt", mimeType: "text/plain", data: encodeText(sanitize(rules)) });
      const diagnostics = await diagnosticAttachment();
      if (diagnostics) attachments.push({ ...diagnostics, name: sanitize(diagnostics.name) });
      if (includeNodes && snapshot && redacted) {
        const nodeData = { appId: sanitize(snapshot.appId), activityId: sanitize(snapshot.activityId ?? ""),
          screenWidth: snapshot.screenWidth, screenHeight: snapshot.screenHeight, nodes: redacted.nodes };
        attachments.push({ name: "nodes.json", mimeType: "application/json", data: encodeText(JSON.stringify(nodeData, null, 2)) });
      }
      if (includeScreenshot && snapshot) {
        if (!imageSize.width) throw new Error("截图尚未加载成功，请重试或取消附带截图。");
        attachments.push({ name: "screenshot.png", mimeType: "image/png", data: await renderRedactedScreenshot(snapshot.screenshotUrl, allRects) });
      }
      const payload: FeedbackPayload = {
        version: 1, clientId: createFeedbackId(), category,
        description: sanitize(description.trim()), contact: sanitizeFeedbackText(contact.trim(), secrets),
        context: {
          appVersion: sanitize(appVersion),
          systemVersion: sanitize(systemVersion),
          gkdVersion: sanitize(gkdVersion.trim()),
          gkdChannel: sanitize(gkdChannelLabel(gkdChannel)),
          page: sanitize(page),
          error: sanitize(errorText),
        },
        attachments,
      };
      if (saved && JSON.stringify({ ...saved.payload, clientId: "" }) === JSON.stringify({ ...payload, clientId: "" })) {
        payload.clientId = saved.payload.clientId;
      }
      const draft = { payload, savedAt: Date.now() };
      await saveFeedbackDraft(draft);
      setDraftBroken(false);
      setSaved(draft);
      setPreview(payload);
      setConfirmed(false);
      dialog.current?.scrollTo(0, 0);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "无法整理材料，请稍后重试。");
    } finally { setBusy(false); }
  }

  async function send() {
    if (!preview || !confirmed || sending.current) return;
    sending.current = true;
    setBusy(true);
    setNotice("");
    try { await saveFeedbackDraft({ payload: preview, savedAt: Date.now() }); }
    catch (cause) {
      setNotice(`${cause instanceof Error ? cause.message : "草稿保存失败"} 本次未发送，请检查设备存储后重试。`);
      sending.current = false;
      setBusy(false);
      return;
    }
    try {
      const result = await submitUserFeedback(preview);
      setReceipt(result.id);
      setPreview(null);
      setSaved(null);
      try { await deleteFeedbackDraft(); }
      catch { setNotice("反馈已提交，但本地草稿未能清除。再次发送同一草稿不会重复生成反馈。"); }
    } catch (cause) {
      setNotice(`${cause instanceof Error ? cause.message : "发送失败"} 已保留脱敏草稿，可稍后手动重试。`);
    } finally { sending.current = false; setBusy(false); }
  }

  async function removeDraft() {
    if (!window.confirm("确定删除本机保存的反馈草稿吗？")) return;
    try { await deleteFeedbackDraft(); setSaved(null); setDraftBroken(false); setPreview(null); setNotice("本地草稿已删除。"); }
    catch { setNotice("草稿删除失败，请检查设备存储后重试。"); }
  }

  return (
    <div className="user-feedback-backdrop">
      <section className="user-feedback-panel" role="dialog" aria-modal="true" aria-labelledby="user-feedback-title"
        inert={maskEditorOpen}
        tabIndex={-1} ref={dialog} onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); close(); }
          if (event.key === "Tab") {
            const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], details > summary:first-child'
            ) ?? []).filter((item) => item.getClientRects().length > 0);
            if (!focusable?.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current || document.activeElement === title.current)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <header className="user-feedback-head">
          <h2 id="user-feedback-title" ref={title} tabIndex={-1}><MessageSquareWarning size={20} />{preview ? "预览反馈" : "反馈"}</h2>
          <button className="android-icon-button" type="button" aria-label="关闭反馈" onClick={close} disabled={busy}><X size={20} /></button>
        </header>
        {notice && (
          <div aria-live="polite" className="user-feedback-notice android-main-toast user-feedback-toast" role="status">
            <span>{notice}</span>
            <button className="android-icon-button" type="button" aria-label="关闭反馈提示" onClick={() => setNotice("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {draftBroken && <button className="android-button" type="button" disabled={busy} onClick={() => void removeDraft()}>删除本地草稿</button>}
        {receipt ? <div className="user-feedback-receipt">
          <Check size={36} /><h3>反馈已收到</h3><p>反馈编号</p><code>{receipt}</code>
          <button className="android-button android-button-primary" type="button" onClick={onClose}>完成</button>
        </div> : preview ? <>
          <dl className="user-feedback-meta"><dt>问题类型</dt><dd>{preview.category === "rule" ? "规则效果问题" : preview.category === "feature" ? "希望有的功能" : "工具故障"}</dd>
            <dt>问题描述</dt><dd>{preview.description}</dd>
            {preview.contact && <><dt>联系方式</dt><dd>{preview.contact}</dd></>}
          </dl>
          <details className="user-feedback-section"><summary>设备与版本</summary>
            <dl className="user-feedback-meta">
              {preview.context.appVersion && <><dt>工具版本</dt><dd>{preview.context.appVersion}</dd></>}
              <dt>GKD 版本</dt><dd>{[preview.context.gkdChannel, preview.context.gkdVersion].filter(Boolean).join(" · ") || "未确认"}</dd>
              {preview.context.systemVersion && <><dt>系统</dt><dd>{preview.context.systemVersion}</dd></>}
              {preview.context.page && <><dt>来源</dt><dd>{preview.context.page}</dd></>}
            </dl>
            {preview.context.error && <details><summary>相关错误</summary><pre>{preview.context.error}</pre></details>}
          </details>
          {preview.attachments.map((attachment, index) => <details className="user-feedback-section" key={index} open>
            <summary>{attachment.name}</summary>
            {attachment.mimeType === "image/png" ? <img className="user-feedback-final-image" alt="即将发送的脱敏截图" src={`data:image/png;base64,${attachment.data}`} />
              : attachment.mimeType === "application/zip"
                ? <p>ZIP 原样发送，可能包含规则、节点文字和日志。</p>
                : <pre>{decodeText(attachment.data)}</pre>}
          </details>)}
          {!preview.attachments.length && <p>未附带材料</p>}
          <details className="user-feedback-section"><summary>发送与隐私</summary>
            <dl className="user-feedback-meta"><dt>保存位置</dt><dd>作者的私有后台</dd><dt>保留期限</dt><dd>90 天</dd></dl>
          </details>
          <label className="user-feedback-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />我已检查，同意发送上述材料</label>
          <div className="user-feedback-actions">
            <button className="android-button" type="button" disabled={busy} onClick={() => { setPreview(null); setConfirmed(false); setNotice("可按当前现场重新整理；再次预览保存会替换原草稿。"); }}>返回整理</button>
            <button className="android-button android-button-primary" type="button" disabled={!confirmed || busy} onClick={() => void send()}>{busy ? "正在提交…" : "提交反馈"}</button>
            <button className="android-button" type="button" disabled={busy} onClick={onClose}>稍后再发</button>
          </div>
        </> : <>
          {saved && <div className="user-feedback-draft"><strong>有一份已脱敏草稿</strong><span>{new Date(saved.savedAt).toLocaleString()}</span>
            <button className="android-button" type="button" disabled={busy} onClick={() => { setPreview(saved.payload); setConfirmed(false); setNotice(""); }}>继续草稿</button>
            <button className="android-button" type="button" disabled={busy} onClick={() => void removeDraft()}><Trash2 size={15} />删除草稿</button></div>}
          <label>问题类型<select disabled={busy} value={category} onChange={(event) => setCategory(event.target.value as FeedbackCategory)}>
            <option value="tool">工具故障</option><option value="rule">规则效果问题</option><option value="feature">希望有的功能</option></select></label>
          <label>问题描述（必填）
            <textarea ref={descriptionInput} aria-label="问题描述" disabled={busy} required aria-invalid={descriptionInvalid}
              aria-describedby={descriptionInvalid ? "user-feedback-description-error" : undefined}
              maxLength={4000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
            {descriptionInvalid && <span id="user-feedback-description-error" className="user-feedback-field-error" role="alert">请填写问题描述，说明遇到的问题或希望增加的功能。</span>}
          </label>
          <label>联系方式（选填）<input aria-label="反馈联系方式" disabled={busy} maxLength={200} value={contact} onChange={(event) => setContact(event.target.value)} autoComplete="off" /></label>
          <details className="user-feedback-section" open={materialsOpen} onToggle={(event) => setMaterialsOpen(event.currentTarget.open)}>
            <summary>附带材料{materialCount > 0 && <span className="user-feedback-summary-value">已选 {materialCount} 项</span>}</summary>
            {(snapshotOptions.length > 0 || snapshotLoading || snapshotError) && <div className="user-feedback-snapshot-picker">
              {snapshotOptions.length > 0 && <label>反馈现场快照
                <select aria-label="反馈现场快照" value={selectedSnapshotId ?? ""} disabled={busy || snapshotLoading}
                  onChange={(event) => onSnapshotSelect?.(event.target.value ? Number(event.target.value) : null)}>
                  <option value="">不附带快照</option>
                  {snapshotOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>}
              {snapshotLoading && <p className="user-feedback-help" role="status">正在读取快照，完成后可选择截图和节点树。</p>}
              {snapshotError && <p className="user-feedback-notice" role="alert">{snapshotError}</p>}
            </div>}
            <fieldset className="user-feedback-materials" aria-label="选择附带材料">
              <label className="user-feedback-check"><input type="checkbox" checked={includeRules} disabled={busy} onChange={(event) => setIncludeRules(event.target.checked)} />当前规则</label>
              {includeRules && <>
                <div className="user-feedback-file">
                  <button className="android-button" type="button" disabled={busy} onClick={() => rulesFileInput.current?.click()}>
                    {rulesFileName ? "更换规则文件" : "选择规则文件"}（JSON / JSON5 / TXT）
                  </button>
                  <input ref={rulesFileInput} type="file" accept={RULE_FILE_ACCEPT} disabled={busy} hidden
                    onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; void selectRulesFile(file); }} />
                  {rulesFileName && <p className="user-feedback-file-name" role="status">已读取：{rulesFileName}</p>}
                </div>
                <label>粘贴或编辑规则<textarea aria-label="反馈规则内容" maxLength={200000} rows={6} value={rules} onChange={(event) => setRules(event.target.value)} spellCheck={false} /></label>
              </>}
              <label className="user-feedback-check"><input type="checkbox" checked={includeScreenshot} disabled={!snapshot} onChange={(event) => setIncludeScreenshot(event.target.checked)} />当前截图</label>
              <label className="user-feedback-check"><input type="checkbox" checked={includeNodes} disabled={!snapshot} onChange={(event) => setIncludeNodes(event.target.checked)} />当前节点树</label>
              {!snapshot && <p>选择快照后可附带截图和节点树。</p>}
              <div className="user-feedback-diagnostic-upload">
                <strong>GKD 诊断 ZIP</strong>
                <button className="android-button" type="button" disabled={busy} onClick={() => diagnosticInput.current?.click()}>{diagnosticFile ? "更换诊断 ZIP" : "选择诊断 ZIP"}</button>
                <input ref={diagnosticInput} type="file" accept={DIAGNOSTIC_FILE_ACCEPT} disabled={busy} hidden
                  onChange={(event) => { const file = event.currentTarget.files?.[0] ?? null; event.currentTarget.value = ""; selectDiagnosticFile(file); }} />
                {diagnosticFile && <div className="user-feedback-file-row"><span>已选择：{diagnosticFile.name}</span>
                  <button className="android-button" type="button" disabled={busy} onClick={() => setDiagnosticFile(null)}>移除</button></div>}
                {diagnosticFile && <p>ZIP 原样发送，可能包含规则、节点文字和日志。</p>}
                <details><summary>如何导出诊断 ZIP</summary>
                  <p>GKD 1.13+ → 工具 → 诊断 → 诊断采集（早期 1.13.0 在 设置 → 诊断）。复现后停止采集，再导出 ZIP。</p>
                </details>
              </div>
            </fieldset>
            {snapshot && (includeScreenshot || includeNodes) && <div className="user-feedback-screenshot-material">
              {imageError
                ? <p className="user-feedback-notice" role="alert">{imageError}</p>
                : <div className="user-feedback-screenshot-frame">
                  <img className="user-feedback-screenshot-preview" src={snapshot.screenshotUrl} alt="截图打码预览" />
                  {imageSize.width > 0 && <svg className="user-feedback-screenshot-masks" aria-hidden="true"
                    viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="none">
                    {[...rects, ...automaticRects].map((rect, index) => <rect key={index}
                      x={Math.floor(rect.x)} y={Math.floor(rect.y)}
                      width={Math.ceil(rect.x + rect.width) - Math.floor(rect.x)}
                      height={Math.ceil(rect.y + rect.height) - Math.floor(rect.y)} fill="#000" />)}
                  </svg>}
                </div>}
              <div className="user-feedback-actions">
                <button ref={maskButton} className="android-button" type="button" disabled={busy} onClick={openMaskEditor}>打码</button>
                <span>手动框选 {rects.length} 处 · 自动遮挡 {automaticRects.length} 处</span>
              </div>
            </div>}
            {includeNodes && <details><summary>手动隐藏节点文字（已选 {hiddenIds.length} 个）</summary>
              <input aria-label="搜索反馈节点" placeholder="搜索节点文字或 ID" value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)} />
              <div className="user-feedback-node-list">{filteredNodes.slice(0, 100).map((node) => <label className="user-feedback-check" key={node.id}>
                <input type="checkbox" checked={hiddenIds.includes(node.id)} onChange={(event) => setHiddenIds((ids) => event.target.checked ? [...ids, node.id] : ids.filter((id) => id !== node.id))} />
                <span>#{node.id} {[node.attr.text, node.attr.desc, node.attr.vid || node.attr.id].filter(Boolean).join(" · ")}</span>
              </label>)}</div>{filteredNodes.length > 100 && <p>显示前 100 个结果，请用搜索缩小范围。</p>}
            </details>}
            <details><summary>隐藏敏感文字{sensitive.trim() && "（已填写）"}</summary>
              <label>每行一项，例如姓名或手机号<textarea aria-label="敏感文字" maxLength={4000} rows={3} value={sensitive} onChange={(event) => setSensitive(event.target.value)} /></label>
            </details>
          </details>
          <details className="user-feedback-section"><summary>设备与版本{gkdChannel && gkdVersion && <span className="user-feedback-summary-value">{gkdChannelLabel(gkdChannel)} · {gkdVersion}</span>}</summary>
            <label>工具版本<input maxLength={200} value={appVersion} onChange={(event) => setAppVersion(event.target.value)} /></label>
            <label>系统版本<input maxLength={500} value={systemVersion} onChange={(event) => setSystemVersion(event.target.value)} /></label>
            <label>GKD 版本类型<select aria-label="GKD 版本类型" value={gkdChannel} onChange={(event) => setGkdChannel(event.target.value as GkdTargetChannel | "")}>
              <option value="">未确认</option><option value="beta">测试版</option><option value="stable">正式版</option></select></label>
            <label>GKD 版本号<input aria-label="GKD 版本号" maxLength={200} value={gkdVersion} onChange={(event) => setGkdVersion(event.target.value)} /></label>
            <label>相关错误<textarea aria-label="反馈错误信息" maxLength={4000} rows={5} value={errorText} onChange={(event) => setErrorText(event.target.value)} /></label>
          </details>
          <button className="android-button android-button-primary" type="button" disabled={busy || !ready} onClick={() => void preparePreview()}>{busy ? "正在脱敏整理…" : "预览并保存草稿"}</button>
        </>}
        {fileNotice && <div className="user-feedback-notice android-main-toast user-feedback-toast">
          <span role="alert">{fileNotice}</span>
          <button className="android-icon-button" type="button" aria-label="关闭上传提示" onClick={() => setFileNotice("")}><X size={16} /></button>
        </div>}
      </section>
      {maskEditorOpen && snapshot && <MaskEditor sourceUrl={snapshot.screenshotUrl} initialRects={rects}
        fixedRects={automaticRects} onCancel={() => requestMaskClose()}
        onComplete={(value) => requestMaskClose(value)} />}
    </div>
  );
}

function MaskEditor({ sourceUrl, initialRects, fixedRects, onCancel, onComplete }: {
  sourceUrl: string; initialRects: FeedbackRect[]; fixedRects: FeedbackRect[]; onCancel: () => void;
  onComplete: (value: FeedbackRect[]) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const pointer = useRef<{
    id: number; screenX: number; screenY: number; imageX: number; imageY: number;
  } | null>(null);
  const [draft, setDraft] = useState<{ rects: FeedbackRect[]; past: FeedbackRect[][] }>(() => ({
    rects: initialRects,
    past: initialRects.map((_, index) => initialRects.slice(0, index)),
  }));
  const [current, setCurrent] = useState<FeedbackRect | null>(null);
  const [imageError, setImageError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setImageError("");
    const img = new Image();
    img.onload = () => {
      if (!active) return;
      if (!img.naturalWidth || img.naturalWidth * img.naturalHeight > 24000000) {
        setImageError("截图尺寸过大，无法安全编辑。"); return;
      }
      image.current = img;
      setLoaded(true);
    };
    img.onerror = () => { if (active) setImageError("截图加载失败，请返回后重新打开快照。"); };
    img.src = sourceUrl;
    return () => { active = false; image.current = null; };
  }, [sourceUrl]);

  useEffect(() => {
    const el = canvas.current, img = image.current;
    if (!el || !img || !loaded) return;
    el.width = img.naturalWidth; el.height = img.naturalHeight;
    const context = el.getContext("2d");
    if (!context) return;
    context.drawImage(img, 0, 0);
    context.fillStyle = "#000";
    for (const rect of [...draft.rects, ...fixedRects, ...(current ? [current] : [])]) {
      context.fillRect(Math.floor(rect.x), Math.floor(rect.y), Math.ceil(rect.x + rect.width) - Math.floor(rect.x), Math.ceil(rect.y + rect.height) - Math.floor(rect.y));
    }
  }, [draft.rects, fixedRects, current, loaded]);

  useEffect(() => {
    editor.current?.focus();
    function handleEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [onCancel]);

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const el = event.currentTarget, bounds = el.getBoundingClientRect();
    return { x: Math.max(0, Math.min(el.width, (event.clientX - bounds.left) * el.width / bounds.width)),
      y: Math.max(0, Math.min(el.height, (event.clientY - bounds.top) * el.height / bounds.height)) };
  }
  function rectangle(event: PointerEvent<HTMLCanvasElement>): FeedbackRect | null {
    const start = pointer.current;
    if (!start || Math.abs(event.clientX - start.screenX) < MASK_MIN_DRAG_SCREEN_PX
      || Math.abs(event.clientY - start.screenY) < MASK_MIN_DRAG_SCREEN_PX) return null;
    const end = point(event);
    return { x: Math.min(start.imageX, end.x), y: Math.min(start.imageY, end.y),
      width: Math.abs(end.x - start.imageX), height: Math.abs(end.y - start.imageY) };
  }
  function commitRects(value: FeedbackRect[]): void {
    setDraft((state) => ({ rects: value, past: [...state.past, state.rects] }));
  }
  function undo(): void {
    setDraft((state) => {
      if (!state.past.length) return state;
      return { rects: state.past[state.past.length - 1], past: state.past.slice(0, -1) };
    });
  }
  function handleTab(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Tab") return;
    const focusable = Array.from(editor.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === editor.current)) {
      event.preventDefault(); last.focus();
    }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div ref={editor} className="user-feedback-mask-editor" role="dialog" aria-label="截图打码"
    aria-modal="true" tabIndex={-1} onKeyDown={handleTab}>
    <header className="user-feedback-mask-head">
      <strong>截图打码</strong>
      <button className="android-button" type="button" onClick={onCancel}>取消</button>
    </header>
    <div className="user-feedback-mask-stage">
      {imageError && <p className="user-feedback-notice" role="alert">{imageError}</p>}
      <canvas ref={canvas} role="img" aria-label="拖动框选截图打码区域" hidden={!loaded}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0 || pointer.current) return;
          event.preventDefault();
          const imagePoint = point(event);
          pointer.current = {
            id: event.pointerId, screenX: event.clientX, screenY: event.clientY,
            imageX: imagePoint.x, imageY: imagePoint.y,
          };
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 合成事件没有活动指针。 */ }
          setCurrent(null);
        }}
        onPointerMove={(event) => {
          if (!pointer.current || event.pointerId !== pointer.current.id) return;
          event.preventDefault();
          setCurrent(rectangle(event));
        }}
        onPointerUp={(event) => {
          if (!pointer.current || event.pointerId !== pointer.current.id) return;
          event.preventDefault();
          const rect = rectangle(event);
          pointer.current = null;
          setCurrent(null);
          if (rect && rect.width > 0 && rect.height > 0) commitRects([...draft.rects, rect]);
        }}
        onPointerCancel={(event) => {
          if (pointer.current?.id !== event.pointerId) return;
          pointer.current = null;
          setCurrent(null);
        }}
        onLostPointerCapture={(event) => {
          if (pointer.current?.id !== event.pointerId) return;
          pointer.current = null;
          setCurrent(null);
        }} />
    </div>
    <footer className="user-feedback-mask-toolbar">
      <button className="android-button" type="button" disabled={!draft.past.length} onClick={undo}><Undo2 size={15} />撤销</button>
      <button className="android-button" type="button" disabled={!loaded} onClick={() => {
        const img = image.current;
        if (img) commitRects([{ x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight }]);
      }}>遮住整张截图</button>
      <span>手动框选 {draft.rects.length} 处 · 自动遮挡 {fixedRects.length} 处</span>
      <button className="android-button android-button-primary" type="button" disabled={!loaded}
        onClick={() => onComplete(draft.rects)}><Check size={15} />完成</button>
    </footer>
  </div>;
}
