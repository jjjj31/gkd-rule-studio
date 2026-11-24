/**
 * 为不支持 WasmGC / Wasm JS String Builtins（Chromium < 130）的旧版 Android WebView
 * 提供与 Kotlin `Regex.matches` 语义一致的纯 JS 回退实现。
 */

function supportsDotAllFlag(): boolean {
  try {
    void new RegExp(".", "s");
    return true;
  } catch {
    return false;
  }
}

const HAS_DOT_ALL = supportsDotAllFlag();

/** 把不支持 `/s` 标志的旧引擎中的 `.`（字符类 `[...]` 之外）替换为 `[\s\S]`。 */
function emulateDotAll(pattern: string): string {
  let result = "";
  let inClass = false;
  let escaped = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === "[" && !inClass) {
      inClass = true;
      result += ch;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      result += ch;
      continue;
    }
    if (ch === "." && !inClass) {
      result += "[\\s\\S]";
      continue;
    }
    result += ch;
  }
  return result;
}

function parseLeadingInlineFlags(source: string): {
  body: string;
  ignoreCase: boolean;
  multiline: boolean;
  dotAll: boolean;
} {
  let rest = source;
  let ignoreCase = false;
  let multiline = false;
  let dotAll = false;

  while (rest.startsWith("(?")) {
    const match = /^\(\?([imsuxdU-]+)\)/.exec(rest);
    if (!match) break;
    const rawFlags = match[1];
    let enabling = true;
    for (const ch of rawFlags) {
      if (ch === "-") {
        enabling = false;
        continue;
      }
      if (ch === "i") ignoreCase = enabling;
      else if (ch === "m") multiline = enabling;
      else if (ch === "s") dotAll = enabling;
    }
    rest = rest.slice(match[0].length);
  }

  return { body: rest, ignoreCase, multiline, dotAll };
}

/**
 * 对应 `regex-wasm` 导出的 `toMatches(source)`：
 * 编译失败时抛出 Error（供 `@gkd-kit/selector` 捕获并转为语法错误），
 * 成功时返回整串匹配函数。
 */
export function createJsRegexToMatches(source: string): (input: string) => boolean {
  const { body: rawBody, ignoreCase, multiline, dotAll } = parseLeadingInlineFlags(source);
  let body = rawBody;
  if (body.startsWith("\\A")) {
    body = body.slice(2);
  }
  if (body.endsWith("\\z") && !body.endsWith("\\\\z")) {
    body = body.slice(0, -2);
  } else if (body.endsWith("\\Z") && !body.endsWith("\\\\Z")) {
    body = body.slice(0, -2);
  }

  let flags = "";
  if (ignoreCase) flags += "i";
  if (multiline) flags += "m";
  if (dotAll) {
    if (HAS_DOT_ALL) {
      flags += "s";
    } else {
      body = emulateDotAll(body);
    }
  }

  const regex = new RegExp(`^(?:${body})$`, flags);
  return (input: string) => regex.test(input);
}
