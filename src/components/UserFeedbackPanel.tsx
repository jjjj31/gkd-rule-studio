import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Check, MessageSquareWarning, Trash2, Undo2, X } from "lucide-react";
import { version as webVersion } from "../../package.json";
import { getAppVersionInfo } from "../lib/androidUpdater";
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
  secrets: string[];
  onSnapshotSelect?: (id: number | null) => void;
  onClose: () => void;
}

function encodeText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function decodeText(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (char) => char.charCodeAt(0)));
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
  secrets,
  onSnapshotSelect,
  onClose,
}: Props) {
  const [category, setCategory] = useState<FeedbackCategory>(snapshot || ruleText ? "rule" : "tool");
  const [description, setDescription] = useState("");
  const [contact, setContact] = useState("");
  const [rules, setRules] = useState(ruleText);
  const [errorText, setErrorText] = useState(errors.slice(-4000));
  const [appVersion, setAppVersion] = useState(webVersion);
  const [systemVersion, setSystemVersion] = useState(navigator.userAgent.slice(0, 500));
  const [includeRules, setIncludeRules] = useState(false);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [includeNodes, setIncludeNodes] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<number[]>([]);
  const [sensitive, setSensitive] = useState("");
  const [nodeFilter, setNodeFilter] = useState("");
  const [rects, setRects] = useState<FeedbackRect[]>([]);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [saved, setSaved] = useState<FeedbackDraft | null>(null);
  const [preview, setPreview] = useState<FeedbackPayload | null>(null);
  const [receipt, setReceipt] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [draftBroken, setDraftBroken] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const sending = useRef(false);
  const closeRef = useRef<() => void>(() => {});

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

  function close() {
    if (sending.current) return;
    if (!receipt && !preview && (description || contact || rects.length || sensitive)
      && !window.confirm("尚未预览保存的修改会丢失，确定关闭吗？")) return;
    onClose();
  }
  closeRef.current = close;

  async function preparePreview() {
    if (busy || !ready) return;
    if (!description.trim()) { setNotice("请描述发生了什么，以及你原本希望发生什么。"); return; }
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
        context: { appVersion: sanitize(appVersion), systemVersion: sanitize(systemVersion), page: sanitize(page), error: sanitize(errorText) },
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
        tabIndex={-1} ref={dialog} onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); close(); }
          if (event.key === "Tab") {
            const focusable = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]');
            if (!focusable?.length) return;
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <header className="user-feedback-head">
          <h2 id="user-feedback-title"><MessageSquareWarning size={20} />反馈问题</h2>
          <button className="android-icon-button" type="button" aria-label="关闭反馈" onClick={close} disabled={busy}><X size={20} /></button>
        </header>
        {notice && <p className="user-feedback-notice" role="status">{notice}</p>}
        {draftBroken && <button className="android-button" type="button" disabled={busy} onClick={() => void removeDraft()}>删除本地草稿</button>}
        {receipt ? <div className="user-feedback-receipt">
          <Check size={36} /><h3>反馈已收到</h3><p>反馈编号</p><code>{receipt}</code>
          <p>感谢你帮忙改进工具。需要补充信息时，作者会通过你留下的联系方式联系你。</p>
          <button className="android-button android-button-primary" type="button" onClick={onClose}>完成</button>
        </div> : preview ? <>
          <p>以下是实际发送的材料。请检查截图和文字，确认没有需要隐藏的个人内容。</p>
          <dl className="user-feedback-meta"><dt>问题类型</dt><dd>{preview.category === "rule" ? "规则效果问题" : "工具故障"}</dd>
            <dt>问题描述</dt><dd>{preview.description}</dd><dt>联系方式</dt><dd>{preview.contact || "未填写"}</dd>
            <dt>版本</dt><dd>{preview.context.appVersion}</dd><dt>系统</dt><dd>{preview.context.systemVersion}</dd><dt>来源</dt><dd>{preview.context.page}</dd></dl>
          <details open><summary>随反馈附带的错误信息</summary><pre>{preview.context.error || "无"}</pre></details>
          {preview.attachments.map((attachment) => <details key={attachment.name} open>
            <summary>{attachment.name}</summary>
            {attachment.mimeType === "image/png" ? <img className="user-feedback-final-image" alt="即将发送的脱敏截图" src={`data:image/png;base64,${attachment.data}`} />
              : <pre>{decodeText(attachment.data)}</pre>}
          </details>)}
          {!preview.attachments.length && <p>未附带规则、截图或节点树。</p>}
          <p className="user-feedback-help">材料保存在作者的私有后台，保留 90 天后自动删除。</p>
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
          <label>问题类型<select value={category} onChange={(event) => setCategory(event.target.value as FeedbackCategory)}>
            <option value="tool">工具故障</option><option value="rule">规则效果问题</option></select></label>
          <label>问题描述（必填）<textarea aria-label="问题描述" maxLength={4000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="你做了什么？发生了什么？原本希望怎样？" /></label>
          <label>联系方式（选填）<input aria-label="反馈联系方式" maxLength={200} value={contact} onChange={(event) => setContact(event.target.value)} placeholder="邮箱或 QQ，方便作者追问" autoComplete="off" /></label>
          <details><summary>自动附带的基础信息与相关错误（可编辑）</summary>
            <label>工具版本<input maxLength={200} value={appVersion} onChange={(event) => setAppVersion(event.target.value)} /></label>
            <label>系统版本<input maxLength={500} value={systemVersion} onChange={(event) => setSystemVersion(event.target.value)} /></label>
            <label>相关错误<textarea aria-label="反馈错误信息" maxLength={4000} rows={5} value={errorText} onChange={(event) => setErrorText(event.target.value)} /></label>
          </details>
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
          <fieldset><legend>选择附带材料</legend>
            <label className="user-feedback-check"><input type="checkbox" checked={includeRules} disabled={!rules} onChange={(event) => setIncludeRules(event.target.checked)} />当前规则{!rules && "（当前无规则）"}</label>
            {includeRules && <label>规则内容（可删改）<textarea aria-label="反馈规则内容" maxLength={200000} rows={6} value={rules} onChange={(event) => setRules(event.target.value)} spellCheck={false} /></label>}
            <label className="user-feedback-check"><input type="checkbox" checked={includeScreenshot} disabled={!snapshot} onChange={(event) => setIncludeScreenshot(event.target.checked)} />当前截图{!snapshot && "（当前无快照）"}</label>
            <label className="user-feedback-check"><input type="checkbox" checked={includeNodes} disabled={!snapshot} onChange={(event) => setIncludeNodes(event.target.checked)} />当前节点树{!snapshot && "（当前无快照）"}</label>
          </fieldset>
          {snapshot && (includeScreenshot || includeNodes) && <>
            <h3>框选敏感区域</h3><p className="user-feedback-help">在图上拖动框选。黑色区域不会出现在上传图片中，与其相交节点的文字也会隐藏。截图与节点可能来自不同时刻，请同时检查文字预览。</p>
            <RedactionCanvas sourceUrl={snapshot.screenshotUrl} rects={rects} fixedRects={automaticRects} onChange={setRects} onSize={setImageSize} />
          </>}
          {includeNodes && <details><summary>手动隐藏节点文字（已选 {hiddenIds.length} 个）</summary>
            <input aria-label="搜索反馈节点" placeholder="搜索节点文字或 ID" value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)} />
            <div className="user-feedback-node-list">{filteredNodes.slice(0, 100).map((node) => <label className="user-feedback-check" key={node.id}>
              <input type="checkbox" checked={hiddenIds.includes(node.id)} onChange={(event) => setHiddenIds((ids) => event.target.checked ? [...ids, node.id] : ids.filter((id) => id !== node.id))} />
              <span>#{node.id} {[node.attr.text, node.attr.desc, node.attr.vid || node.attr.id].filter(Boolean).join(" · ")}</span>
            </label>)}</div>{filteredNodes.length > 100 && <p>显示前 100 个结果，请用搜索缩小范围。</p>}
          </details>}
          <label>在文字材料中一并隐藏的内容<textarea aria-label="敏感文字" maxLength={4000} rows={3} value={sensitive} onChange={(event) => setSensitive(event.target.value)} placeholder="每行一项，例如姓名、手机号、账号；会在描述、错误、规则、节点中同步替换" /></label>
          <p className="user-feedback-help">无需登录。文字材料中的已知密钥会自动排除，截图请手动打码。规则、截图和节点树仅在勾选后附带。反馈与附件保留 90 天。下一步可以检查实际发送内容。</p>
          <button className="android-button android-button-primary" type="button" disabled={busy || !ready || !description.trim()} onClick={() => void preparePreview()}>{busy ? "正在脱敏整理…" : "预览并保存草稿"}</button>
        </>}
      </section>
    </div>
  );
}

