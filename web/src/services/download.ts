import { registerPlugin } from "@capacitor/core";
import { appURL } from "./base";
import { isCapacitorRuntime } from "./runtime";

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
};

const NativeDownload = registerPlugin<NativeDownloadPlugin>("NativeDownload");

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

/**
 * Android (Capacitor) 专用下载：
 * 调用原生 NativeDownload 插件，通过 Android DownloadManager
 * 将文件直接下载到系统公共 Downloads 目录（/sdcard/Download/）。
 * - 通知栏显示下载进度
 * - 完成后通知栏显示"下载完成"，点击可打开文件
 * - 文件在"下载"App 和文件管理器里可见
 * - 无需存储权限（Android 10+）
 */
async function downloadWithAndroidDownloadManager(url: string, filename: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("下载地址不是完整的 http/https URL，请先配置移动端 API 地址");
  }

  await NativeDownload.download({ url, filename });
  // DownloadManager 接管后台下载，通知栏会显示进度和完成提示
}

export async function downloadFile(params: DownloadFileParams): Promise<void> {
  const filename = sanitizeDownloadName(params.path, params.name);
  const url = buildDownloadURL(params.rootId, params.path);

  if (typeof document === "undefined") {
    throw new Error("download is only available in browser runtime");
  }

  if (isCapacitorRuntime()) {
    await downloadWithAndroidDownloadManager(url, filename);
    return;
  }

  triggerBrowserDownload(url, filename);
}
