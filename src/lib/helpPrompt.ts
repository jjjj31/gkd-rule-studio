/**
 * 单步"求助 prompt"组装器。
 * 把当前快照、选点、候选、场景设置打包成文字，复制给外部 AI。
 * @see aiModel.ts 内置 AI 也引用这里的 prompt 作为 user message
 */
import type {
  NodePickResult,
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { PromptScenarioInfo, RuleSettings } from "../types/ruleDraft";

interface PromptInput {
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
  ruleSettings: RuleSettings;
  /** false 时省略内嵌节点树（复制给外部 AI 时用，节点树由导出文件携带），默认 true。 */
  includeNodeTree?: boolean;
  /** 当前选择的场景（预设/自定义）名称与说明，帮助 AI 理解运行参数的来由。 */
  scenario?: PromptScenarioInfo;
}

/** 单步求助 prompt 入口：快照+选点+候选+设置 → 格式化文字。包装了场景、节点树、现有候选和兜底策略。 */
export function buildHelpPrompt(input: PromptInput): string {
  const { snapshot, pickResult, ruleSettings, includeNodeTree = true, scenario } = input;

  if (!snapshot) {
    return "请先导入或连接设备加载一个 GKD 快照。";
  }

  const lines = [
    "你是 GKD 规则专家。请根据下面的快照信息，为我生成稳定、低误触、尽量省电的 GKD 应用规则 JSON5。",
    "",
    "重要原则：",
    "- 不要把当前 pickedNode 当成唯一正确目标。用户点击只是手指常点的大概区域，同一可视区域可能有多个节点、父子层、遮罩层和真实按钮层，必须结合节点树、bounds、clickable、id/vid/text、父子关系判断哪个节点最像真实点击目标。",
    "- 不要因为单次 exact text 命中就忽略倒计时、WebView 遮挡、广告热区和 action 执行策略。",
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
    "输出格式（严格按此格式输出，否则提取失败）：",
    "1. 所有测试版必须放在唯一一个 ```json5 代码块中，块内是一个 JSON 对象：{ candidates: [{ id, title, summary, risk, app }] }。candidates 数量 2-4 个。",
    "2. 每个候选的 id 使用 candidate-a/candidate-b 稳定短 id；title 使用“测试版 A / 测试版 B / 测试版 C”这种唯一短名称。",
    "3. app 必须是完整的 GKD 规则对象 { id, name, groups }，groups[].rules[].matches 是字符串数组。",
    "4. summary 用 1-2 句说明验证思路和可能失败点；risk 说明误触风险。",
    "5. 测试版应覆盖：A=保守方案(高置信稳定 selector)，B=同框节点/父节点/真实按钮层验证，C=调整 actionDelay/actionCd/actionMaximum 等执行参数；如有 WebView/遮罩证据才加 D=广告容器兜底。",
    "6. 代码块之后附上“测试反馈格式”，要求用户反馈测试版编号、是否触发、是否关闭、是否误触、失败页面等信息。",
    "7. 不要输出节点树复述、不要输出无关长解释。不要加多个代码块——只允许一个 ```json5 块。",
    "",
    "应用信息：",
    `- appId: ${snapshot.appId}`,
    `- appName: ${snapshot.appInfo?.name ?? "-"}`,
    `- activityId: ${snapshot.activityId}`,
    `- screen: ${snapshot.screenWidth}x${snapshot.screenHeight}`,
    "",
    ...(scenario
      ? [
          "场景：",
          `- 场景名称: ${scenario.label}`,
          ...(scenario.description
            ? [`- 场景说明: ${scenario.description}`]
            : []),
        ]
      : []),
    "期望运行参数：",
    ...formatRuleSettingsLines(ruleSettings),
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

  if (includeNodeTree) {
    lines.push(
      "节点树摘要：",
      ...formatTreeExcerpt(snapshot, pickResult?.pickedNode ?? null),
    );
  } else {
    lines.push(
      "节点树说明：",
      "- 本 prompt 不再内嵌节点树，避免与导出文件重复。完整节点树、bounds 坐标和截图请见随消息附上的快照导出文件（在工具首页对快照点导出，得到 Markdown 文档 + PNG 截图）。",
      "- 若未收到导出文件附件，请先要求用户导出并上传，再生成规则。",
    );
  }

  return lines.join("\n");
}

/** 运行参数行（不带「期望运行参数：」标题），单步 prompt 和多步每步场景参数共用。 */
export function formatRuleSettingsLines(ruleSettings: RuleSettings): string[] {
  return [
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
  ];
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
