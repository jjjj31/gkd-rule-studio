import { describe, expect, it } from "vitest";
import { buildAiGenerateMessages } from "./aiModel";

describe("full-tree prompt experiment", () => {
  it("keeps the complete prompt when compactPrompt is false", () => {
    const treeLines = Array.from(
      { length: 320 },
      (_, index) => `#${index} TextView text="node-${index}"`,
    );
    const prompt = [
      "用户点击的目标节点：",
      "{ id: 319 }",
      "",
      "节点树摘要：",
      ...treeLines,
    ].join("\n");
    const messages = buildAiGenerateMessages({
      mode: "single",
      prompt,
      compactPrompt: false,
    });
    const userText = messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");

    expect(userText).toContain("#319 TextView text=\"node-319\"");
    expect(userText).not.toContain("已省略");
    expect(userText.length).toBeGreaterThan(9000);
  });
});
