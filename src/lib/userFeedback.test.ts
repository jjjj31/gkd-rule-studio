import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ParsedGkdSnapshot,
  SnapshotNode,
  SnapshotNodeAttr,
} from "../types/gkdSnapshot";
import {
  createFeedbackId,
  deleteFeedbackDraft,
  loadFeedbackDraft,
  redactFeedbackNodes,
  renderRedactedScreenshot,
  sanitizeFeedbackText,
  saveFeedbackDraft,
  submitUserFeedback,
  type FeedbackDraft,
  type FeedbackPayload,
} from "./userFeedback";

describe("user feedback privacy", () => {
  it("removes Basic credentials from quoted JSON authorization headers", () => {
    const result = sanitizeFeedbackText('{"Authorization":"Basic dXNlcjpwYXNzd29yZA==","status":401}');
    expect(result).not.toContain("dXNlcjpwYXNzd29yZA==");
    expect(JSON.parse(result).status).toBe(401);
  });
  it("redacts known credentials and common secret forms without touching coordinates", () => {
    const text = [
      "secret=sk-live-known-secret",
      "Authorization: Bearer bearer.payload.value",
      "api_key=api-key-789",
      'password="two words"',
      "https://alice:url-pass@example.com/a?token=query-secret&signature=sig-secret&x=10&y=20",
      "node left=10 top=20 right=30 bottom=40 width=20 height=20",
      'id="button-7" tokenCount=4 passwordHint="remember"',
      "账户余额 999 元",
      "占位词 [已隐藏]",
    ].join("\n");

    const result = sanitizeFeedbackText(
      text,
      ["sk-live-known-secret"],
      ["账户余额 999 元", "[已隐藏]"],
    );

    expect(result).not.toContain("sk-live-known-secret");
    expect(result).not.toContain("bearer.payload.value");
    expect(result).not.toContain("api-key-789");
    expect(result).not.toContain("two words");
    expect(result).not.toContain("alice:url-pass");
    expect(result).not.toContain("query-secret");
    expect(result).not.toContain("sig-secret");
    expect(result).not.toContain("账户余额 999 元");
    expect(result).toContain("x=10");
    expect(result).toContain("y=20");
    expect(result).toContain("left=10 top=20 right=30 bottom=40");
    expect(result).toContain('id="button-7"');
    expect(result).toContain("tokenCount=4");
    expect(result).toContain('passwordHint="remember"');
    expect(result).toContain("[已隐藏]");
  });

  it("redacts selected and edge-intersecting nodes without mutating the snapshot", () => {
    const touching = node(1, 1, 2, "边界私密", "边界描述", "id-boundary", "vid-boundary");
    const justOutside = node(2, 1, 2, "保留", null, "id-keep", null);
    const selected = node(3, 1, 2, "共享私密", null, "id-selected", null);
    const textCopy = node(4, 1, 2, null, "共享私密", "id-copy", null);
    const normal = node(5, 1, 2, "普通按钮", null, "com.demo:id/action", "action");
    normal.attr.name = "android.widget.Token token=name-secret";
    Object.assign(normal, { privateNodeExtension: "private-node-extension" });
    Object.assign(normal.attr, { privateAttrExtension: "private-attr-extension" });
    const snapshot = parsedSnapshot([touching, justOutside, selected, textCopy, normal]);

    const result = redactFeedbackNodes(
      snapshot,
      [{ x: 200, y: 100, width: 10, height: 10 }],
      [3],
      ["known-secret"],
      ["已有敏感值", "[已隐藏]"],
    );

    expect(result.nodes).toHaveLength(5);
    expect((result.nodes[0] as SnapshotNode).attr).toMatchObject({
      text: null,
      desc: null,
      id: null,
      vid: null,
    });
    expect((result.nodes[1] as SnapshotNode).attr.text).toBe("保留");
    expect((result.nodes[2] as SnapshotNode).attr.text).toBeNull();
    expect((result.nodes[3] as SnapshotNode).attr.desc).toBeNull();
    expect((result.nodes[4] as SnapshotNode).attr).toMatchObject({
      text: "普通按钮",
      name: "android.widget.Token token=[REDACTED]",
      id: "com.demo:id/action",
      vid: "action",
    });
    expect(Object.keys((result.nodes[4] as SnapshotNode).attr).sort()).toEqual([
      "bottom",
      "checkable",
      "checked",
      "childCount",
      "clickable",
      "depth",
      "desc",
      "editable",
      "focusable",
      "height",
      "id",
      "index",
      "left",
      "longClickable",
      "name",
      "right",
      "text",
      "top",
      "vid",
      "visibleToUser",
      "width",
    ]);
    expect(Object.keys(result.nodes[4] as object).sort()).toEqual([
      "attr",
      "children",
      "id",
      "idQf",
      "pid",
      "textQf",
    ]);
    expect(result.sensitiveTexts).toEqual(
      expect.arrayContaining([
        "已有敏感值",
        "边界私密",
        "边界描述",
        "id-boundary",
        "vid-boundary",
        "共享私密",
        "id-selected",
      ]),
    );
    expect(result.sensitiveTexts).not.toContain("[已隐藏]");
    expect(JSON.stringify(result.nodes)).not.toContain("边界私密");
    expect(JSON.stringify(result.nodes)).not.toContain("共享私密");
    expect(JSON.stringify(result.nodes)).not.toContain("name-secret");
    expect(JSON.stringify(result.nodes)).not.toContain("private-node-extension");
    expect(JSON.stringify(result.nodes)).not.toContain("private-attr-extension");
    expect(result.sensitiveTexts).not.toContain("[已隐藏]");

    expect(touching.attr.text).toBe("边界私密");
    expect(selected.attr.text).toBe("共享私密");
    expect(snapshot.nodeById.get(1)?.attr.text).toBe("边界私密");
    expect(snapshot.screenshotUrl).toBe("blob:private-screenshot");
  });

  it("returns a usable client id when randomUUID is unavailable", () => {
    const cryptoObject = globalThis.crypto;
    vi.stubGlobal("crypto", undefined);
    try {
      const first = createFeedbackId();
      const second = createFeedbackId();
      expect(first).toMatch(/^feedback-[a-z0-9-]{20,}$/i);
      expect(second).not.toBe(first);
    } finally {
      vi.stubGlobal("crypto", cryptoObject);
    }
  });
});

