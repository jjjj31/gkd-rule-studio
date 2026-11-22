/**
 * 多步流程规则组装。
 * 把多个 FlowRuleStep（每步有自己的快照、选点、候选）合成为一条大的 AppRuleDraft。
 * 同时提供流程级别的 help prompt 构建。
 * @see ruleDraft.ts 单步规则组装，本模块是多步版
 */
import type { NormalizedSnapshotNode } from "../types/gkdSnapshot";
import JSON5 from "json5";
import type { AppRuleDraft, RuleDraft } from "../types/ruleDraft";
import type { FlowDraftInput, FlowRuleStep } from "../types/flowDraft";
import { AI_RULE_OUTPUT_CONTRACT, AI_RULE_OUTPUT_EXAMPLE } from "./aiRuleContract";
import { isDynamicActivityId } from "./countdownText";
import {
  GKD_RULE_SELF_CHECK,
  analyzeClickableTarget,
  formatClickTargetHint,
  formatRuleSettingsLines,
  type PromptAudience,
} from "./helpPrompt";
import { buildVisualTargetIds } from "./visualTarget";

interface BuildableFlowStep extends FlowRuleStep {
  selectedCandidate: NonNullable<FlowRuleStep["selectedCandidate"]>;
}

export interface FlowHelpPromptInput extends FlowDraftInput {
  /** external（默认）：复制给外部 AI；builtin：内置 AI，禁止追问并省略外部反馈格式。 */
  audience?: PromptAudience;
}

const MAX_STEP_TREE_LINES = 120;

/** 多步 → 组装成大 AppRuleDraft，lint 后返回（可能部分步骤跳过）。无可用步骤时返回 null。 */
export function createFlowAppRuleDraft(
  input: FlowDraftInput,
): AppRuleDraft | null {
  const buildableSteps = input.steps.filter(isBuildableStep);
  const firstStep = buildableSteps[0];
  if (!firstStep) return null;
  const rules = buildableSteps.map((step, index) =>
    createFlowRule(step, index, buildableSteps),
  );
  const groupFastQuery = rules.every((rule) => rule.fastQuery === true);

  return {
    id: firstStep.snapshot.appId,
    name: firstStep.snapshot.appInfo?.name ?? firstStep.snapshot.appId,
    groups: [
      removeUndefined({
        key: input.groupKey ?? 0,
        name: flowGroupName(input.flowName),
        desc: input.flowDesc?.trim() || undefined,
        fastQuery: groupFastQuery ? true : undefined,
        rules: groupFastQuery
          ? rules.map(({ fastQuery: _fastQuery, ...rule }) => rule)
          : rules,
      }),
    ],
  };
}

/** JSON5 序列化（用于复制和预览）。 */
export function stringifyFlowRuleDraft(draft: AppRuleDraft): string {
  return JSON5.stringify(draft, null, 2);
}

