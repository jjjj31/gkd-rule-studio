import JSON5 from "json5";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIBRARY_IMPORTS_KEY, LIBRARY_SOURCES_KEY, inspectLibraryGroup, libraryContentKey, loadLibraryImports,
  loadLibrarySources, normalizeSubscriptionUrl, parseLibrarySubscription,
  prepareLibraryAppend, refreshLibrarySource, saveLibraryImports, saveLibrarySources,
  searchLibraryApps, selectLibraryGroup, stringifyLibrarySelection,
} from "./subscriptionLibrary";
import { buildLibraryTestSubscription } from "./subscriptionTesting";
import type { LibrarySource } from "../types/subscriptionLibrary";
import type { RawSubscriptionDraft } from "./testSubscription";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

function source(url = "https://example.com/a.json5", name = "淘宝", version = 1): LibrarySource {
  return {
    url, refreshedAt: 100,
    subscription: parseLibrarySubscription(JSON5.stringify({
      id: 123, name: "来源 A", version, author: "作者",
      apps: [{ id: "com.taobao", name, groups: [{
        key: 7, name: "关闭弹窗", desc: "两步操作", enable: false,
        actionCdKey: 10, actionMaximumKey: 30, matchTime: 12000,
        snapshotUrls: ["https://example.com/snapshot"], customField: { retained: true },
        rules: [
          { key: 10, matches: '[text="关闭"]', actionMaximum: 2 },
          { key: 30, preKeys: 10, anyMatches: ['[text="确认"]'], actionCdKey: 10, actionMaximumKey: 30 },
        ],
      }] }],
    })),
  };
}

describe("subscription sources and cache", () => {
  it("times out a second source whose headers arrive but body stalls, preserving the first source and allowing retry", async () => {
    vi.useFakeTimers();
    const store = storage();
    const first = source();
    saveLibrarySources([first], store);
    const before = store.getItem(LIBRARY_SOURCES_KEY);
    let signal: AbortSignal | null | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      signal = init?.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
    });
    let outcome = "pending";
    const pending = refreshLibrarySource([first], "https://example.com/second.json5", store)
      .then(() => { outcome = "saved"; }, (error: Error) => { outcome = error.message; });
    await vi.advanceTimersByTimeAsync(20001);
    expect(outcome).toContain("超时");
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(store.getItem(LIBRARY_SOURCES_KEY)).toBe(before);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...first.subscription, id: 456 })));
    expect(await refreshLibrarySource([first], "https://example.com/second.json5", store)).toHaveLength(2);
  });
  it("normalizes URLs while rejecting non-file webpages and unsupported schemes", () => {
    expect(normalizeSubscriptionUrl(" https://EXAMPLE.com:443/a.json5#part ")).toBe("https://example.com/a.json5");
    for (const input of ["javascript:alert(1)", "file:///a", "https://user:pass@example.com/a", "https://github.com/a/b/blob/main/a.json5"]) {
      expect(() => normalizeSubscriptionUrl(input)).toThrow();
    }
    expect(() => parseLibrarySubscription("<!doctype html>")).toThrow("网页");
    expect(() => parseLibrarySubscription("{name:'x'}")).toThrow("id");
    expect(() => parseLibrarySubscription("{id:1,name:'x',version:1,custom:NaN}")).toThrow("非有限");
  });

  it("adds and refreshes one normalized source, and keeps old data on HTTP, parse and storage failures", async () => {
    const store = storage();
    const first = source();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(first.subscription)));
    const added = await refreshLibrarySource([], first.url, store);
    expect(loadLibrarySources(store).sources).toEqual(added);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...first.subscription, version: 2 })));
    const updated = await refreshLibrarySource(added, `${first.url}#fragment`, store);
    expect(updated).toHaveLength(1);
    expect(updated[0].subscription.version).toBe(2);
    const before = store.getItem(LIBRARY_SOURCES_KEY);
    vi.mocked(fetch).mockResolvedValue(new Response("down", { status: 503 }));
    await expect(refreshLibrarySource(updated, first.url, store)).rejects.toThrow("503");
    vi.mocked(fetch).mockResolvedValue(new Response("not json"));
    await expect(refreshLibrarySource(updated, first.url, store)).rejects.toThrow("JSON");
    expect(store.getItem(LIBRARY_SOURCES_KEY)).toBe(before);
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(first.subscription)));
    await expect(refreshLibrarySource(updated, first.url, { ...store, setItem() { throw new Error("quota"); } })).rejects.toThrow("缓存");
    expect(store.getItem(LIBRARY_SOURCES_KEY)).toBe(before);
  });

  it("rejects a different subscription id at a saved URL", async () => {
    const previous = source();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ...previous.subscription, id: 456 })));
    await expect(refreshLibrarySource([previous], previous.url, storage())).rejects.toThrow("不同的订阅 id");
  });

  it("restores usable sources without networking and isolates damaged cached sources", () => {
    const store = storage();
    const first = source();
    store.setItem(LIBRARY_SOURCES_KEY, JSON.stringify([first, { url: "bad" }]));
    expect(loadLibrarySources(store)).toMatchObject({ sources: [first], error: expect.stringContaining("部分") });
    saveLibrarySources([], store);
    expect(loadLibrarySources(store).sources).toEqual([]);
  });

  it("aggregates by package and searches all source names without merging groups", () => {
    const a = source();
    const b = source("https://example.com/b.json5", "Taobao");
    const c = source("https://example.com/c.json5");
    c.subscription.apps[0].id = "com.other.taobao";
    expect(searchLibraryApps([a, b, c], "  TAOBAO  ")).toHaveLength(2);
    expect(searchLibraryApps([a, b], "淘")[0]).toMatchObject({ sourceCount: 2, groupCount: 2 });
    const pickA = selectLibraryGroup(a, a.subscription.apps[0], 0);
    const pickB = selectLibraryGroup(b, b.subscription.apps[0], 0);
    expect(pickA.id).not.toBe(pickB.id);
  });
});

