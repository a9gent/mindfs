import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function listPublicAssets(publicDir: string): string[] {
  if (!fs.existsSync(publicDir)) {
    return [];
  }

  const urls: string[] = [];

  const walk = (currentDir: string) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      const relativePath = path.relative(publicDir, absolutePath).split(path.sep).join("/");
      if (!relativePath || relativePath === "service-worker.js") {
        continue;
      }
      urls.push(`./${relativePath}`);
    }
  };

  walk(publicDir);
  return urls.sort();
}

type BundleItem = {
  fileName: string;
  type: string;
};

function listShellBundleAssets(bundle: Record<string, BundleItem>): string[] {
  return Object.values(bundle)
    .filter((item) => item.fileName !== "service-worker.js")
    .filter((item) => !item.fileName.endsWith(".map"))
    .filter((item) => item.fileName.startsWith("assets/index-"))
    .map((item) => `./${item.fileName}`)
    .sort();
}

function buildServiceWorker(precacheUrls: string[], version: string): string {
  return `const SHELL_CACHE = "mindfs-shell-${version}";
const RUNTIME_CACHE = "mindfs-runtime-${version}";
const OFFLINE_URL = new URL("./offline.html", self.location.href).toString();
const INDEX_URL = new URL("./index.html", self.location.href).toString();
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};

function normalizedPathname(pathname) {
  const relayPrefixMatch = pathname.match(/^\\/n\\/[^/]+(?=\\/|$)/);
  if (!relayPrefixMatch) {
    return pathname;
  }
  const normalized = pathname.slice(relayPrefixMatch[0].length);
  return normalized || "/";
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(PRECACHE_URLS.map((url) => new URL(url, self.location.href).toString()));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys
      .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  const pathname = normalizedPathname(url.pathname);
  if (pathname.startsWith("/mindfs-assets/")) {
    return;
  }
  if (pathname.startsWith("/api/") || pathname === "/api" || pathname === "/ws" || pathname === "/health") {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  event.respondWith(handleStaticRequest(request));
});

async function handleNavigationRequest(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    cache.put(INDEX_URL, response.clone()).catch(() => {});
    return response;
  } catch {
    const cachedIndex = await cache.match(INDEX_URL);
    if (cachedIndex) {
      return cachedIndex;
    }
    const offlineResponse = await cache.match(OFFLINE_URL);
    if (offlineResponse) {
      return offlineResponse;
    }
    throw new Error("offline");
  }
}

async function handleStaticRequest(request) {
  const shellCache = await caches.open(SHELL_CACHE);
  const cachedShellResponse = await shellCache.match(request);
  if (cachedShellResponse) {
    return cachedShellResponse;
  }

  const runtimeCache = await caches.open(RUNTIME_CACHE);
  const cachedRuntimeResponse = await runtimeCache.match(request);
  if (cachedRuntimeResponse) {
    return cachedRuntimeResponse;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      runtimeCache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    if (request.destination === "image") {
      const iconResponse = await shellCache.match(new URL("./pwa-192.png", self.location.href).toString());
      if (iconResponse) {
        return iconResponse;
      }
    }
    return new Response("", {
      status: 504,
      statusText: "Asset Unavailable",
    });
  }
}
`;
}

function appShellHTMLPlugin() {
  return {
    name: "mindfs-app-shell-html",
    transformIndexHtml(html: string) {
      const pwaLinks = [
        '    <link rel="manifest" href="/manifest.webmanifest" />',
        '    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
      ].join("\n");
      const pwaMeta = [
        '    <meta name="apple-mobile-web-app-capable" content="yes" />',
        '    <meta name="apple-mobile-web-app-status-bar-style" content="default" />',
        '    <meta name="apple-mobile-web-app-title" content="MindFS" />',
        '    <meta name="mobile-web-app-capable" content="yes" />',
      ].join("\n");
      const appShell = process.env.VITE_APP_SHELL === "1";
      return html
        .replace("<!--APP_SHELL_PWA_LINKS-->", appShell ? "" : pwaLinks)
        .replace("<!--APP_SHELL_PWA_META-->", appShell ? "" : pwaMeta);
    },
  };
}

const PWA_ONLY_ASSETS = new Set([
  "manifest.webmanifest",
  "apple-touch-icon.png",
  "pwa-192.png",
  "pwa-512.png",
  "pwa-icon-maskable.svg",
  "pwa-icon.svg",
  "pwa-maskable-192.png",
  "pwa-maskable-512.png",
  "service-worker.js",
]);

function appShellExcludeAssetsPlugin() {
  let resolvedOutDir = "";
  return {
    name: "mindfs-app-shell-exclude-assets",
    apply: "build" as const,
    configResolved(config: { build: { outDir: string } }) {
      resolvedOutDir = config.build.outDir;
    },
    closeBundle() {
      if (process.env.VITE_APP_SHELL !== "1" || !resolvedOutDir) {
        return;
      }
      // public/ 目录文件由 Vite 直接复制，不经过 bundle，需在 closeBundle 里删除
      for (const fileName of PWA_ONLY_ASSETS) {
        const filePath = path.join(resolvedOutDir, fileName);
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath);
        }
      }
    },
  };
}

function autoPrecachePlugin() {
  return {
    name: "mindfs-auto-precache",
    apply: "build" as const,
    generateBundle(this: { emitFile: (file: { type: "asset"; fileName: string; source: string }) => void }, _options: unknown, bundle: Record<string, BundleItem>) {
      if (process.env.VITE_APP_SHELL === "1") {
        return;
      }
      const publicDir = path.resolve(__dirname, "public");
      const publicAssets = listPublicAssets(publicDir);
      const shellBundleAssets = listShellBundleAssets(bundle);
      const precacheUrls = Array.from(
        new Set(["./", "./index.html", ...publicAssets, ...shellBundleAssets]),
      );
      const version = crypto
        .createHash("sha256")
        .update(JSON.stringify(precacheUrls))
        .digest("hex")
        .slice(0, 12);

      this.emitFile({
        type: "asset",
        fileName: "service-worker.js",
        source: buildServiceWorker(precacheUrls, version),
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), react(), appShellHTMLPlugin(), appShellExcludeAssetsPlugin(), autoPrecachePlugin()],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:7331",
      "/ws": {
        target: "ws://localhost:7331",
        ws: true,
      },
    },
  },
});
