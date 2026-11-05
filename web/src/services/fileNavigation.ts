export function normalizePathForRoot(value: string, rootPath?: string): string {
  const path = String(value || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  const root = String(rootPath || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  if (root && path === root) return "";
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

export async function shouldRedirectToRelayNodes(
  status: number,
  errorCode: string,
  probeNodeStatus: () => Promise<number>,
): Promise<boolean> {
  // Connector outages are recoverable. Keep the page and its reconnect loop.
  if (["node_offline", "connector_unavailable"].includes(errorCode)) return false;
  if (["forbidden", "node_not_found"].includes(errorCode)) {
    return true;
  }
  if (![403, 404].includes(status)) return false;
  // A file or directory error does not establish that the node is unavailable.
  try {
    return [403, 404].includes(await probeNodeStatus());
  } catch {
    return false;
  }
}
