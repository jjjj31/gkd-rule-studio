import { describe, expect, it } from "vitest";
import { createJsRegexToMatches } from "./regexFallback";

describe("createJsRegexToMatches", () => {
  it("按整串匹配而非子串匹配", () => {
    const matcher = createJsRegexToMatches("跳过");
    expect(matcher("跳过")).toBe(true);
    expect(matcher("点击跳过")).toBe(false);
  });

  it("支持 Kotlin 常见的 (?is) / (?i) / (?m) 前置内联标志", () => {
    const anySkip = createJsRegexToMatches("(?is).*跳过.*");
    expect(anySkip("第一行\n点击跳过广告")).toBe(true);
    expect(anySkip("确定")).toBe(false);

    const caseInsensitive = createJsRegexToMatches("(?i)skip\\s*\\d+");
    expect(caseInsensitive("SKIP 3")).toBe(true);
    expect(caseInsensitive("SKIP 3s")).toBe(false);

    const multiline = createJsRegexToMatches("(?ms).*^关闭$.*");
    expect(multiline("第一行\n关闭\n最后一行")).toBe(true);
    expect(multiline("第一行\n关闭按钮\n最后一行")).toBe(false);
  });

  it("支持 \\A / \\z 锚点且非法正则时抛出异常", () => {
    const anchored = createJsRegexToMatches("\\A跳过\\d+\\z");
    expect(anchored("跳过5")).toBe(true);
    expect(anchored("跳过")).toBe(false);

    expect(() => createJsRegexToMatches("[")).toThrow();
  });
});
