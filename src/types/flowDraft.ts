import type {
  NodePickResult,
  ParsedGkdSnapshot,
} from "./gkdSnapshot";
import type {
  PromptScenarioInfo,
  RuleSettings,
  SelectorCandidate,
} from "./ruleDraft";

export interface FlowRuleStep {
  id: string;
  title: string;
  note: string;
  delayNote: string;
  preKeys?: number[];
  /** 这一步独立使用的场景参数（不再跟随全局 ruleSettings）。 */
  ruleSettings: RuleSettings;
  /** 场景预设 id 或自定义场景 id，用于回显下拉框。 */
  scenarioId: string;
  snapshot: ParsedGkdSnapshot;
  pickResult: NodePickResult | null;
  candidates: SelectorCandidate[];
  selectedCandidate: SelectorCandidate | null;
}

export interface FlowDraftInput {
  flowName: string;
  flowDesc?: string;
  groupKey?: number;
  steps: FlowRuleStep[];
  /** false 时省略每步内嵌的节点树（复制给外部 AI 时用，节点树由导出文件携带），默认 true。 */
  includeNodeTrees?: boolean;
  /** 按步骤 id 提供场景名称/说明（预设或自定义场景），未提供的步骤只输出参数值。 */
  stepScenarios?: Record<string, PromptScenarioInfo | undefined>;
}
