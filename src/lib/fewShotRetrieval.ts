/**
 * 方案 B：基于真机真值库的 Few-Shot / RAG 检索。
 *
 * 把目标控件和它的局部上下文抽成离散特征 token，用加权余弦在官方真值库里找最相似的
 * 历史案例，拼成 few-shot prompt 交给大模型仿写。不依赖向量数据库和网络，纯本地计算。
 *
 * @see .scratch/dataset-crawler/clean_dataset.py 生成 fewshot_library.jsonl 的同一套特征
 */
import distilledCompactRaw from "../data/distilledFewShot.json";
import type {
  NodePickResult,
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";

export interface FewShotTarget {
  id: number;
  name: string;
  vid: string | null;
  text: string | null;
  desc: string | null;
  clickable: boolean;
  childCount: number | null;
  depth: number | null;
  bounds: number[];
}

export interface FewShotNodeBrief {
  id: number;
  name: string;
  vid: string | null;
  text: string | null;
  desc: string | null;
  clickable: boolean;
  visible: boolean;
  anchorWords?: string[];
}

export interface FewShotContext {
  ancestors: FewShotNodeBrief[];
  siblings: FewShotNodeBrief[];
  anchors: FewShotNodeBrief[];
  targetPath: string;
}

export interface FewShotRecord {
  id: string;
  appId: string;
  appName: string;
  groupName: string | null;
  selector: string;
  selectorShape: {
    kind: string;
    hasAt: boolean;
    hasUnion: boolean;
    hasHierarchy: boolean;
    hasSibling: boolean;
    attrs: string[];
  };
  target: FewShotTarget;
  context: FewShotContext;
  features: string[];
}

export interface FewShotQuery {
  target: FewShotTarget;
  context: FewShotContext;
  features: string[];
}

export interface FewShotHit {
  record: FewShotRecord;
  score: number;
}

/** 与清洗脚本保持一致的语义锚点词表。 */
export const ANCHOR_WORDS = [
  "广告", "跳过", "关闭", "取消", "跳过广告", "跳过此广告", "关闭广告",
  "下次", "暂不", "以后再说", "稍后", "忽略", "残忍拒绝", "不感兴趣",
  "权限", "通知", "定位", "更新", "升级", "公告", "提示", "评分", "评价",
  "推荐", "反馈", "领取", "打开", "下载", "安装",
];

const TOKEN_WEIGHTS: Array<[RegExp, number]> = [
  [/^anchor:/, 1.6],
  [/^cls:/, 1.2],
  [/^vid:/, 1.2],
  [/^kind:/, 0.9],
  [/^attr:/, 0.7],
  [/^op:/, 0.6],
  [/^txt:/, 0.5],
  [/^desc:/, 0.5],
  [/^click:/, 0.5],
  [/^cc:/, 0.4],
  [/^depth:/, 0.3],
];

function tokenWeight(token: string): number {
  for (const [pattern, weight] of TOKEN_WEIGHTS) {
    if (pattern.test(token)) return weight;
  }
  return 0.2;
}

function bucket(value: number | null, cuts: Array<[number, string]>): string {
  if (value === null || value === undefined) return "na";
  for (const [edge, label] of cuts) {
    if (value <= edge) return label;
  }
  return cuts[cuts.length - 1][1] + "+";
}

export function shortClassName(name: string): string {
  return name.split(".").pop() || name;
}

/** 从目标与上下文生成检索特征 token。 */
export function buildFeatureTokens(input: {
  target: FewShotTarget;
  context: FewShotContext;
  selectorShape?: FewShotRecord["selectorShape"];
}): string[] {
  const { target, context, selectorShape } = input;
  const tokens = new Set<string>([
    "cls:" + shortClassName(target.name || "View"),
    "vid:" + (target.vid ? "yes" : "no"),
    "txt:" + (target.text ? "yes" : "no"),
    "desc:" + (target.desc ? "yes" : "no"),
    "click:" + (target.clickable ? "yes" : "no"),
    "cc:" + bucket(target.childCount, [[0, "0"], [1, "1"], [3, "2-3"]]),
    "depth:" + bucket(target.depth, [[3, "d0-3"], [5, "d4-5"], [8, "d6-8"]]),
  ]);
  if (selectorShape) {
    tokens.add("kind:" + selectorShape.kind);
    if (selectorShape.hasAt) tokens.add("op:at");
    if (selectorShape.hasUnion) tokens.add("op:union");
    for (const attr of selectorShape.attrs) tokens.add("attr:" + attr);
  }
  for (const anchor of context.anchors) {
    for (const word of anchor.anchorWords ?? []) tokens.add("anchor:" + word);
  }
  return [...tokens].sort();
}

/** 加权余弦相似度。权重只看 token 前缀，因此分母可以缓存。 */
export function featureSimilarity(a: string[], b: string[]): number {
  const left = new Map<string, number>();
  let normA = 0;
  for (const token of a) {
    const weight = tokenWeight(token);
    left.set(token, weight);
    normA += weight * weight;
  }
  let normB = 0;
  let dot = 0;
  for (const token of b) {
    const weight = tokenWeight(token);
    normB += weight * weight;
    const other = left.get(token);
    if (other !== undefined) dot += other * weight;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** 在真值库里检索 Top-K 相似案例。 */
export function retrieveFewShot(
  library: FewShotRecord[],
  query: FewShotQuery,
  k = 3,
): FewShotHit[] {
  const hits: FewShotHit[] = [];
  for (const record of library) {
    const score = featureSimilarity(query.features, record.features);
    hits.push({ record, score });
  }
  // 特征相同时（真机里同类控件很多），优先给更短、更简单的答案做示例，模型更好仿写。
  hits.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
    const lengthDiff = a.record.selector.length - b.record.selector.length;
    if (lengthDiff !== 0) return lengthDiff;
    return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
  });

  const seen = new Set<string>();
  const picked: FewShotHit[] = [];
  for (const hit of hits) {
    if (seen.has(hit.record.selector)) continue;
    seen.add(hit.record.selector);
    picked.push(hit);
    if (picked.length >= Math.max(0, k)) break;
  }
  return picked;
}

function describeNode(node: FewShotNodeBrief): string {
  const parts = [shortClassName(node.name)];
  if (node.vid) parts.push(`vid="${node.vid}"`);
  if (node.text) parts.push(`text="${node.text}"`);
  if (node.desc) parts.push(`desc="${node.desc}"`);
  parts.push(node.clickable ? "clickable=true" : "clickable=false");
  return parts.join(" ");
}

function describeTarget(target: FewShotTarget): string {
  const parts = [shortClassName(target.name)];
  if (target.vid) parts.push(`vid="${target.vid}"`);
  if (target.text) parts.push(`text="${target.text}"`);
  if (target.desc) parts.push(`desc="${target.desc}"`);
  parts.push(target.clickable ? "clickable=true" : "clickable=false");
  if (target.childCount !== null) parts.push(`childCount=${target.childCount}`);
  if (target.bounds?.length === 4) {
    const [left, top, right, bottom] = target.bounds;
    parts.push(`bounds=[${left},${top},${right},${bottom}]`);
  }
  return parts.join(" ");
}

function describeTargetForExample(target: FewShotTarget): string {
  const parts = [shortClassName(target.name)];
  if (target.vid) parts.push(`vid="${target.vid}"`);
  if (target.text) parts.push(`text="${target.text}"`);
  if (target.desc) parts.push(`desc="${target.desc}"`);
  parts.push(target.clickable ? "clickable=true" : "clickable=false");
  if (target.childCount !== null) parts.push(`childCount=${target.childCount}`);
  return parts.join(" ");
}

/** 拼装可直接喂给大模型的 few-shot prompt。 */
export function buildFewShotPrompt(
  query: FewShotQuery,
  examples: FewShotHit[],
): string {
  const lines: string[] = [];
  lines.push("你是 GKD 规则专家。根据给定的目标控件和局部界面上下文，输出一条 GKD 选择器。");
  lines.push("");
  lines.push("## 目标控件（必须唯一命中它）");
  lines.push(describeTarget(query.target));
  lines.push(`层级路径：${query.context.targetPath || "未知"}`);

  if (query.context.siblings.length > 0) {
    lines.push("");
    lines.push("## 同层兄弟节点");
    for (const sibling of query.context.siblings.slice(0, 8)) {
      lines.push(`- ${describeNode(sibling)}`);
    }
  }
  if (query.context.anchors.length > 0) {
    lines.push("");
    lines.push("## 语义锚点");
    for (const anchor of query.context.anchors.slice(0, 6)) {
      const words = anchor.anchorWords?.length ? ` (锚点: ${anchor.anchorWords.join("/")})` : "";
      lines.push(`- ${describeNode(anchor)}${words}`);
    }
  }

  if (examples.length > 0) {
    lines.push("");
    lines.push("## 相似历史案例（官方标准答案）");
    examples.forEach((hit, index) => {
      lines.push(
        `案例 ${index + 1}（相似度 ${hit.score.toFixed(2)}，来自 ${hit.record.appName}）：`,
      );
      lines.push(`  目标：${describeTarget(hit.record.target)}`);
      const siblings = hit.record.context.siblings.slice(0, 3).map(describeNode);
      if (siblings.length > 0) lines.push(`  上下文：${siblings.join("；")}`);
      lines.push(`  答案：${hit.record.selector}`);
    });
  }

  lines.push("");
  lines.push("## 输出要求");
  lines.push("- 只输出选择器字符串，不要解释、不要代码块");
  lines.push("- 优先使用 vid/id/text/desc 等稳定属性；目标没有稳定属性时，用相邻文字做锚点");
  lines.push("- 选择器必须在当前界面上唯一命中目标控件，不能点到广告或其它按钮");
  return lines.join("\n");
}

/** 把检索到的官方案例格式化成完整规则 prompt 的一段；只教写法，不泄漏当前答案。 */
export function formatFewShotExamples(examples: FewShotHit[]): string[] {
  const lines: string[] = [];
  examples.forEach((hit, index) => {
    lines.push(
      `案例 ${index + 1}（相似度 ${hit.score.toFixed(2)}，来自 ${hit.record.appName}，形态 ${hit.record.selectorShape.kind}）：`,
    );
    lines.push(`  目标：${describeTargetForExample(hit.record.target)}`);
    const siblings = hit.record.context.siblings.slice(0, 3).map(describeNode);
    if (siblings.length > 0) lines.push(`  上下文：${siblings.join("；")}`);
    lines.push(`  答案：${hit.record.selector}`);
  });
  return lines;
}

function toBrief(node: NormalizedSnapshotNode): FewShotNodeBrief {
  const hits: string[] = [];
  const text = `${node.attr.text ?? ""} ${node.attr.desc ?? ""} ${node.attr.vid ?? ""}`.toLowerCase();
  for (const word of ANCHOR_WORDS) {
    if (text.includes(word.toLowerCase())) hits.push(word);
  }
  return {
    id: node.id,
    name: node.attr.name,
    vid: node.attr.vid,
    text: node.attr.text,
    desc: node.attr.desc,
    clickable: node.attr.clickable,
    visible: node.attr.visibleToUser,
    ...(hits.length > 0 ? { anchorWords: [...new Set(hits)] } : {}),
  };
}

/** 从实时快照构建检索 query，供软件内直接调用。 */
export function buildQueryFromSnapshot(
  snapshot: ParsedGkdSnapshot,
  targetNode: NormalizedSnapshotNode,
  ancestors: NormalizedSnapshotNode[],
  siblings: NormalizedSnapshotNode[],
): FewShotQuery {
  const target: FewShotTarget = {
    id: targetNode.id,
    name: targetNode.attr.name,
    vid: targetNode.attr.vid,
    text: targetNode.attr.text,
    desc: targetNode.attr.desc,
    clickable: targetNode.attr.clickable,
    childCount: targetNode.attr.childCount,
    depth: targetNode.attr.depth,
    bounds: [
      targetNode.attr.left,
      targetNode.attr.top,
      targetNode.attr.right,
      targetNode.attr.bottom,
    ],
  };
  const ancestorBriefs = ancestors.slice(0, 4).map(toBrief);
  const siblingBriefs = siblings
    .filter((node) => node.attr.visibleToUser)
    .slice(0, 8)
    .map(toBrief);

  const scanIds = new Set<number>([
    targetNode.pid,
    ...(ancestors.length > 0 ? [ancestors[0].id] : []),
  ]);
  const anchors: FewShotNodeBrief[] = [];
  for (const node of snapshot.nodes) {
    if (node.id === targetNode.id || !scanIds.has(node.pid)) continue;
    if (!node.attr.visibleToUser) continue;
    const brief = toBrief(node);
    if (brief.anchorWords?.length) anchors.push(brief);
    if (anchors.length >= 8) break;
  }

  const context: FewShotContext = {
    ancestors: ancestorBriefs,
    siblings: siblingBriefs,
    anchors,
    targetPath: [
      ...ancestorBriefs.map((node) => shortClassName(node.name)).reverse(),
      shortClassName(targetNode.attr.name),
    ].join(" > "),
  };
  return { target, context, features: buildFeatureTokens({ target, context }) };
}

interface CompactDistilledEntry {
  i: string;
  a: string;
  n: string;
  k: string;
  s: string;
  t: [string, string | null, string | null, string | null, number, number | null];
  b: Array<[string, string | null, string | null, string | null, number]>;
  f: string[];
}

const OBFUSCATED_VID_SET = new Set([
  "obfuscated",
  "0_resource_name_obfuscated",
  "arg",
  "pdd",
  "unused_res_a",
]);

const ON_DEVICE_TOKEN_WEIGHTS: Array<[RegExp, number]> = [
  [/^vid:/, 1.6],
  [/^click:/, 1.5],
  [/^txt:/, 1.4],
  [/^anchor:/, 1.4],
  [/^cls:/, 1.1],
  [/^ctx:/, 1.0],
  [/^desc:/, 0.5],
  [/^cc:/, 0.4],
  [/^depth:/, 0.3],
];

function onDeviceTokenWeight(token: string): number {
  for (const [pattern, weight] of ON_DEVICE_TOKEN_WEIGHTS) {
    if (pattern.test(token)) return weight;
  }
  return 0.2;
}

function onDeviceSimilarity(a: string[], b: string[]): number {
  const left = new Map<string, number>();
  let normA = 0;
  for (const token of a) {
    const weight = onDeviceTokenWeight(token);
    left.set(token, weight);
    normA += weight * weight;
  }
  let normB = 0;
  let dot = 0;
  for (const token of b) {
    const weight = onDeviceTokenWeight(token);
    normB += weight * weight;
    const other = left.get(token);
    if (other !== undefined) dot += other * weight;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

function isObfuscatedVidValue(vid: string | null | undefined): boolean {
  if (!vid) return false;
  if (OBFUSCATED_VID_SET.has(vid)) return true;
  if (/^unused_res_/i.test(vid)) return true;
  if (/^[a-z0-9]{1,3}$/.test(vid) && /\d/.test(vid)) return true;
  return false;
}

function isDynamicCountdownValue(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = text.trim();
  return (
    /^跳过\s*\d+\s*s?$/i.test(s) ||
    /^\d+\s*s?\s*后?\s*跳过$/i.test(s) ||
    /^skip\s*\d+\s*s?$/i.test(s)
  );
}

let hydratedDistilledLibrary: Array<{
  record: FewShotRecord;
  obsTokens: string[];
}> | null = null;

/** 读取内置于端侧包中的百 KB 级蒸馏官方案例库。 */
export function getDistilledFewShotLibrary(): FewShotRecord[] {
  return ensureDistilledEntries().map((entry) => entry.record);
}

function ensureDistilledEntries(): Array<{
  record: FewShotRecord;
  obsTokens: string[];
}> {
  if (hydratedDistilledLibrary) return hydratedDistilledLibrary;
  const raw = distilledCompactRaw as unknown as CompactDistilledEntry[];
  hydratedDistilledLibrary = raw.map((entry) => {
    const [cls, vid, text, desc, clickableNum, childCount] = entry.t;
    const siblings: FewShotNodeBrief[] = entry.b.map((sib, idx) => ({
      id: idx + 2,
      name: sib[0],
      vid: sib[1],
      text: sib[2],
      desc: sib[3],
      clickable: sib[4] === 1,
      visible: true,
    }));
    const record: FewShotRecord = {
      id: entry.i,
      appId: entry.a,
      appName: entry.n,
      groupName: null,
      selector: entry.s,
      selectorShape: {
        kind: entry.k,
        hasAt: entry.s.includes("@"),
        hasUnion: entry.s.includes("||") || entry.s.includes(","),
        hasHierarchy: entry.k === "hierarchy",
        hasSibling: entry.k === "sibling",
        attrs: [],
      },
      target: {
        id: 1,
        name: cls,
        vid,
        text,
        desc,
        clickable: clickableNum === 1,
        childCount,
        depth: null,
        bounds: [],
      },
      context: {
        ancestors: [],
        siblings,
        anchors: [],
        targetPath: cls,
      },
      features: entry.f,
    };
    return { record, obsTokens: entry.f };
  });
  return hydratedDistilledLibrary;
}

/** 从实时快照与选点提取零真值泄漏的可观测特征，检索端侧蒸馏案例（兼顾跨应用与写法形态多样性）。 */
export function retrieveOnDeviceFewShot({
  snapshot,
  pickResult,
  k = 3,
}: {
  snapshot: ParsedGkdSnapshot;
  pickResult: NodePickResult | null;
  k?: number;
}): FewShotHit[] {
  if (!pickResult || k <= 0) return [];
  const targetNode = pickResult.pickedNode;
  const visibleNodes = snapshot.nodes.filter((n) => n.attr.visibleToUser);
  const tokens = new Set<string>([
    "cls:" + shortClassName(targetNode.attr.name || "View"),
    "desc:" + (targetNode.attr.desc ? "yes" : "no"),
    "cc:" + bucket(targetNode.attr.childCount, [[0, "0"], [1, "1"], [3, "2-3"]]),
    "depth:" + bucket(targetNode.attr.depth, [[3, "d0-3"], [5, "d4-5"], [8, "d6-8"]]),
  ]);

  if (!targetNode.attr.vid) {
    tokens.add("vid:no");
  } else if (isObfuscatedVidValue(targetNode.attr.vid)) {
    tokens.add("vid:obfuscated");
  } else {
    const vidHits = visibleNodes.filter((n) => n.attr.vid === targetNode.attr.vid).length;
    tokens.add(vidHits > 1 ? "vid:multi" : "vid:unique");
  }

  if (!targetNode.attr.text) {
    tokens.add("txt:no");
  } else if (isDynamicCountdownValue(targetNode.attr.text)) {
    tokens.add("txt:countdown");
  } else {
    const txtHits = visibleNodes.filter((n) => n.attr.text === targetNode.attr.text).length;
    tokens.add(txtHits > 1 ? "txt:multi" : "txt:unique");
  }

  if (targetNode.attr.clickable) {
    tokens.add("click:self");
    const wrapsTextChild = visibleNodes.some(
      (n) =>
        n.pid === targetNode.id &&
        Boolean(n.attr.text || n.attr.desc) &&
        !n.attr.clickable,
    );
    if (!targetNode.attr.text && wrapsTextChild) {
      tokens.add("click:wraps_text_child");
    }
  } else {
    const firstClickIdx = pickResult.ancestors.findIndex((a) => a.attr.clickable);
    if (firstClickIdx === 0) tokens.add("click:parent_direct");
    else if (firstClickIdx > 0) tokens.add("click:parent_deep");
    else tokens.add("click:none");
  }

  const visibleSiblings = pickResult.siblings.filter((s) => s.attr.visibleToUser);
  if (visibleSiblings.some((s) => s.attr.text || s.attr.desc)) {
    tokens.add("ctx:sib_text");
  }
  if (visibleSiblings.some((s) => s.attr.vid && !isObfuscatedVidValue(s.attr.vid))) {
    tokens.add("ctx:sib_vid");
  }
  if (
    pickResult.ancestors
      .slice(0, 4)
      .some((a) => a.attr.vid && !isObfuscatedVidValue(a.attr.vid))
  ) {
    tokens.add("ctx:anc_vid");
  }

  const anchorSourceNodes = [
    targetNode,
    ...visibleSiblings.slice(0, 8),
    ...pickResult.nearbyTextNodes.slice(0, 8),
    ...pickResult.ancestors.slice(0, 3),
  ];
  for (const node of anchorSourceNodes) {
    const text = `${node.attr.text ?? ""} ${node.attr.desc ?? ""} ${node.attr.vid ?? ""}`.toLowerCase();
    for (const word of ANCHOR_WORDS) {
      if (text.includes(word.toLowerCase())) tokens.add("anchor:" + word);
    }
  }

  const queryTokens = [...tokens].sort();
  const entries = ensureDistilledEntries();
  const scored: FewShotHit[] = [];
  for (const entry of entries) {
    if (entry.record.appId === snapshot.appId) continue;
    const score = onDeviceSimilarity(queryTokens, entry.obsTokens);
    scored.push({ record: entry.record, score });
  }

  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
    const lenDiff = a.record.selector.length - b.record.selector.length;
    if (lenDiff !== 0) return lenDiff;
    return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
  });

  if (scored.length === 0) return [];

  const bestScore = scored[0].score;
  const picked: FewShotHit[] = [];
  const seenSelectors = new Set<string>();
  const usedKinds = new Set<string>();

  // 第一轮：优先覆盖不同写法形态（只要相似度不低于最佳分数的 72%），让模型同时学到主形态与邻近结构写法
  for (const hit of scored) {
    if (picked.length >= k) break;
    if (seenSelectors.has(hit.record.selector)) continue;
    const kind = hit.record.selectorShape.kind;
    if (usedKinds.has(kind)) continue;
    if (picked.length > 0 && hit.score < bestScore * 0.72) continue;
    seenSelectors.add(hit.record.selector);
    usedKinds.add(kind);
    picked.push(hit);
  }

  // 第二轮：按纯分数补足剩余槽位
  for (const hit of scored) {
    if (picked.length >= k) break;
    if (seenSelectors.has(hit.record.selector)) continue;
    seenSelectors.add(hit.record.selector);
    picked.push(hit);
  }

  return picked;
}