/** 多步求助 prompt：默认每步内嵌节点树节选；includeNodeTrees=false 时省略，改为指引外部 AI 读导出文件。 */
export function buildFlowHelpPrompt(input: FlowHelpPromptInput): string {
  const flowName = input.flowName.trim() || "未命名流程";
  const includeNodeTrees = input.includeNodeTrees ?? true;
  const isBuiltin = input.audience === "builtin";
  const appIds = Array.from(new Set(input.steps.map((step) => step.snapshot.appId)));
  const lines = [
    "你是 GKD 规则专家。请根据下面的多快照流程信息生成完整的多步骤 GKD 规则。",
    "这是一份求助 prompt：用户已经在本地选好了多个快照、步骤顺序和目标节点，你需要把这些信息合成为可用规则。",
    "",
    "重要限制：",
    "- 多步骤关系优先用 rules[].preKeys 表达，不要编造 workflow/state machine。",
    ...(isBuiltin
      ? [
          "- 内置自动生成模式：直接基于当前步骤顺序与已提供的 preKeys 生成完整 JSON5 候选（并在不同候选中验证合理的 preKeys 组合），禁止向用户追问。",
        ]
      : [
          "- 如果步骤之间的先后依赖、触发条件或场景不明确，先向用户追问；默认按步骤顺序串联 preKeys，不代表唯一正确关系。",
        ]),
    "- 运行场景默认按整个流程统一处理；除非快照或用户备注明确说明不同步骤需要不同场景，否则不要为每步强行拆分场景。",
    "- 步骤备注和延迟说明只作为判断上下文，不要生成 GKD 不支持的字段。",
    "- 避免点击下载、安装、打开、查看详情、广告热区等危险 CTA。",
    "- 特别注意流氓广告/广告 SDK：资源名含 shade/mask/hotArea/click_area/ad_click/splash_click 的节点通常是遮罩或广告热区，即使同时含 skip/close 也不要当成首选点击目标；优先找真实跳过按钮/布局，例如 *_skip_ll、*_skip_btn、tv_ad_skip。",
    "- pickedNode 是用户选中的目标区域，不是可以随意跳过的参考；第一条候选必须命中每步 pickedNode 本身、与它矩形重合的视觉摞或安全 clickable 父容器（禁止跳到同屏标题、兄弟 CTA 或无关关闭图标）。同时注意用户点击只是手指常点的大概区域，同一可视区域可能有多个节点（视觉摞、父子层、遮罩层与真实按钮层），在同一目标区域内不要把当前 pickedNode 当成唯一正确目标，必须结合每一步的节点树、bounds、clickable、id/vid/text、父子关系判断安全可点击层（无安全可点击父容器时改用 action: \"clickCenter\"）。",
    "- fastQuery: true 严苛约束：仅当规则中每条 selector 最右侧匹配单元都包含精确 id/vid 或非正则 text，且 id/vid/text 必须位于最右侧节点首个独立 [...] 中，不与其它属性用 && 混写（如 [vid=\"x\"][clickable=true] 支持，但 [clickable=true][vid=\"x\"] 和 [vid=\"x\" && clickable=true] 均不支持 fastQuery），且目标不在 WebView 内时才开启；纯 desc、无字图标、纯类名/宽高结构、或最右侧节点无 id/vid/text 必须省略 fastQuery 或设为 false。",
    "- 严禁默认添加 actionDelay；测试版 A/B 默认立即点击，仅在倒计时刚出现不可点、过渡动画未就绪或已触发未关闭时，才在测试版 C 按需测试 actionDelay。",
    "- 禁止编造 vid/id 或把 id 改写成 vid；禁止写死 left/top/right/bottom 固定像素坐标；禁止把带动态数字/匿名后缀的 activityId 写死进 activityIds；多分支用 anyMatches，不要写顶层逗号。",
    "",
    "输出格式（严格按此格式输出，否则提取失败）：",
    "1. 所有测试版必须放在唯一一个 ```json5 代码块中，块内是一个 JSON 对象：{ candidates: [{ id, title, summary, risk, app }] }。candidates 数量 2-4 个。",
    "2. 每个候选的 id 使用 candidate-a/candidate-b 稳定短 id；title 使用“测试版 A / 测试版 B / 测试版 C”这种唯一短名称。",
    "3. app 必须是完整的 GKD 规则对象 { id, name, groups }，多步骤用 rules[].preKeys 表达先后关系。",
    "4. summary 用 1-2 句说明验证思路和可能失败点；risk 说明误触风险。",
    "5. 测试版应覆盖：A=保守方案(高置信稳定 selector，不设 actionDelay 立即点击)，B=同框节点/安全父节点/真实按钮层验证（同样不设 actionDelay），C=按需调整 actionDelay/actionCd/actionMaximum 与 preKeys 组合；如有 WebView/遮罩证据才加 D=广告容器兜底。",
    ...(isBuiltin
      ? []
      : [
          "6. 代码块之后附上“测试反馈格式”，要求用户反馈测试版编号、每一步是否触发、是否进入下一步、是否误触、失败在哪个 Activity 等信息。",
        ]),
    `${isBuiltin ? "6" : "7"}. 不要输出节点树复述、不要输出无关长解释。不要加多个代码块——只允许一个 \`\`\`json5 块。`,
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
    "流程信息：",
    `- flowName: ${flowName}`,
    `- flowDesc: ${input.flowDesc?.trim() || "-"}`,
    `- appIds: ${appIds.join(", ") || "-"}`,
    `- stepCount: ${input.steps.length}`,
    ...(includeNodeTrees
      ? []
      : [
          "- nodeTree: 本 prompt 不再内嵌各步骤的节点树，避免与导出文件重复。每个快照的完整节点树、bounds 坐标和截图请见随消息附上的导出文件（在工具首页对快照点导出，得到 Markdown 文档 + PNG 截图）；未收到附件时，先要求用户导出并上传，再生成规则。",
        ]),
    "",
  ];

  input.steps.forEach((step, index) => {
    lines.push(
      ...formatStepForPrompt(step, index, includeNodeTrees, input.stepScenarios?.[step.id]),
      "",
    );
  });

  if (!isBuiltin) {
    lines.push(...GKD_RULE_SELF_CHECK);
  }

  return lines.join("\n");
}

