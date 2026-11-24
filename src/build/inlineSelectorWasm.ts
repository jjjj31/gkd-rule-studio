import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const FALLBACK_MODULE_PATH = fileURLToPath(
  new URL("../lib/regexFallback.ts", import.meta.url),
).replace(/\\/g, "/");

function replaceRequired(
  code: string,
  target: string | RegExp,
  replacement: string,
  label: string,
): string {
  const matched = typeof target === "string" ? code.includes(target) : target.test(code);
  if (!matched) {
    throw new Error(`regex-wasm ${label} 已变化，请检查离线打包与降级适配`);
  }
  return code.replace(target, replacement);
}

function wrapLazyWasmHelper(
  code: string,
  moduleVar: string,
  helpersVar: string,
  getterName: string,
  methodName: string,
): string {
  let next = replaceRequired(
    code,
    `const ${moduleVar} = new WebAssembly.Module(`,
    `let ${helpersVar};\nfunction ${getterName}() {\n  return (${helpersVar} ??= new WebAssembly.Instance(new WebAssembly.Module(`,
    `js-builtins ${moduleVar} 模块定义`,
  );
  next = replaceRequired(
    next,
    new RegExp(
      `\\]\\)\\);\\r?\\nconst ${helpersVar} = new WebAssembly\\.Instance\\(${moduleVar}\\)\\.exports;`,
    ),
    `]))).exports);\n}`,
    `js-builtins ${helpersVar} 实例化`,
  );
  next = replaceRequired(
    next,
    `${helpersVar}.${methodName}`,
    `${getterName}().${methodName}`,
    `js-builtins ${helpersVar}.${methodName} 调用`,
  );
  return next;
}

function transformJsBuiltins(code: string): string {
  let next = wrapLazyWasmHelper(
    code,
    "moduleFromCharCodeArray",
    "helpersFromCharCodeArray",
    "getHelpersFromCharCodeArray",
    "a16_get",
  );
  next = wrapLazyWasmHelper(
    next,
    "moduleIntoCharCode",
    "helpersIntoCharCode",
    "getHelpersIntoCharCode",
    "a16_set",
  );
  return next;
}

function transformImportObject(code: string): string {
  const start = code.indexOf("if (typeof process");
  const end = code.indexOf("export function setWasmExports");
  if (start < 0 || end < start) {
    throw new Error("regex-wasm 宿主入口已变化，请检查离线打包适配");
  }
  let next = code.slice(0, start) + code.slice(end);
  next = replaceRequired(
    next,
    "const wasmJsTag = WebAssembly.JSTag;",
    'const wasmJsTag = typeof WebAssembly !== "undefined" ? WebAssembly.JSTag : undefined;',
    "import-object JSTag 读取",
  );
  next = replaceRequired(
    next,
    "const wasmTag = wasmJsTag ?? new WebAssembly.Tag({ parameters: ['externref'] });",
    'const wasmTag = wasmJsTag ?? (typeof WebAssembly !== "undefined" && typeof WebAssembly.Tag === "function" ? new WebAssembly.Tag({ parameters: [\'externref\'] }) : undefined);',
    "import-object Tag 初始化",
  );
  return next;
}

// Android loads assets through file:// with network disabled; embed the official Wasm binary
// and fall back to JS RegExp when older Android WebView lacks WasmGC / js-string builtins.
export function inlineSelectorWasm(): Plugin {
  return {
    name: "inline-selector-wasm",
    enforce: "pre",
    transform(code, id) {
      const path = id.replace(/\\/g, "/");
      if (path.endsWith("/regex-wasm/dist/regex-wasm.js-builtins.mjs")) {
        return { code: transformJsBuiltins(code), map: null };
      }
      if (path.endsWith("/regex-wasm/dist/regex-wasm.import-object.mjs")) {
        return { code: transformImportObject(code), map: null };
      }
      if (!path.endsWith("/regex-wasm/dist/regex-wasm.mjs")) return;
      const start = code.indexOf("let wasmInstance;");
      const exportsMarker = code.indexOf("export const {");
      if (start < 0 || exportsMarker < start) {
        throw new Error("regex-wasm 初始化入口已变化，请检查离线打包适配");
      }
      const binary = readFileSync(join(dirname(id), "regex-wasm.wasm")).toString("base64");
      const fallbackCode = `import { createJsRegexToMatches } from ${JSON.stringify(FALLBACK_MODULE_PATH)};

let wasmExports = null;
try {
  const binary = Uint8Array.from(atob("${binary}"), (c) => c.charCodeAt(0));
  const wasmInstance = new WebAssembly.Instance(
    new WebAssembly.Module(binary, {
      builtins: ["js-string"],
      importedStringConstants: "'",
    }),
    importObject,
  );
  wasmExports = wasmInstance.exports;
  setWasmExports(wasmExports);
} catch (cause) {
  console.warn("[regex-wasm] 当前运行环境不支持 Wasm 正则，已降级为 JS RegExp：", cause);
}

export const toMatches = wasmExports ? wasmExports.toMatches : createJsRegexToMatches;
export const memory = wasmExports ? wasmExports.memory : undefined;
`;
      return {
        code: code.slice(0, start) + fallbackCode,
        map: null,
      };
    },
  };
}
