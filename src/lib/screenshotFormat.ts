export type ScreenshotMimeType = "image/png" | "image/webp";

export function screenshotMimeType(bytes: Uint8Array): ScreenshotMimeType {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12 && [82, 73, 70, 70].every((value, index) => bytes[index] === value)
    && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)) return "image/webp";
  throw new Error("截图不是有效的 PNG 或 WebP 数据");
}
