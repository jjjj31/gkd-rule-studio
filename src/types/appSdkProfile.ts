/**
 * LibChecker 应用信息导入后的应用 SDK 档案类型。
 *
 * 档案只描述"这个应用的组件里出现了哪些受支持广告 SDK 的包名/类名前缀"，
 * 不代表当前页面一定有广告，也不代表某个节点可以点击。
 */

/** 组件类别，与 LibChecker 导出里的四类组件数组一一对应。 */
export type AppSdkComponentType = "activity" | "service" | "receiver" | "provider";

/** 单条匹配证据：哪个组件类名命中了哪个签名前缀。 */
export interface AppSdkEvidence {
  componentType: AppSdkComponentType;
  /** 完整组件类名（保留原样，便于人工核对）。 */
  name: string;
  /** 命中的签名包名/类名前缀，来自 AD_SDK_SIGNATURES.packagePrefixes。 */
  matchedPrefix: string;
}

/** 一个应用匹配到的某个受支持 SDK 及其全部证据。 */
export interface AppSdkMatch {
  /** AD_SDK_SIGNATURES 里的稳定 id。 */
  sdkId: string;
  evidence: AppSdkEvidence[];
}

/**
 * 单个应用的 SDK 档案。
 *
 * 只保存应用身份、分析/导入时间和匹配证据；不保存权限、证书、图标、
 * 完整应用清单原文或未命中的组件明细。
 */
export interface AppSdkProfile {
  /** 应用包名，同时是档案主键（按包名整条替换）。 */
  appId: string;
  appName?: string;
  /** 应用版本码，保持上游的十进制字符串语义（可能超出 JS 安全整数）。 */
  versionCode?: string;
  versionName?: string;
  /** LibChecker 导出时的分析时间（上游 analyzedAt）。 */
  analyzedAt?: string;
  /** 本机导入时间（ISO 字符串）。 */
  importedAt: string;
  /** 按签名表顺序排列的匹配结果；可以为空数组（未识别到受支持的 SDK）。 */
  sdks: AppSdkMatch[];
}
