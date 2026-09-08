/// <reference types="vite/client" />

interface Window {
  GkdAndroidBridge?: {
    copyToClipboard?: (text: string) => void;
    setBackVisible?: (visible: boolean) => void;
    saveFile?: (fileName: string, mimeType: string, base64: string) => void;
    postJson?: (
      requestId: string,
      url: string,
      headersJson: string,
      bodyJson: string,
      timeoutMs: number,
    ) => void;
    getAppUpdateInfo?: (requestId: string) => void;
    canInstallApk?: (requestId: string) => void;
    openInstallSettings?: () => void;
    downloadApk?: (
      requestId: string,
      urlsJson: string,
      sha256: string,
      fileName: string,
    ) => void;
    installApk?: (requestId: string, filePath: string) => void;
  };
  __GkdAndroidBridgeResult?: (
    requestId: string,
    result: {
      ok: boolean;
      status?: number;
      body?: string;
      error?: string;
      [key: string]: unknown;
    },
  ) => void;
  __GkdUpdateProgress?: (
    requestId: string,
    progress: { percent: number; received: number; total: number },
  ) => void;
  __GkdAndroidBack?: () => void;
  __NetworkExtension__?: {
    GM_xmlhttpRequest?: (options: GmXmlHttpRequestOptions) => {
      abort: () => void;
    };
  };
}

interface GmXmlHttpRequestResponse {
  finalUrl?: string;
  response?: Blob | ArrayBuffer | string;
  responseHeaders?: string;
  responseText?: string;
  readyState?: number;
  status: number;
  statusText: string;
}

interface GmXmlHttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: string | Blob | FormData | URLSearchParams | ArrayBuffer;
  binary?: boolean;
  responseType?: "blob" | "arraybuffer";
  timeout?: number;
  onload?: (response: GmXmlHttpRequestResponse) => void;
  onerror?: (response: unknown) => void;
  ontimeout?: () => void;
  onabort?: () => void;
  onreadystatechange?: (response: GmXmlHttpRequestResponse) => void;
}
