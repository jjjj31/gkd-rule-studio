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
import { AI_RULE_OUTPUT_CONTRACT, AI_RULE_OUTPUT_EXAMPLE } from "./aiRuleContract";
import { isDynamicActivityId, isDynamicCountdownText } from "./countdownText";
import {
  formatFewShotExamples,
  retrieveOnDeviceFewShot,
  type FewShotHit,
} from "./fewShotRetrieval";
import {
  buildVisualTargetIds,
  findSafeClickableAncestorWithDiagnostics,
  getUnsafeClickableTargetReason,
} from "./visualTarget";

export type PromptAudience = "external" | "builtin";

const HOT_AREA_OR_MASK_RE =
  /(?:shade|mask|hot_?area|click_?area|ad_?click|splash_?click|click_?group)/i;
const FULLSCREEN_MASK_AREA_THRESHOLD = 0.85;

export interface ClickableTargetAnalysis {
  visualStackNodes: NormalizedSnapshotNode[];
  safeClickableTarget: NormalizedSnapshotNode | null;
  unsafeClickableCandidate: {
    node: NormalizedSnapshotNode;
    reason: string;
  } | null;
}

export interface ClickTargetHint {
  expression: string;
  usesDesc: boolean;
}

const GKD_RULE_HARD_RULES = [
  "硬规则（违反任一条都视为无效输出）：",
  "- 第一条候选（candidate-a）必须命中 pickedNode 本身、与它矩形重合的视觉摞，或它的安全 clickable 父容器；禁止用同屏标题、兄弟 CTA、无关关闭图标代替目标。",
  "- 属性名和值必须原样照抄节点树：树里写 id=... 就用 [id=\"...\"]；树里写 vid=... 才用 [vid=\"...\"]。不要把 id 的包名前缀去掉改成 vid。",
  "- 本任务只允许使用材料中出现的 selector 属性：id、vid、text、desc、clickable、visibleToUser、childCount、index、depth、width、height（width/height 仅作次级尺寸过滤）。禁止 [bounds=...]、[class=...] 以及 [left=...]/[top=...]/[right=...]/[bottom=...] 固定像素坐标；控件类名只能作为类型前缀。",
  "- 点击目标：如果文字节点的 clickable=false，而父/祖先有安全 clickable=true 容器（面积占比 <= 15% 且非遮罩/热区/正向 CTA），优先写 @[clickable=true] > [text=\"...\"]，或直接选安全可点击父容器；若外层仅是大面积容器或广告热区，严禁 @ 抬升，必须改用 action: \"clickCenter\"。",
  "- 如果写成 Parent > Child，且 Parent 是安全 clickable=true、Child 是 clickable=false，必须在 Parent 前加 @；没有 @ 时点击目标是 Child。",
  "- > 只匹配直接子节点；文字在孙节点时，用 @[clickable=true] > * > [text=\"...\"] 或 @[clickable=true] [text=\"...\"]（空格后代），不要盲写 > 导致 0 命中。",
  "- 同框挂多个文本/描述锚点时，禁止把两个 [text=...]/[desc=...] 用连续空格写进同一条 selector（例如 A [text=\"文案1\"] [text=\"文案2\"] 表示后者是前者的子孙，几乎必 0 命中）；请拆成 matches 多段数组（前几条写上下文锚点如 [\"[text=\\\"...\\\"]\", ...]，最后一条写点击目标如 \"@ImageView[width<120 && height<120]\"），或用兄弟关系 +。",
  "- 正向 CTA（下载/安装/打开/查看详情/立即购买等）只能作为上下文锚点，不能作为点击目标；如果 selector 的唯一命中是正向 CTA，action 必须是 back 或 none，不能 click/clickCenter。",
  "- 禁止用 [left=...]/[top=...]/[right=...]/[bottom=...] 等固定屏幕像素坐标定位控件（不同设备分辨率会失效）；当控件无 id/vid/text/desc 时，必须用弹窗内的稳定业务文案做前置锚点，若 clickable=false 则配 action: \"clickCenter\"。",
  "- 几何属性（width/height）只能作为已有 text/id/vid/desc 锚点之后的次级过滤；不要单独用 [clickable=true][width=...][height=...] 作为主选择器。",
  "- fastQuery: true 严苛约束：仅当规则中每条 selector 最右侧匹配单元都包含精确 id/vid 或非正则 text，且 id/vid/text 必须位于最右侧节点首个独立 [...] 中，不与其它属性用 && 混写（如 [vid=\"x\"][clickable=true] 支持，但 [clickable=true][vid=\"x\"] 和 [vid=\"x\" && clickable=true] 均不支持 fastQuery），且目标不在 WebView 内时才开启；纯 desc、无字图标、纯类名/宽高结构、或最右侧节点无 id/vid/text（如 [text=\"广告\"] + @ImageView）必须省略 fastQuery 或设为 false。",
  "- 严禁默认添加 actionDelay；测试版 A/B 默认立即点击，仅在倒计时刚出现不可点或已触发未关闭时，才在测试版 C 按需测试 actionDelay。",
  "- 多分支请用 anyMatches 数组；不要把顶层逗号写进单条 selector。",
  "- 输出要短：summary 和 risk 各不超过 1 句话；默认 3 个候选，不要为了凑数输出第 4 个；接近长度限制时优先保证 JSON 完整闭合。",
];

