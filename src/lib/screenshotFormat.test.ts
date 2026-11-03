import { expect, it } from "vitest";
import { screenshotMimeType } from "./screenshotFormat";

it("detects PNG and WebP by bytes and rejects truncated or unrelated data", () => {
  expect(screenshotMimeType(new Uint8Array([137,80,78,71,13,10,26,10]))).toBe("image/png");
  expect(screenshotMimeType(new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80]))).toBe("image/webp");
  for (const bytes of [[], [82,73,70,70], [1,2,3], [137,80,78]]) {
    expect(() => screenshotMimeType(new Uint8Array(bytes))).toThrow("PNG 或 WebP");
  }
});