function isBuildableStep(step: FlowRuleStep): step is BuildableFlowStep {
  return Boolean(step.snapshot && step.selectedCandidate);
}

function formatStepPreKeys(step: FlowRuleStep, index: number): string {
  if (step.preKeys && step.preKeys.length > 0) {
    return `[${step.preKeys.join(",")}]`;
  }
  if (index === 0) return "无(第 1 步)";
  return "默认线性全串";
}

function createFlowRule(
  step: BuildableFlowStep,
  index: number,
  steps: BuildableFlowStep[],
): RuleDraft {
  const key = index + 1;
  const preKeys =
    step.preKeys && step.preKeys.length > 0
      ? step.preKeys
      : index === 0
        ? undefined
        : steps.slice(0, index).map((_, previousIndex) => previousIndex + 1);

  return removeUndefined({
    ...step.selectedCandidate.rule,
    key,
    name: stepRuleName(step, index),
    preKeys,
  });
}

function flowGroupName(flowName: string): string {
  const name = flowName.trim();
  return name || "未命名流程";
}

function stepRuleName(step: FlowRuleStep, index: number): string {
  const title = step.title.trim() || `步骤 ${index + 1}`;
  return title;
}

function formatStepForPrompt(
  step: FlowRuleStep,
  index: number,
  includeTree: boolean,
  scenario?: { label: string; description?: string },
): string[] {
  const pickResult = step.pickResult;
  const stepTitle = step.title.trim() || `步骤 ${index + 1}`;
  const lines = [
    `步骤 ${index + 1}：${stepTitle}`,
    `- note: ${step.note.trim() || "-"}`,
    `- delayNote: ${step.delayNote.trim() || "-"}`,
    `- preKeys: ${formatStepPreKeys(step, index)}`,
    `- appId: ${step.snapshot.appId}`,
    `- appName: ${step.snapshot.appInfo?.name ?? "-"}`,
    `- activityId: ${step.snapshot.activityId ?? "-"}`,
    ...(isDynamicActivityId(step.snapshot.activityId)
      ? [
          `  ⚠️ 注意：当前步骤 activityId（${step.snapshot.activityId}）带动态数字/匿名后缀，严禁写死进 activityIds！`,
        ]
      : []),
    `- sourceName: ${step.snapshot.sourceName}`,
    ...(scenario
      ? [
          `- 场景: ${scenario.label}${scenario.description ? `（${scenario.description}）` : ""}`,
        ]
      : []),
    "- 场景参数：",
    ...formatRuleSettingsLines(step.ruleSettings).map((line) => `  ${line}`),
  ];

  if (pickResult) {
    const pickedNode = pickResult.pickedNode;
    lines.push("- 用户点击的目标节点：", formatNodeDetail(pickedNode));

    const { visualStackNodes, safeClickableTarget, unsafeClickableCandidate } =
      analyzeClickableTarget(step.snapshot, pickResult);

    if (!pickedNode.attr.clickable) {
      if (safeClickableTarget) {
        const hint = formatClickTargetHint(pickedNode);
        const descNote = hint.usesDesc
          ? "（基于 desc 匹配时禁止开启 fastQuery: true）"
          : "";
        lines.push(
          `  ⚠️ 警示：目标节点 #${pickedNode.id} clickable=false，安全可点击父容器为 #${safeClickableTarget.id} ${shortName(safeClickableTarget.attr.name)} (clickable=true)。若用子属性过滤，必须用 @ 语法提升点击目标（如 @[clickable=true] > ${hint.expression}${descNote}）。`,
        );
      } else if (unsafeClickableCandidate) {
        lines.push(
          `  ⚠️ 警示：目标节点 #${pickedNode.id} clickable=false，外层可点击容器 #${unsafeClickableCandidate.node.id} ${shortName(unsafeClickableCandidate.node.attr.name)}（${unsafeClickableCandidate.reason}）属于大面积/热区/危险容器，严禁 @ 抬升！必须显式设置 action: "clickCenter"。`,
        );
      } else {
        lines.push(
          `  ⚠️ 警示：目标节点 #${pickedNode.id} clickable=false，且父链未发现安全 clickable=true 容器。规则必须显式设置 action: "clickCenter"（坐标点击）。`,
        );
      }
    }

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
      `- 本步真实 vid 白名单: ${realVids.length > 0 ? realVids.map((v) => `vid="${v}"`).join(", ") : "无"}`,
      `- 本步真实 id 白名单: ${realIds.length > 0 ? realIds.slice(0, 8).map((id) => `id="${id}"`).join(", ") : "无"}`,
    );
  } else {
    lines.push("- 用户点击的目标节点：未选择");
  }

  if (includeTree) {
    lines.push(
      "- 当前步骤节点树摘要：",
      ...formatStepTreeExcerpt(step).map((line) => `  ${line}`),
    );
  }

  return lines;
}

