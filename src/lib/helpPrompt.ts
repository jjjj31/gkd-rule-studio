import type {
  NodePickResult,
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { RuleSettings, SelectorCandidate } from "../types/ruleDraft";
import { createAppRuleDraft, stringifyRuleDraft } from "./ruleDraft";

interface PromptInput {
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
  candidates: SelectorCandidate[];
  selectedCandidate: SelectorCandidate | null;
  ruleSettings: RuleSettings;
}

export function buildHelpPrompt(input: PromptInput): string {
  const { snapshot, pickResult, candidates, selectedCandidate, ruleSettings } =
    input;

  if (!snapshot) {
    return "请先导入或连接设备加载一个 GKD 快照。";
  }

  const lines = [
    "你是 GKD 规则专家。请根据下面的快照信息，为我生成稳定、低误触、尽量省电的 GKD 应用规则 JSON5。",
    "",
    "重要原则：",
    "- 下面如果提供了“当前 JSON5 草稿”，请优先审查并修正该草稿，不要从零重写。",
    "- 只有当草稿 selector、activityIds 或 action plan 明显错误时，才替换对应字段，并说明原因。",
    "- 不要因为单次 exact text 命中就忽略倒计时、WebView 遮挡、广告热区和 action 执行策略。",
    "- 用户点击只是手指常点的大概区域，不是精确指定某一个无障碍节点；同一可视区域可能有多个节点、父子层、遮罩层和真实按钮层。不要把当前 pickedNode 当成唯一正确目标，必须结合候选 selector 列表、同框节点提示、bounds、clickable、id/vid/text、父子关系判断哪个节点最像真实点击目标。",
    "",
    "要求：",
    "- 优先使用短、准、唯一命中的 selector。",
    "- 如果目标是关闭/取消/暂不/跳过等泛化文本，请加上下文或 activityIds。",
    "- 避免点击下载、安装、打开、查看详情等正向 CTA。",
    "- 特别注意流氓广告/广告 SDK：资源名含 shade/mask/hotArea/click_area/ad_click/splash_click 的节点通常是遮罩或广告热区，即使同时含 skip/close 也不要当成首选点击目标；优先找真实跳过按钮/布局，例如 *_skip_ll、*_skip_btn、tv_ad_skip。",
    "- 有触发记录但没关时，优先诊断 actionDelay、clickCenter、actionMaximum、actionCd、forcedTime、matchRoot，不要只改 selector。",
    "- 说明 selector 为什么稳定，以及还需要人工确认的风险。",
    "- 输出可放入订阅仓库的 JSON5 规则片段，并保留必要的省电参数。",
    "",
    "输出格式：",
    "1. 第一部分一次性给出 2-4 个测试版规则方案，按“测试版 A / 测试版 B / 测试版 C”命名，每个测试版各自放在独立 JSON5 代码块中。",
    "2. 测试版应覆盖不同思路：稳定 id/vid、真实跳过布局、WebView/广告容器兜底、不同 actionDelay/actionMaximum/actionCd 组合。不要只给一个看似最终的答案。",
    "   如果候选列表里有“同框节点”或相近 bounds 的候选，请至少给一个测试版验证同框候选，避免用户箭头落到垃圾节点而错过真实按钮。",
    "3. 每个测试版后用 1-2 句说明它要验证什么、可能失败在哪里、是否有误触风险。",
    "4. 最后输出“测试反馈格式”，要求用户逐个反馈：测试版编号、是否有触发记录、是否关闭广告、是否误触打开广告、失败时停留在哪个页面、是否需要延迟/重试。",
    "5. 不要输出节点树复述，不要输出与规则无关的长解释。用户试成功后会自己保留成功版本；没成功会带测试结果继续反馈。",
    "",
    "应用信息：",
    `- appId: ${snapshot.appId}`,
    `- appName: ${snapshot.appInfo?.name ?? "-"}`,
    `- activityId: ${snapshot.activityId}`,
    `- screen: ${snapshot.screenWidth}x${snapshot.screenHeight}`,
    "",
    "期望运行参数：",
    `- groupName: ${ruleSettings.groupName || "-"}`,
    `- activityIds: ${ruleSettings.activityIds || "(留空)"}`,
    `- matchTime: ${ruleSettings.matchTime ?? "(留空)"}`,
    `- actionMaximum: ${ruleSettings.actionMaximum ?? "(留空)"}`,
    `- actionCd: ${ruleSettings.actionCd ?? "(留空)"}`,
    `- resetMatch: ${ruleSettings.resetMatch || "(留空)"}`,
    `- action: ${ruleSettings.action || "(工具自动判断)"}`,
    `- actionDelay: ${ruleSettings.actionDelay ?? "(工具自动判断)"}`,
    `- forcedTime: ${ruleSettings.forcedTime ?? "(工具自动判断)"}`,
    `- matchRoot: ${ruleSettings.matchRoot ?? "(工具自动判断)"}`,
    "",
  ];

  if (pickResult) {
    lines.push(
      "用户点击的目标节点：",
      formatNodeDetail(pickResult.pickedNode),
      "",
      "祖先链（从近到远）：",
      ...pickResult.ancestors.slice(0, 8).map(formatNodeLine),
      "",
      "同级节点：",
      ...pickResult.siblings.slice(0, 12).map(formatNodeLine),
      "",
      "附近文本/描述节点：",
      ...pickResult.nearbyTextNodes.slice(0, 12).map(formatNodeLine),
      "",
    );
  } else {
    lines.push("用户尚未选择目标节点。请先提示用户点击截图上的目标按钮。", "");
  }

  if (selectedCandidate) {
    lines.push(
      "当前工具推荐候选：",
      `- strategy: ${selectedCandidate.strategyName}`,
      `- score: ${selectedCandidate.risk.finalScore}`,
      `- matches: ${selectedCandidate.rule.matches.join(" && ")}`,
      `- hitCount: ${selectedCandidate.validation.hitCount}`,
      `- actionPlan: ${formatActionPlan(selectedCandidate)}`,
      `- riskNotes: ${selectedCandidate.riskNotes.join("；") || "-"}`,
      `- debugAdvice: ${selectedCandidate.debugAdvice.join("；") || "-"}`,
      "",
    );
  }

  if (candidates.length) {
    lines.push(
      "候选 selector 列表：",
      ...candidates.slice(0, 6).map((candidate) => {
        return `- ${candidate.strategyName} / score ${candidate.risk.finalScore} / hit ${candidate.validation.hitCount}: ${candidate.rule.matches.join(" && ")}`;
      }),
      "",
    );
  }

  if (selectedCandidate) {
    lines.push(
      "当前 JSON5 草稿（优先在此基础上修正，不要从零重写）：",
      "```json5",
      stringifyRuleDraft(createAppRuleDraft(snapshot, selectedCandidate, candidates)),
      "```",
      "",
    );
  }

  lines.push(
    "节点树摘要：",
    ...formatTreeExcerpt(snapshot, pickResult?.pickedNode ?? null),
  );

  return lines.join("\n");
}

function formatActionPlan(candidate: SelectorCandidate): string {
  const plan = candidate.actionPlan;
  return JSON.stringify({
    activityIds: plan.activityIds,
    action: plan.action,
    actionDelay: plan.actionDelay,
    matchTime: plan.matchTime,
    actionMaximum: plan.actionMaximum,
    actionCd: plan.actionCd,
    forcedTime: plan.forcedTime,
    matchRoot: plan.matchRoot,
    resetMatch: plan.resetMatch,
  });
}

function formatTreeExcerpt(
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode | null,
): string[] {
  if (snapshot.nodes.length <= 220) {
    return snapshot.nodes.map((node) => formatIndentedNode(node));
  }

  if (!pickedNode) {
    return [
      `节点数量 ${snapshot.nodes.length}，未选择目标，仅展示前 160 个节点：`,
      ...snapshot.nodes.slice(0, 160).map((node) => formatIndentedNode(node)),
    ];
  }

  const keep = new Set<number>();
  const add = (node: NormalizedSnapshotNode | undefined) => {
    if (node) keep.add(node.id);
  };

  add(pickedNode);
  let current: NormalizedSnapshotNode | undefined = pickedNode;
  while (current && current.pid >= 0) {
    current = snapshot.nodeById.get(current.pid);
    add(current);
  }

  for (const node of snapshot.nodes) {
    if (node.pid === pickedNode.pid || keep.has(node.pid)) {
      keep.add(node.id);
    }
  }

  return [
    `节点数量 ${snapshot.nodes.length}，展示目标节点相关子树：`,
    ...snapshot.nodes
      .filter((node) => keep.has(node.id))
      .slice(0, 220)
      .map((node) => formatIndentedNode(node)),
  ];
}

function formatNodeDetail(node: NormalizedSnapshotNode): string {
  return JSON.stringify(
    {
      id: node.id,
      pid: node.pid,
      name: node.attr.name,
      text: node.attr.text,
      desc: node.attr.desc,
      idAttr: node.attr.id,
      vid: node.attr.vid,
      clickable: node.attr.clickable,
      visibleToUser: node.attr.visibleToUser,
      bounds: [node.attr.left, node.attr.top, node.attr.right, node.attr.bottom],
      childCount: node.attr.childCount,
      index: node.attr.index,
      depth: node.attr.depth,
    },
    null,
    2,
  );
}

function formatIndentedNode(node: NormalizedSnapshotNode): string {
  return `${"  ".repeat(Math.min(node.attr.depth, 12))}${formatNodeLine(node)}`;
}

function formatNodeLine(node: NormalizedSnapshotNode): string {
  const parts = [
    `#${node.id}`,
    shortName(node.attr.name),
    node.attr.clickable ? "clickable" : "",
    node.attr.visibleToUser ? "" : "hidden",
    node.attr.vid ? `vid=${node.attr.vid}` : "",
    node.attr.id ? `id=${node.attr.id}` : "",
    node.attr.text ? `text=${JSON.stringify(node.attr.text)}` : "",
    node.attr.desc ? `desc=${JSON.stringify(node.attr.desc)}` : "",
    `bounds=${node.attr.left},${node.attr.top},${node.attr.right},${node.attr.bottom}`,
  ].filter(Boolean);
  return parts.join(" ");
}

function shortName(name: string): string {
  return name.split(".").at(-1) ?? name;
}
