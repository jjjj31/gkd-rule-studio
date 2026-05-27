import type {
  NodePickResult,
  ParsedGkdSnapshot,
} from "./gkdSnapshot";
import type { SelectorCandidate } from "./ruleDraft";

export interface FlowRuleStep {
  id: string;
  title: string;
  note: string;
  delayNote: string;
  preKeys?: number[];
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
