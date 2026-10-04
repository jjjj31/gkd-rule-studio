/**
 * 广告 SDK 界面签名表。
 *
 * 作用：从快照节点里识别"这是哪个广告 SDK 的广告"，用于
 * - 给 SDK 专属的跳过/关闭控件定向加分（riskScoring）；
 * - 给候选规则打 SDK 标签、落到「开屏广告-穿山甲」这类分组。
 *
 * 包名前缀与资源名来自社区订阅的实测规则（AIsouler / yuuouu 等提交）与厂商
 * 文档；只收录可核实的特征，未证实的 SDK 不写 skipSignals，避免误加分。
 * 匹配一律小写子串。
 */
export interface AdSdkSignature {
  /** 稳定 id，用于测试与去重。 */
  id: string;
  /** 展示名。 */
  label: string;
  /** 包名 / 类名前缀；命中节点 id/vid/name 即认为该 SDK 在场。 */
  packagePrefixes: string[];
  /** 广告容器资源特征（不用于加分，仅用于识别与展示）。 */
  containerSignals: string[];
  /** SDK 专属的"跳过/关闭"控件资源特征；命中即视为可直接点击的关闭位。 */
  skipSignals: string[];
}

export const AD_SDK_SIGNATURES: readonly AdSdkSignature[] = [
  {
    id: "pangle",
    label: "穿山甲",
    // 新包名 com.byted.pangle，旧包名 com.bytedance.sdk.openadsdk 仍大量存在。
    packagePrefixes: ["com.byted.pangle", "com.bytedance.sdk.openadsdk"],
    containerSignals: ["tt_splash", "tt_ad", "tt_native"],
    skipSignals: [
      "tt_splash_skip_btn",
      "tt_splash_skip_view",
      "tt_splash_skip_frame",
      "tt_skip_btn",
    ],
  },
  {
    id: "kwad",
    label: "快手",
    packagePrefixes: ["com.kwad.sdk", "com.kwad"],
    containerSignals: ["ksad_container", "ksad_splash"],
    skipSignals: ["ksad_skip", "ksad_splash_skip"],
  },
  {
    id: "sigmob",
    label: "Sigmob",
    packagePrefixes: ["com.sigmob.sdk"],
    containerSignals: ["sigmob_ad", "ad_area"],
    skipSignals: ["sigmob_close"],
  },
  {
    id: "gdt",
    label: "优量汇",
    packagePrefixes: ["com.qq.e"],
    // 优量汇的跳过/热区由 riskScoring 既有的 hotarea/ptgadvertlayout 逻辑处理，
    // 这里不重复加分。
    containerSignals: ["ptgadvertlayout", "hotarea", "splashhotarea"],
    skipSignals: [],
  },
  {
    id: "jd",
    label: "京媒",
    packagePrefixes: ["com.jd.ad.sdk"],
    containerSignals: ["jad_"],
    skipSignals: [],
  },
  {
    id: "mbridge",
    label: "Mintegral",
    packagePrefixes: ["com.mbridge.msdk"],
    containerSignals: ["mbridge_"],
    skipSignals: [],
  },
];

export interface AdSdkSkipMatch {
  sdk: AdSdkSignature;
  signal: string;
}

function toLower(value: string | null | undefined): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** 节点用于识别 SDK 的字段拼接（小写）。 */
function nodeIdentifiers(node: {
  attr: { id: string | null; vid: string | null; name: string };
}): string {
  return [node.attr.id, node.attr.vid, node.attr.name].map(toLower).join(" ");
}

/** 从单个节点识别所属 SDK（按包名/类名前缀，或容器/跳过控件资源特征）。 */
export function detectAdSdkForNode(node: {
  attr: { id: string | null; vid: string | null; name: string };
}): AdSdkSignature | null {
  const value = nodeIdentifiers(node);
  return (
    AD_SDK_SIGNATURES.find((sdk) =>
      [...sdk.packagePrefixes, ...sdk.containerSignals, ...sdk.skipSignals].some(
        (token) => value.includes(token),
      ),
    ) ?? null
  );
}

/** 从整棵快照里找出出现的 SDK（用于分组标签 / 风险提示）。 */
export function detectAdSdkInSnapshot(snapshot: {
  nodes: Array<{ attr: { id: string | null; vid: string | null; name: string } }>;
}): AdSdkSignature | null {
  for (const node of snapshot.nodes) {
    const sdk = detectAdSdkForNode(node);
    if (sdk) return sdk;
  }
  return null;
}

/**
 * 目标节点是否命中某个 SDK 的专属跳过控件特征。
 * 只认 SDK 专属特征（如 tt_splash_skip_btn），不认通用的 skip/close 词，
 * 避免把广告遮罩热区误判成跳过按钮。
 */
export function matchAdSdkSkipSignal(node: {
  attr: { id: string | null; vid: string | null; name: string; text: string | null; desc: string | null };
}): AdSdkSkipMatch | null {
  const value = [
    node.attr.id,
    node.attr.vid,
    node.attr.name,
    node.attr.text,
    node.attr.desc,
  ]
    .map(toLower)
    .join(" ");
  for (const sdk of AD_SDK_SIGNATURES) {
    const signal = sdk.skipSignals.find((token) => value.includes(token));
    if (signal) return { sdk, signal };
  }
  return null;
}