describe("redacted screenshot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("draws clipped opaque rectangles into a new PNG without uploading the source", async () => {
    const fillRect = vi.fn();
    const context = {
      fillStyle: "",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      imageSmoothingEnabled: true,
      drawImage: vi.fn(),
      fillRect,
    } as unknown as CanvasRenderingContext2D;
    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback, type?: string) => {
        callback(new Blob([pngBytes], { type }));
      }),
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal("document", {
      createElement: vi.fn((tag: string) => {
        expect(tag).toBe("canvas");
        return canvas;
      }),
    });
    vi.stubGlobal("Image", fakeImage(100, 50));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await renderRedactedScreenshot("blob:private-source", [
      { x: -10, y: 40, width: 20, height: 30 },
      { x: 90, y: -5, width: 30, height: 20 },
    ]);

    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(50);
    expect(fillRect).toHaveBeenNthCalledWith(1, 0, 40, 10, 10);
    expect(fillRect).toHaveBeenNthCalledWith(2, 90, 0, 10, 15);
    expect(result).toBe("iVBORw==");
    expect(result).not.toContain("data:image/png;base64");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized images before allocating a canvas", async () => {
    const createElement = vi.fn();
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal("Image", fakeImage(5000, 5000));

    await expect(renderRedactedScreenshot("blob:oversized", [])).rejects.toThrow(
      "像素尺寸过大",
    );
    expect(createElement).not.toHaveBeenCalled();
  });
});