const GKD_RULE_DIAGNOSIS_STEPS = [
  "5 步规则排查思路（按顺序完成后再落笔）：",
  "1. 查 clickable 与安全可点击父容器：锁定 pickedNode/视觉摞；不可点击时向上找安全 clickable=true 父容器（过滤面积 > 15%、shade/mask/hotArea/click_area/ad_click/splash_click/click_group 及正向 CTA），用 @ 抬升；若外层仅为大面积容器或广告热区，严禁 @ 抬升，改用 action: \"clickCenter\"。",
  "2. 查同屏冲突与全屏遮罩：核对是否存在同屏同名 text / 同 desc / 同 vid / 同 id 冲突节点及面积 > 85% 的全屏遮罩层；若有冲突必须补充兄弟/祖先/弹窗业务文案锚点收窄，禁止裸写冲突属性。",
  "3. 选稳定锚点并避坑：严禁写死倒计时数字（改用 text^=/text$=）、严禁写死 left/top/right/bottom 坐标、严禁写死带动态数字/匿名后缀的 activityId、严禁点击正向 CTA。",
  "4. 决策 action / fastQuery / actionDelay：严禁默认加 actionDelay；严禁对纯 desc、无字图标、WebView 或最右侧节点无 id/vid/text 的规则开 fastQuery: true；仅不可点且无安全父容器/WebView 自绘时设 action: \"clickCenter\"。",
  "5. 对照真实节点树自检：逐条确认 id/vid 真实存在且未混用、父子 > 与后代层级准确、@ 指向安全可点击节点、JSON5 字段类型合法完整。",
];

const GKD_RULE_CONTRAST_EXAMPLES = [
  "高频错误对照（只学写法，不要照抄示例里的值）：",
  "- 树里是 #8 Button id=com.demo:id/tv_cancel text=\"取消\"：写 [id=\"com.demo:id/tv_cancel\"]，不要写 [vid=\"tv_cancel\"]。",
  "- 目标是 #13 LinearLayout clickable=true，文字在 #15 TextView clickable=false：写 @[clickable=true] > [text=\"不感兴趣\"]，不要只写 [text=\"不感兴趣\"]。",
  "- 弹窗右上角无字无 ID 关闭图标：写 matches: ['[text=\"跳转微信\"]', 'FrameLayout > @ImageView[width<120 && height<120]'] 并设 action: \"clickCenter\"（且不开 fastQuery）；不要写 [left=...][top=...] 像素坐标，也不要用连续空格串联两个平行 [text=...] 节点。",
  "- 树里只给 bounds=...：不要写 [bounds=...]；用 text/id/vid/desc，几何属性（width/height）只做次级过滤。",
];

export const GKD_RULE_SELF_CHECK = [
  "输出前自检（在内部完成，不要输出自检过程）：",
  "1. 每个 [vid=...] 对应的节点行真的有 vid= 吗？只有 id= 的必须写 [id=...]。",
  "2. selector 里有没有 bounds/class 或硬编码 left=/top=/right=/bottom= 像素坐标？有没有把两个平行 [text=...] 用空格串联？",
  "3. 第一条候选是否命中 pickedNode 本身、视觉摞或安全 clickable 父容器？有没有误抬升到大面积/热区遮罩，或跳到同屏标题、兄弟 CTA、无关关闭图标？",
  "4. 如果用了 Parent > Child，Parent 安全 clickable 且 Child 不可点击，Parent 前有没有 @？",
  "5. > 是否只用于直接子节点？文字在孙节点时有没有用 > * > 或空格后代？",
  "6. 最终点击节点是安全 clickable=true 吗？不可点且无安全父容器时是否设置了 action: \"clickCenter\"？",
  "7. 纯 desc / 无字图标 / WebView / 最右侧无 id/vid/text 的规则是否已关闭或省略 fastQuery？是否避免了无故默认加 actionDelay？",
  "8. 有没有把正向 CTA 当成点击目标？多分支是否放进了 anyMatches，而不是单条 selector 的顶层逗号？",
  "9. 只输出一个 json5 代码块，candidates 2-4 个。",
];

export interface PromptInput {
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
  ruleSettings: RuleSettings;
  /** external（默认）：复制给外部 AI；builtin：内置 AI，省略与 system prompt 重复的契约与外部反馈格式。 */
  audience?: PromptAudience;
  /** false 时省略内嵌节点树（复制给外部 AI 时用，节点树由导出文件携带），默认 true。 */
  includeNodeTree?: boolean;
  /** true 时输出完整节点树，不按上限截断；仅用于全树实验。 */
  includeFullTree?: boolean;
  /** 当前选择的场景（预设/自定义）名称与说明，帮助 AI 理解运行参数的来由。 */
  scenario?: PromptScenarioInfo;
  /** 从官方真值库检索到的相似案例；只教写法，不替代当前快照上下文。 */
  fewShotExamples?: FewShotHit[];
}

