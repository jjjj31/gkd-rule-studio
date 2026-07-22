/**
 * GKD selector 反向匹配入口。
 *
 * 内部把字符串 selector 委托给 `@gkd-kit/selector`（GKD 官方 Kotlin→JS 编译包）
 * 解析+匹配；本文件只保留对外的两个函数签名，把"字符串 → 节点"的脏活封装到
 * `./selectorAdapter` 里。
 *
 * 对外接口保持不变：
 * - `validateSelectorPlan(snapshot, plan)` —— 内置算法路径
 * - `validateAiCandidateAgainstSnapshot(candidate, snapshot)` —— AI 路径
 */
import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { SelectorPlan, SelectorValidation } from "../types/ruleDraft";
import type { AiRuleCandidate } from "./aiModel";
import { matchGkdSelectorString } from "./selectorAdapter";
import { serializePlan } from "./selectorSerialize";

function resolveClickNodes(
  snapshot: ParsedGkdSnapshot,
  ids: Iterable<number>,
): NormalizedSnapshotNode[] {
  const out: NormalizedSnapshotNode[] = [];
  for (const id of ids) {
    const n = snapshot.nodeById.get(id);
    if (n) out.push(n);
  }
  return out;
}

export function validateSelectorPlan(
  snapshot: ParsedGkdSnapshot,
  plan: SelectorPlan,
): SelectorValidation {
  // serializePlan 对大多数 kind 返回单串；matchesChain 返回 [context, target]
  // 这两条串对应 GKD 多段链的"裸空格 = Ancestor(1)"，可以直接喂给 KMP。
  const exprs = serializePlan(plan);
  const clickIds = new Set<number>();
  const unparsed: string[] = [];
  for (const expr of exprs) {
    const r = matchGkdSelectorString(snapshot, expr);
    if (r.unparsed) unparsed.push(expr);
    else for (const id of r.clickIds) clickIds.add(id);
  }
  const clickNodes = resolveClickNodes(snapshot, clickIds);
  const result: SelectorValidation = {
    hitCount: clickNodes.length,
    clickNodes,
    supportNodes: [],
  };
  if (unparsed.length > 0) result.unparsedMatches = unparsed;
  return result;
}

export function validateAiCandidateAgainstSnapshot(
  candidate: AiRuleCandidate,
  snapshot: ParsedGkdSnapshot,
): SelectorValidation {
  const clickIds = new Set<number>();
  const unparsed: string[] = [];
  for (const group of candidate.app.groups) {
    for (const rule of group.rules) {
      for (const expr of rule.matches) {
        const r = matchGkdSelectorString(snapshot, expr);
        if (r.unparsed) unparsed.push(expr);
        else for (const id of r.clickIds) clickIds.add(id);
      }
    }
  }
  const clickNodes = resolveClickNodes(snapshot, clickIds);
  const result: SelectorValidation = {
    hitCount: clickNodes.length,
    clickNodes,
    supportNodes: [],
  };
  if (unparsed.length > 0) result.unparsedMatches = unparsed;
  return result;
}
