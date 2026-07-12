/** 候选卡片的"小白话"引导标签：给排序和打分结果加一行可读建议（推荐/安全/谨慎/危险）。 */
import type { SelectorCandidate } from "../types/ruleDraft";

export type CandidateGuidanceTone = "recommend" | "safe" | "caution" | "danger";

export interface CandidateGuidance {
  tone: CandidateGuidanceTone;
  label: string;
  reason: string;
}

export function getCandidateGuidance(
  candidate: SelectorCandidate,
  index: number,
): CandidateGuidance {
  const selectorText = candidate.rule.matches.join(" && ").toLowerCase();

  if (isAdOverlaySelector(selectorText)) {
    return {
      tone: "danger",
      label: "不要优先选",
      reason: "像遮罩或广告热区，可能会打开广告。",
    };
  }

  if (targetsCountdownText(candidate, selectorText)) {
    return {
      tone: "caution",
      label: "先看父节点",
      reason: "这是倒计时文字层，真正可点通常在外层父节点。",
    };
  }

  if (isClickableParentStrategy(candidate.strategyName)) {
    return {
      tone: "safe",
      label: "可选",
      reason: "用文字或子控件定位，并点击外层可点区域。",
    };
  }

  if (
    index === 0 &&
    candidate.validation.hitCount === 1 &&
    candidate.risk.level === "low"
  ) {
    return {
      tone: "recommend",
      label: "建议选这个",
      reason: "小白用户直接选这项；它唯一命中且风险最低。",
    };
  }

  if (candidate.validation.hitCount !== 1) {
    return {
      tone: "caution",
      label: "需要复核",
      reason: `当前命中 ${candidate.validation.hitCount} 个，可能点到相似控件。`,
    };
  }

  if (candidate.risk.level === "high") {
    return {
      tone: "danger",
      label: "不建议",
      reason: "风险分较高，除非推荐项失败再测试。",
    };
  }

  return {
    tone: "safe",
    label: "备选",
    reason: "可作为推荐项失败后的测试候选。",
  };
}

function isAdOverlaySelector(selectorText: string): boolean {
  return [
    "shade",
    "mask",
    "hotarea",
    "hot_area",
    "click_area",
    "clickarea",
    "click_group",
    "ad_click",
    "splash_click",
  ].some((word) => selectorText.includes(word));
}

function targetsCountdownText(
  candidate: SelectorCandidate,
  selectorText: string,
): boolean {
  if (
    candidate.strategyName === "clickParentDirectChildText" ||
    candidate.strategyName === "clickParentByChildIdVid" ||
    candidate.strategyName === "adContainerSkipFallback"
  ) {
    return false;
  }

  return (
    selectorText.includes("text^=\"跳过\"") ||
    selectorText.includes("text=\"跳过") ||
    selectorText.includes("text^=\"skip\"") ||
    selectorText.includes("text=\"skip")
  );
}

function isClickableParentStrategy(
  strategyName: SelectorCandidate["strategyName"],
): boolean {
  return (
    strategyName === "clickParentDirectChildText" ||
    strategyName === "clickParentByChildIdVid"
  );
}
