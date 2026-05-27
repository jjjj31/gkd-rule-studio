export function hasNetworkExtension(): boolean {
  return typeof getNetworkExtension()?.GM_xmlhttpRequest === "function";
}

export async function extensionFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: { responseType?: "blob" | "arraybuffer"; timeout?: number } = {},
): Promise<Response> {
  const gmXhr = getNetworkExtension()?.GM_xmlhttpRequest;
  if (!gmXhr) {
    throw new Error("油猴网络扩展未注入 GM_XHR。");
  }

  const request = new Request(input, init);
  const headers = headersToObject(new Headers(request.headers));
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });

  const body = await requestBody(request, init);

  return new Promise<Response>((resolve, reject) => {
    const handle = gmXhr({
      method: request.method,
      url: request.url,
      headers,
      data: body,
      binary: body instanceof ArrayBuffer || body instanceof Blob,
      responseType: options.responseType,
      timeout: options.timeout ?? 8000,
      onload(response) {
        const bodyValue =
          response.response ?? response.responseText ?? null;
        const nextResponse = new Response(bodyValue, {
          status: response.status,
          statusText: response.statusText,
          headers: parseHeaders(response.responseHeaders ?? ""),
        });
        if (response.finalUrl) {
          Object.defineProperty(nextResponse, "url", {
            value: response.finalUrl,
          });
        }
        resolve(nextResponse);
      },
      onerror(cause) {
        reject(new TypeError("GM_XHR 网络请求失败", { cause }));
      },
      ontimeout() {
        reject(new TypeError("GM_XHR 网络请求超时"));
      },
      onabort() {
        reject(new DOMException("GM_XHR 请求已取消", "AbortError"));
      },
      onreadystatechange(response) {
        if (response.readyState === 4) {
          request.signal?.removeEventListener("abort", abort);
        }
      },
    });

    function abort() {
      handle.abort();
    }

    request.signal?.addEventListener("abort", abort);
  });
}

function getNetworkExtension(): Window["__NetworkExtension__"] {
  return (globalThis as typeof globalThis & Partial<Window>).__NetworkExtension__;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function enhancedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: { responseType?: "blob" | "arraybuffer"; timeout?: number } = {},
): Promise<Response> {
  try {
    return await fetchWithTimeout(input, init, options.timeout);
  } catch (cause) {
    if (!hasNetworkExtension()) throw cause;
    return extensionFetch(input, init, options);
  }
}

function parseHeaders(rawHeaders: string): Headers {
  const headers = new Headers();
  rawHeaders
    .replace(/\r?\n[\t ]+/g, " ")
    .split(/\r?\n/)
    .forEach((line) => {
      const index = line.indexOf(":");
      if (index <= 0) return;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (key) headers.append(key, value);
    });
  return headers;
}

function headersToObject(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

async function requestBody(
  request: Request,
  init: RequestInit,
): Promise<string | Blob | FormData | URLSearchParams | ArrayBuffer | undefined> {
  if (request.method.toUpperCase() === "GET") return undefined;
  if (!init.body) return undefined;
  if (
    typeof init.body === "string" ||
    init.body instanceof Blob ||
    init.body instanceof FormData ||
    init.body instanceof URLSearchParams ||
    init.body instanceof ArrayBuffer
  ) {
    return init.body;
  }
  return request.arrayBuffer();
}
