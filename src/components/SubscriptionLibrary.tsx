import JSON5 from "json5";
import { ChevronLeft, ClipboardCopy, Download, Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { copyTextToClipboard } from "../lib/clipboard";
import type { DeviceApiClient } from "../lib/deviceApi";
import { isBetaTarget, matchesTargetChannel, targetChannelLabel, type GkdTargetChannel } from "../lib/gkdTarget";
import {
  inspectLibraryGroup, libraryContentKey, loadLibraryImports, loadLibrarySources,
  normalizeSubscriptionUrl, prepareLibraryAppend, refreshLibrarySource, saveLibraryImports,
  saveLibrarySources, searchLibraryApps, selectLibraryGroup, stringifyLibrarySelection,
} from "../lib/subscriptionLibrary";
import type { LibraryImportRecord, LibrarySelection, LibrarySource, LibraryTest } from "../types/subscriptionLibrary";
import "./SubscriptionLibrary.css";

interface Props {
  active: boolean;
  client: DeviceApiClient | null;
  targetChannel: GkdTargetChannel;
  loading: boolean;
  tests: LibraryTest[];
  onClose: () => void;
  onTest: (selection: LibrarySelection) => Promise<void>;
  onTestResult: (status: "ended" | "valid" | "invalid") => Promise<void>;
  onSync: () => Promise<unknown>;
}

export function SubscriptionLibrary(props: Props) {
  const [cached] = useState(loadLibrarySources);
  const [savedImports] = useState(loadLibraryImports);
  const [sources, setSources] = useState(cached.sources);
  const [records, setRecords] = useState(savedImports.records);
  const [link, setLink] = useState("");
  const [query, setQuery] = useState("");
  const [groupQuery, setGroupQuery] = useState("");
  const [appId, setAppId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(cached.error ?? savedImports.error ?? null);
  const [task, setTask] = useState<string | null>(null);
  const taskRef = useRef(false);
  const apps = useMemo(() => searchLibraryApps(sources, query), [sources, query]);
  const appIndex = useMemo(() => searchLibraryApps(sources, ""), [sources]);
  const selectedApp = appId ? appIndex.find((app) => app.id === appId) : undefined;
  const activeTest = props.tests.find((test) => ["syncing", "testing", "failed"].includes(test.status));
  const busy = Boolean(task) || props.loading;
  const targetMatches = props.client && matchesTargetChannel(props.client.serverInfo.gkdAppInfo, props.targetChannel);
  const groupKeyword = groupQuery.trim().toLocaleLowerCase();
  const groupSections = props.active && selectedApp ? sources.flatMap((source) => {
    const app = source.subscription.apps.find((item) => item.id === selectedApp.id);
    if (!app) return [];
    const groups = app.groups.map((raw, index) => ({ raw, index, inspected: inspectLibraryGroup(raw) }))
      .filter(({ inspected }) => inspected.name.toLocaleLowerCase().includes(groupKeyword));
    return groups.length ? [{ source, app, groups }] : [];
  }) : [];

  useEffect(() => {
    const pop = (event: PopStateEvent) => { setAppId(event.state?.libraryAppId ?? null); setGroupQuery(""); };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);

  function openApp(id: string) {
    window.history.pushState({ ...window.history.state, gkdRuleBuilderView: "library", libraryAppId: id }, "", window.location.href);
    setAppId(id);
    setGroupQuery("");
    setNotice(null);
  }

  async function runTask(id: string, action: () => Promise<void>) {
    if (taskRef.current) return;
    taskRef.current = true;
    setTask(id);
    setNotice(null);
    try { await action(); }
    catch (cause) { setNotice(cause instanceof Error ? cause.message : "操作失败，请重试"); }
    finally { taskRef.current = false; setTask(null); }
  }

  async function refresh(input: string) {
    await runTask(input, async () => {
      try {
        const updated = await refreshLibrarySource(sources, input);
        setSources(updated);
        setLink("");
        setNotice("订阅已保存");
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : "下载失败";
        let url = input;
        try { url = normalizeSubscriptionUrl(input); } catch { /* Input validation is shown by the task handler. */ }
        const failed = sources.map((source) => source.url === url ? { ...source, error } : source);
        setSources(failed);
        try { saveLibrarySources(failed); } catch { /* The last successful cache remains available. */ }
        throw cause;
      }
    });
  }

  function deleteSource(source: LibrarySource) {
    if (busy) return;
    try {
      const updated = sources.filter((item) => item.url !== source.url);
      saveLibrarySources(updated);
      setSources(updated);
      setNotice("来源已删除");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "删除来源失败"); }
  }

  async function copy(selection: LibrarySelection) {
    try {
      await copyTextToClipboard(stringifyLibrarySelection(selection));
      setNotice("已复制");
    } catch (cause) { setNotice(cause instanceof Error ? cause.message : "复制失败，请重试"); }
  }

  async function importGroup(selection: LibrarySelection, force = false) {
    const client = props.client;
    if (!isBetaTarget(props.targetChannel)) { await copy(selection); return; }
    if (!client || !targetMatches) { setNotice("未连接对应版本的 GKD"); return; }
    if (savedImports.error) { setNotice(savedImports.error); return; }
    const existing = records.find((record) => record.deviceOrigin === client.origin &&
      record.targetPackage === props.targetChannel && libraryContentKey(record) === libraryContentKey(selection));
    if (existing && !force) { setNotice("已导入"); return; }
    await runTask(`import:${selection.id}`, async () => {
      const submittedApp = prepareLibraryAppend(selection);
      const result = await client.appendLocalRules(submittedApp).catch((cause) => {
        const detail = cause instanceof Error ? cause.message : "导入请求失败";
        throw new Error(`${detail}。可使用“复制”手动添加；请求中断时请先在 GKD 核对是否已写入。`);
      });
      if (result.addedRules === 0) {
        setNotice(`没有新增规则，跳过 ${result.skippedDuplicates} 条。请在 GKD 核对；新版追加不会覆盖旧副本。`);
        return;
      }
      const record: LibraryImportRecord = {
        ...selection, submittedApp, importedAt: Date.now(), deviceOrigin: client.origin,
        targetPackage: props.targetChannel,
        complete: result.addedGroups === 1 && result.addedRules === submittedApp.groups[0].rules.length && result.skippedDuplicates === 0,
      };
      const updated = [...records.filter((item) => !(item.deviceOrigin === client.origin && item.targetPackage === props.targetChannel && libraryContentKey(item) === libraryContentKey(selection))), record];
      setRecords(updated);
      saveLibraryImports(updated);
      if (!record.complete) {
        throw new Error(`GKD 只写入 ${result.addedGroups} 组 / ${result.addedRules} 条，跳过 ${result.skippedDuplicates} 条；请核对规则完整性，勿盲目再次追加。`);
      }
      setNotice(`已导入 ${result.addedGroups} 组 · ${result.addedRules} 条${submittedApp.groups[0].enable === false ? " · 默认禁用" : ""}`);
    });
  }

  if (!props.active) return null;

  return (
    <section className="rule-library" aria-label="订阅规则库">
      <div className="library-heading">
        <button className="android-icon-button" aria-label={appId ? "返回应用列表" : "返回首页"} type="button" onClick={() => appId ? window.history.back() : props.onClose()}><ChevronLeft size={18} /></button>
        <div><h2>{selectedApp?.name ?? "订阅规则库"}</h2>{selectedApp && <p>{selectedApp.id}</p>}</div>
      </div>

      {notice && <div className="android-message library-notice" role="status">{notice}<button type="button" aria-label="关闭规则库提示" onClick={() => setNotice(null)}>×</button></div>}

      {activeTest && <section className="android-card library-active-test" aria-label="规则库当前测试">
        <strong>{activeTest.app.name} · {activeTest.app.groups[0].name}</strong>
        <span>{activeTest.subscriptionName} · v{activeTest.version} · {testStatusLabel(activeTest.status)}</span>
        {activeTest.error && <p className="library-error">{activeTest.error}</p>}
        <div className="library-actions">
          <button className="android-button" disabled={busy || activeTest.status !== "testing"} onClick={() => void props.onTestResult("valid")} type="button">有效</button>
          <button className="android-button" disabled={busy || activeTest.status !== "testing"} onClick={() => void props.onTestResult("invalid")} type="button">无效</button>
          <button className="android-button" disabled={busy} onClick={() => void props.onTestResult("ended")} type="button">结束测试</button>
        </div>
      </section>}
      {props.tests.some((test) => test.error) && <button className="android-button" disabled={busy || !props.client} onClick={() => void props.onSync()} type="button">重试同步当前测试集合</button>}

      {!selectedApp && <>
        <section className="android-card">
          <div className="library-search"><Search size={18} /><input className="android-input" aria-label="搜索应用名或包名" placeholder="输入软件名或包名" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <span className="android-muted">{sources.length} 个来源 · {apps.length} 个应用</span>
        </section>
        <details className="android-card library-sources" open={sources.length === 0}>
          <summary>管理订阅来源（{sources.length}）</summary>
          <form className="library-form" onSubmit={(event) => { event.preventDefault(); void refresh(link); }}>
            <input className="android-input" aria-label="订阅文件链接" type="url" placeholder="粘贴订阅 JSON/JSON5 文件链接" required value={link} onChange={(event) => setLink(event.target.value)} disabled={Boolean(task)} />
            <button className="android-button android-button-primary" disabled={busy || !link.trim()} type="submit">{task ? <Loader2 size={16} className="spinning" /> : <Plus size={16} />}{task ? "处理中…" : "添加"}</button>
          </form>
          {sources.map((source) => <div className="library-source" key={source.url}>
            <strong>{source.subscription.name} <small>v{source.subscription.version}</small></strong>
            <span className="android-muted">{source.subscription.author && `${source.subscription.author} · `}刷新于 {formatTime(source.refreshedAt)}</span>
            <span className="library-url">{source.url}</span>
            {source.error && <p className="library-error">刷新失败：{source.error}。当前仍使用已保存的 v{source.subscription.version}。</p>}
            <div className="library-actions">
              <button className="android-button" type="button" disabled={busy} onClick={() => void refresh(source.url)}><RefreshCw size={14} />{task === source.url ? "刷新中…" : "刷新"}</button>
              <button className="android-button" type="button" disabled={busy} onClick={() => deleteSource(source)}><Trash2 size={14} />删除来源</button>
            </div>
          </div>)}
        </details>
        {sources.length > 0 && apps.length === 0 && <p className="android-empty library-empty">未找到应用</p>}
        <div className="library-app-list">{apps.map((app) => <button className="android-card library-app-button" key={app.id} type="button" onClick={() => openApp(app.id)}>
          <strong>{app.name}</strong><span className="library-url">{app.id}</span><small>{app.sourceCount} 个来源 · {app.groupCount} 个规则组</small>
        </button>)}</div>
      </>}

      {selectedApp && <section className="android-card">
        <div className="library-search"><Search size={18} /><input className="android-input" type="search" aria-label="搜索规则名称" placeholder="搜索规则名称" value={groupQuery} onChange={(event) => setGroupQuery(event.target.value)} /></div>
        <span className="android-muted">{groupSections.reduce((count, section) => count + section.groups.length, 0)} / {selectedApp.groupCount} 个规则组</span>
      </section>}
      {selectedApp && groupSections.length === 0 && <p className="android-empty library-empty">未找到规则</p>}
      {selectedApp && groupSections.map(({ source, app, groups }) => {
        return <section className="library-source-groups" key={source.url}>
          <div className="library-source-heading"><h3>{source.subscription.name}</h3><span>v{source.subscription.version} · 刷新于 {formatTime(source.refreshedAt)}</span></div>
          {source.error && <p className="library-error">{source.error}；正在使用已保存的数据。</p>}
          {groups.map(({ raw, index, inspected }) => {
            let selection: LibrarySelection | undefined;
            let error = inspected.error;
            if (!error) try { selection = selectLibraryGroup(source, app, index); } catch (cause) { error = cause instanceof Error ? cause.message : "规则组无法交付"; }
            const content = selection ? libraryContentKey(selection) : "";
            const test = props.tests.find((item) => libraryContentKey(item) === content && item.version === selection?.version);
            const imported = records.find((item) => libraryContentKey(item) === content && item.deviceOrigin === props.client?.origin && item.targetPackage === props.targetChannel);
            return <article className="android-card library-group" key={index}>
              <div className="library-group-title"><h3>{inspected.name}</h3><span>{test ? testStatusLabel(test.status) : "未测试"}</span></div>
              {inspected.group?.desc && <p className="library-description">{inspected.group.desc}</p>}
              <div className="library-group-meta">{inspected.group && <span>{inspected.group.rules.length} 条规则</span>}{inspected.group?.enable === false && <span>源规则默认禁用</span>}{imported && <span>{imported.complete === false ? "部分写入，请核对" : "已追加固定副本"} · v{imported.version}</span>}</div>
              {error && <p className="library-error">{error}</p>}
              {test?.error && <p className="library-error">{test.error}</p>}
              <div className="library-actions">
                <button className="android-button" type="button" disabled={!selection || busy || !targetMatches} onClick={() => selection && void props.onTest(selection)}>测试</button>
                <button className="android-button" type="button" disabled={!selection} onClick={() => selection && void copy(selection)}><ClipboardCopy size={14} />复制</button>
                <button className="android-button android-button-primary" type="button" disabled={!selection || busy || (isBetaTarget(props.targetChannel) && (Boolean(savedImports.error) || !targetMatches))} onClick={() => selection && void importGroup(selection, Boolean(imported))}><Download size={14} />{isBetaTarget(props.targetChannel) ? imported ? "再次追加" : "导入" : "手动添加"}</button>
              </div>
              <details className="library-raw"><summary>查看规则原文</summary><pre>{JSON5.stringify(raw, null, 2)}</pre></details>
            </article>;
          })}
        </section>;
      })}

      {records.length > 0 && <details className="android-card library-import-history"><summary>固定副本记录（{records.length}）</summary>
        {records.map((record, index) => <div className="library-source" key={index}>
          <strong>{record.app.name} · {record.app.groups[0]?.name}</strong>
          <span>{record.subscriptionName} · v{record.version} · {formatTime(record.importedAt)}</span>
          {record.complete === false && <span className="library-error">部分写入，请先在 GKD 核对；下方可复制完整的原请求内容。</span>}
          <span className="library-url">{record.sourceUrl}</span>
          <small>{targetChannelLabel(record.targetPackage)} · {record.deviceOrigin}</small>
          <button className="android-button" type="button" onClick={() => void copy(record)}><ClipboardCopy size={14} />复制导入时内容</button>
        </div>)}
      </details>}
    </section>
  );
}

function formatTime(time: number) { return new Date(time).toLocaleString("zh-CN"); }
function testStatusLabel(status: LibraryTest["status"]) {
  return { syncing: "发送中", testing: "测试中", ended: "已结束", valid: "有效", invalid: "无效", failed: "未同步" }[status];
}