function formatStepTreeExcerpt(step: FlowRuleStep): string[] {
  const pickedNode = step.pickResult?.pickedNode ?? null;
  const nodes = step.snapshot.nodes;
  const excerpt =
    pickedNode === null
      ? nodes.slice(0, MAX_STEP_TREE_LINES)
      : selectTargetRelatedNodes(step, pickedNode).slice(0, MAX_STEP_TREE_LINES);
  const lines = excerpt.map((node) => formatNodeLine(node));
  if (excerpt.length < nodes.length) {
    lines.push(`... 已省略 ${nodes.length - excerpt.length} 个节点`);
  }
  return lines;
}

function selectTargetRelatedNodes(
  step: FlowRuleStep,
  pickedNode: NormalizedSnapshotNode,
): NormalizedSnapshotNode[] {
  const keep = new Set<number>();
  const addChain = (node: NormalizedSnapshotNode | undefined) => {
    let current = node;
    while (current && keep.size < MAX_STEP_TREE_LINES) {
      keep.add(current.id);
      current = current.pid >= 0 ? step.snapshot.nodeById.get(current.pid) : undefined;
    }
  };

  // 1. 目标自身与全祖先链
  addChain(pickedNode);

  // 2. 视觉摞及其祖先链
  const visualIds = buildVisualTargetIds({ snapshot: step.snapshot, pickedNode });
  for (const id of visualIds) {
    addChain(step.snapshot.nodeById.get(id));
  }

  // 3. 目标的直接子节点、同父兄弟、父级兄弟（叔节点）——只基于静态父 ID，绝不在遍历时读动态 keep.has(node.pid)
  const parentNode =
    pickedNode.pid >= 0 ? step.snapshot.nodeById.get(pickedNode.pid) : undefined;
  const grandParentNode =
    parentNode && parentNode.pid >= 0
      ? step.snapshot.nodeById.get(parentNode.pid)
      : undefined;

  const directChildren = step.snapshot.nodes.filter(
    (node) => node.pid === pickedNode.id,
  );
  const directSiblings = step.snapshot.nodes
    .filter((node) => node.pid === pickedNode.pid && node.id !== pickedNode.id)
    .sort(
      (a, b) =>
        Math.abs(a.attr.index - pickedNode.attr.index) -
        Math.abs(b.attr.index - pickedNode.attr.index),
    );
  const parentSiblings = parentNode
    ? step.snapshot.nodes
        .filter((node) => node.pid === parentNode.pid && node.id !== parentNode.id)
        .sort(
          (a, b) =>
            Math.abs(a.attr.index - parentNode.attr.index) -
            Math.abs(b.attr.index - parentNode.attr.index),
        )
    : [];
  const grandParentSiblings = grandParentNode
    ? step.snapshot.nodes
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

  const structuralLimit = Math.max(keep.size, MAX_STEP_TREE_LINES - 24);
  for (const node of [
    ...directChildren,
    ...directSiblings,
    ...parentSiblings,
    ...grandParentSiblings,
  ]) {
    if (keep.size >= structuralLimit) break;
    keep.add(node.id);
  }

  // 4. 保锚节点（按距离优先，确保父链完整）
  const targetX = (pickedNode.attr.left + pickedNode.attr.right) / 2;
  const targetY = (pickedNode.attr.top + pickedNode.attr.bottom) / 2;
  const anchorKeywords =
    /(?:title|close|cancel|skip|ad|btn|button|dialog|popup|banner|time|count)/i;

  const candidateAnchors: Array<{ node: NormalizedSnapshotNode; distance: number }> = [];
  for (const node of step.snapshot.nodes) {
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
      candidateAnchors.push({ node, distance: Math.hypot(nx - targetX, ny - targetY) });
    }
  }

  candidateAnchors.sort((a, b) => a.distance - b.distance);
  for (const { node } of candidateAnchors) {
    if (keep.size >= MAX_STEP_TREE_LINES) break;
    let n: NormalizedSnapshotNode | undefined = node;
    const path: NormalizedSnapshotNode[] = [];
    while (n && !keep.has(n.id)) {
      path.push(n);
      n = n.pid >= 0 ? step.snapshot.nodeById.get(n.pid) : undefined;
    }
    if (keep.size + path.length <= MAX_STEP_TREE_LINES) {
      for (const p of path) keep.add(p.id);
    }
  }

  return step.snapshot.nodes.filter((node) => keep.has(node.id));
}

