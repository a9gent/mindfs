export type ReadMode = "full" | "incremental";

export type FilePayload = {
  name: string;
  path: string;
  content: string;
  encoding: string;
  truncated: boolean;
  next_cursor?: number;
  size: number;
  ext?: string;
  mime?: string;
  mtime?: string;
  root?: string;
  file_meta?: any[];
  targetLine?: number;
  targetColumn?: number;
};

type FetchFileParams = {
  rootId: string;
  path: string;
  readMode?: ReadMode;
  cursor?: number;
  timeoutMs?: number;
};

type CachedFileRecord = {
  key: string;
  rootId: string;
  path: string;
  readMode: ReadMode;
  cursor: number;
  touchedAt: number;
  file: FilePayload;
};

type FileResponse = {
  file?: FilePayload | null;
};

const DB_NAME = "mindfs-file-cache";
const DB_VERSION = 1;
const STORE_NAME = "files";
const MAX_CACHE_ENTRIES = 200;

const memoryCache = new Map<string, FilePayload>();
let dbPromise: Promise<IDBDatabase> | null = null;

function buildCacheKey(rootId: string, path: string, readMode: ReadMode, cursor: number): string {
  return [rootId, path, readMode, String(cursor)].join("::");
}

function normalizeCursor(cursor?: number): number {
  return typeof cursor === "number" && cursor > 0 ? cursor : 0;
}

function openDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.reject(new Error("indexeddb unavailable"));
  }
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error("failed to open indexeddb"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("touchedAt", "touchedAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  return openDB().then((db) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    return run(store);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb request failed"));
  });
}

async function pruneCache(): Promise<void> {
  try {
    await withStore("readwrite", async (store) => {
      const entries = (await requestToPromise(store.getAll())) as CachedFileRecord[];
      if (entries.length <= MAX_CACHE_ENTRIES) {
        return;
      }
      entries
        .sort((a, b) => a.touchedAt - b.touchedAt)
        .slice(0, entries.length - MAX_CACHE_ENTRIES)
        .forEach((entry) => {
          store.delete(entry.key);
          memoryCache.delete(entry.key);
        });
    });
  } catch {
  }
}

async function loadCachedRecord(cacheKey: string): Promise<CachedFileRecord | null> {
  try {
    const cached = await withStore("readonly", (store) =>
      requestToPromise(store.get(cacheKey) as IDBRequest<CachedFileRecord | undefined>),
    );
    return cached || null;
  } catch {
    return null;
  }
}

async function saveCachedRecord(record: CachedFileRecord): Promise<void> {
  try {
    await withStore("readwrite", (store) => requestToPromise(store.put(record)));
    void pruneCache();
  } catch {
  }
}

async function deleteCachedRecords(match: (record: CachedFileRecord) => boolean): Promise<void> {
  try {
    await withStore("readwrite", async (store) => {
      const entries = (await requestToPromise(store.getAll())) as CachedFileRecord[];
      entries.forEach((entry) => {
        if (!match(entry)) return;
        store.delete(entry.key);
        memoryCache.delete(entry.key);
      });
    });
  } catch {
  }
}

export async function getCachedFile(params: Omit<FetchFileParams, "timeoutMs">): Promise<FilePayload | null> {
  const readMode = params.readMode || "incremental";
  const cursor = normalizeCursor(params.cursor);
  const cacheKey = buildCacheKey(params.rootId, params.path, readMode, cursor);
  const inMemory = memoryCache.get(cacheKey);
  if (inMemory) {
    return inMemory;
  }
  const cached = await loadCachedRecord(cacheKey);
  if (!cached?.file) {
    return null;
  }
  memoryCache.set(cacheKey, cached.file);
  void saveCachedRecord({ ...cached, touchedAt: Date.now() });
  return cached.file;
}

export function invalidateFileCache(rootId: string, path: string): void {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(`${rootId}::${path}::`)) {
      memoryCache.delete(key);
    }
  }
  void deleteCachedRecords((record) => record.rootId === rootId && record.path === path);
}

export function clearFileCacheForRoot(rootId: string): void {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(`${rootId}::`)) {
      memoryCache.delete(key);
    }
  }
  void deleteCachedRecords((record) => record.rootId === rootId);
}

export async function fetchFile(params: FetchFileParams): Promise<FilePayload | null> {
  const readMode = params.readMode || "incremental";
  const cursor = normalizeCursor(params.cursor);
  const cacheKey = buildCacheKey(params.rootId, params.path, readMode, cursor);
  const cached = (await getCachedFile({
    rootId: params.rootId,
    path: params.path,
    readMode,
    cursor,
  })) || null;

  const queryParams = new URLSearchParams({
    root: params.rootId,
    path: params.path,
    read: readMode,
  });
  if (cursor > 0) {
    queryParams.set("cursor", String(cursor));
  }
  if (typeof cached?.mtime === "string" && cached.mtime) {
    queryParams.set("mtime", cached.mtime);
  }

  const url = `/api/file?${queryParams.toString()}`;
  let controller: AbortController | null = null;
  let timer: number | null = null;
  try {
    if (params.timeoutMs && params.timeoutMs > 0) {
      controller = new AbortController();
      timer = window.setTimeout(() => controller?.abort(), params.timeoutMs);
    }
    const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (response.status === 304) {
      return cached;
    }
    if (!response.ok) {
      throw new Error(`open file failed: status=${response.status}`);
    }
    const payload = (await response.json()) as FileResponse;
    const file = payload?.file || null;
    if (!file) {
      return null;
    }
    memoryCache.set(cacheKey, file);
    void saveCachedRecord({
      key: cacheKey,
      rootId: params.rootId,
      path: params.path,
      readMode,
      cursor,
      touchedAt: Date.now(),
      file,
    });
    return file;
  } finally {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  }
}
