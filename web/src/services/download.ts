import { registerPlugin } from "@capacitor/core";
import { appURL } from "./base";
import { e2eeService } from "./e2ee";
import { fetchProofProtectedBlob } from "./file";
import { getNativeBridge } from "./nativeBridge";
import { getApiBaseURL, isNativeShellRuntime } from "./runtime";

type DownloadFileParams = {
  rootId: string;
  path: string;
  name?: string;
};

type NativeDownloadPlugin = {
  download: (opts: { url: string; filename: string }) => Promise<{
    downloadId: number;
    filename: string;
    directory: string;
  }>;
  saveBase64: (opts: { dataBase64: string; filename: string; mimeType?: string }) => Promise<{
    filename: string;
    directory: string;
    path?: string;
  }>;
};

const NativeDownload = registerPlugin<NativeDownloadPlugin>("NativeDownload");

type WindowWithNativeDownloadBridge = Window & {
  MindFSNativeDownload?: {
    download?: (url: string, filename: string) => string;
    saveBase64?: (dataBase64: string, filename: string, mimeType?: string) => string;
  };
};

function sanitizeDownloadName(path: string, name?: string): string {
  const candidate = String(name || path || "").trim();
  if (!candidate) {
    return "download";
  }
  const parts = candidate.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "download";
}

function buildDownloadURL(rootId: string, path: string): string {
  return appURL("/api/file", new URLSearchParams({
    raw: "1",
    root: rootId,
    path,
    download: "1",
  }));
}

function toAbsoluteDownloadURL(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  const apiBaseURL = getApiBaseURL();
  if (apiBaseURL) {
    return new URL(url, `${apiBaseURL.replace(/\/+$/, "")}/`).toString();
  }

  if (typeof window !== "undefined" && /^https?:$/i.test(window.location.protocol)) {
    return new URL(url, window.location.href).toString();
  }

  return url;
}

function triggerBrowserDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectURL = URL.createObjectURL(blob);
  try {
    triggerBrowserDownload(objectURL, filename);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectURL), 30_000);
  }
}

async function downloadWithNativeShell(url: string, filename: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("下载地址不是完整的 http/https URL，请先配置移动端 API 地址");
  }

  const unifiedBridge = getNativeBridge();
  if (typeof unifiedBridge?.download === "function") {
    const result = await unifiedBridge.download(JSON.stringify({ url, filename }));
    if (typeof result === "string" && result) {
      throw new Error(result);
    }
    return;
  }

  const nativeBridge = (window as WindowWithNativeDownloadBridge).MindFSNativeDownload;
  if (nativeBridge && typeof nativeBridge.download === "function") {
    const errorMessage = nativeBridge.download(url, filename);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return;
  }

  await NativeDownload.download({ url, filename });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("读取下载内容失败"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

async function saveBlobWithNativeShell(blob: Blob, filename: string): Promise<void> {
  const dataBase64 = await blobToBase64(blob);
  const mimeType = blob.type || "application/octet-stream";
  const unifiedBridge = getNativeBridge();
  if (typeof unifiedBridge?.saveBase64 === "function") {
    const result = await unifiedBridge.saveBase64(JSON.stringify({ dataBase64, filename, mimeType }));
    if (typeof result === "string" && result) {
      throw new Error(result);
    }
    return;
  }

  const nativeBridge = (window as WindowWithNativeDownloadBridge).MindFSNativeDownload;
  if (nativeBridge && typeof nativeBridge.saveBase64 === "function") {
    const errorMessage = nativeBridge.saveBase64(dataBase64, filename, mimeType);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return;
  }

  await NativeDownload.saveBase64({ dataBase64, filename, mimeType });
}

export async function downloadURL(url: string, filename = "download"): Promise<void> {
  if (typeof document === "undefined") {
    throw new Error("download is only available in browser runtime");
  }

  const safeFilename = sanitizeDownloadName(filename, filename);
  const absoluteURL = toAbsoluteDownloadURL(url);
  if (isNativeShellRuntime()) {
    await downloadWithNativeShell(absoluteURL, safeFilename);
    return;
  }

  triggerBrowserDownload(absoluteURL, safeFilename);
}

export async function downloadFile(params: DownloadFileParams): Promise<void> {
  const filename = sanitizeDownloadName(params.path, params.name);
  if (e2eeService.isRequired()) {
    if (!isNativeShellRuntime()) {
      const blob = await fetchProofProtectedBlob({ rootId: params.rootId, path: params.path });
      triggerBlobDownload(blob, filename);
      return;
    }
    const blob = await fetchProofProtectedBlob({ rootId: params.rootId, path: params.path });
    try {
      await saveBlobWithNativeShell(blob, filename);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (!/not implemented|unimplemented|not available|plugin/i.test(message)) {
        throw error;
      }
      throw new Error("当前 Android 壳不支持 E2EE 文件保存，请升级到最新版 Android 壳后重试");
    }
    return;
  }
  const url = toAbsoluteDownloadURL(buildDownloadURL(params.rootId, params.path));
  await downloadURL(url, filename);
}
