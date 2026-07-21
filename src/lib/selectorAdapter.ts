/**
 * GKD selector 桥接层：把 `@gkd-kit/selector`（Kotlin→JS 编译包）的接口
 * 适配到我们 `NormalizedSnapshotNode` 节点结构上。
 *
 * 不要删 `clazzList` 那段——它看起来什么都没干，但访问 `.name` 的副作用
 * 是告诉 esbuild/Vite minify "这些 Kotlin 类名别改"，否则 `instanceof`
 * 在生产环境会静默挂掉。
 */
import {
  Transform,
  Selector,
  MatchOption,
  AstNode,
  QueryContext,
  QueryResult,
  initDefaultTypeInfo,
  SyntaxException,
  GkdException,
  getStringAttr,
  getStringInvoke,
  getIntInvoke,
  getBooleanInvoke,
  FastQuery,
  BinaryExpression,
  CompareOperator,
  ConnectExpression,
  ConnectOperator,
  ConnectSegment,
  ConnectWrapper,
  Expression,
  LogicalExpression,
  LogicalOperator,
  LogicalSelectorExpression,
  NotExpression,
  PolynomialExpression,
  PropertySegment,
  ValueExpression,
  PropertyUnit,
  PropertyWrapper,
  SelectorExpression,
  SelectorLogicalOperator,
  TupleExpression,
  UnitSelectorExpression,
  NotSelectorExpression,
} from "@gkd-kit/selector";
import type { NormalizedSnapshotNode, ParsedGkdSnapshot } from "../types/gkdSnapshot";

const KtSelector = Selector as unknown as {
  Companion: {
    parseAst: (source: string) => AstNode<Selector>;
    parseOrNull: (source: string) => Selector | null | undefined;
    parse: (source: string) => Selector;
  };
};
const KtTransform = Transform as unknown as {
  Companion: {
    multiplatformBuild: <T>(
      getAttr: (p0: any, p1: string) => any,
      getInvoke: (p0: any, p1: string, p2: any) => any,
      getName: (p0: T) => any,
      getChildren: (p0: T) => any,
      getParent: (p0: T) => any,
    ) => Transform<T>;
  };
};

// ★ keep class name trick（照搬 inspect/src/utils/selector.ts）
// 仅副作用：让 esbuild/Vite minify 不要压缩这些 Kotlin 类名，
// 否则 `instanceof` 静默失败，selector 匹配在生产环境全挂。
const clazzList = Object.entries({
  MatchOption, QueryResult, Transform, QueryContext, AstNode, Selector,
  FastQuery, BinaryExpression, CompareOperator, ConnectExpression,
  ConnectOperator, ConnectSegment, ConnectWrapper, Expression,
  LogicalExpression, LogicalOperator, LogicalSelectorExpression,
  NotExpression, PolynomialExpression, PropertySegment, ValueExpression,
  PropertyUnit, PropertyWrapper, SelectorExpression, SelectorLogicalOperator,
  TupleExpression, UnitSelectorExpression, NotSelectorExpression,
  SyntaxException, GkdException,
}).map(([k, v]) => ({ clazz: v as any, name: k }));
clazzList.forEach((v) => {
  Object.keys(v.clazz).forEach((sub) => {
    const c = (v.clazz as any)[sub];
    if (c instanceof Function) clazzList.push({ clazz: c, name: sub });
  });
});
clazzList.forEach((v) => {
  // 故意访问 .name 以防 minify 改 Kotlin 类标识符
  void v.clazz.name;
});

export interface MatchResult {
  clickIds: number[];
  unparsed: boolean;
  unparsedReason?: string;
}

let cached: { matchOption: MatchOption; typeInfo: ReturnType<typeof initDefaultTypeInfo> } | null = null;
function ensureGlobals() {
  if (cached) return cached;
  cached = {
    matchOption: new MatchOption(false),
    typeInfo: initDefaultTypeInfo(true),
  };
  return cached;
}

