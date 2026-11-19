/**
 * 官方订阅数据里用顶层逗号表示“任一分支”，而本地
 * `@gkd-kit/selector` 只接受单条分支。这里按括号和引号安全拆分。
 */
export function splitSelectorBranches(selector: string): string[] {
  const branches: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index]!;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === "," && bracketDepth === 0 && parenDepth === 0) {
      const branch = selector.slice(start, index).trim();
      if (branch) branches.push(branch);
      start = index + 1;
    }
  }

  const last = selector.slice(start).trim();
  if (last) branches.push(last);
  return branches.length > 0 ? branches : [selector.trim()];
}