describe("complete rule group delivery", () => {
  it.each(["[text='关闭']", { anyMatches: "[text='关闭']" }, ["[text='关闭']", "[text='取消']"], [{ matches: "[text='关闭']" }]])(
    "accepts GKD string, object and array rule shapes: %j", (rules) => {
      expect(inspectLibraryGroup({ key: 0, name: "关闭", rules }).group).toBeDefined();
    },
  );

  it("preserves all fields and references in a copy without mutating the cache", () => {
    const original = source();
    const before = JSON.stringify(original);
    const selected = selectLibraryGroup(original, original.subscription.apps[0], 0);
    const copied = JSON5.parse(stringifyLibrarySelection(selected));
    expect(copied).toEqual(selected.app);
    expect(copied.groups[0]).toMatchObject({ key: 7, enable: false, customField: { retained: true }, rules: [expect.anything(), { key: 30, preKeys: 10, anyMatches: [expect.any(String)], actionCdKey: 10, actionMaximumKey: 30 }] });
    expect(JSON.stringify(original)).toBe(before);
    expect(copied.groups).toHaveLength(1);
    expect(copied.updateUrl).toBeUndefined();
  });

  it("rejects external scopes, missing references and duplicate keys but keeps their names readable", () => {
    for (const raw of [
      { key: 1, name: "依赖组", scopeKeys: [2], rules: "A" },
      { key: 1, name: "依赖组", rules: { matches: "A", preKeys: [999] } },
      { key: 1, name: "依赖组", rules: [{ key: 1, matches: "A" }, { key: 1, matches: "B" }] },
      { key: 1, name: "依赖组", rules: [{ key: 1, matches: "A" }], actionCdKey: "wrong" },
      { key: 1, name: "依赖组", rules: [{ key: 1, matches: "A" }], actionCdKey: [1] },
    ]) expect(inspectLibraryGroup(raw)).toMatchObject({ name: "依赖组", error: expect.any(String) });
    const broken = source();
    broken.subscription.apps[0].groups.push(broken.subscription.apps[0].groups[0]);
    expect(() => selectLibraryGroup(broken, broken.subscription.apps[0], 0)).toThrow("重复");
  });

  it("maps all local references to the fork's rule order and retains source defaults", () => {
    const original = source();
    const selected = selectLibraryGroup(original, original.subscription.apps[0], 0);
    const prepared = prepareLibraryAppend(selected);
    expect(prepared.groups[0]).toMatchObject({ enable: false, actionCdKey: 0, actionMaximumKey: 1, rules: [
      { key: 0, matches: expect.any(String) }, { key: 1, preKeys: 0, actionCdKey: 0, actionMaximumKey: 1 },
    ] });
    expect(selected.app.groups[0].rules[1].preKeys).toBe(10);
  });

  it("keeps copy attribution in a single comment even when a source name contains Unicode line separators", () => {
    const original = source();
    original.subscription.name = "来源\u2028后续\u2029文字";
    const selected = selectLibraryGroup(original, original.subscription.apps[0], 0);
    expect(JSON5.parse(stringifyLibrarySelection(selected))).toEqual(selected.app);
  });

  it("shares a memory subscription with generated candidates, avoids key collisions and only enables the temporary copy", () => {
    const original = source();
    const selected = selectLibraryGroup(original, original.subscription.apps[0], 0);
    const generated: RawSubscriptionDraft = {
      id: 0, name: "测试", version: 1, author: "local",
      apps: [{ id: "com.taobao", name: "淘宝", groups: [{ key: 7, name: "关闭弹窗", rules: [{ key: 0, matches: ["A"] }] }] }],
    };
    const testing = buildLibraryTestSubscription(generated, selected);
    expect(testing.apps[0].groups).toHaveLength(2);
    expect(testing.apps[0].groups[1]).toMatchObject({ key: 0, enable: true, rules: [expect.anything(), { key: 30, preKeys: 10, anyMatches: expect.any(Array), actionCdKey: 10, actionMaximumKey: 30 }] });
    expect(selected.app.groups[0].enable).toBe(false);
    expect(generated.apps[0].groups).toHaveLength(1);
    expect(buildLibraryTestSubscription(generated, null).apps[0].groups).toHaveLength(1);
  });

  it("keeps fixed import records across source removal and reports record persistence errors", () => {
    const original = source();
    const selected = selectLibraryGroup(original, original.subscription.apps[0], 0);
    const record = { ...selected, importedAt: 123, deviceOrigin: "http://device:8888", targetPackage: "debug", submittedApp: prepareLibraryAppend(selected) };
    const store = storage();
    saveLibraryImports([record], store);
    saveLibrarySources([], store);
    expect(loadLibraryImports(store).records).toEqual([record]);
    expect(() => saveLibraryImports([record], { ...store, setItem() { throw new Error("quota"); } })).toThrow("GKD 已写入");
    expect(loadLibraryImports(store).records).toEqual([record]);
  });

  it("uses complete content, including execution parameters, for repeated-copy identity", () => {
    const original = source();
    const selected = selectLibraryGroup(original, original.subscription.apps[0], 0);
    const reordered = { ...selected, app: { groups: selected.app.groups, name: selected.app.name, id: selected.app.id } };
    expect(libraryContentKey(reordered)).toBe(libraryContentKey(selected));
    const changed = structuredClone(selected);
    changed.app.groups[0].matchTime = 999;
    expect(libraryContentKey(changed)).not.toBe(libraryContentKey(selected));
  });

  it("preserves malformed saved records and refuses to treat them as executable snapshots", () => {
    const original = source();
    const selected = selectLibraryGroup(original, original.subscription.apps[0], 0);
    const record = { ...selected, importedAt: 123, deviceOrigin: "http://device:8888", targetPackage: "debug", submittedApp: prepareLibraryAppend(selected) };
    record.app.groups[0].rules[1].preKeys = [999];
    const store = storage();
    const corrupted = JSON.stringify([record]);
    store.setItem(LIBRARY_IMPORTS_KEY, corrupted);
    expect(loadLibraryImports(store)).toMatchObject({ records: [], error: expect.stringContaining("失败") });
    expect(store.getItem(LIBRARY_IMPORTS_KEY)).toBe(corrupted);
  });
});
