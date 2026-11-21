/** GKD app metadata from `gkd.getServerInfo()`. */
export interface SnapshotAppInfo {
  id: string;
  name?: string;
  versionCode?: number;
  versionName?: string;
  isSystem?: boolean;
}

/** 单个 UI 节点的属性——它在屏幕上的坐标、文字、是否可见、能否点击等。 */
export interface SnapshotNodeAttr {
  id: string | null;
  vid: string | null;
  name: string;
  text: string | null;
  desc: string | null;
  clickable: boolean;
  focusable: boolean;
  checkable: boolean;
  checked: boolean;
  editable: boolean;
  longClickable: boolean;
  visibleToUser: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  childCount: number;
  index: number;
  depth: number;
}

export interface SnapshotNode {
  id: number;
  pid: number;
  idQf: boolean | null;
  textQf: boolean | null;
  attr: SnapshotNodeAttr;
}

export interface NormalizedSnapshotNode extends SnapshotNode {
  children: number[];
}

/** gkd HTTP 服务直接返回的原始快照，nodes 是平铺数组。 */
export interface RawGkdSnapshot {
  id: number;
  appId: string;
  /** GKD 在桌面/系统界面等场景抓的快照没有可用的顶层 Activity，此时为 null。 */
  activityId: string | null;
  screenWidth: number;
  screenHeight: number;
  isLandscape: boolean;
  appInfo?: SnapshotAppInfo;
  device?: SnapshotDeviceInfo;
  gkdAppInfo?: SnapshotAppInfo;
  nodes: SnapshotNode[];
}

export interface SnapshotDeviceInfo {
  device?: string;
  model?: string;
  manufacturer?: string;
  brand?: string;
  sdkInt?: number;
  release?: string;
}

export interface DeviceServerInfo {
  device: SnapshotDeviceInfo;
  gkdAppInfo: SnapshotAppInfo;
}

/** 从 gkd 快照列表接口返回的摘要，用于首页列表展示。 */
export interface DeviceSnapshotSummary {
  id: number;
  appId: string;
  /** 与 RawGkdSnapshot 一致：桌面/系统界面快照可能为 null，渲染时必须兜底。 */
  activityId: string | null;
  screenWidth: number;
  screenHeight: number;
  isLandscape: boolean;
  appInfo?: SnapshotAppInfo;
  appName?: string;
  appVersionName?: string;
  appVersionCode?: number;
}

/**
 * 前端用的"解析后"快照。相比 RawGkdSnapshot：
 * - nodes 已带上 children 索引（父子关系可直接遍历）
 * - nodeById 是 Map，支持 O(1) 按 id 查节点
 * - screenshotUrl 是 blob: URL，直接传给 <img> 显示
 * - sourceName 标记来源（设备快照 / zip 导入）
 */
export interface ParsedGkdSnapshot extends Omit<RawGkdSnapshot, "nodes"> {
  nodes: NormalizedSnapshotNode[];
  nodeById: Map<number, NormalizedSnapshotNode>;
  screenshotUrl: string;
  sourceName: string;
}

/** 截图上的一个坐标点，x/y 是快照分辨率下的像素位置。 */
export interface NodePoint {
  x: number;
  y: number;
}

/**
 * nodePicker 返回的结果。
 * pickedNode 是落在坐标上的"最佳"节点，ancestors/siblings/nearbyTextNodes
 * 是候选生成需要的上下文信息。
 */
export interface NodePickResult {
  point: NodePoint;
  pickedNode: NormalizedSnapshotNode;
  containingNodes: NormalizedSnapshotNode[];
  ancestors: NormalizedSnapshotNode[];
  siblings: NormalizedSnapshotNode[];
  clickableAncestor: NormalizedSnapshotNode | null;
  nearbyTextNodes: NormalizedSnapshotNode[];
}

/** 计算节点面积（宽×高），用于排序或去重判断。 */
export function nodeArea(node: Pick<SnapshotNodeAttr, "width" | "height">): number {
  return Math.max(0, node.width) * Math.max(0, node.height);
}

/**
 * 从 SnapshotNode 中提取"对人类/UI 有意义的标签"，优先用 text/desc/vid/id/name。
 * 显示在候选卡片标题、节点树节点名、目标小结条里。
 */
export function nodeLabel(node: SnapshotNode): string {
  return (
    node.attr.text ||
    node.attr.desc ||
    node.attr.vid ||
    node.attr.id ||
    node.attr.name
  );
}
