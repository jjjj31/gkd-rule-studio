/// <reference types="vite/client" />

interface FileSystemHandlePermissionDescriptor {
  mode?: "read" | "readwrite";
}

interface FileSystemHandle {
  kind: "file" | "directory";
  name: string;
  queryPermission?: (
    descriptor?: FileSystemHandlePermissionDescriptor,
  ) => Promise<PermissionState>;
  requestPermission?: (
    descriptor?: FileSystemHandlePermissionDescriptor,
  ) => Promise<PermissionState>;
}

interface FileSystemFileHandle extends FileSystemHandle {
  kind: "file";
  getFile: () => Promise<File>;
  createWritable: () => Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  kind: "directory";
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemDirectoryHandle>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemFileHandle>;
  removeEntry: (
    name: string,
    options?: { recursive?: boolean },
  ) => Promise<void>;
}

interface FileSystemWritableFileStream extends WritableStream {
  write: (data: string | BufferSource | Blob) => Promise<void>;
  close: () => Promise<void>;
}

interface Window {
  showDirectoryPicker?: (options?: {
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
  GkdAndroidBridge?: {
    copyToClipboard?: (text: string) => void;
    setBackVisible?: (visible: boolean) => void;
    postJson?: (
      requestId: string,
      url: string,
      headersJson: string,
      bodyJson: string,
      timeoutMs: number,
    ) => void;
  };
  __GkdAndroidBridgeResult?: (
    requestId: string,
    result: {
      ok: boolean;
      status?: number;
      body: string;
      error?: string;
    },
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
