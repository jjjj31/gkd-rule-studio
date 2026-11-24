import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inlineSelectorWasm } from "./inlineSelectorWasm";

const require = createRequire(import.meta.url);
const regexWasmEntry = require.resolve("regex-wasm");
const regexWasmDir = dirname(regexWasmEntry);

function runTransformedRegexWasm(options: {
  disableWasmMode?: "all" | "js-string-only";
  checkScript: string;
}) {
  const plugin = inlineSelectorWasm();
  const transform = plugin.transform as (
    code: string,
    id: string,
  ) => { code: string } | undefined;

  const tempDir = mkdtempSync(join(tmpdir(), "inline-selector-wasm-test-"));
  try {
    const files = [
      "regex-wasm.js-builtins.mjs",
      "regex-wasm.import-object.mjs",
      "regex-wasm.mjs",
    ];
    for (const file of files) {
      const fullPath = join(regexWasmDir, file);
      const raw = readFileSync(fullPath, "utf8");
      const result = transform(raw, fullPath);
      let transformed = result ? result.code : raw;
      // Node 原生 ESM 不允许裸 Windows 盘符路径（C:/...），测试临时目录里转为 file:// URL
      transformed = transformed.replace(
        /from "([A-Za-z]:\/[^"]+)"/g,
        (_match, filePath: string) => `from ${JSON.stringify(pathToFileURL(filePath).href)}`,
      );
      writeFileSync(join(tempDir, file), transformed, "utf8");
    }

    const disablePrelude =
      options.disableWasmMode === "all"
        ? `
const OrigModule = WebAssembly.Module;
WebAssembly.Module = function(bytes, opts) {
  if (opts && Array.isArray(opts.builtins)) {
    throw new WebAssembly.CompileError("js-string builtin not supported");
  }
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === 0xfb) {
      throw new WebAssembly.CompileError("WasmGC opcode 0xfb not supported");
    }
  }
  return new OrigModule(bytes, opts);
};
WebAssembly.Module.prototype = OrigModule.prototype;
delete WebAssembly.JSTag;
delete WebAssembly.Tag;
`
        : options.disableWasmMode === "js-string-only"
          ? `
const OrigModule = WebAssembly.Module;
WebAssembly.Module = function(bytes, opts) {
  if (opts && Array.isArray(opts.builtins)) {
    throw new WebAssembly.CompileError("js-string builtin not supported");
  }
  return new OrigModule(bytes, opts);
};
WebAssembly.Module.prototype = OrigModule.prototype;
`
          : "";

    const fallbackUrl = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), "../lib/regexFallback.ts"),
    ).href;
    const entryUrl = pathToFileURL(join(tempDir, "regex-wasm.mjs")).href;
    const script = `
await import(${JSON.stringify(fallbackUrl)});
${disablePrelude}
const mod = await import(${JSON.stringify(entryUrl)});
${options.checkScript}
`;
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    }).trim();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const FALLBACK_CHECK_SCRIPT = `
const matchSkip = mod.toMatches("(?is).*跳过.*");
const matchExact = mod.toMatches("skip");
let invalidThrew = false;
try { mod.toMatches("["); } catch { invalidThrew = true; }
console.log(JSON.stringify({
  matchedNewline: matchSkip("第一行\\n点击跳过广告"),
  missed: matchSkip("确定"),
  exactTrue: matchExact("skip"),
  exactFalse: matchExact("skip_ad"),
  invalidThrew,
  hasMemory: Boolean(mod.memory),
}));
`;

describe("inlineSelectorWasm", () => {
  it("在不支持 WasmGC / Tag 的早期 Android WebView（Chromium < 119）中安全降级", () => {
    const output = runTransformedRegexWasm({
      disableWasmMode: "all",
      checkScript: FALLBACK_CHECK_SCRIPT,
    });

    expect(JSON.parse(output)).toEqual({
      matchedNewline: true,
      missed: false,
      exactTrue: true,
      exactFalse: false,
      invalidThrew: true,
      hasMemory: false,
    });
  });

  it("在支持 WasmGC 但不支持 js-string builtins 的 WebView（Chromium 119-129）中安全降级", () => {
    const output = runTransformedRegexWasm({
      disableWasmMode: "js-string-only",
      checkScript: FALLBACK_CHECK_SCRIPT,
    });

    expect(JSON.parse(output)).toEqual({
      matchedNewline: true,
      missed: false,
      exactTrue: true,
      exactFalse: false,
      invalidThrew: true,
      hasMemory: false,
    });
  });

  it("在支持 Wasm 的现代环境中继续正常使用官方 regex-wasm", () => {
    const output = runTransformedRegexWasm({
      checkScript: `
const matchSkip = mod.toMatches("(?is).*跳过.*");
console.log(JSON.stringify({ matched: matchSkip("点击跳过"), hasMemory: Boolean(mod.memory) }));
`,
    });

    expect(JSON.parse(output)).toEqual({
      matched: true,
      hasMemory: true,
    });
  });
});
