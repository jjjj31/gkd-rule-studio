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

interface BuildableFlowStep extends FlowRuleStep {
  selectedCandidate: NonNullable<FlowRuleStep["selectedCandidate"]>;
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

export function buildFlowHelpPrompt(input: FlowDraftInput): string {
  const flowName = input.flowName.trim() || "未命名流程";
  const appIds = Array.from(new Set(input.steps.map((step) => step.snapshot.appId)));
  const lines = [
    "你是 GKD 规则专家。请根据下面的多快照流程信息生成完整的多步骤 GKD 规则。",
    "这是一份求助 prompt：用户已经在本地选好了多个快照、步骤顺序和目标节点，你需要把这些信息合成为可用规则。",
    "",
    "重要限制：",
    "- 多步骤关系优先用 rules[].preKeys 表达，不要编造 workflow/state machine。",
    "- 如果步骤之间的先后依赖、触发条件或场景不明确，先向用户追问；默认按步骤顺序串联 preKeys，不代表唯一正确关系。",
    "- 运行场景默认按整个流程统一处理；除非快照或用户备注明确说明不同步骤需要不同场景，否则不要为每步强行拆分场景。",
    "- 步骤备注和延迟说明只作为判断上下文，不要生成 GKD 不支持的字段。",
    "- 避免点击下载、安装、打开、查看详情、广告热区等危险 CTA。",
    "- 特别注意流氓广告/广告 SDK：资源名含 shade/mask/hotArea/click_area/ad_click/splash_click 的节点通常是遮罩或广告热区，即使同时含 skip/close 也不要当成首选点击目标；优先找真实跳过按钮/布局，例如 *_skip_ll、*_skip_btn、tv_ad_skip。",
    "- 用户点击只是手指常点的大概区域，不是精确指定某一个无障碍节点；同一可视区域可能有多个节点、父子层、遮罩层和真实按钮层。不要把当前 pickedNode 当成唯一正确目标，必须结合每一步的节点树、bounds、clickable、id/vid/text、父子关系判断哪个节点最像真实点击目标。",
    "",
    "输出格式：",
    "1. 第一部分一次性给出 2-4 个测试版规则方案，按“测试版 A / 测试版 B / 测试版 C”命名，每个测试版各自放在独立 JSON5 代码块中。",
    "2. 测试版应覆盖不同思路：稳定 id/vid、真实跳过布局、WebView/广告容器兜底、不同 actionDelay/actionMaximum/actionCd 与 preKeys 组合。不要只给一个看似最终的答案。",
    "3. 每个测试版后用 1-2 句说明它要验证什么、可能失败在哪里、是否有误触风险。",
    "4. 最后输出“测试反馈格式”，要求用户逐个反馈：测试版编号、每一步是否有触发记录、是否进入下一步/关闭目标、是否误触打开广告、失败停在哪个 Activity、是否需要延迟/重试。",
    "5. 用户试成功后会自己保留成功版本；没成功会带测试结果继续反馈。",
    "",
    "流程信息：",
    `- flowName: ${flowName}`,
    `- flowDesc: ${input.flowDesc?.trim() || "-"}`,
    `- appIds: ${appIds.join(", ") || "-"}`,
    `- stepCount: ${input.steps.length}`,
    "",
  ];

  input.steps.forEach((step, index) => {
    lines.push(...formatStepForPrompt(step, index), "");
  });

  return lines.join("\n");
}

function isBuildableStep(step: FlowRuleStep): step is BuildableFlowStep {
  return Boolean(step.snapshot && step.selectedCandidate);
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

function formatStepForPrompt(step: FlowRuleStep, index: number): string[] {
  const pickResult = step.pickResult;
  const stepTitle = step.title.trim() || `步骤 ${index + 1}`;
  const lines = [
    `步骤 ${index + 1}：${stepTitle}`,
    `- note: ${step.note.trim() || "-"}`,
    `- delayNote: ${step.delayNote.trim() || "-"}`,
    `- appId: ${step.snapshot.appId}`,
    `- appName: ${step.snapshot.appInfo?.name ?? "-"}`,
    `- activityId: ${step.snapshot.activityId}`,
    `- sourceName: ${step.snapshot.sourceName}`,
  ];

  if (pickResult) {
    lines.push("- 用户点击目标节点：", formatNodeDetail(pickResult.pickedNode));
  } else {
    lines.push("- 用户点击目标节点：未选择");
  }

  lines.push(
    "- 当前步骤节点树摘要：",
    ...formatStepTreeExcerpt(step).map((line) => `  ${line}`),
  );

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
  const add = (node: NormalizedSnapshotNode | undefined) => {
    if (node) keep.add(node.id);
  };

  add(pickedNode);
  let current: NormalizedSnapshotNode | undefined = pickedNode;
  while (current && current.pid >= 0) {
    current = step.snapshot.nodeById.get(current.pid);
    add(current);
  }

  for (const node of step.snapshot.nodes) {
    if (node.pid === pickedNode.pid || keep.has(node.pid)) {
      keep.add(node.id);
    }
  }

  return step.snapshot.nodes.filter((node) => keep.has(node.id));
}

function formatNodeDetail(node: NormalizedSnapshotNode): string {
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
  });
}

function formatNodeLine(node: NormalizedSnapshotNode): string {
  const parts = [
    `#${node.id}`,
    shortName(node.attr.name),
    node.attr.clickable ? "clickable" : "",
    node.attr.visibleToUser ? "" : "hidden",
    node.attr.text ? `text=${JSON.stringify(node.attr.text)}` : "",
    node.attr.desc ? `desc=${JSON.stringify(node.attr.desc)}` : "",
    node.attr.vid ? `vid=${JSON.stringify(node.attr.vid)}` : "",
    node.attr.id ? `id=${JSON.stringify(node.attr.id)}` : "",
    `bounds=[${node.attr.left},${node.attr.top},${node.attr.right},${node.attr.bottom}]`,
  ].filter(Boolean);
  return `${"  ".repeat(Math.min(node.attr.depth, 12))}${parts.join(" ")}`;
}

function shortName(name: string): string {
  return name.split(".").pop() ?? name;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
