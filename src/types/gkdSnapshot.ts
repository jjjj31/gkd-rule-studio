export interface SnapshotAppInfo {
  id: string;
  name?: string;
  versionCode?: number;
  versionName?: string;
  isSystem?: boolean;
}

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

export interface RawGkdSnapshot {
  id: number;
  appId: string;
  activityId: string;
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

export interface DeviceSnapshotSummary {
  id: number;
  appId: string;
  activityId: string;
  screenWidth: number;
  screenHeight: number;
  isLandscape: boolean;
  appInfo?: SnapshotAppInfo;
  appName?: string;
  appVersionName?: string;
  appVersionCode?: number;
}

export interface ParsedGkdSnapshot extends Omit<RawGkdSnapshot, "nodes"> {
  nodes: NormalizedSnapshotNode[];
  nodeById: Map<number, NormalizedSnapshotNode>;
  screenshotUrl: string;
  sourceName: string;
}

export interface NodePoint {
  x: number;
  y: number;
}

export interface NodePickResult {
  point: NodePoint;
  pickedNode: NormalizedSnapshotNode;
  containingNodes: NormalizedSnapshotNode[];
  ancestors: NormalizedSnapshotNode[];
  siblings: NormalizedSnapshotNode[];
  clickableAncestor: NormalizedSnapshotNode | null;
  nearbyTextNodes: NormalizedSnapshotNode[];
}

export function nodeArea(node: Pick<SnapshotNodeAttr, "width" | "height">): number {
  return Math.max(0, node.width) * Math.max(0, node.height);
}

export function nodeLabel(node: SnapshotNode): string {
  return (
    node.attr.text ||
    node.attr.desc ||
    node.attr.vid ||
    node.attr.id ||
    node.attr.name
  );
}
