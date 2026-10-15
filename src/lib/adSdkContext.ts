/**
 * 当前快照的广告 SDK 上下文。
 *
 * 把 LibChecker 导入的应用清单（`AppSdkProfile`）与当前快照的页面特征整理成
 * 两组互相独立的证据：
 * - 清单证据（manifest）：只代表"这个应用的组件里出现了该 SDK 的类名前缀"；
 * - 页面证据（page）：当前 Activity 与节点里出现的 SDK 类名/资源特征。
 *
 * 纯函数：不读本地存储、不联网、不发 AI 请求；调用方显式传入档案。
 * 单步 prompt、多步 prompt 与界面共用这里的同一套证据语义。
 *
 * @see libCheckerImport.ts 档案来源与本地保存
 * @see helpPrompt.ts / flowDraft.ts prompt 消费方
 * @see adSdkSignatures.ts 共享签名数据
 */
import {
  AD_SDK_SIGNATURES,
  matchAdSdkPackagePrefixes,
  matchAdSdkResourceSignals,
} from "../data/adSdkSignatures";
import type { AppSdkComponentType, AppSdkProfile } from "../types/appSdkProfile";
import type {
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";

/** 清单与快照的版本核对状态。 */
export type AdSdkVersionStatus = "matched" | "mismatched" | "unverified";

/** 页面证据的来源字段。 */
export type AdSdkPageSource = "activityId" | "nodeId" | "nodeVid" | "nodeName";

/** 清单证据：某个组件类名命中了某个签名前缀。 */
export interface AdSdkManifestEvidence {
  componentType: AppSdkComponentType;
  name: string;
  matchedPrefix: string;
}

/** 页面证据：当前 Activity 或某个节点的字段命中了 SDK 特征。 */
export interface AdSdkPageEvidence {
  source: AdSdkPageSource;
  /** 命中特征：包名/类名前缀或 SDK 专属资源名。 */
  signal: string;
  /** 命中的原始字段值。 */
  value: string;
  /** 节点编号；activityId 来源时为 null。 */
  nodeId: number | null;
  /** 收集时的快照 activityId，便于展示来源页面。 */
  activityId: string | null;
}

/** 一个 SDK 及其证据；按签名表顺序稳定输出。 */
export interface AdSdkEvidenceGroup<E> {
  sdkId: string;
  label: string;
  evidence: E[];
}

/** 当前快照的完整 SDK 上下文。 */
export interface AdSdkContext {
  appId: string;
  /** 关联到的档案包名；未导入或包名不同时为 null。 */
  profileAppId: string | null;
  appName: string | null;
  versionStatus: AdSdkVersionStatus;
  /** 版本核对说明，界面与 prompt 直接展示。 */
  versionNote: string;
  /** 导入清单证据；版本失配时仍保留，由 prompt 决定是否省略名单。 */
  manifest: Array<AdSdkEvidenceGroup<AdSdkManifestEvidence>>;
  /** 当前页面证据，独立于导入结果收集。 */
  page: Array<AdSdkEvidenceGroup<AdSdkPageEvidence>>;
}

/** 按精确包名找档案；找不到返回 null（不做应用名关联）。 */
export function findAppSdkProfile(
  profiles: readonly AppSdkProfile[] | null | undefined,
  appId: string,
): AppSdkProfile | null {
  if (!profiles) return null;
  return profiles.find((profile) => profile.appId === appId) ?? null;
}

/**
 * 组装当前快照的 SDK 上下文。
 *
 * 只关联 `profile.appId === snapshot.appId` 的档案；版本失配的档案名单仍保留在
 * 返回值里（供详情查看），由 prompt 格式化时省略。页面证据始终独立收集，不受
 * 清单有无或版本状态影响。输入对象不被修改。
 */
export function resolveAdSdkContext(
  snapshot: ParsedGkdSnapshot,
  profile?: AppSdkProfile | null,
): AdSdkContext {
  const linked = profile && profile.appId === snapshot.appId ? profile : null;
  const version = resolveVersionStatus(snapshot, linked);
  return {
    appId: snapshot.appId,
    profileAppId: linked?.appId ?? null,
    appName: linked?.appName ?? null,
    versionStatus: version.status,
    versionNote: version.note,
    manifest: linked ? buildManifestGroups(linked) : [],
    page: collectPageGroups(snapshot),
  };
}

export interface FormatAdSdkContextOptions {
  /** 每行前缀，多步 prompt 用它把整段缩进到步骤下面。 */
  indent?: string;
  /** 每个 SDK 最多展示的证据条数，默认 2。 */
  maxEvidencePerSdk?: number;
}

/**
 * 把上下文格式化成 prompt 行。
 *
 * 两类证据都缺失（未导入该应用、页面也没有 SDK 特征）时返回空数组，保持未使用
 * LibChecker 的用户 prompt 完全不变。每 SDK 最多展示 `maxEvidencePerSdk` 条
 * 清单证据和同样数量的页面证据，顺序稳定。
 */
export function formatAdSdkContextLines(
  context: AdSdkContext,
  options: FormatAdSdkContextOptions = {},
): string[] {
  const indent = options.indent ?? "";
  const maxEvidence = options.maxEvidencePerSdk ?? 2;
  const hasManifest = context.profileAppId !== null;
  const hasPage = context.page.length > 0;
  if (!hasManifest && !hasPage) return [];

  const lines: string[] = [`${indent}- 应用 SDK 上下文：`];
  lines.push(`${indent}  - ${context.versionNote}`);

  if (!hasManifest) {
    lines.push(
      `${indent}  - 导入清单：未导入 ${context.appId} 的 LibChecker 应用信息。`,
    );
  } else if (context.versionStatus === "mismatched") {
    lines.push(
      `${indent}  - 导入清单：版本失配，已省略 SDK 名单（仅供详情查看，不用于生成）。`,
    );
  } else {
    const title =
      context.versionStatus === "unverified"
        ? "导入清单（版本未核对，仅作背景；只代表应用包含该 SDK）"
        : "导入清单（只代表应用包含该 SDK，不代表当前页面）";
    if (context.manifest.length === 0) {
      lines.push(`${indent}  - ${title}：未识别到受支持的 SDK。`);
    } else {
      lines.push(`${indent}  - ${title}：`);
      for (const group of context.manifest) {
        lines.push(
          `${indent}    - ${group.sdkId} / ${group.label}：${formatManifestEvidence(group.evidence, maxEvidence)}`,
        );
      }
    }
  }

  if (hasPage) {
    lines.push(`${indent}  - 当前页面命中（结合当前节点树确认）：`);
    for (const group of context.page) {
      lines.push(
        `${indent}    - ${group.sdkId} / ${group.label}：${formatPageEvidence(group.evidence, maxEvidence)}`,
      );
    }
  } else {
    lines.push(`${indent}  - 当前页面命中：页面未命中已知 SDK 特征。`);
  }

  lines.push(`${indent}  - 定位提示：${locateHint(hasManifest, hasPage)}`);
  return lines;
}

function locateHint(hasManifest: boolean, hasPage: boolean): string {
  if (hasManifest && hasPage) {
    return "静态清单只代表应用包含该 SDK，定位必须用当前节点树；只能点击当前页面实际可定位的关闭/跳过节点，不要仅凭 SDK 名单编造选择器。";
  }
  if (hasManifest) {
    return "静态清单只代表应用包含该 SDK，当前页面未命中已知 SDK 特征；必须用当前节点树定位，不要仅凭 SDK 名单编造选择器。";
  }
  return "页面特征仍需结合当前节点树确认；只能点击当前页面实际可定位的关闭/跳过节点。";
}

function resolveVersionStatus(
  snapshot: ParsedGkdSnapshot,
  profile: AppSdkProfile | null,
): { status: AdSdkVersionStatus; note: string } {
  if (!profile) {
    return {
      status: "unverified",
      note: "版本核对：未导入该应用的 SDK 信息。",
    };
  }

  const profileCode = normalizeVersionToken(profile.versionCode);
  const snapshotCode = normalizeVersionToken(snapshot.appInfo?.versionCode);
  if (profileCode !== null && snapshotCode !== null) {
    const same = versionTokensEqual(profileCode, snapshotCode);
    return {
      status: same ? "matched" : "mismatched",
      note: same
        ? `版本核对：相符（versionCode ${snapshotCode}）。`
        : `版本核对：导入信息与快照版本不同（导入 versionCode ${profileCode} / 快照 versionCode ${snapshotCode}）。`,
    };
  }

  const profileName = normalizeVersionToken(profile.versionName);
  const snapshotName = normalizeVersionToken(snapshot.appInfo?.versionName);
  if (profileName !== null && snapshotName !== null) {
    const same = versionTokensEqual(profileName, snapshotName);
    return {
      status: same ? "matched" : "mismatched",
      note: same
        ? `版本核对：相符（versionName ${snapshotName}）。`
        : `版本核对：导入信息与快照版本不同（导入 versionName ${profileName} / 快照 versionName ${snapshotName}）。`,
    };
  }

  const reason =
    profileCode === null && profileName === null
      ? "导入信息缺少版本码和版本名"
      : snapshotCode === null && snapshotName === null
        ? "快照缺少版本码和版本名"
        : "双方版本字段类型不同，无法比较";
  return {
    status: "unverified",
    note: `版本核对：版本未核对（${reason}）。`,
  };
}

function normalizeVersionToken(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

/** 十进制整数用 BigInt 比较（版本码可能超出安全整数范围），否则按字符串比较。 */
function versionTokensEqual(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    try {
      return BigInt(a) === BigInt(b);
    } catch {
      return a === b;
    }
  }
  return a === b;
}

function buildManifestGroups(
  profile: AppSdkProfile,
): Array<AdSdkEvidenceGroup<AdSdkManifestEvidence>> {
  const byId = new Map(profile.sdks.map((match) => [match.sdkId, match]));
  return AD_SDK_SIGNATURES.flatMap((sdk) => {
    const match = byId.get(sdk.id);
    if (!match || match.evidence.length === 0) return [];
    return [
      {
        sdkId: sdk.id,
        label: sdk.label,
        evidence: match.evidence.map((item) => ({
          componentType: item.componentType,
          name: item.name,
          matchedPrefix: item.matchedPrefix,
        })),
      },
    ];
  });
}

function collectPageGroups(
  snapshot: ParsedGkdSnapshot,
): Array<AdSdkEvidenceGroup<AdSdkPageEvidence>> {
  const bySdkId = new Map<string, AdSdkPageEvidence[]>();
  const seen = new Set<string>();
  const add = (sdkId: string, evidence: AdSdkPageEvidence) => {
    const key = [
      sdkId,
      evidence.source,
      evidence.signal,
      evidence.value,
      evidence.nodeId ?? "",
    ].join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    const list = bySdkId.get(sdkId) ?? [];
    list.push(evidence);
    bySdkId.set(sdkId, list);
  };

  const activityId = snapshot.activityId;
  if (activityId) {
    for (const match of matchAdSdkPackagePrefixes(activityId)) {
      add(match.sdk.id, {
        source: "activityId",
        signal: match.prefix,
        value: activityId,
        nodeId: null,
        activityId,
      });
    }
  }

  for (const node of snapshot.nodes) {
    collectNodeEvidence(node, activityId, add);
  }

  return AD_SDK_SIGNATURES.flatMap((sdk) => {
    const evidence = bySdkId.get(sdk.id);
    if (!evidence || evidence.length === 0) return [];
    return [{ sdkId: sdk.id, label: sdk.label, evidence }];
  });
}

function collectNodeEvidence(
  node: NormalizedSnapshotNode,
  activityId: string | null,
  add: (sdkId: string, evidence: AdSdkPageEvidence) => void,
): void {
  const fields: ReadonlyArray<{ source: AdSdkPageSource; value: string | null }> = [
    { source: "nodeId", value: node.attr.id },
    { source: "nodeVid", value: node.attr.vid },
    { source: "nodeName", value: node.attr.name },
  ];
  for (const { source, value } of fields) {
    if (!value) continue;
    for (const match of matchAdSdkPackagePrefixes(value)) {
      add(match.sdk.id, {
        source,
        signal: match.prefix,
        value,
        nodeId: node.id,
        activityId,
      });
    }
    for (const match of matchAdSdkResourceSignals(value)) {
      add(match.sdk.id, {
        source,
        signal: match.signal,
        value,
        nodeId: node.id,
        activityId,
      });
    }
  }
}

const PAGE_SOURCE_LABEL: Record<AdSdkPageSource, string> = {
  activityId: "activityId",
  nodeId: "id",
  nodeVid: "vid",
  nodeName: "name",
};

function formatManifestEvidence(
  evidence: readonly AdSdkManifestEvidence[],
  max: number,
): string {
  const shown = evidence
    .slice(0, max)
    .map((item) => `${item.componentType} ${item.name}`);
  if (evidence.length > shown.length) shown.push(`…等 ${evidence.length} 条`);
  return shown.join("；");
}

function formatPageEvidence(
  evidence: readonly AdSdkPageEvidence[],
  max: number,
): string {
  const shown = evidence.slice(0, max).map((item) =>
    item.source === "activityId"
      ? `activityId ${item.value}（前缀 ${item.signal}）`
      : `#${item.nodeId} ${PAGE_SOURCE_LABEL[item.source]}=${item.value}（特征 ${item.signal}）`,
  );
  if (evidence.length > shown.length) shown.push(`…等 ${evidence.length} 条`);
  return shown.join("；");
}
