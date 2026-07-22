import type {
  NodePickResult,
  ParsedGkdSnapshot,
} from "./gkdSnapshot";
import type { RuleSettings, SelectorCandidate } from "./ruleDraft";

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
}
