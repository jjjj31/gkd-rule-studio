import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DeviceSnapshotSummary,
  NormalizedSnapshotNode,
  ParsedGkdSnapshot,
} from "../types/gkdSnapshot";
import type { AppRuleDraft } from "../types/ruleDraft";
import {
  evaluateMultiSnapshotSample,
  isCurrentMultiSnapshotValidation,
  releaseSnapshotResource,
  toMultiSnapshotSampleMetadata,
  type MultiSnapshotExpectation,
  type MultiSnapshotSample,
  type MultiSnapshotValidationResult,
  type MultiSnapshotValidationRun,
} from "../lib/multiSnapshotValidation";
import "./MultiSnapshotValidationPanel.css";

export interface MultiSnapshotValidationPanelProps {
  app: AppRuleDraft;
  snapshot: ParsedGkdSnapshot;
  availableSnapshots?: DeviceSnapshotSummary[];
  loadSnapshot?: (id: number) => Promise<ParsedGkdSnapshot>;
}

interface LoadedSnapshot {
  snapshot: ParsedGkdSnapshot;
  ownedUrl: boolean;
  run: MultiSnapshotValidationRun;
}

export function MultiSnapshotValidationPanel({
  app,
  snapshot,
  availableSnapshots = [],
  loadSnapshot,
}: MultiSnapshotValidationPanelProps) {
  const [samples, setSamples] = useState<MultiSnapshotSample[]>([]);
  const [loaded, setLoaded] = useState<Map<number, LoadedSnapshot>>(() => new Map());
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [pendingIds, setPendingIds] = useState<number[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [selectedAvailableId, setSelectedAvailableId] = useState("");
  const [selectedExpectation, setSelectedExpectation] =
    useState<MultiSnapshotExpectation>("positive");
  const loadedRef = useRef(loaded);
  const mountedRef = useRef(false);
  loadedRef.current = loaded;

  const appKey = useMemo(() => JSON.stringify(app), [app]);
  const appIdRef = useRef(app.id);
  const runRef = useRef<MultiSnapshotValidationRun>({ token: 0, appKey });
  if (runRef.current.appKey !== appKey) {
    runRef.current = { token: runRef.current.token + 1, appKey };
  }
  const currentRun = runRef.current;
  appIdRef.current = app.id;

  useEffect(() => {
    setSamples((current) =>
      current.filter((item) => item.appId === app.id),
    );
    setLoaded((current) => {
      const next = new Map(current);
      for (const [id, item] of current) {
        if (item.snapshot.appId !== app.id) {
          releaseSnapshotResource({
            screenshotUrl: item.snapshot.screenshotUrl,
            ownedUrl: item.ownedUrl,
          });
          next.delete(id);
        }
      }
      return next;
    });
    setErrors({});
    setPendingIds([]);
  }, [app.id]);

  useEffect(() => {
    setLoaded((current) => {
      const sampleIds = new Set(samples.map((item) => item.id));
      const next = new Map(current);
      for (const [id, item] of current) {
        if (!sampleIds.has(id) && item.run.token !== currentRun.token) {
          releaseSnapshotResource({
            screenshotUrl: item.snapshot.screenshotUrl,
            ownedUrl: item.ownedUrl,
          });
          next.delete(id);
        }
      }
      return next;
    });
  }, [currentRun, samples]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const item of loadedRef.current.values()) {
        releaseSnapshotResource({
          screenshotUrl: item.snapshot.screenshotUrl,
          ownedUrl: item.ownedUrl,
        });
      }
      loadedRef.current.clear();
    };
  }, []);

  const resultInputs = useMemo(() => {
    const map = new Map<number, { snapshot: ParsedGkdSnapshot; ownedUrl: boolean }>();
    for (const sample of samples) {
      if (snapshot.id === sample.id && snapshot.appId === sample.appId) {
        map.set(sample.id, { snapshot, ownedUrl: false });
      } else {
        const item = loaded.get(sample.id);
        if (item && item.snapshot.appId === sample.appId) {
          map.set(sample.id, item);
        }
      }
    }
    return map;
  }, [loaded, samples, snapshot]);

  const results = useMemo(
    () =>
      samples.map((sample) => {
        const item = resultInputs.get(sample.id);
        if (!item) {
          return {
            sample,
            validation: null,
            rules: [],
            verdict: "unknown" as const,
            message: errors[sample.id] ?? "样例尚未加载。",
            targets: [],
            isCurrent: true,
          };
        }
        return evaluateMultiSnapshotSample({
          sample,
          snapshot: item.snapshot,
          app,
          run: currentRun,
          currentRun,
        });
      }),
    [app, currentRun, errors, refreshToken, resultInputs, samples],
  );

  function isSampleId(id: number): boolean {
    return samples.some((item) => item.id === id);
  }

  function addSample(
    source: ParsedGkdSnapshot,
    expectation: MultiSnapshotExpectation,
    sourceLabel: string,
    ownedUrl = false,
    run = currentRun,
  ): void {
    if (isSampleId(source.id)) return;
    setSamples((current) => [
      ...current,
      toMultiSnapshotSampleMetadata(source, expectation, sourceLabel),
    ]);
    if (ownedUrl) {
      setLoaded((current) => {
        const next = new Map(current);
        next.set(source.id, { snapshot: source, ownedUrl: true, run });
        return next;
      });
    }
  }

  async function addAvailableSample(): Promise<void> {
    const id = Number(selectedAvailableId);
    const summary = availableSnapshots.find((item) => item.id === id);
    if (!summary || !loadSnapshot) return;
    if (appsDiffer(summary.appId, app.id)) {
      setErrors((current) => ({ ...current, [id]: "该快照属于其他 App，不能加入此规则。" }));
      return;
    }
    if (isSampleId(id)) {
      setErrors((current) => ({ ...current, [id]: "该快照已在样例列表中。" }));
      return;
    }

    const requestRun = currentRun;
    const expected = selectedExpectation;
    setPendingIds((current) => [...current, id]);
    setErrors((current) => ({ ...current, [id]: "" }));
    try {
      const loadedSnapshot = await loadSnapshot(id);
      if (
        !mountedRef.current ||
        !isCurrentMultiSnapshotValidation(requestRun, runRef.current) ||
        appIdRef.current !== app.id ||
        appsDiffer(loadedSnapshot.appId, app.id) ||
        loadedSnapshot.id !== id
      ) {
        releaseSnapshotResource({
          screenshotUrl: loadedSnapshot.screenshotUrl,
          ownedUrl: true,
        });
        return;
      }
      addSample(
        loadedSnapshot,
        expected,
        `设备快照 · ${summary.appInfo?.name ?? summary.appName ?? summary.appId}`,
        true,
        requestRun,
      );
      setSelectedAvailableId("");
    } catch (cause) {
      if (mountedRef.current && isCurrentMultiSnapshotValidation(requestRun, runRef.current)) {
        setErrors((current) => ({
          ...current,
          [id]: cause instanceof Error ? cause.message : "加载快照失败。",
        }));
      }
    } finally {
      setPendingIds((current) => current.filter((pending) => pending !== id));
    }
  }

  function removeSample(id: number): void {
    setSamples((current) => current.filter((item) => item.id !== id));
    releaseLoadedSample(id);
    setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  function setExpectation(id: number, expectation: MultiSnapshotExpectation): void {
    setSamples((current) =>
      current.map((item) => (item.id === id ? { ...item, expectation } : item)),
    );
  }

  const appSnapshots = availableSnapshots.filter(
    (item) =>
      !appsDiffer(item.appId, app.id) &&
      item.id !== snapshot.id &&
      !isSampleId(item.id),
  );

  function releaseLoadedSample(id: number): void {
    setLoaded((current) => {
      const item = current.get(id);
      if (!item) return current;
      releaseSnapshotResource({
        screenshotUrl: item.snapshot.screenshotUrl,
        ownedUrl: item.ownedUrl,
      });
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }

  return (
    <section className="multi-snapshot-panel" aria-label="多快照正反例验证">
      <header>
        <div>
          <strong>正反例验证</strong>
          <span>同一规则逐张检查；这些样例不会成为流程步骤或写入规则。</span>
        </div>
        <button type="button" onClick={() => setRefreshToken((value) => value + 1)}>
          重新验证
        </button>
      </header>

      <div className="multi-snapshot-add-actions">
        <button type="button" onClick={() => addSample(snapshot, "positive", "当前快照")}>
          添加当前快照为正例
        </button>
        <button type="button" onClick={() => addSample(snapshot, "negative", "当前快照")}>
          添加当前快照为反例
        </button>
      </div>

      {appSnapshots.length > 0 && loadSnapshot && (
        <div className="multi-snapshot-device-picker">
          <label>
            <span>设备中的同 App 快照</span>
            <select
              value={selectedAvailableId}
              onChange={(event) => setSelectedAvailableId(event.target.value)}
            >
              <option value="">选择快照…</option>
              {appSnapshots.map((item) => (
                <option key={item.id} value={item.id}>
                  #{item.id} · {item.appInfo?.name ?? item.appName ?? item.appId} · {item.activityId ?? "无 Activity"}
                </option>
              ))}
            </select>
          </label>
          <select
            aria-label="新样例预期"
            value={selectedExpectation}
            onChange={(event) =>
              setSelectedExpectation(
                event.target.value === "negative" ? "negative" : "positive",
              )
            }
          >
            <option value="positive">应匹配（正例）</option>
            <option value="negative">不应匹配（反例）</option>
          </select>
          <button
            type="button"
            disabled={!selectedAvailableId || pendingIds.includes(Number(selectedAvailableId))}
            onClick={() => void addAvailableSample()}
          >
            {pendingIds.includes(Number(selectedAvailableId)) ? "载入中…" : "添加设备快照"}
          </button>
        </div>
      )}
      {!loadSnapshot && (
        <p>当前快照仍单独作为参照；连接设备后，可从同 App 的其他快照添加样例。</p>
      )}

      {samples.length === 0 ? (
        <p className="multi-snapshot-empty">先添加一张正例或反例；当前快照不会被自动计入。</p>
      ) : (
        <div className="multi-snapshot-list" data-refresh-token={refreshToken}>
          {results.map((result) => (
            <SampleResult
              key={result.sample.id}
              result={result}
              onRemove={() => removeSample(result.sample.id)}
              onExpectation={(expectation) =>
                setExpectation(result.sample.id, expectation)
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SampleResult({
  result,
  onRemove,
  onExpectation,
}: {
  result: MultiSnapshotValidationResult;
  onRemove: () => void;
  onExpectation: (expectation: MultiSnapshotExpectation) => void;
}) {
  const { sample, validation, verdict, message } = result;
  const status = validation?.status ?? "unknown";
  const ruleCount = result.rules.length;
  const matchingRules = result.rules.filter(
    (rule) => rule.status === "satisfied" && rule.clickNodes.length > 0,
  ).length;
  return (
    <article className={`multi-snapshot-sample is-${verdict}`}>
      <div className="multi-snapshot-sample-heading">
        <div>
          <strong>#{sample.id} · {sample.sourceLabel}</strong>
          <span>{sample.expectation === "positive" ? "正例：应匹配" : "反例：不应匹配"} · {sample.nodeCount} 个节点</span>
        </div>
        <select
          aria-label={`样例 ${sample.id} 预期`}
          value={sample.expectation}
          onChange={(event) =>
            onExpectation(event.target.value === "negative" ? "negative" : "positive")
          }
        >
          <option value="positive">正例</option>
          <option value="negative">反例</option>
        </select>
        <button type="button" onClick={onRemove}>删除</button>
      </div>
      <div className={`multi-snapshot-verdict verdict-${verdict}`} role="status">
        <strong>{verdictLabel(verdict)}</strong>
        <span>{message}</span>
        <span>
          App 聚合：{statusLabel(status)} · 命中规则 {matchingRules}/{ruleCount} · 实际目标 {result.targets.length}
        </span>
      </div>
      {validation?.diagnostics?.map((diagnostic) => (
        <p key={diagnostic} className="multi-snapshot-diagnostic">{diagnostic}</p>
      ))}
      {result.targets.length > 0 && (
        <div className="multi-snapshot-targets">
          <span>实际目标</span>
          {result.targets.map((node) => (
            <span key={node.id} className="multi-snapshot-target">
              #{node.id} {nodeLabel(node)} · [{nodeBounds(node)}]
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function nodeLabel(node: NormalizedSnapshotNode): string {
  return (
    node.attr.text ||
    node.attr.desc ||
    node.attr.id?.split("/").pop() ||
    node.attr.vid ||
    node.attr.name.split(".").pop() ||
    node.attr.name
  );
}

function nodeBounds(node: NormalizedSnapshotNode): string {
  return `${node.attr.left},${node.attr.top} → ${node.attr.right},${node.attr.bottom}`;
}

function verdictLabel(verdict: MultiSnapshotValidationResult["verdict"]): string {
  if (verdict === "pass") return "符合预期";
  if (verdict === "fail") return "不符合预期";
  return "未知";
}

function statusLabel(status: string): string {
  if (status === "satisfied") return "已满足";
  if (status === "unsatisfied") return "未满足";
  if (status === "partial") return "部分验证";
  if (status === "invalid") return "无效";
  return "未加载";
}

function appsDiffer(first: string, second: string): boolean {
  return first.trim().toLowerCase() !== second.trim().toLowerCase();
}