// KMP 会根据 `target` 的实际类型调用我们的桥接：
//   - QueryContext：链式匹配中的上下文（解 `.current` 拿节点）
//   - string/number/boolean：`MemberExpression` / `InvokeExpression` 中间结果
//     （例如 text.length 求值时，"跳过" 字符串会作为 target 传进 getAttr）
//   - node：真正的节点
function readAttr(target: unknown, name: string): string | number | boolean | null {
  // 几个非节点的伪属性
  if (name === "_id") {
    const n = unwrapNode(target);
    return n ? n.id : null;
  }
  if (name === "_pid") {
    const n = unwrapNode(target);
    return n ? n.pid : null;
  }
  if (typeof target === "string") return getStringAttr(target, name);
  if (typeof target === "number" || typeof target === "boolean") return null;
  const node = unwrapNode(target);
  if (!node) return null;
  if (name === "text.length") return node.attr.text?.length ?? 0;
  const value = (node.attr as unknown as Record<string, unknown>)[name];
  if (value === undefined || value === null) return null;
  return value as string | number | boolean;
}

function unwrapNode(target: unknown): NormalizedSnapshotNode | null {
  if (target == null) return null;
  if (target instanceof QueryContext) {
    const c = (target as { current: unknown }).current;
    return (c && typeof c === "object" && "attr" in (c as object)) ? c as NormalizedSnapshotNode : null;
  }
  if (typeof target === "object" && "attr" in (target as object)) {
    return target as NormalizedSnapshotNode;
  }
  return null;
}

export function buildTransform(snapshot: ParsedGkdSnapshot): Transform<NormalizedSnapshotNode> {
  return KtTransform.Companion.multiplatformBuild<NormalizedSnapshotNode>(
    (node, name) => readAttr(node, name),
    (node, fnName, args) => {
      // InvokeExpression 的中间结果：getChild(0)、childCount() 之类
      if (typeof node === "string") return getStringInvoke(node, fnName, args);
      if (typeof node === "number") return getIntInvoke(node, fnName, args);
      if (typeof node === "boolean") return getBooleanInvoke(node, fnName, args);
      const real = unwrapNode(node);
      if (!real) return null;
      if (fnName === "getChild") {
        const view = typeof args?.asJsReadonlyArrayView === "function"
          ? args.asJsReadonlyArrayView()
          : (args as unknown as ReadonlyArray<unknown>);
        const i = (view[0] as number) ?? 0;
        return snapshot.nodeById.get(real.children[i]) ?? null;
      }
      return null;
    },
    (node) => {
      const real = unwrapNode(node);
      return real ? real.attr.name : null;
    },
    (node) => {
      const real = unwrapNode(node);
      if (!real) return [];
      const out: NormalizedSnapshotNode[] = [];
      for (const id of real.children) {
        const c = snapshot.nodeById.get(id);
        if (c) out.push(c);
      }
      return out;
    },
    (node) => {
      const real = unwrapNode(node);
      if (!real) return null;
      return real.pid >= 0 ? snapshot.nodeById.get(real.pid) ?? null : null;
    },
  );
}

export function matchGkdSelectorString(
  snapshot: ParsedGkdSnapshot,
  expr: string,
): MatchResult {
  try {
    const ast = KtSelector.Companion.parseAst(expr);
    const { matchOption, typeInfo } = ensureGlobals();
    ast.value.checkType(typeInfo.globalType);
    const transform = buildTransform(snapshot);
    const root = snapshot.nodes.find((n) => n.pid < 0) ?? snapshot.nodes[0];
    if (!root) {
      return { clickIds: [], unparsed: true, unparsedReason: "empty-snapshot" };
    }
    const results = transform.querySelectorAllContextArray(root, ast.value, matchOption);
    const seen = new Set<number>();
    const clickIds: number[] = [];
    for (const r of results as Array<QueryResult<NormalizedSnapshotNode>>) {
      const target = (r as { target: NormalizedSnapshotNode | null | undefined }).target;
      if (target && !seen.has(target.id)) {
        seen.add(target.id);
        clickIds.push(target.id);
      }
    }
    return { clickIds, unparsed: false };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return { clickIds: [], unparsed: true, unparsedReason: msg };
  }
}