function formatNodeDetail(node: NormalizedSnapshotNode): string {
  const width =
    Math.max(0, node.attr.right - node.attr.left) ||
    Math.max(0, node.attr.width ?? 0);
  const height =
    Math.max(0, node.attr.bottom - node.attr.top) ||
    Math.max(0, node.attr.height ?? 0);
  return JSON.stringify({
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
    index: node.attr.index,
    depth: node.attr.depth,
  });
}

function formatNodeLine(node: NormalizedSnapshotNode): string {
  const width =
    Math.max(0, node.attr.right - node.attr.left) ||
    Math.max(0, node.attr.width ?? 0);
  const height =
    Math.max(0, node.attr.bottom - node.attr.top) ||
    Math.max(0, node.attr.height ?? 0);
  const parts = [
    `#${node.id}`,
    shortName(node.attr.name),
    node.attr.clickable ? "clickable" : "",
    node.attr.visibleToUser ? "" : "hidden",
    `d=${node.attr.depth}`,
    `p=#${node.pid}`,
    `idx=${node.attr.index}`,
    `${width}x${height}`,
    node.attr.text ? `text=${JSON.stringify(node.attr.text)}` : "",
    node.attr.desc ? `desc=${JSON.stringify(node.attr.desc)}` : "",
    node.attr.vid ? `vid=${JSON.stringify(node.attr.vid)}` : "",
    node.attr.id ? `id=${JSON.stringify(node.attr.id)}` : "",
    `bounds=[${node.attr.left},${node.attr.top},${node.attr.right},${node.attr.bottom}]`,
  ].filter(Boolean);
  return `${"  ".repeat(Math.max(0, node.attr.depth))}${parts.join(" ")}`;
}

function shortName(name: string): string {
  return name.split(".").pop() ?? name;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