function RedactionCanvas({ sourceUrl, rects, fixedRects, onChange, onSize }: {
  sourceUrl: string; rects: FeedbackRect[]; fixedRects: FeedbackRect[]; onChange: (value: FeedbackRect[]) => void;
  onSize: (size: { width: number; height: number }) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<FeedbackRect | null>(null);
  const [imageError, setImageError] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    const img = new Image();
    img.onload = () => {
      if (!active) return;
      if (!img.naturalWidth || img.naturalWidth * img.naturalHeight > 24000000) {
        setImageError("截图尺寸过大，无法安全预览。请取消附带截图。"); return;
      }
      image.current = img;
      onSize({ width: img.naturalWidth, height: img.naturalHeight });
      setLoaded(true);
    };
    img.onerror = () => { if (active) setImageError("截图加载失败，请重新打开快照，或取消截图附件。"); };
    img.src = sourceUrl;
    return () => { active = false; image.current = null; };
  }, [sourceUrl, onSize]);

  useEffect(() => {
    const el = canvas.current, img = image.current;
    if (!el || !img || !loaded) return;
    el.width = img.naturalWidth; el.height = img.naturalHeight;
    const context = el.getContext("2d");
    if (!context) return;
    context.drawImage(img, 0, 0);
    context.fillStyle = "#000";
    for (const rect of [...rects, ...fixedRects, ...(current ? [current] : [])]) {
      context.fillRect(Math.floor(rect.x), Math.floor(rect.y), Math.ceil(rect.x + rect.width) - Math.floor(rect.x), Math.ceil(rect.y + rect.height) - Math.floor(rect.y));
    }
  }, [rects, fixedRects, current, loaded]);

  function point(event: PointerEvent<HTMLCanvasElement>) {
    const el = event.currentTarget, bounds = el.getBoundingClientRect();
    return { x: Math.max(0, Math.min(el.width, (event.clientX - bounds.left) * el.width / bounds.width)),
      y: Math.max(0, Math.min(el.height, (event.clientY - bounds.top) * el.height / bounds.height)) };
  }
  function rectangle(event: PointerEvent<HTMLCanvasElement>): FeedbackRect | null {
    if (!start.current) return null;
    const end = point(event);
    return { x: Math.min(start.current.x, end.x), y: Math.min(start.current.y, end.y),
      width: Math.abs(end.x - start.current.x), height: Math.abs(end.y - start.current.y) };
  }
  return <div className="user-feedback-image-editor">
    {imageError && <p role="alert">{imageError}</p>}
    <canvas ref={canvas} role="img" aria-label="拖动框选截图打码区域" hidden={!loaded}
      onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); start.current = point(event); }}
      onPointerMove={(event) => { if (start.current) setCurrent(rectangle(event)); }}
      onPointerUp={(event) => { const rect = rectangle(event); start.current = null; setCurrent(null);
        if (rect && rect.width > 0 && rect.height > 0) onChange([...rects, rect]); }}
      onPointerCancel={() => { start.current = null; setCurrent(null); }} />
    <div className="user-feedback-actions">
      <button className="android-button" type="button" disabled={!rects.length} onClick={() => onChange(rects.slice(0, -1))}><Undo2 size={15} />撤销打码</button>
      <button className="android-button" type="button" disabled={!loaded} onClick={() => {
        const img = image.current; if (img) onChange([{ x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight }]);
      }}>遮住整张截图</button><span>手动框选 {rects.length} 处 · 自动遮挡 {fixedRects.length} 处</span>
    </div>
  </div>;
}