/** 评估视觉摞与祖先链中的安全可点击容器，直接复用 visualTarget.ts 的单一事实源。 */
export function analyzeClickableTarget(
  snapshot: ParsedGkdSnapshot,
  pickResult: NodePickResult,
): ClickableTargetAnalysis {
  const pickedNode = pickResult.pickedNode;
  const ancestorDiag = findSafeClickableAncestorWithDiagnostics(snapshot, pickedNode);

  const visualStackNodeIds = buildVisualTargetIds({
    snapshot,
    pickedNode,
    clickableAncestor: ancestorDiag.safeAncestor,
  });
  const visualStackNodes = Array.from(visualStackNodeIds)
    .map((id) => snapshot.nodeById.get(id))
    .filter((n): n is NormalizedSnapshotNode => Boolean(n));

  let unsafeClickableCandidate: ClickableTargetAnalysis["unsafeClickableCandidate"] =
    ancestorDiag.unsafeClickableAncestor && ancestorDiag.unsafeReason
      ? {
          node: ancestorDiag.unsafeClickableAncestor,
          reason: ancestorDiag.unsafeReason,
        }
      : null;

  for (const candidate of visualStackNodes) {
    if (!candidate.attr.clickable || !candidate.attr.visibleToUser) continue;
    const unsafeReason = getUnsafeClickableTargetReason(
      snapshot,
      candidate,
      pickedNode,
    );
    if (!unsafeReason) {
      return {
        visualStackNodes,
        safeClickableTarget: candidate,
        unsafeClickableCandidate,
      };
    }
    unsafeClickableCandidate ??= { node: candidate, reason: unsafeReason };
  }

  if (ancestorDiag.safeAncestor) {
    return {
      visualStackNodes,
      safeClickableTarget: ancestorDiag.safeAncestor,
      unsafeClickableCandidate,
    };
  }

  return {
    visualStackNodes,
    safeClickableTarget: null,
    unsafeClickableCandidate,
  };
}

/** 为不可点击子节点生成精准的 @ 抬升子匹配示例，避免 text 为空但 desc 非空时错写 [text="..."]。 */
export function formatClickTargetHint(pickedNode: NormalizedSnapshotNode): ClickTargetHint {
  const pickedText = pickedNode.attr.text?.trim() ?? "";
  if (pickedText) {
    if (isDynamicCountdownText(pickedText)) {
      const expr =
        pickedText.endsWith("跳过") && !pickedText.startsWith("跳过")
          ? '[text$="跳过"]'
          : /^skip\b/i.test(pickedText)
            ? '[text^="Skip"]'
            : /\bskip$/i.test(pickedText)
              ? '[text$="skip"]'
              : '[text^="跳过"]';
      return { expression: expr, usesDesc: false };
    }
    return { expression: `[text=${JSON.stringify(pickedText)}]`, usesDesc: false };
  }

  const pickedDesc = pickedNode.attr.desc?.trim() ?? "";
  if (pickedDesc) {
    return { expression: `[desc=${JSON.stringify(pickedDesc)}]`, usesDesc: true };
  }

  if (pickedNode.attr.vid?.trim()) {
    return {
      expression: `[vid=${JSON.stringify(pickedNode.attr.vid.trim())}]`,
      usesDesc: false,
    };
  }
  if (pickedNode.attr.id?.trim()) {
    return {
      expression: `[id=${JSON.stringify(pickedNode.attr.id.trim())}]`,
      usesDesc: false,
    };
  }
  return { expression: shortName(pickedNode.attr.name), usesDesc: false };
}

