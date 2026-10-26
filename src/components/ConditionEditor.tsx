import { useEffect, useMemo, useState } from "react";
import type { ParsedGkdSnapshot, NormalizedSnapshotNode } from "../types/gkdSnapshot";
import type { SelectorCandidate } from "../types/ruleDraft";
import { copyTextToClipboard } from "../lib/clipboard";
import {
  applyConditionEditorDraft,
  createConditionEditorModel,
  selectorFromSnapshotNode,
  type ConditionEditorCondition,
  type ConditionEditorDraft,
  type ConditionEditorSelector,
} from "../lib/conditionEditor";
import "./ConditionEditor.css";

export interface ConditionEditorProps {
  snapshot: ParsedGkdSnapshot;
  candidate: SelectorCandidate;
  onPreview?: (candidate: SelectorCandidate | null) => void;
  onApply: (candidate: SelectorCandidate) => void;
  onCancel?: () => void;
}

const ATTR_LABELS = {
  text: "文字",
  desc: "描述",
  id: "资源 ID",
  vid: "VID",
} as const;

const OP_LABELS = { eq: "等于", contains: "包含" } as const;
const EXECUTION_LABELS: Record<string, string> = {
  activityIds: "适用页面", fastQuery: "快速查询", action: "动作",
  actionDelay: "动作延迟（毫秒）", matchTime: "匹配窗口（毫秒）",
  actionMaximum: "最多执行次数", actionCd: "动作间隔（毫秒）",
  forcedTime: "强制查询时间（毫秒）", matchRoot: "从根节点查询", resetMatch: "重置条件",
};

