import { describe, expect, it } from "vitest";
import {
  buildFeatureTokens,
  buildFewShotPrompt,
  featureSimilarity,
  formatFewShotExamples,
  getDistilledFewShotLibrary,
  retrieveFewShot,
  retrieveOnDeviceFewShot,
  type FewShotRecord,
} from "./fewShotRetrieval";
import { normalizeSnapshot } from "./snapshotNormalize";
import { pickExistingNode } from "./nodePicker";

function makeRecord(overrides: Partial<FewShotRecord> = {}): FewShotRecord {
  return {
    id: "1:1",
    appId: "com.demo",
    appName: "Demo",
    groupName: "全屏广告",
    selector: "@ImageView[clickable=true] - [text=\"反馈\"]",
    selectorShape: {
      kind: "sibling",
      hasAt: true,
      hasUnion: false,
      hasHierarchy: false,
      hasSibling: true,
      attrs: ["clickable", "text"],
    },
    target: {
      id: 1,
      name: "android.widget.ImageView",
      vid: null,
      text: null,
      desc: null,
      clickable: true,
      childCount: 0,
      depth: 6,
      bounds: [0, 0, 90, 90],
    },
    context: {
      ancestors: [],
      siblings: [
        {
          id: 2,
          name: "android.widget.TextView",
          vid: null,
          text: "反馈",
          desc: null,
          clickable: true,
          visible: true,
        },
      ],
      anchors: [
        {
          id: 2,
          name: "android.widget.TextView",
          vid: null,
          text: "反馈",
          desc: null,
          clickable: true,
          visible: true,
          anchorWords: ["反馈"],
        },
      ],
      targetPath: "FrameLayout > ImageView",
    },
    features: [],
    ...overrides,
  };
}

describe("few-shot retrieval", () => {
  it("builds features from target attributes and anchor words", () => {
    const record = makeRecord();
    const tokens = buildFeatureTokens({
      target: record.target,
      context: record.context,
      selectorShape: record.selectorShape,
    });
    expect(tokens).toContain("cls:ImageView");
    expect(tokens).toContain("vid:no");
    expect(tokens).toContain("click:yes");
    expect(tokens).toContain("cc:0");
    expect(tokens).toContain("depth:d6-8");
    expect(tokens).toContain("anchor:反馈");
    expect(tokens).toContain("kind:sibling");
    expect(tokens).toContain("op:at");
  });

  it("scores identical feature sets highest", () => {
    const tokens = ["cls:ImageView", "vid:no", "anchor:反馈"];
    expect(featureSimilarity(tokens, tokens)).toBeCloseTo(1, 5);
    expect(featureSimilarity(tokens, ["cls:Button"])).toBe(0);
  });

  it("ranks the closer example first", () => {
    const near = makeRecord({
      id: "near",
      features: ["cls:ImageView", "vid:no", "anchor:反馈", "kind:sibling"],
    });
    const far = makeRecord({
      id: "far",
      selector: "[vid=\"iv_close\"]",
      features: ["cls:Button", "vid:yes", "kind:attr_only"],
      target: { ...makeRecord().target, name: "android.widget.Button", vid: "iv_close" },
    });
    const query = {
      target: makeRecord().target,
      context: makeRecord().context,
      features: ["cls:ImageView", "vid:no", "anchor:反馈"],
    };
    const hits = retrieveFewShot([far, near], query, 2);
    expect(hits[0].record.id).toBe("near");
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("renders a prompt with target, examples and output rules", () => {
    const record = makeRecord({
      features: ["cls:ImageView", "vid:no", "anchor:反馈"],
    });
    const query = {
      target: record.target,
      context: record.context,
      features: record.features,
    };
    const prompt = buildFewShotPrompt(query, retrieveFewShot([record], query, 1));
    expect(prompt).toContain("## 目标控件");
    expect(prompt).toContain("## 相似历史案例");
    expect(prompt).toContain(record.selector);
    expect(prompt).toContain("只输出选择器字符串");
  });

  it("formats retrieved examples for the full rule prompt", () => {
    const record = makeRecord({
      features: ["cls:ImageView", "vid:no", "anchor:反馈"],
    });
    const query = {
      target: record.target,
      context: record.context,
      features: record.features,
    };
    const text = formatFewShotExamples(
      retrieveFewShot([record], query, 1),
    ).join("\n");
    expect(text).toContain("案例 1");
    expect(text).toContain("形态 sibling");
    expect(text).toContain(record.selector);
    expect(text).toContain("目标：");
  });

  it("retrieves cross-app diverse examples from the bundled distilled library", () => {
    const library = getDistilledFewShotLibrary();
    expect(library.length).toBeGreaterThanOrEqual(150);

    const snapshot = normalizeSnapshot(
      {
        id: 100,
        appId: "com.current.app",
        activityId: "com.current.app.MainActivity",
        screenWidth: 1080,
        screenHeight: 2400,
        isLandscape: false,
        appInfo: { id: "com.current.app", name: "CurrentApp" },
        nodes: [
          {
            id: 0,
            pid: -1,
            idQf: null,
            textQf: null,
            attr: {
              id: null,
              vid: null,
              name: "android.widget.FrameLayout",
              text: null,
              desc: null,
              clickable: false,
              focusable: false,
              checkable: false,
              checked: false,
              editable: false,
              longClickable: false,
              visibleToUser: true,
              left: 0,
              top: 0,
              right: 1080,
              bottom: 2400,
              width: 1080,
              height: 2400,
              childCount: 1,
              index: 0,
              depth: 0,
            },
          },
          {
            id: 1,
            pid: 0,
            idQf: null,
            textQf: null,
            attr: {
              id: null,
              vid: "dislike_item",
              name: "android.widget.LinearLayout",
              text: null,
              desc: null,
              clickable: true,
              focusable: false,
              checkable: false,
              checked: false,
              editable: false,
              longClickable: false,
              visibleToUser: true,
              left: 80,
              top: 1000,
              right: 520,
              bottom: 1100,
              width: 440,
              height: 100,
              childCount: 1,
              index: 0,
              depth: 1,
            },
          },
          {
            id: 2,
            pid: 1,
            idQf: null,
            textQf: null,
            attr: {
              id: null,
              vid: null,
              name: "android.widget.TextView",
              text: "不感兴趣",
              desc: null,
              clickable: false,
              focusable: false,
              checkable: false,
              checked: false,
              editable: false,
              longClickable: false,
              visibleToUser: true,
              left: 120,
              top: 1020,
              right: 320,
              bottom: 1080,
              width: 200,
              height: 60,
              childCount: 0,
              index: 0,
              depth: 2,
            },
          },
        ],
      },
      "",
      "100",
    );

    const pick = pickExistingNode(snapshot, snapshot.nodeById.get(1)!);
    const hits = retrieveOnDeviceFewShot({ snapshot, pickResult: pick, k: 3 });
    expect(hits).toHaveLength(3);
    expect(hits.every((hit) => hit.record.appId !== "com.current.app")).toBe(true);
    const kinds = new Set(hits.map((hit) => hit.record.selectorShape.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(2);
  });
});