/** 单步求助 prompt 入口：快照+选点+候选+设置 → 格式化文字。包装了场景、节点树、现有候选和兜底策略。 */
export function buildHelpPrompt(input: PromptInput): string {
  const {
    snapshot,
    pickResult,
    ruleSettings,
    audience = "external",
    includeNodeTree = true,
    includeFullTree = false,
    scenario,
    fewShotExamples,
  } = input;

  if (!snapshot) {
    return "请先导入或连接设备加载一个 GKD 快照。";
  }

  const isBuiltin = audience === "builtin";

  const outputFormatLines = [
    "输出格式（严格按此格式输出，否则提取失败）：",
    "1. 所有测试版必须放在唯一一个 ```json5 代码块中，块内是一个 JSON 对象：{ candidates: [{ id, title, summary, risk, app }] }。candidates 数量 2-4 个。",
    "2. 每个候选的 id 使用 candidate-a/candidate-b 稳定短 id；title 使用“测试版 A / 测试版 B / 测试版 C”这种唯一短名称。",
    "3. app 必须是完整的 GKD 规则对象 { id, name, groups }，groups[].rules[].matches 是字符串数组。",
    "4. summary 用 1 句话（≤60 字）说明验证思路和可能失败点；risk 用 1 句话（≤60 字）说明误触风险。",
    "5. 测试版默认 3 个：A=保守方案(高置信稳定 selector，不设 actionDelay 立即点击)，B=同框节点/父节点/真实按钮层验证（同样不设 actionDelay），C=调整 actionDelay/actionCd/actionMaximum 等执行参数（若当前已有明确跳过文案/容器，不要全套都加 actionDelay）；只有材料明确显示需要广告容器兜底时才加 D，不要为了凑数输出 4 个。",
    "6. 如果内容接近长度限制，优先保证 JSON 完整闭合；不要重复节点树或规则解释。",
    ...(isBuiltin
      ? []
      : [
          "7. 代码块之后附上“测试反馈格式”，要求用户反馈测试版编号、是否触发、是否关闭、是否误触、失败页面等信息。",
        ]),
    `${isBuiltin ? "7" : "8"}. 不要输出节点树复述、不要输出无关长解释。不要加多个代码块——只允许一个 \`\`\`json5 块。`,
  ];

  const lines = [
    "你是 GKD 规则专家。请根据下面的快照信息，为我生成稳定、低误触、尽量省电的 GKD 应用规则 JSON5。",
    "",
    "重要原则：",
    "- pickedNode 是用户选中的目标区域，不是可以随意跳过的参考。第一条候选必须命中 pickedNode 本身，或与它矩形重合的视觉摞/它的安全 clickable 父容器；只有材料明确显示遮罩层、WebView 遮挡或真实按钮层时，才允许改点父子层或使用 clickCenter。禁止用同屏标题、兄弟 CTA、无关关闭图标代替目标。",
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
    ...GKD_RULE_DIAGNOSIS_STEPS,
    "",
    ...GKD_RULE_HARD_RULES,
    "",
    ...GKD_RULE_CONTRAST_EXAMPLES,
    "",
    ...outputFormatLines,
    ...(isBuiltin
      ? [""]
      : [
          "",
          AI_RULE_OUTPUT_CONTRACT,
          "",
          "完整 JSON5 示例（只学习字段结构，不要照抄 appId/selector）：",
          AI_RULE_OUTPUT_EXAMPLE,
          "",
        ]),
    "应用信息：",
    `- appId: ${snapshot.appId}`,
    `- appName: ${snapshot.appInfo?.name ?? "-"}`,
    `- activityId: ${snapshot.activityId ?? "-"}`,
    ...(isDynamicActivityId(snapshot.activityId)
      ? [
          `- ⚠️ 注意：当前 activityId（${snapshot.activityId}）带动态数字/匿名后缀，严禁写死进 activityIds！`,
        ]
      : []),
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

  let conflictNodesForTree: NormalizedSnapshotNode[] = [];
  let fullscreenMasksForTree: NormalizedSnapshotNode[] = [];

  if (pickResult) {
    const pickedNode = pickResult.pickedNode;
    lines.push(
      "用户点击的目标节点：",
      formatNodeDetail(pickedNode),
      "",
    );

    // 客观事实 1: 视觉摞与安全可点击性事实
    const clickAnalysis = analyzeClickableTarget(snapshot, pickResult);
    const { visualStackNodes, safeClickableTarget, unsafeClickableCandidate } =
      clickAnalysis;

    lines.push(
      "目标区域与可点击性事实：",
      `- pickedNode 可点击性: clickable=${pickedNode.attr.clickable}`,
    );
    if (visualStackNodes.length > 1) {
      lines.push(
        `- 视觉摞（同坐标重合层）：共 ${visualStackNodes.length} 个节点：`,
        ...visualStackNodes.map(
          (n) =>
            `  * #${n.id} ${shortName(n.attr.name)} clickable=${n.attr.clickable} text=${n.attr.text ? JSON.stringify(n.attr.text) : "-"} desc=${n.attr.desc ? JSON.stringify(n.attr.desc) : "-"} vid=${n.attr.vid ?? "-"} id=${n.attr.id ?? "-"}`,
        ),
      );
    }
    if (!pickedNode.attr.clickable) {
      if (safeClickableTarget) {
        const hint = formatClickTargetHint(pickedNode);
        const descNote = hint.usesDesc
          ? "（注意：基于 desc 匹配时禁止开启 fastQuery: true）"
          : "";
        lines.push(
          `⚠️ 【关键警示】当前选中的 pickedNode (#${pickedNode.id}) clickable=false，无障碍服务直接点击它通常无效！`,
          `  可响应点击的父容器/同层节点为 #${safeClickableTarget.id} ${shortName(safeClickableTarget.attr.name)} (clickable=true)。`,
          `  如果用子节点属性收窄，必须使用 @ 抬升语法点击父容器，例如 @[clickable=true] > ${hint.expression} 或 @[clickable=true] ${hint.expression}${descNote}，绝对不能只写不可点击的子节点。`,
        );
      } else if (unsafeClickableCandidate) {
        lines.push(
          `⚠️ 【关键警示】当前选中的 pickedNode (#${pickedNode.id}) clickable=false；其外层可点击容器 #${unsafeClickableCandidate.node.id} ${shortName(unsafeClickableCandidate.node.attr.name)}（${unsafeClickableCandidate.reason}）属于大面积/广告热区/危险容器，严禁使用 @ 抬升点击该外层容器！规则必须直接定位目标并显式设置 action: "clickCenter"（坐标点击）。`,
        );
      } else {
        lines.push(
          `⚠️ 【关键警示】pickedNode (#${pickedNode.id}) clickable=false，且父链未发现安全 clickable=true 容器。规则必须显式设置 action: "clickCenter"（坐标点击），否则默认 clickNode 会点不动。`,
        );
      }
    }
    lines.push("");

    // 客观事实 2: 同屏同名/同 desc/同 vid/同 id 冲突与全屏遮罩告警
    const conflictReport = detectSameScreenConflictsAndMasks(
      snapshot,
      pickedNode,
      safeClickableTarget,
      visualStackNodes,
    );
    conflictNodesForTree = conflictReport.conflictNodes;
    fullscreenMasksForTree = conflictReport.fullscreenMasks;
    if (
      conflictReport.conflictLines.length > 0 ||
      conflictReport.maskLines.length > 0
    ) {
      lines.push(
        "同屏属性冲突与全屏遮罩告警：",
        ...conflictReport.conflictLines,
        ...conflictReport.maskLines,
        "",
      );
    }

    // 客观事实 3: 局部节点真实属性白名单（防编造与 vid/id 混淆）
    const localNodes = [
      ...visualStackNodes,
      pickedNode,
      ...pickResult.ancestors.slice(0, 6),
      ...pickResult.siblings.slice(0, 10),
      ...pickResult.nearbyTextNodes.slice(0, 10),
    ];
    const realVids = Array.from(
      new Set(
        localNodes
          .map((n) => n.attr.vid)
          .filter((v): v is string => Boolean(v && v.trim().length > 0)),
      ),
    );
    const realIds = Array.from(
      new Set(
        localNodes
          .map((n) => n.attr.id)
          .filter((id): id is string => Boolean(id && id.trim().length > 0)),
      ),
    );

    lines.push(
      "局部节点真实属性白名单（防属性编造与 vid/id 混淆）：",
      `- 真实 vid 清单: ${realVids.length > 0 ? realVids.map((v) => `vid="${v}"`).join(", ") : "无（该局部区域节点均无 vid 属性）"}`,
      `- 真实 id 清单: ${realIds.length > 0 ? realIds.slice(0, 8).map((id) => `id="${id}"`).join(", ") : "无"}`,
      "- ⚠️ 严格约束：树中只有 id= 的节点严禁改写为 [vid=\"...\"]；绝对不要编造上述清单或树中未出现的 vid 名称！",
      "",
    );

    lines.push(
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

    const pickedGenericOrBlank =
      (!pickedNode.attr.id && !pickedNode.attr.vid) ||
      !pickedNode.attr.text?.trim() ||
      /^(关闭|取消|跳过|确定|确认|知道|知道了|不再提示|close|cancel|skip|ok)$/i.test(
        pickedNode.attr.text.trim(),
      );
    if (pickedGenericOrBlank) {
      const anchorNodes = collectNonGenericAnchorNodes(snapshot, pickedNode);
      if (anchorNodes.length > 0) {
        lines.push(
          "同屏业务文案锚点参考（防误触：严禁写死 left/top 像素坐标，优先拆成 matches 多段数组作前置锚点）：",
          `- ${anchorNodes.map((n) => formatNodeLine(n).trim()).join("；")}`,
          "",
        );
      }
    }
  } else {
    lines.push("用户尚未选择目标节点。请先提示用户点击截图上的目标按钮。", "");
  }

  const effectiveFewShots =
    fewShotExamples !== undefined
      ? fewShotExamples
      : snapshot && pickResult
        ? retrieveOnDeviceFewShot({
            snapshot,
            pickResult,
            k: 2,
          })
        : [];

  if (effectiveFewShots && effectiveFewShots.length > 0) {
    lines.push(
      "相似历史案例（来自其它应用的官方标准答案，只学习属性选择、层级/兄弟/联合写法；案例里的 appId、vid、id、text、selector 都不能直接用于当前快照）：",
      ...formatFewShotExamples(effectiveFewShots),
      "",
    );
  }

  if (includeNodeTree) {
    lines.push(
      "节点树摘要：",
      ...formatTreeExcerpt(
        snapshot,
        pickResult?.pickedNode ?? null,
        includeFullTree,
        audience,
        conflictNodesForTree,
        fullscreenMasksForTree,
      ),
    );
  } else {
    lines.push(
      "节点树说明：",
      "- 本 prompt 不再内嵌节点树，避免与导出文件重复。完整节点树、bounds 坐标和截图请见随消息附上的快照导出文件（在工具首页对快照点导出，得到 Markdown 文档 + PNG 截图）。",
      "- 若未收到导出文件附件，请先要求用户导出并上传，再生成规则。",
    );
  }

  lines.push("", ...GKD_RULE_SELF_CHECK);

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

function detectSameScreenConflictsAndMasks(
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode,
  safeClickableTarget: NormalizedSnapshotNode | null,
  visualStackNodes: NormalizedSnapshotNode[],
): {
  conflictLines: string[];
  maskLines: string[];
  conflictNodes: NormalizedSnapshotNode[];
  fullscreenMasks: NormalizedSnapshotNode[];
} {
  const excludedIds = new Set<number>([
    pickedNode.id,
    ...(safeClickableTarget ? [safeClickableTarget.id] : []),
    ...visualStackNodes.map((n) => n.id),
  ]);

  const probeTargets = [pickedNode];
  if (safeClickableTarget && safeClickableTarget.id !== pickedNode.id) {
    probeTargets.push(safeClickableTarget);
  }

  const attrsToCheck: Array<{
    key: "text" | "desc" | "vid" | "id";
    label: string;
    value: string;
  }> = [];
  const seenProbe = new Set<string>();
  for (const target of probeTargets) {
    for (const key of ["text", "desc", "vid", "id"] as const) {
      const value = target.attr[key]?.trim();
      if (!value) continue;
      const probeKey = `${key}:${value}`;
      if (seenProbe.has(probeKey)) continue;
      seenProbe.add(probeKey);
      attrsToCheck.push({ key, label: key, value });
    }
  }

  const conflictLines: string[] = [];
  const conflictNodeMap = new Map<number, NormalizedSnapshotNode>();

  for (const probe of attrsToCheck) {
    const matches = snapshot.nodes.filter(
      (n) =>
        n.attr.visibleToUser &&
        !excludedIds.has(n.id) &&
        n.attr[probe.key]?.trim() === probe.value,
    );
    if (matches.length === 0) continue;
    for (const m of matches.slice(0, 6)) {
      conflictNodeMap.set(m.id, m);
    }
    const briefList = matches
      .slice(0, 4)
      .map(
        (m) =>
          `#${m.id} ${shortName(m.attr.name)} bounds=${m.attr.left},${m.attr.top},${m.attr.right},${m.attr.bottom} (占比${(nodeAreaRatio(snapshot, m) * 100).toFixed(1)}%)`,
      )
      .join("；");
    conflictLines.push(
      `- ⚠️ 同屏属性冲突：[${probe.label}=${JSON.stringify(probe.value)}] 在同屏另命中 ${matches.length} 个非目标节点（${briefList}）；禁止裸写该属性，必须加祖先/兄弟或弹窗业务文案锚点收窄！`,
    );
  }

  const fullscreenMasks = snapshot.nodes.filter((n) => {
    if (!n.attr.visibleToUser || excludedIds.has(n.id)) return false;
    const ratio = nodeAreaRatio(snapshot, n);
    if (ratio <= FULLSCREEN_MASK_AREA_THRESHOLD) return false;
    if (n.attr.clickable) return true;
    const signals = `${n.attr.vid ?? ""} ${n.attr.id ?? ""} ${n.attr.desc ?? ""}`;
    return HOT_AREA_OR_MASK_RE.test(signals);
  });

  const maskLines = fullscreenMasks.slice(0, 4).map(
    (m) =>
      `- ⚠️ 全屏遮罩/热区层：#${m.id} ${shortName(m.attr.name)} clickable=${m.attr.clickable}${m.attr.vid ? ` vid=${m.attr.vid}` : ""}${m.attr.id ? ` id=${m.attr.id}` : ""} bounds=${m.attr.left},${m.attr.top},${m.attr.right},${m.attr.bottom} (占屏 ${(nodeAreaRatio(snapshot, m) * 100).toFixed(1)}%)；严禁将其作为 @ 抬升或点击目标！`,
  );

  return {
    conflictLines,
    maskLines,
    conflictNodes: Array.from(conflictNodeMap.values()),
    fullscreenMasks,
  };
}

function formatTreeExcerpt(
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode | null,
  includeFullTree: boolean,
  audience: PromptAudience,
  conflictNodes: NormalizedSnapshotNode[],
  fullscreenMasks: NormalizedSnapshotNode[],
): string[] {
  if (includeFullTree) {
    return [
      `节点数量 ${snapshot.nodes.length}，输出完整节点树：`,
      ...snapshot.nodes.map((node) => formatIndentedNode(node)),
    ];
  }

  const maxKeptNodes = audience === "builtin" ? 60 : 120;

  if (snapshot.nodes.length <= maxKeptNodes) {
    return snapshot.nodes.map((node) => formatIndentedNode(node));
  }

  if (!pickedNode) {
    return [
      `节点数量 ${snapshot.nodes.length}，未选择目标，仅展示前 ${maxKeptNodes} 个节点：`,
      ...snapshot.nodes.slice(0, maxKeptNodes).map((node) => formatIndentedNode(node)),
    ];
  }

  const keep = new Set<number>();
  const addChain = (
    node: NormalizedSnapshotNode | undefined | null,
    limit: number,
  ) => {
    let current = node ?? undefined;
    while (current && keep.size < limit) {
      keep.add(current.id);
      current = current.pid >= 0 ? snapshot.nodeById.get(current.pid) : undefined;
    }
  };

  // 1. 必保：目标自身与全祖先链
  addChain(pickedNode, maxKeptNodes);

  // 2. 必保：视觉摞重合节点及其祖先
  const visualIds = buildVisualTargetIds({ snapshot, pickedNode });
  for (const id of visualIds) {
    addChain(snapshot.nodeById.get(id), maxKeptNodes);
  }

  // 3. 必保：冲突属性节点及其父链
  for (const conflictNode of conflictNodes.slice(0, 6)) {
    addChain(conflictNode, maxKeptNodes);
  }

  // 4. 必保：全屏可点击遮罩及其父链
  for (const maskNode of fullscreenMasks.slice(0, 4)) {
    addChain(maskNode, maxKeptNodes);
  }

  // 5. 必保/高优：目标的直接子节点、同父兄弟、父容器的直接兄弟（叔节点）、祖父容器的直接兄弟
  const parentNode =
    pickedNode.pid >= 0 ? snapshot.nodeById.get(pickedNode.pid) : undefined;
  const grandParentNode =
    parentNode && parentNode.pid >= 0
      ? snapshot.nodeById.get(parentNode.pid)
      : undefined;

  const directChildren = snapshot.nodes.filter((node) => node.pid === pickedNode.id);
  const directSiblings = snapshot.nodes
    .filter((node) => node.pid === pickedNode.pid && node.id !== pickedNode.id)
    .sort(
      (a, b) =>
        Math.abs(a.attr.index - pickedNode.attr.index) -
        Math.abs(b.attr.index - pickedNode.attr.index),
    );
  const parentSiblings = parentNode
    ? snapshot.nodes
        .filter((node) => node.pid === parentNode.pid && node.id !== parentNode.id)
        .sort(
          (a, b) =>
            Math.abs(a.attr.index - parentNode.attr.index) -
            Math.abs(b.attr.index - parentNode.attr.index),
        )
    : [];
  const grandParentSiblings = grandParentNode
    ? snapshot.nodes
        .filter(
          (node) =>
            node.pid === grandParentNode.pid && node.id !== grandParentNode.id,
        )
        .sort(
          (a, b) =>
            Math.abs(a.attr.index - grandParentNode.attr.index) -
            Math.abs(b.attr.index - grandParentNode.attr.index),
        )
    : [];

  const structuralReserve = Math.max(8, Math.floor(maxKeptNodes * 0.25));
  const structuralLimit = Math.max(keep.size, maxKeptNodes - structuralReserve);
  for (const node of [
    ...directChildren,
    ...directSiblings,
    ...parentSiblings,
    ...grandParentSiblings,
  ]) {
    if (keep.size >= structuralLimit) break;
    keep.add(node.id);
  }

  // 6. 保锚裁剪（Anchor Preserving）：优先同弹窗子树与近距离的文本/描述/关键 ID 节点
  const targetX = (pickedNode.attr.left + pickedNode.attr.right) / 2;
  const targetY = (pickedNode.attr.top + pickedNode.attr.bottom) / 2;
  const anchorKeywords =
    /(?:title|close|cancel|skip|ad|btn|button|dialog|popup|banner|time|count)/i;
  const ancestorDepthMap = buildAncestorDepthMap(snapshot, pickedNode);

  const candidateAnchors: Array<{
    node: NormalizedSnapshotNode;
    lcaDepth: number;
    distance: number;
  }> = [];
  for (const node of snapshot.nodes) {
    if (keep.has(node.id)) continue;
    const hasText = Boolean(node.attr.text && node.attr.text.trim().length > 0);
    const hasDesc = Boolean(node.attr.desc && node.attr.desc.trim().length > 0);
    const hasKeyId = Boolean(
      (node.attr.vid && anchorKeywords.test(node.attr.vid)) ||
        (node.attr.id && anchorKeywords.test(node.attr.id)),
    );

    if (hasText || hasDesc || hasKeyId) {
      const nx = (node.attr.left + node.attr.right) / 2;
      const ny = (node.attr.top + node.attr.bottom) / 2;
      const distance = Math.hypot(nx - targetX, ny - targetY);
      const lcaDepth = findLcaDepth(snapshot, node, ancestorDepthMap);
      candidateAnchors.push({ node, lcaDepth, distance });
    }
  }

  candidateAnchors.sort((a, b) => {
    if (a.lcaDepth !== b.lcaDepth) return b.lcaDepth - a.lcaDepth;
    return a.distance - b.distance;
  });

  // 逐步加入保锚节点及其到根的祖先链，直到达到上限
  for (const { node } of candidateAnchors) {
    if (keep.size >= maxKeptNodes) break;
    let n: NormalizedSnapshotNode | undefined = node;
    const pathToRoot: NormalizedSnapshotNode[] = [];
    while (n && !keep.has(n.id)) {
      pathToRoot.push(n);
      n = n.pid >= 0 ? snapshot.nodeById.get(n.pid) : undefined;
    }
    if (keep.size + pathToRoot.length <= maxKeptNodes) {
      for (const p of pathToRoot) keep.add(p.id);
    }
  }

  return [
    `节点数量 ${snapshot.nodes.length}，展示目标节点相关子树（含关键文本/组件锚点）：`,
    ...snapshot.nodes
      .filter((node) => keep.has(node.id))
      .slice(0, maxKeptNodes)
      .map((node) => formatIndentedNode(node)),
  ];
}

function formatNodeDetail(node: NormalizedSnapshotNode): string {
  const { width, height } = nodeDimensions(node);
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
      width,
      height,
      childCount: node.attr.childCount,
      index: node.attr.index,
      depth: node.attr.depth,
    },
    null,
    2,
  );
}

function formatIndentedNode(node: NormalizedSnapshotNode): string {
  // 保留真实层级缩进，并在行内显式标注 d=/p=#，避免超深节点把父子看成兄弟
  return `${"  ".repeat(Math.max(0, node.attr.depth))}${formatNodeLine(node)}`;
}

function formatNodeLine(node: NormalizedSnapshotNode): string {
  const { width, height } = nodeDimensions(node);
  const parts = [
    `#${node.id}`,
    shortName(node.attr.name),
    node.attr.clickable ? "clickable" : "",
    node.attr.visibleToUser ? "" : "hidden",
    `d=${node.attr.depth}`,
    `p=#${node.pid}`,
    `idx=${node.attr.index}`,
    `${width}x${height}`,
    node.attr.vid ? `vid=${node.attr.vid}` : "",
    node.attr.id ? `id=${node.attr.id}` : "",
    node.attr.text ? `text=${JSON.stringify(node.attr.text)}` : "",
    node.attr.desc ? `desc=${JSON.stringify(node.attr.desc)}` : "",
    `bounds=${node.attr.left},${node.attr.top},${node.attr.right},${node.attr.bottom}`,
  ].filter(Boolean);
  return parts.join(" ");
}

function collectNonGenericAnchorNodes(
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode,
): NormalizedSnapshotNode[] {
  const genericWords = new Set([
    "关闭",
    "取消",
    "跳过",
    "确定",
    "确认",
    "知道",
    "知道了",
    "不再提示",
    "close",
    "cancel",
    "skip",
    "ok",
  ]);
  const ancestorDepthMap = buildAncestorDepthMap(snapshot, pickedNode);
  const popupRootId = findPopupSubtreeRootId(snapshot, pickedNode);
  const targetX = (pickedNode.attr.left + pickedNode.attr.right) / 2;
  const targetY = (pickedNode.attr.top + pickedNode.attr.bottom) / 2;

  const candidates: Array<{
    node: NormalizedSnapshotNode;
    raw: string;
    inSamePopup: boolean;
    lcaDepth: number;
    isBottomNav: boolean;
    distance: number;
  }> = [];

  for (const node of snapshot.nodes) {
    if (node.id === pickedNode.id || !node.attr.visibleToUser) continue;
    const raw = (node.attr.text ?? node.attr.desc ?? "").trim();
    if (!raw || raw.length < 2 || raw.length > 40) continue;
    if (/^\d+$/.test(raw)) continue;
    if (genericWords.has(raw.toLowerCase()) || isDynamicCountdownText(raw)) continue;

    const inSamePopup =
      popupRootId !== null && isDescendantOf(snapshot, node, popupRootId);
    const lcaDepth = findLcaDepth(snapshot, node, ancestorDepthMap);
    const isBottomNav =
      !inSamePopup &&
      snapshot.screenHeight > 0 &&
      node.attr.top >= snapshot.screenHeight * 0.88;
    const nx = (node.attr.left + node.attr.right) / 2;
    const ny = (node.attr.top + node.attr.bottom) / 2;
    const distance = Math.hypot(nx - targetX, ny - targetY);
    candidates.push({
      node,
      raw,
      inSamePopup,
      lcaDepth,
      isBottomNav,
      distance,
    });
  }

  candidates.sort((a, b) => {
    if (a.inSamePopup !== b.inSamePopup) return a.inSamePopup ? -1 : 1;
    if (a.isBottomNav !== b.isBottomNav) return a.isBottomNav ? 1 : -1;
    if (a.lcaDepth !== b.lcaDepth) return b.lcaDepth - a.lcaDepth;
    return a.distance - b.distance;
  });

  const seenText = new Set<string>();
  const out: NormalizedSnapshotNode[] = [];
  for (const candidate of candidates) {
    if (seenText.has(candidate.raw)) continue;
    seenText.add(candidate.raw);
    out.push(candidate.node);
    if (out.length >= 6) break;
  }
  return out;
}

function buildAncestorDepthMap(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): Map<number, number> {
  const map = new Map<number, number>();
  let current: NormalizedSnapshotNode | undefined = node;
  while (current) {
    map.set(current.id, current.attr.depth);
    current = current.pid >= 0 ? snapshot.nodeById.get(current.pid) : undefined;
  }
  return map;
}

function findLcaDepth(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
  targetAncestors: Map<number, number>,
): number {
  let current: NormalizedSnapshotNode | undefined = node;
  while (current) {
    const depth = targetAncestors.get(current.id);
    if (depth !== undefined) return depth;
    current = current.pid >= 0 ? snapshot.nodeById.get(current.pid) : undefined;
  }
  return -1;
}

function findPopupSubtreeRootId(
  snapshot: ParsedGkdSnapshot,
  pickedNode: NormalizedSnapshotNode,
): number | null {
  let highestNonFullscreen: NormalizedSnapshotNode | null = null;
  let current: NormalizedSnapshotNode | undefined =
    pickedNode.pid >= 0 ? snapshot.nodeById.get(pickedNode.pid) : undefined;
  while (current) {
    const ratio = nodeAreaRatio(snapshot, current);
    if (ratio < FULLSCREEN_MASK_AREA_THRESHOLD && current.attr.depth >= 1) {
      highestNonFullscreen = current;
    }
    current = current.pid >= 0 ? snapshot.nodeById.get(current.pid) : undefined;
  }
  return highestNonFullscreen?.id ?? null;
}

function isDescendantOf(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
  ancestorId: number,
): boolean {
  let current: NormalizedSnapshotNode | undefined = node;
  while (current) {
    if (current.id === ancestorId) return true;
    current = current.pid >= 0 ? snapshot.nodeById.get(current.pid) : undefined;
  }
  return false;
}

function nodeDimensions(node: NormalizedSnapshotNode): {
  width: number;
  height: number;
} {
  const width =
    Math.max(0, node.attr.right - node.attr.left) ||
    Math.max(0, node.attr.width ?? 0);
  const height =
    Math.max(0, node.attr.bottom - node.attr.top) ||
    Math.max(0, node.attr.height ?? 0);
  return { width, height };
}

function nodeAreaRatio(
  snapshot: ParsedGkdSnapshot,
  node: NormalizedSnapshotNode,
): number {
  const screenArea = Math.max(1, snapshot.screenWidth * snapshot.screenHeight);
  const { width, height } = nodeDimensions(node);
  return (width * height) / screenArea;
}

function shortName(name: string): string {
  return name.split(".").at(-1) ?? name;
}
