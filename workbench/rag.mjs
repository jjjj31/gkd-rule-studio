/**
 * Workbench 侧的 Few-Shot 检索实现（纯 JS）。
 *
 * 与 src/lib/fewShotRetrieval.ts 保持同一套特征权重和 prompt 结构，
 * 一致性由 bench/rag-parity.bench.ts 校验。修改任一侧都要同步另一侧。
 */

const TOKEN_WEIGHTS = [
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

export function tokenWeight(token) {
  for (const [pattern, weight] of TOKEN_WEIGHTS) {
    if (pattern.test(token)) return weight;
  }
  return 0.2;
}

export function featureSimilarity(a, b) {
  const left = new Map();
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

export function retrieveFewShot(library, query, k = 3) {
  const hits = [];
  for (const record of library) {
    hits.push({ record, score: featureSimilarity(query.features, record.features) });
  }
  hits.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 1e-9) return b.score - a.score;
    const lengthDiff = a.record.selector.length - b.record.selector.length;
    if (lengthDiff !== 0) return lengthDiff;
    return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
  });

  const seen = new Set();
  const picked = [];
  for (const hit of hits) {
    if (seen.has(hit.record.selector)) continue;
    seen.add(hit.record.selector);
    picked.push(hit);
    if (picked.length >= Math.max(0, k)) break;
  }
  return picked;
}

export function shortClassName(name) {
  return String(name || "").split(".").pop() || name;
}

function describeNode(node) {
  const parts = [shortClassName(node.name)];
  if (node.vid) parts.push(`vid="${node.vid}"`);
  if (node.text) parts.push(`text="${node.text}"`);
  if (node.desc) parts.push(`desc="${node.desc}"`);
  parts.push(node.clickable ? "clickable=true" : "clickable=false");
  return parts.join(" ");
}

function describeTarget(target) {
  const parts = [shortClassName(target.name)];
  if (target.vid) parts.push(`vid="${target.vid}"`);
  if (target.text) parts.push(`text="${target.text}"`);
  if (target.desc) parts.push(`desc="${target.desc}"`);
  parts.push(target.clickable ? "clickable=true" : "clickable=false");
  if (target.childCount !== null && target.childCount !== undefined) {
    parts.push(`childCount=${target.childCount}`);
  }
  if (Array.isArray(target.bounds) && target.bounds.length === 4) {
    const [left, top, right, bottom] = target.bounds;
    parts.push(`bounds=[${left},${top},${right},${bottom}]`);
  }
  return parts.join(" ");
}

export function buildFewShotPrompt(query, examples) {
  const lines = [];
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
