import { describe, expect, it } from "vitest";
import {
  AD_SDK_SIGNATURES,
  detectAdSdkForNode,
  detectAdSdkInSnapshot,
  matchAdSdkSkipSignal,
} from "./adSdkSignatures";
import { scoreCandidate } from "../lib/riskScoring";
import { normalizeSnapshot } from "../lib/snapshotNormalize";
import { exactSelector } from "../lib/selectorSerialize";
import type { NormalizedSnapshotNode, RawGkdSnapshot, SnapshotNode, SnapshotNodeAttr } from "../types/gkdSnapshot";

function attr(o: Partial<SnapshotNodeAttr>): SnapshotNodeAttr {
  return o as SnapshotNodeAttr;
}
function node(id: number, pid: number, a: SnapshotNodeAttr): SnapshotNode {
  return { id, pid, idQf: Boolean(a.id), textQf: Boolean(a.text), attr: a };
}

function snapshotWithNodes(nodes: SnapshotNode[]) {
  const raw: RawGkdSnapshot = {
    id: 1,
    appId: "com.demo",
    activityId: "com.demo.MainActivity",
    screenWidth: 1080,
    screenHeight: 2400,
    isLandscape: false,
    appInfo: { id: "com.demo", name: "Demo" },
    nodes: [node(0, -1, attr({ name: "android.widget.FrameLayout", childCount: nodes.length, right: 1080, bottom: 2400 })), ...nodes],
  };
  return normalizeSnapshot(raw, "blob:test", "test.zip");
}

describe("adSdkSignatures 识别", () => {
  it("识别穿山甲新旧包名", () => {
    expect(
      detectAdSdkForNode({ attr: { id: "com.byted.pangle:id/tt_splash_skip_btn", vid: null, name: "TextView" } })?.id,
    ).toBe("pangle");
    expect(
      detectAdSdkForNode({ attr: { id: "com.bytedance.sdk.openadsdk:id/tt_splash_skip_btn", vid: null, name: "TextView" } })?.id,
    ).toBe("pangle");
  });

  it("识别快手与优量汇", () => {
    expect(detectAdSdkForNode({ attr: { id: null, vid: "ksad_container", name: "FrameLayout" } })?.id).toBe("kwad");
    expect(detectAdSdkForNode({ attr: { id: "com.qq.e.ads.nativ.NativeAD", vid: null, name: "View" } })?.id).toBe("gdt");
  });

  it("无 SDK 特征时返回 null", () => {
    expect(detectAdSdkForNode({ attr: { id: "com.demo:id/btn", vid: "tv_skip", name: "TextView" } })).toBeNull();
  });

  it("从整棵快照里找到出现的 SDK", () => {
    const snapshot = snapshotWithNodes([
      node(1, 0, attr({ name: "android.widget.FrameLayout", childCount: 0 })),
      node(2, 0, attr({ name: "android.widget.TextView", vid: "ksad_skip", text: "跳过" })),
    ]);
    expect(detectAdSdkInSnapshot(snapshot)?.id).toBe("kwad");
  });

  it("只认 SDK 专属跳过特征，不认通用跳过/遮罩词", () => {
    expect(
      matchAdSdkSkipSignal({ attr: { id: null, vid: "tt_splash_skip_btn", name: "TextView", text: null, desc: null } })?.sdk.id,
    ).toBe("pangle");
    expect(
      matchAdSdkSkipSignal({ attr: { id: null, vid: "ksad_skip", name: "View", text: null, desc: null } })?.sdk.id,
    ).toBe("kwad");
    // 通用"跳过"文本、广告遮罩、热区都不算 SDK 专属跳过控件
    expect(matchAdSdkSkipSignal({ attr: { id: null, vid: null, name: "TextView", text: "跳过", desc: null } })).toBeNull();
    expect(matchAdSdkSkipSignal({ attr: { id: null, vid: "tobid_splash_skip_shade", name: "View", text: null, desc: null } })).toBeNull();
  });

  it("签名表 id 唯一", () => {
    const ids = AD_SDK_SIGNATURES.map((sdk) => sdk.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("riskScoring 接入 SDK 跳过控件加分", () => {
  function scoreTarget(targetNode: SnapshotNode) {
    const snapshot = snapshotWithNodes([targetNode]);
    const target = snapshot.nodeById.get(targetNode.id) as NormalizedSnapshotNode;
    const plan = { kind: "simple" as const, selector: exactSelector("vid", targetNode.attr.vid ?? "", "TextView") };
    return scoreCandidate({
      baseScore: 50,
      snapshot,
      plan,
      rule: { key: 0, matches: ["TextView[vid=\"x\"]"] },
      validation: { hitCount: 1, clickNodes: [target], supportNodes: [] },
    });
  }

  it("命中穿山甲跳过控件时加分并带 SDK 标签", () => {
    const risk = scoreTarget(node(1, 0, attr({ name: "android.widget.TextView", vid: "tt_splash_skip_btn", text: "跳过", clickable: true, right: 100, bottom: 50, width: 100, height: 50 })));
    expect(risk.items.map((item) => item.label)).toContain("穿山甲跳过控件");
  });

  it("普通跳过控件不加 SDK 分", () => {
    const risk = scoreTarget(node(1, 0, attr({ name: "android.widget.TextView", vid: "tv_skip", text: "跳过", clickable: true, right: 100, bottom: 50, width: 100, height: 50 })));
    expect(risk.items.map((item) => item.label)).not.toContain("穿山甲跳过控件");
  });
});
