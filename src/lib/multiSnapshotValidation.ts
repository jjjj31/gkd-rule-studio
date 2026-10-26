import type { ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { AppRuleDraft, SelectorValidation } from "../types/ruleDraft";
import {
  validateAiCandidateAgainstSnapshot,
  validateAppRuleAgainstSnapshot,
} from "./selectorMatcher";

export type MultiSnapshotExpectation = "positive" | "negative";

/** 只保存当前会话内的身份和预期；快照节点与截图 URL 留在运行态。 */
export interface MultiSnapshotSample {
  id: number;
  appId: string;
  expectation: MultiSnapshotExpectation;
  sourceLabel: string;
  nodeCount: number;
}

export interface MultiSnapshotValidationRun {
  token: number;
  appKey: string;
}

export interface SnapshotResourceOwner {
  screenshotUrl: string;
  ownedUrl: boolean;
}

export type MultiSnapshotVerdict = "pass" | "fail" | "unknown";

export interface MultiSnapshotValidationResult {
  sample: MultiSnapshotSample;
  validation: SelectorValidation | null;
  /** Core 返回的逐规则结果，只用于解释正反例。 */
  rules: SelectorValidation[];
  verdict: MultiSnapshotVerdict;
  message: string;
  targets: SelectorValidation["clickNodes"];
  isCurrent: boolean;
}

export function toMultiSnapshotSampleMetadata(
  snapshot: ParsedGkdSnapshot,
  expectation: MultiSnapshotExpectation,
  sourceLabel: string,
): MultiSnapshotSample {
  return {
    id: snapshot.id,
    appId: snapshot.appId,
    expectation,
    sourceLabel,
    nodeCount: snapshot.nodes.length,
  };
}

export function evaluateMultiSnapshotSample({
  sample,
  snapshot,
  app,
  run,
  currentRun,
}: {
  sample: MultiSnapshotSample;
  snapshot: ParsedGkdSnapshot;
  app: AppRuleDraft;
  run: MultiSnapshotValidationRun;
  currentRun?: MultiSnapshotValidationRun;
}): MultiSnapshotValidationResult {
  const isCurrent = !currentRun || isCurrentMultiSnapshotValidation(run, currentRun);
  const identityMatches =
    snapshot.id === sample.id &&
    snapshot.appId === sample.appId &&
    app.id === sample.appId;
  const ruleValidations =
    identityMatches
      ? validateAppRuleAgainstSnapshot(snapshot, app)
      : null;
  if (!isCurrent) {
    return {
      sample,
      validation: null,
      rules: [],
      verdict: "unknown",
      message: "规则已变化或验证已切换，旧结果已丢弃。",
      targets: [],
      isCurrent: false,
    };
  }
  if (!ruleValidations?.length) {
    return {
      sample,
      validation: null,
      rules: [],
      verdict: "unknown",
      message:
        identityMatches
          ? "规则没有可验证的规则项。"
          : "快照身份与样例不一致，无法验证。",
      targets: [],
      isCurrent: true,
    };
  }

  // App 级命中/未知/无效只采用 core 聚合；逐规则结果仅供逐张判定。
  const validation = validateAiCandidateAgainstSnapshot(
    {
      app,
      id: "multi-snapshot",
      title: "多快照验证",
      summary: "",
      risk: "",
    },
    snapshot,
  );
  const status = validation.status ?? "invalid";
  const knownNegativeTargets = ruleValidations
    .filter((result) => result.status === "satisfied")
    .flatMap((result) => result.clickNodes);
  const verdict = classifyVerdict(sample.expectation, status, ruleValidations);
  return {
    sample,
    validation,
    rules: ruleValidations,
    verdict,
    message: describeVerdict(sample.expectation, status, verdict),
    targets:
      sample.expectation === "negative"
        ? knownNegativeTargets.length > 0
          ? uniqueClickNodes(knownNegativeTargets)
          : []
        : verdict === "pass"
          ? validation.clickNodes
          : [],
    isCurrent: true,
  };
}

/** 每个样例请求携带生成时的 appKey；只有同一规则内容的最新 token 可回写。 */
export function isCurrentMultiSnapshotValidation(
  responseRun: MultiSnapshotValidationRun,
  currentRun: MultiSnapshotValidationRun,
): boolean {
  return (
    responseRun.token === currentRun.token &&
    responseRun.appKey === currentRun.appKey
  );
}

/** 只释放组件从 loadSnapshot 得到的资源；父组件的当前快照始终为 ownedUrl=false。 */
export function releaseSnapshotResource(
  resource: SnapshotResourceOwner,
  revoke: (url: string) => void = URL.revokeObjectURL,
): void {
  if (resource.ownedUrl) revoke(resource.screenshotUrl);
}

function classifyVerdict(
  expectation: MultiSnapshotExpectation,
  status: NonNullable<SelectorValidation["status"]>,
  ruleValidations: SelectorValidation[],
): MultiSnapshotVerdict {
  const hasKnownMatch = ruleValidations.some(
    (result) => result.status === "satisfied" && result.clickNodes.length > 0,
  );
  if (expectation === "negative") {
    return hasKnownMatch ? "fail" : status === "unsatisfied" ? "pass" : "unknown";
  }
  if (
    status === "partial" ||
    status === "invalid" ||
    ruleValidations.some(
      (result) => result.status === "partial" || result.status === "invalid",
    )
  ) return "unknown";
  return status === "satisfied" ? "pass" : "fail";
}

function uniqueClickNodes(
  nodes: SelectorValidation["clickNodes"],
): SelectorValidation["clickNodes"] {
  const seen = new Set<number>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function describeVerdict(
  expectation: MultiSnapshotExpectation,
  status: NonNullable<SelectorValidation["status"]>,
  verdict: MultiSnapshotVerdict,
): string {
  if (expectation === "negative" && verdict === "fail") {
    return status === "partial" || status === "invalid"
      ? "反例存在已知误命中，不应匹配；其他规则未完整验证。"
      : "反例存在已知误命中，不应匹配。";
  }
  if (status === "partial") {
    return "静态信息不足，无法完整确认是否符合预期。";
  }
  if (status === "invalid") {
    return "规则存在非法或不可解析内容，需要修正后再验证。";
  }
  if (expectation === "positive") {
    return verdict === "pass" ? "正例按预期命中，需要匹配。" : "正例未命中，需要匹配。";
  }
    return verdict === "pass" ? "反例未被误触，符合预期。" : "反例被误触，不应匹配。";
}