describe("feedback submission", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the client id as an idempotency key and sends exactly once", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init: init as RequestInit });
      return new Response(JSON.stringify({ id: "feedback-123" }), { status: 201 });
    });
    const payload = feedbackPayload();

    await expect(
      submitUserFeedback(payload, "http://localhost:4174/api/feedback"),
    ).resolves.toEqual({ id: "feedback-123" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:4174/api/feedback");
    expect(calls[0]!.init.headers).toMatchObject({
      "Content-Type": "application/json",
      "Idempotency-Key": payload.clientId,
    });
    expect(calls[0]!.init.body).toBe(JSON.stringify(payload));
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [409, "已经提交"],
    [429, "过于频繁"],
    [413, "附件过大"],
  ])("maps HTTP %i to a safe actionable error", async (status, message) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("server-secret-details", { status }),
    );

    const error = await submitUserFeedback(feedbackPayload()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toContain("server-secret-details");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects too many or oversized attachments before fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tooMany = feedbackPayload();
    tooMany.attachments = Array.from({ length: 5 }, (_, index) => ({
      name: `${index}.txt`,
      mimeType: "text/plain" as const,
      data: "QQ==",
    }));
    await expect(submitUserFeedback(tooMany)).rejects.toThrow("4 个");

    const tooLarge = feedbackPayload();
    tooLarge.attachments = [{
      name: "large.txt",
      mimeType: "text/plain",
      data: "A".repeat(Math.ceil((8 * 1024 * 1024 + 1) / 3) * 4),
    }];
    await expect(submitUserFeedback(tooLarge)).rejects.toThrow("8 MiB");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects plain HTTP for production hosts", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      submitUserFeedback(feedbackPayload(), "http://120.25.221.144/api/feedback"),
    ).rejects.toThrow("必须使用 HTTPS");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("aborts a stalled request with a safe timeout error", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    );

    const request = submitUserFeedback(feedbackPayload()).catch(
      (caught: unknown) => caught,
    );
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(request).resolves.toMatchObject({
      message: expect.stringContaining("超时"),
    });
  });

  it("keeps the timeout active while a response body is stalled", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
      new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      } }), { status: 201 }));
    const request = submitUserFeedback(feedbackPayload()).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(request).resolves.toMatchObject({ message: expect.stringContaining("超时") });
  });
});

describe("feedback draft storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps one latest draft and can delete it", async () => {
    const database = new MemoryIndexedDb();
    vi.stubGlobal("indexedDB", database);
    const first: FeedbackDraft = { payload: feedbackPayload(), savedAt: 100 };
    const second: FeedbackDraft = {
      payload: { ...feedbackPayload(), clientId: "feedback-second" },
      savedAt: 200,
    };

    await saveFeedbackDraft(first);
    await saveFeedbackDraft(second);
    await expect(loadFeedbackDraft()).resolves.toEqual(second);
    expect(database.size).toBe(1);

    await deleteFeedbackDraft();
    await expect(loadFeedbackDraft()).resolves.toBeNull();
    expect(database.size).toBe(0);
  });

  it("fails explicitly when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(saveFeedbackDraft({ payload: feedbackPayload(), savedAt: 1 })).rejects.toThrow(
      "IndexedDB",
    );
    await expect(loadFeedbackDraft()).rejects.toThrow("IndexedDB");
    await expect(deleteFeedbackDraft()).rejects.toThrow("IndexedDB");
  });

  it("rejects an oversized decoded draft before opening IndexedDB", async () => {
    const open = vi.fn();
    vi.stubGlobal("indexedDB", { open });
    const draft: FeedbackDraft = {
      payload: {
        ...feedbackPayload(),
        attachments: [{
          name: "oversized.txt",
          mimeType: "text/plain",
          data: "A".repeat(Math.ceil((8 * 1024 * 1024 + 1) / 3) * 4),
        }],
      },
      savedAt: 1,
    };

    await expect(saveFeedbackDraft(draft)).rejects.toThrow("8 MiB");
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a corrupt draft and still allows it to be deleted", async () => {
    const database = new MemoryIndexedDb();
    vi.stubGlobal("indexedDB", database);
    database.writeRaw({
      payload: { ...feedbackPayload(), version: 2 },
      savedAt: 1,
    });

    await expect(loadFeedbackDraft()).rejects.toThrow("已损坏");
    await expect(deleteFeedbackDraft()).resolves.toBeUndefined();
    await expect(loadFeedbackDraft()).resolves.toBeNull();
  });
});

function feedbackPayload(): FeedbackPayload {
  return {
    version: 1,
    clientId: "feedback-client-1",
    category: "tool",
    description: "测试反馈",
    contact: "",
    context: {
      appVersion: "0.2.0",
      systemVersion: "Android 16",
      page: "rule",
      error: "",
    },
    attachments: [{
      name: "screenshot.png",
      mimeType: "image/png",
      data: "aGVsbG8=",
    }],
  };
}

