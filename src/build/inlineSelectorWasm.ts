import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

// Android loads assets through file:// with network disabled; embed the official Wasm binary.
export function inlineSelectorWasm(): Plugin {
  return {
    name: "inline-selector-wasm",
    enforce: "pre",
    transform(code, id) {
      const path = id.replace(/\\/g, "/");
      if (path.endsWith("/regex-wasm/dist/regex-wasm.import-object.mjs")) {
        const start = code.indexOf("if (typeof process");
        const end = code.indexOf("export function setWasmExports");
        if (start < 0 || end < start) throw new Error("regex-wasm 宿主入口已变化，请检查离线打包适配");
        return { code: code.slice(0, start) + code.slice(end), map: null };
      }
      if (!path.endsWith("/regex-wasm/dist/regex-wasm.mjs")) return;
      const start = code.indexOf("let wasmInstance;");
      const end = code.indexOf("const exports = wasmInstance.exports");
      if (start < 0 || end < start) throw new Error("regex-wasm 初始化入口已变化，请检查离线打包适配");
      const binary = readFileSync(join(dirname(id), "regex-wasm.wasm")).toString("base64");
      return {
        code: code.slice(0, start) + `const binary = Uint8Array.from(atob("${binary}"), c => c.charCodeAt(0));
const wasmInstance = new WebAssembly.Instance(new WebAssembly.Module(binary,
  { builtins: ['js-string'], importedStringConstants: "'" }), importObject);
` + code.slice(end),
        map: null,
      };
    },
  };
}
