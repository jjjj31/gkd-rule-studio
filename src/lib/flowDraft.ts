import type { NormalizedSnapshotNode } from "../types/gkdSnapshot";
import JSON5 from "json5";
import type { AppRuleDraft, RuleDraft } from "../types/ruleDraft";
import type { FlowDraftInput, FlowRuleStep } from "../types/flowDraft";

interface BuildableFlowStep extends FlowRuleStep {
  selectedCandidate: NonNullable<FlowRuleStep["selectedCandidate"]>;
}

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

export function stringifyFlowRuleDraft(draft: AppRuleDraft): string {
  return JSON5.stringify(draft, null, 2);
}

export function buildFlowHelpPrompt(input: FlowDraftInput): string {
  const draft = createFlowAppRuleDraft(input);
  const flowName = input.flowName.trim() || "未命名流程";
  const appIds = Array.from(new Set(input.steps.map((step) => step.snapshot.appId)));
  const lines = [
    "你是 GKD 规则专家。请根据下面的多快照流程信息生成完整的多步骤 GKD 规则。",
    "这是一份求助 prompt：用户已经在本地选好了多个快照、步骤顺序、目标节点和候选 selector，你需要把这些信息合成为可用规则。",
    "",
    "重要限制：",
    "- 下面的本地 JSON5 草稿仅作为参考，可以直接修正，也可以在保留步骤意图的前提下重组 selector 和 action 参数。",
    "- 多步骤关系优先用 rules[].preKeys 表达，不要编造 workflow/state machine。",
    "- 步骤备注和延迟说明只作为判断上下文，不要生成 GKD 不支持的字段。",
    "- 避免点击下载、安装、打开、查看详情、广告热区等危险 CTA。",
    "- 特别注意流氓广告/广告 SDK：资源名含 shade/mask/hotArea/click_area/ad_click/splash_click 的节点通常是遮罩或广告热区，即使同时含 skip/close 也不要当成首选点击目标；优先找真实跳过按钮/布局，例如 *_skip_ll、*_skip_btn、tv_ad_skip。",
    "- 用户点击只是手指常点的大概区域，不是精确指定某一个无障碍节点；同一可视区域可能有多个节点、父子层、遮罩层和真实按钮层。不要把当前 pickedNode 当成唯一正确目标，必须结合每一步的候选 selector、同框节点提示、bounds、clickable、id/vid/text、父子关系判断哪个节点最像真实点击目标。",
    "",
    "输出格式：",
    "1. 第一部分一次性给出 2-4 个测试版规则方案，按“测试版 A / 测试版 B / 测试版 C”命名，每个测试版各自放在独立 JSON5 代码块中。",
    "2. 测试版应覆盖不同思路：本地草稿保守版、selector 兜底版、action 参数加强版、preKeys/步骤依赖调整版。不要只给一个看似最终的答案。",
    "   如果某一步候选列表里有“同框节点”或相近 bounds 的候选，请至少给一个测试版验证同框候选，避免用户箭头落到垃圾节点而错过真实按钮。",
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

  lines.push(
    "本地生成的 JSON5 草稿仅作为参考：",
    "```json5",
    draft ? stringifyFlowRuleDraft(draft) : "null",
    "```",
  );

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
    name: stepRuleName(step),
    preKeys,
  });
}

function flowGroupName(flowName: string): string {
  const name = flowName.trim();
  return name || "未命名流程";
}

function stepRuleName(step: FlowRuleStep): string {
  const title = step.title.trim() || step.selectedCandidate?.rule.name || "未命名步骤";
  return title;
}

function formatStepForPrompt(step: FlowRuleStep, index: number): string[] {
  const selectedCandidate = step.selectedCandidate;
  const pickResult = step.pickResult;
  const lines = [
    `步骤 ${index + 1}：${step.title.trim() || "未命名步骤"}`,
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

  if (selectedCandidate) {
    lines.push(
      "- 当前步骤推荐候选：",
      `  - strategy: ${selectedCandidate.strategyName}`,
      `  - score: ${selectedCandidate.risk.finalScore}`,
      `  - hitCount: ${selectedCandidate.validation.hitCount}`,
      `  - matches: ${selectedCandidate.rule.matches.join(" && ")}`,
      `  - actionPlan: ${formatActionPlan(selectedCandidate)}`,
    );
  } else {
    lines.push("- 当前步骤推荐候选：未选择");
  }

  if (step.candidates.length) {
    lines.push(
      "- 当前步骤候选 selector：",
      ...step.candidates.slice(0, 5).map((candidate) => {
        return `  - ${candidate.strategyName} / score ${candidate.risk.finalScore} / hit ${candidate.validation.hitCount}: ${candidate.rule.matches.join(" && ")}`;
      }),
    );
  }

  return lines;
}

function formatActionPlan(candidate: BuildableFlowStep["selectedCandidate"]): string {
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

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