function node(
  id: number,
  pid: number,
  depth: number,
  text: string | null,
  desc: string | null,
  resourceId: string | null,
  vid: string | null,
): SnapshotNode {
  return {
    id,
    pid,
    idQf: Boolean(resourceId),
    textQf: Boolean(text),
    attr: attr({ text, desc, id: resourceId, vid, depth }),
  };
}

function attr(overrides: Partial<SnapshotNodeAttr>): SnapshotNodeAttr {
  const left = overrides.left ?? 0;
  const top = overrides.top ?? 0;
  const right = overrides.right ?? 100;
  const bottom = overrides.bottom ?? 100;
  return {
    id: null,
    vid: null,
    name: "android.widget.TextView",
    text: null,
    desc: null,
    clickable: false,
    focusable: false,
    checkable: false,
    checked: false,
    editable: false,
    longClickable: false,
    visibleToUser: true,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    childCount: 0,
    index: 0,
    depth: 0,
    ...overrides,
  };
}

function parsedSnapshot(nodes: SnapshotNode[]): ParsedGkdSnapshot {
  const normalized = nodes.map((item) => ({
    ...item,
    attr: { ...item.attr },
    children: [],
  }));
  if (normalized[0]) {
    normalized[0].attr = attr({
      ...normalized[0].attr,
      text: "边界私密",
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
    });
  }
  return {
    id: 1,
    appId: "com.example",
    activityId: ".MainActivity",
    screenWidth: 1080,
    screenHeight: 1920,
    isLandscape: false,
    nodes: normalized,
    nodeById: new Map(normalized.map((item) => [item.id, item])),
    screenshotUrl: "blob:private-screenshot",
    sourceName: "fixture",
  };
}

function fakeImage(width: number, height: number): new () => HTMLImageElement {
  return class {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  } as unknown as new () => HTMLImageElement;
}

class MemoryIndexedDb {
  private values = new Map<string, unknown>();
  private initialized = false;

  get size(): number {
    return this.values.size;
  }

  writeRaw(value: unknown): void {
    this.values.set("latest", structuredClone(value));
  }

  open(): IDBOpenDBRequest {
    const request = {
      result: undefined as unknown as IDBDatabase,
      onupgradeneeded: null as ((event: IDBVersionChangeEvent) => unknown) | null,
      onsuccess: null as ((event: Event) => unknown) | null,
      onerror: null as ((event: Event) => unknown) | null,
      onblocked: null as ((event: Event) => unknown) | null,
    };
    const database = {
      objectStoreNames: {
        contains: () => this.initialized,
      },
      createObjectStore: () => {
        this.initialized = true;
        return {} as IDBObjectStore;
      },
      transaction: () => this.transaction(),
      close: () => undefined,
    };
    request.result = database as unknown as IDBDatabase;
    queueMicrotask(() => {
      request.onupgradeneeded?.({} as IDBVersionChangeEvent);
      request.onsuccess?.({} as Event);
    });
    return request as unknown as IDBOpenDBRequest;
  }

  private transaction(): IDBTransaction {
    const transaction: IDBTransaction = {
      oncomplete: null,
      onerror: null,
      onabort: null,
      error: null,
      objectStore: () => this.objectStore(transaction),
    } as unknown as IDBTransaction;
    return transaction;
  }

  private objectStore(transaction: IDBTransaction): IDBObjectStore {
    const complete = (request: IDBRequest, action: () => unknown) => {
      queueMicrotask(() => {
        Object.assign(request, { result: action() });
        request.onsuccess?.({} as Event);
        queueMicrotask(() => transaction.oncomplete?.({} as Event));
      });
      return request;
    };
    const request = () => ({
      result: undefined as unknown,
      onsuccess: null as ((event: Event) => unknown) | null,
      onerror: null as ((event: Event) => unknown) | null,
      error: null,
    }) as unknown as IDBRequest;
    return {
      put: (value: unknown, key: IDBValidKey) =>
        complete(request(), () => {
          this.values.set(String(key), structuredClone(value));
          return key;
        }),
      get: (key: IDBValidKey) =>
        complete(request(), () => this.values.get(String(key))),
      delete: (key: IDBValidKey) =>
        complete(request(), () => {
          this.values.delete(String(key));
          return undefined;
        }),
    } as unknown as IDBObjectStore;
  }
}