export function ConditionEditor({
  snapshot,
  candidate,
  onPreview,
  onApply,
  onCancel,
}: ConditionEditorProps) {
  const model = useMemo(() => createConditionEditorModel(candidate), [candidate]);
  const [draft, setDraft] = useState<ConditionEditorDraft | null>(
    model.supported ? model.draft : null,
  );
  const [loadedCandidate, setLoadedCandidate] = useState(candidate);
  const [advanced, setAdvanced] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    setLoadedCandidate(candidate);
    setDraft(model.supported ? model.draft : null);
  }, [candidate, model]);

  const result = useMemo(
    () =>
      draft
        ? applyConditionEditorDraft({ snapshot, candidate, draft })
        : { candidate: null, previewCandidate: undefined, validation: null },
    [candidate, draft, snapshot],
  );

  useEffect(() => {
    onPreview?.(draft ? result.previewCandidate ?? null : loadedCandidate);
  }, [draft, loadedCandidate, onPreview, result.previewCandidate]);

  function cancelEditing() {
    onPreview?.(loadedCandidate);
    onCancel?.();
  }

  function applyEditing() {
    if (!result.candidate) return;
    onPreview?.(result.candidate);
    onApply(result.candidate);
  }

  if (!model.supported || !draft) {
    const reason = model.supported ? "条件草稿未加载。" : model.reason;
    return (
      <section className="condition-editor condition-editor-advanced" aria-label="条件编辑器">
        <header>
          <div>
            <strong>高级 JSON</strong>
            <span>只读：这条候选含条件表单不能无损表达的字段。</span>
          </div>
          <button type="button" onClick={cancelEditing}>
            取消
          </button>
        </header>
        <p role="status">{reason} 条件未做部分改写，完整原文保留如下。</p>
        <pre>{JSON.stringify(candidate.rule, null, 2)}</pre>
        <button
          type="button"
          onClick={() => {
            void copyTextToClipboard(JSON.stringify(candidate.rule, null, 2)).then(
              () => setCopyStatus("已复制完整规则"),
              () => setCopyStatus("复制失败，请手动选择上方 JSON"),
            );
          }}
        >
          复制完整规则
        </button>
        <span role="status">{copyStatus}</span>
      </section>
    );
  }

  const validation = result.validation;
  const relation = draft.relation;

  return (
    <section className="condition-editor" aria-label="条件编辑器">
      <header>
        <div>
          <strong>编辑候选条件</strong>
          <span>
            条件默认全部满足；每个候选点击最后一个目标。执行设置完整展示并随规则保留。
          </span>
          {model.readOnlyRuleFields.length > 0 && (
            <span>执行设置只读；需要调整时可返回场景设置。</span>
          )}
        </div>
        <div className="condition-editor-header-actions">
          <button
            type="button"
            onClick={cancelEditing}
          >
            取消
          </button>
          <button type="button" onClick={() => setAdvanced((value) => !value)}>
            {advanced ? "隐藏高级 JSON" : "高级 JSON"}
          </button>
        </div>
      </header>

      {model.readOnlyRuleFields.length > 0 && <details className="condition-editor-execution">
        <summary>执行设置（随规则保留）</summary>
        <dl>{model.readOnlyRuleFields.map((field) => <div key={field}>
          <dt>{EXECUTION_LABELS[field] ?? field}</dt>
          <dd>{JSON.stringify(candidate.rule[field])}</dd>
        </div>)}</dl>
      </details>}
      <ConditionFields
        label="点击目标"
        value={draft.target}
        onChange={(target) => setDraft({ ...draft, target })}
      />

      <div className="condition-editor-relation">
        <label>
          <span>上下文</span>
          <select
            value={relation.kind}
            onChange={(event) => {
              const kind = event.target.value;
              if (kind === "none") {
                setDraft({ ...draft, relation: { kind: "none" } });
                return;
              }
              const context = suggestedContext(snapshot, draft.target, kind);
              if (!context) return;
              setDraft({ ...draft, relation: context });
            }}
          >
            <option value="none">无</option>
            <option value="parentChild">父子</option>
            <option value="adjacent">相邻兄弟</option>
          </select>
        </label>

        {relation.kind === "parentChild" && (
          <label>
            <span>上下文位置</span>
            <select
              value={relation.contextRole}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  relation: {
                    ...relation,
                    contextRole: event.target.value === "parent" ? "parent" : "child",
                  },
                })
              }
            >
              <option value="parent">父节点</option>
              <option value="child">子节点</option>
            </select>
          </label>
        )}
        {relation.kind === "adjacent" && (
          <label>
            <span>上下文位置</span>
            <select
              value={relation.contextPosition}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  relation: {
                    ...relation,
                    contextPosition: event.target.value === "before" ? "before" : "after",
                  },
                })
              }
            >
              <option value="before">目标前一个</option>
              <option value="after">目标后一个</option>
            </select>
          </label>
        )}

        {relation.kind === "none" ? (
          <p>当前只有一个目标条件组；可添加一位父/子或相邻节点缩小范围。</p>
        ) : (
          <ConditionFields
            label="上下文节点"
            value={relation.context}
            onChange={(context) => setDraft({ ...draft, relation: { ...relation, context } })}
          />
        )}
      </div>

      {relation.kind !== "none" && (
        <label className="condition-editor-node-picker">
          <span>从当前快照选择上下文节点</span>
          <select
            value=""
            onChange={(event) => {
              const node = snapshot.nodeById.get(Number(event.target.value));
              if (node) {
                setDraft({
                  ...draft,
                  relation: { ...relation, context: selectorFromSnapshotNode(node) },
                });
              }
            }}
          >
            <option value="">选择节点…</option>
            {snapshot.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {nodeOptionLabel(node)}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="condition-editor-validation" role="status">
        {result.error ? (
          <strong>{result.error}</strong>
        ) : (
          <strong>当前快照命中 {validation?.hitCount ?? 0} 个点击目标</strong>
        )}
        {(validation?.hitCount ?? 0) > 1 && (
          <span>规则较宽，会在这些节点中分别尝试；不会一次点击全部节点。</span>
        )}
        {result.normalizations?.map((note) => <span key={note}>{note}</span>)}
        {result.preservedRuleFields && result.preservedRuleFields.length > 0 && (
          <span>已保留执行字段：{result.preservedRuleFields.join("、")}</span>
        )}
        {result.preservedActionPlanFields &&
          result.preservedActionPlanFields.length > 0 && (
            <span>
              已保留动作计划：{result.preservedActionPlanFields.join("、")}；请用高级 JSON 查看完整值。
            </span>
          )}
      </div>

      <div className="condition-editor-actions">
        <button
          type="button"
          onClick={cancelEditing}
        >
          取消编辑
        </button>
        <button
          type="button"
          disabled={!result.candidate}
          onClick={applyEditing}
        >
          应用条件
        </button>
      </div>

      {advanced && (
        <div className="condition-editor-json">
          <pre>{JSON.stringify(result.previewCandidate?.rule ?? candidate.rule, null, 2)}</pre>
          <button
            type="button"
            onClick={() => {
              void copyTextToClipboard(
                JSON.stringify(result.previewCandidate?.rule ?? candidate.rule, null, 2),
              )
                .then(
                  () => setCopyStatus("已复制当前完整规则"),
                  () => setCopyStatus("复制失败，请手动选择 JSON"),
                );
            }}
          >
            复制当前 JSON
          </button>
          <button type="button" onClick={() => setAdvanced(false)}>
            高级 JSON 只读
          </button>
          <span role="status">{copyStatus}</span>
        </div>
      )}
    </section>
  );
}

function ConditionFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ConditionEditorSelector;
  onChange: (value: ConditionEditorSelector) => void;
}) {
  const update = (index: number, patch: Partial<ConditionEditorCondition>) => {
    onChange({
      ...value,
      conditions: value.conditions.map((condition, current) =>
        current === index ? { ...condition, ...patch } : condition,
      ),
    });
  };

  return (
    <fieldset className="condition-editor-fields">
      <legend>{label}</legend>
      <label>
        <span>类型</span>
        <input
          value={value.typeName}
          placeholder="任意类型"
          onChange={(event) => onChange({ ...value, typeName: event.target.value })}
        />
      </label>
      {value.conditions.map((condition, index) => (
        <div className="condition-editor-condition" key={index}>
          <select
            aria-label={`${label}条件 ${index + 1} 属性`}
            value={condition.attr}
            onChange={(event) =>
              update(index, {
                attr: event.target.value as ConditionEditorCondition["attr"],
              })
            }
          >
            {Object.entries(ATTR_LABELS).map(([attr, text]) => (
              <option key={attr} value={attr}>{text}</option>
            ))}
          </select>
          <select
            aria-label={`${label}条件 ${index + 1} 关系`}
            value={condition.op}
            onChange={(event) =>
              update(index, {
                op: event.target.value as ConditionEditorCondition["op"],
              })
            }
          >
            {Object.entries(OP_LABELS).map(([op, text]) => (
              <option key={op} value={op}>{text}</option>
            ))}
          </select>
          <input
            aria-label={`${label}条件 ${index + 1} 值`}
            value={condition.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <button
            type="button"
            aria-label={`删除${label}条件 ${index + 1}`}
            onClick={() =>
              onChange({
                ...value,
                conditions: value.conditions.filter((_, current) => current !== index),
              })
            }
          >
            删除
          </button>
        </div>
      ))}
      <div className="condition-editor-field-actions">
        <button
          type="button"
          onClick={() =>
            onChange({
              ...value,
              conditions: [
                ...value.conditions,
                { attr: "text", op: "eq", value: "" },
              ],
            })
          }
        >
          添加条件
        </button>
        <label className="condition-editor-toggle">
          <input
            type="checkbox"
            checked={value.clickable}
            onChange={(event) => onChange({ ...value, clickable: event.target.checked })}
          />
          可点击
        </label>
        <label className="condition-editor-toggle">
          <input
            type="checkbox"
            checked={value.visibleToUser}
            onChange={(event) =>
              onChange({ ...value, visibleToUser: event.target.checked })
            }
          />
          用户可见
        </label>
      </div>
    </fieldset>
  );
}

function suggestedContext(
  snapshot: ParsedGkdSnapshot,
  target: ConditionEditorSelector,
  kind: string,
): ConditionEditorDraft["relation"] {
  const matching = snapshot.nodes.find((node) => nodeMatches(node, target));
  if (kind === "parentChild" && matching) {
    const parent = snapshot.nodeById.get(matching.pid);
    if (parent) {
      return {
        kind: "parentChild",
        contextRole: "parent",
        context: selectorFromSnapshotNode(parent),
      };
    }
  }
  if (kind === "adjacent" && matching && matching.pid >= 0) {
    const siblings = snapshot.nodes.filter(
      (node) => node.pid === matching.pid && node.id !== matching.id,
    );
    if (siblings.length > 0) {
      return {
        kind: "adjacent",
        contextPosition: "before",
        context: selectorFromSnapshotNode(siblings[0]),
      };
    }
  }
  return { kind: "none" };
}

function nodeMatches(node: NormalizedSnapshotNode, selector: ConditionEditorSelector): boolean {
  const type = node.attr.name.split(".").at(-1) ?? "";
  if (selector.typeName && selector.typeName !== type) return false;
  return selector.conditions.every((condition) => {
    const value = node.attr[condition.attr];
    if (typeof value !== "string") return false;
    return condition.op === "eq" ? value === condition.value : value.includes(condition.value);
  });
}

function nodeOptionLabel(node: NormalizedSnapshotNode): string {
  const label =
    node.attr.text ||
    node.attr.desc ||
    node.attr.vid ||
    node.attr.id ||
    node.attr.name.split(".").at(-1) ||
    String(node.id);
  return `#${node.id} ${label}`;
}
