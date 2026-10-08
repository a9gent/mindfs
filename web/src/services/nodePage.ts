const MEMORY_KEY = "mindfs.nodePageURL";
export const NODE_PAGE_PARAM = "node_page";

export function validNodePageURL(raw: string): string {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    if (!/^\/(?:n\/[^/]+\/)?nodes\/?$/.test(url.pathname)) return "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return ""; }
}

export function ownNodePageURL(href = window.location.href): string {
  const url = new URL(href);
  const prefix = /^\/n\/[^/]+/.exec(url.pathname)?.[0] || "";
  return `${url.origin}${prefix}/nodes`;
}

export function isNodePage(href = window.location.href): boolean {
  return Boolean(validNodePageURL(href));
}

export function rememberNodePage(href = window.location.href): void {
  const url = new URL(href);
  const page = validNodePageURL(url.searchParams.get(NODE_PAGE_PARAM) || "");
  if (page) {
    try { localStorage.setItem(MEMORY_KEY, page); } catch { /* Storage can be unavailable. */ }
  }
}

export function returnNodePageURL(href = window.location.href): string {
  const incoming = validNodePageURL(new URL(href).searchParams.get(NODE_PAGE_PARAM) || "");
  if (incoming) return incoming;
  try {
    const remembered = validNodePageURL(localStorage.getItem(MEMORY_KEY) || "");
    if (remembered) return remembered;
  } catch { /* Fall back to this node. */ }
  return ownNodePageURL(href);
}

export function nodeDestinationURL(target: string, page = ownNodePageURL()): string {
  const url = new URL(target);
  url.searchParams.set(NODE_PAGE_PARAM, page);
  return url.href;
}
