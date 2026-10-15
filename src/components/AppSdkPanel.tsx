/**
 * 首页“SDK 信息”面板与工作区“应用 SDK／页面特征”摘要。
 *
 * 面板只做界面编排：文件解析、匹配、存储都调用 `libCheckerImport` 与
 * `adSdkContext`，不在组件里重复实现签名匹配。导入与删除都在整批保存成功后
 * 才替换内存状态，失败保留原记录。
 *
 * @see libCheckerImport.ts 解析、合并与本地保存
 * @see adSdkContext.ts 快照与档案关联
 */
import {
  ChevronLeft,
  FileUp,
  Loader2,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { adSdkLabel } from "../data/adSdkSignatures";
import { findAppSdkProfile, resolveAdSdkContext } from "../lib/adSdkContext";
import {
  deleteAppSdkProfile,
  mergeAppSdkProfiles,
  readLibCheckerProfiles,
  saveAppSdkProfiles,
} from "../lib/libCheckerImport";
import type {
  AppSdkComponentType,
  AppSdkProfile,
} from "../types/appSdkProfile";
import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import "./AppSdkPanel.css";

const COMPONENT_LABELS: Record<AppSdkComponentType, string> = {
  activity: "Activity",
  service: "Service",
  receiver: "Receiver",
  provider: "Provider",
};

const ACCEPTED_TYPES =
  ".lcapps,.json,application/json,application/zip,application/octet-stream";

interface AppSdkPanelProps {
  active: boolean;
  /** 当前内存中的档案；面板不自行读取存储，避免两处状态不一致。 */
  profiles: readonly AppSdkProfile[];
  /** 缓存损坏等加载错误；导入成功后由调用方清除。 */
  loadError?: string;
  onClose: () => void;
  /** 仅在解析、合并与本地保存都成功后才调用。 */
  onProfilesChange: (profiles: AppSdkProfile[]) => void;
}

export function AppSdkPanel(props: AppSdkPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(props.loadError ?? null);
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);

  const keyword = query.trim().toLocaleLowerCase();
  const apps = useMemo(() => {
    const sorted = [...props.profiles].sort((a, b) =>
      (a.appName ?? a.appId).localeCompare(b.appName ?? b.appId, "zh-CN"),
    );
    if (!keyword) return sorted;
    return sorted.filter(
      (profile) =>
        profile.appId.toLocaleLowerCase().includes(keyword) ||
        (profile.appName?.toLocaleLowerCase().includes(keyword) ?? false),
    );
  }, [props.profiles, keyword]);
  const matchedCount = useMemo(
    () => props.profiles.filter((profile) => profile.sdks.length > 0).length,
    [props.profiles],
  );
  const selected = detailId
    ? props.profiles.find((profile) => profile.appId === detailId)
    : undefined;

  async function handleFile(file: File) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const incoming = await readLibCheckerProfiles(file);
      const merged = mergeAppSdkProfiles(props.profiles, incoming);
      // 先整批保存，成功后才替换内存状态；保存失败时抛错并保留旧记录。
      saveAppSdkProfiles(merged);
      props.onProfilesChange(merged);
      const matched = incoming.filter((profile) => profile.sdks.length > 0).length;
      setNotice(
        `已导入 ${incoming.length} 个应用，其中 ${matched} 个匹配到受支持的 SDK；当前共 ${merged.length} 个应用。`,
      );
      setQuery("");
      setDetailId(null);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "导入失败，请重试");
    } finally {
      busyRef.current = false;
      setBusy(false);
      // 允许再次选择同一个文件。
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removeProfile(appId: string) {
    if (busy) return;
    try {
      const next = deleteAppSdkProfile(appId);
      props.onProfilesChange(next);
      setDetailId(null);
      setNotice("已删除该应用的 SDK 档案");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "删除失败，请重试");
    }
  }

  if (!props.active) return null;

  return (
    <section className="app-sdk-panel" aria-label="SDK 信息">
      <div className="library-heading">
        <button
          className="android-icon-button"
          aria-label={selected ? "返回应用列表" : "返回首页"}
          type="button"
          onClick={() => (selected ? setDetailId(null) : props.onClose())}
        >
          <ChevronLeft size={18} />
        </button>
        <div>
          <h2>{selected ? selected.appName ?? selected.appId : "SDK 信息"}</h2>
          <p>
            {selected
              ? selected.appId
              : `LibChecker 应用信息 · ${props.profiles.length} 个应用`}
          </p>
        </div>
      </div>

      {notice && (
        <div className="android-message library-notice" role="status">
          {notice}
          <button
            type="button"
            aria-label="关闭 SDK 信息提示"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      )}

      {!selected && (
        <>
          <section className="android-card">
            <div className="android-section-title">
              <h2>导入 LibChecker 文件</h2>
            </div>
            <div className="ad-sdk-import">
              <input
                ref={fileInputRef}
                className="ad-sdk-file-input"
                type="file"
                accept={ACCEPTED_TYPES}
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
              <button
                className="android-button android-button-primary"
                type="button"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {busy ? (
                  <Loader2 size={16} className="ad-sdk-spin" />
                ) : (
                  <FileUp size={16} />
                )}
                {busy ? "导入中…" : "选择文件"}
              </button>
              <span className="android-muted">
                支持 .lcapps／ZIP 导出或其中的 apps.json（文件上限 32 MiB）。只读取根目录
                apps.json，匹配现有六类广告 SDK 的类名前缀；解析与保存成功后才替换现有记录。
              </span>
            </div>
          </section>

          <section className="android-card">
            <div className="library-search">
              <Search size={18} />
              <input
                className="android-input"
                type="search"
                aria-label="搜索应用名或包名"
                placeholder="输入软件名或包名"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <span className="android-muted">
              {props.profiles.length} 个应用 · {matchedCount} 个匹配到受支持的 SDK
            </span>
          </section>

          {props.profiles.length === 0 && (
            <p className="android-empty library-empty">
              还没有导入应用信息，请选择 LibChecker 导出的文件。
            </p>
          )}
          {props.profiles.length > 0 && apps.length === 0 && (
            <p className="android-empty library-empty">未找到应用</p>
          )}

          <div className="library-app-list">
            {apps.map((profile) => (
              <button
                className="android-card library-app-button"
                key={profile.appId}
                type="button"
                onClick={() => {
                  setDetailId(profile.appId);
                  setNotice(null);
                }}
              >
                <strong>{profile.appName ?? profile.appId}</strong>
                <span className="library-url">{profile.appId}</span>
                <small>
                  {profile.sdks.length === 0
                    ? "未识别到受支持的 SDK"
                    : profile.sdks
                        .map((match) => adSdkLabel(match.sdkId))
                        .join(" · ")}
                </small>
                <small>
                  {profile.versionName || profile.versionCode
                    ? `版本 ${profile.versionName ?? profile.versionCode}`
                    : "无版本信息"}{" "}
                  · 导入于 {formatTime(profile.importedAt)}
                </small>
              </button>
            ))}
          </div>
        </>
      )}

      {selected && (
        <>
          <section className="android-card">
            <div className="ad-sdk-meta">
              <span>包名：{selected.appId}</span>
              <span>
                应用版本：
                {selected.versionName ?? selected.versionCode ?? "导出未提供"}
              </span>
              {selected.versionName && selected.versionCode && (
                <span>versionCode：{selected.versionCode}</span>
              )}
              <span>
                LibChecker 分析时间：
                {selected.analyzedAt ? formatTime(selected.analyzedAt) : "导出未提供"}
              </span>
              <span>本机导入时间：{formatTime(selected.importedAt)}</span>
            </div>
            <div className="library-actions">
              <button
                className="android-button"
                type="button"
                disabled={busy}
                onClick={() => removeProfile(selected.appId)}
              >
                <Trash2 size={14} />
                删除该应用档案
              </button>
            </div>
          </section>

          <section className="android-card">
            <div className="android-section-title">
              <h2>SDK 名单（{selected.sdks.length}）</h2>
            </div>
            {selected.sdks.length === 0 ? (
              <p className="android-muted">
                未识别到受支持的 SDK。这只表示现有签名表未匹配到组件类名，不代表应用没有广告。
              </p>
            ) : (
              selected.sdks.map((match) => (
                <details className="ad-sdk-detail" key={match.sdkId}>
                  <summary>
                    {adSdkLabel(match.sdkId)} <small>{match.sdkId}</small> ·{" "}
                    {match.evidence.length} 条证据
                  </summary>
                  <ul className="ad-sdk-evidence">
                    {match.evidence.map((item, index) => (
                      <li key={index}>
                        <small>{COMPONENT_LABELS[item.componentType]}</small>{" "}
                        <code>{item.name}</code>{" "}
                        <span className="android-muted">前缀 {item.matchedPrefix}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))
            )}
            <span className="ad-sdk-hint">
              应用清单只代表该应用的组件里出现了这些 SDK 的类名前缀，不代表当前页面一定有广告，
              也不能据此判断某个节点可以点击。
            </span>
          </section>
        </>
      )}
    </section>
  );
}

/**
 * 工作区摘要：分别呈现“应用 SDK”（导入清单）与“页面特征”（当前快照命中）。
 * 两类证据互相独立；版本失配时名单只放在可展开区域里，与 prompt 的省略行为一致。
 */
export function AdSdkWorkspaceSummary({
  snapshot,
  profiles,
}: {
  snapshot: ParsedGkdSnapshot | null;
  profiles: readonly AppSdkProfile[];
}) {
  const context = useMemo(
    () =>
      snapshot
        ? resolveAdSdkContext(snapshot, findAppSdkProfile(profiles, snapshot.appId))
        : null,
    [snapshot, profiles],
  );
  if (!context) return null;

  const mismatched = context.versionStatus === "mismatched";

  return (
    <section className="android-card ad-sdk-summary" aria-label="应用 SDK 与页面特征">
      <div className="android-section-title">
        <h2>应用 SDK／页面特征</h2>
      </div>

      <div className="ad-sdk-block">
        <strong>应用 SDK</strong>
        {context.profileAppId === null ? (
          <span className="android-muted">
            未导入 {context.appId} 的 LibChecker 应用信息。
          </span>
        ) : (
          <>
            <span className="android-muted">{context.versionNote}</span>
            {context.manifest.length === 0 ? (
              <span className="android-muted">未识别到受支持的 SDK。</span>
            ) : mismatched ? (
              <details className="ad-sdk-detail">
                <summary>版本失配，查看导入清单（仅供参考，不用于生成）</summary>
                <ul className="ad-sdk-evidence">
                  {context.manifest.map((group) => (
                    <li key={group.sdkId}>
                      {group.label} <small>{group.sdkId}</small> ·{" "}
                      {group.evidence.length} 条证据
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <ul className="ad-sdk-evidence">
                {context.manifest.map((group) => (
                  <li key={group.sdkId}>
                    {group.label} <small>{group.sdkId}</small> ·{" "}
                    {group.evidence.length} 条证据
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="ad-sdk-block">
        <strong>页面特征</strong>
        {context.page.length === 0 ? (
          <span className="android-muted">当前页面未命中已知 SDK 特征。</span>
        ) : (
          context.page.map((group) => (
            <details className="ad-sdk-detail" key={group.sdkId}>
              <summary>
                {group.label} <small>{group.sdkId}</small> · {group.evidence.length} 条
              </summary>
              <ul className="ad-sdk-evidence">
                {group.evidence.map((item, index) => (
                  <li key={index}>
                    {item.source === "activityId" ? (
                      <>
                        <small>activityId</small> <code>{item.value}</code>
                      </>
                    ) : (
                      <>
                        <small>#{item.nodeId}</small>{" "}
                        <code>
                          {pageSourceLabel(item.source)}={item.value}
                        </code>
                      </>
                    )}{" "}
                    <span className="android-muted">特征 {item.signal}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))
        )}
      </div>

      <span className="ad-sdk-hint">
        静态清单只代表应用包含该 SDK；定位必须用当前节点树，只能点击当前页面实际可定位的
        关闭／跳过节点，不要仅凭 SDK 名单编造选择器。
      </span>
    </section>
  );
}

function pageSourceLabel(source: "nodeId" | "nodeVid" | "nodeName"): string {
  return { nodeId: "id", nodeVid: "vid", nodeName: "name" }[source];
}

function formatTime(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString("zh-CN");
}
