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
const LS_RECORD_PREFIX = "mindfs-file-cache-record:";
const LS_MAX_RECORD_BYTES = 256 * 1024;
const LS_MAX_RECORDS = 50;

const memoryCache = new Map<string, FilePayload>();
let dbPromise: Promise<IDBDatabase> | null = null;

function buildCacheKey(rootId: string, path: string, readMode: ReadMode, cursor: number): string {
  return [rootId, path, readMode, String(cursor)].join("::");
}

function buildCacheKeyPrefix(rootId: string, path: string): string {
  return `${rootId}::${path}::`;
}

function normalizeCursor(cursor?: number): number {
  return typeof cursor === "number" && cursor > 0 ? cursor : 0;
}

function hasUsableCachedContent(file: FilePayload | null | undefined): boolean {
  if (!file) {
    return false;
  }
  if (typeof file.content === "string" && file.content.length > 0) {
    return true;
  }
  return file.encoding === "binary";
}

function getLocalStorageRecordKey(cacheKey: string): string {
  return `${LS_RECORD_PREFIX}${cacheKey}`;
}

function shouldPersistToLocalStorage(file: FilePayload): boolean {
  if (!hasUsableCachedContent(file)) {
    return false;
  }
  if (file.encoding === "binary") {
    return false;
  }
  return typeof file.content === "string" && file.content.length <= LS_MAX_RECORD_BYTES;
}

function loadCachedRecordFromLocalStorage(cacheKey: string): CachedFileRecord | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(getLocalStorageRecordKey(cacheKey));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as CachedFileRecord | null;
    if (!parsed || parsed.key !== cacheKey || !parsed.file) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveCachedRecordToLocalStorage(record: CachedFileRecord): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!shouldPersistToLocalStorage(record.file)) {
      window.localStorage.removeItem(getLocalStorageRecordKey(record.key));
      return;
    }
    window.localStorage.setItem(getLocalStorageRecordKey(record.key), JSON.stringify(record));
    pruneLocalStorageRecords();
  } catch {
  }
}

function removeCachedRecordFromLocalStorage(cacheKey: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(getLocalStorageRecordKey(cacheKey));
  } catch {
  }
}

function listLocalStorageRecords(): CachedFileRecord[] {
  if (typeof window === "undefined") {
    return [];
  }
  const records: CachedFileRecord[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(LS_RECORD_PREFIX)) {
        continue;
      }
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as CachedFileRecord | null;
        if (parsed?.key && parsed?.file) {
          records.push(parsed);
        }
      } catch {
      }
    }
  } catch {
  }
  return records;
}

function pruneLocalStorageRecords(): void {
  const records = listLocalStorageRecords();
  if (records.length <= LS_MAX_RECORDS) {
    return;
  }
  records
    .sort((a, b) => a.touchedAt - b.touchedAt)
    .slice(0, records.length - LS_MAX_RECORDS)
    .forEach((record) => {
      removeCachedRecordFromLocalStorage(record.key);
    });
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

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb request failed"));
  });
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  return openDB().then((db) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const completion = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("indexeddb transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("indexeddb transaction aborted"));
    });
    return run(store).then(async (result) => {
      await completion;
      return result;
    });
  });
}

function readMemoryCache(cacheKey: string): FilePayload | null {
  return memoryCache.get(cacheKey) || null;
}

function writeMemoryCache(cacheKey: string, file: FilePayload): void {
  memoryCache.set(cacheKey, file);
}

async function loadCachedRecord(cacheKey: string): Promise<CachedFileRecord | null> {
  const localRecord = loadCachedRecordFromLocalStorage(cacheKey);
  if (localRecord?.file) {
    return localRecord;
  }
  try {
    const record = await withStore("readonly", (store) =>
      requestToPromise(store.get(cacheKey) as IDBRequest<CachedFileRecord | undefined>),
    );
    return record || null;
  } catch {
    return null;
  }
}

async function listCachedRecords(): Promise<CachedFileRecord[]> {
  try {
    return await withStore("readonly", (store) =>
      requestToPromise(store.getAll() as IDBRequest<CachedFileRecord[]>),
    );
  } catch {
    return [];
  }
}

async function saveCachedRecord(record: CachedFileRecord): Promise<void> {
  saveCachedRecordToLocalStorage(record);
  try {
    await withStore("readwrite", (store) => requestToPromise(store.put(record)));
  } catch {
  }
}

async function deleteCachedRecords(match: (record: CachedFileRecord) => boolean): Promise<void> {
  try {
    await withStore("readwrite", async (store) => {
      const entries = (await requestToPromise(store.getAll() as IDBRequest<CachedFileRecord[]>)) || [];
      entries.forEach((entry) => {
        if (!match(entry)) {
          return;
        }
        store.delete(entry.key);
        memoryCache.delete(entry.key);
        removeCachedRecordFromLocalStorage(entry.key);
      });
    });
  } catch {
  }
}

async function pruneCache(): Promise<void> {
  try {
    await withStore("readwrite", async (store) => {
      const entries = (await requestToPromise(store.getAll() as IDBRequest<CachedFileRecord[]>)) || [];
      if (entries.length <= MAX_CACHE_ENTRIES) {
        return;
      }
      entries
        .sort((a, b) => a.touchedAt - b.touchedAt)
        .slice(0, entries.length - MAX_CACHE_ENTRIES)
        .forEach((entry) => {
          store.delete(entry.key);
          memoryCache.delete(entry.key);
          removeCachedRecordFromLocalStorage(entry.key);
        });
    });
  } catch {
  }
}

function clearSiblingMemoryCaches(rootId: string, path: string, keepKey: string): void {
  const prefix = buildCacheKeyPrefix(rootId, path);
  for (const key of memoryCache.keys()) {
    if (key !== keepKey && key.startsWith(prefix)) {
      memoryCache.delete(key);
    }
  }
}

async function clearSiblingPersistentCaches(rootId: string, path: string, keepKey: string): Promise<void> {
  await deleteCachedRecords((record) => {
    if (record.key === keepKey) {
      return false;
    }
    return record.rootId === rootId && record.path === path;
  });
}

async function persistExactCache(
  cacheKey: string,
  rootId: string,
  path: string,
  readMode: ReadMode,
  cursor: number,
  file: FilePayload,
): Promise<void> {
  writeMemoryCache(cacheKey, file);
  await saveCachedRecord({
    key: cacheKey,
    rootId,
    path,
    readMode,
    cursor,
    touchedAt: Date.now(),
    file,
  });
  clearSiblingMemoryCaches(rootId, path, cacheKey);
  await clearSiblingPersistentCaches(rootId, path, cacheKey);
  void pruneCache();
}

function buildFileURL(rootId: string, path: string, readMode: ReadMode, cursor: number, mtime?: string): string {
  const queryParams = new URLSearchParams({
    root: rootId,
    path,
    read: readMode,
  });
  if (cursor > 0) {
    queryParams.set("cursor", String(cursor));
  }
  if (mtime) {
    queryParams.set("mtime", mtime);
  }
  return `/api/file?${queryParams.toString()}`;
}

function createFetchOptions(timeoutMs?: number): {
  controller: AbortController | null;
  timer: number | null;
  init?: RequestInit;
} {
  if (!timeoutMs || timeoutMs <= 0) {
    return { controller: null, timer: null };
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    timer,
    init: { signal: controller.signal },
  };
}

async function fetchResponse(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

export async function getCachedFile(params: Omit<FetchFileParams, "timeoutMs">): Promise<FilePayload | null> {
  const readMode = params.readMode || "incremental";
  const cursor = normalizeCursor(params.cursor);
  const cacheKey = buildCacheKey(params.rootId, params.path, readMode, cursor);

  const inMemory = readMemoryCache(cacheKey);
  if (inMemory) {
    return inMemory;
  }

  const record = await loadCachedRecord(cacheKey);
  if (!record?.file) {
    return null;
  }

  writeMemoryCache(cacheKey, record.file);
  void saveCachedRecord({
    ...record,
    touchedAt: Date.now(),
  });
  return record.file;
}

export function invalidateFileCache(rootId: string, path: string): void {
  const prefix = buildCacheKeyPrefix(rootId, path);
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) {
      memoryCache.delete(key);
      removeCachedRecordFromLocalStorage(key);
    }
  }
  void deleteCachedRecords((record) => record.rootId === rootId && record.path === path);
}

export function clearFileCacheForRoot(rootId: string): void {
  const prefix = `${rootId}::`;
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) {
      memoryCache.delete(key);
      removeCachedRecordFromLocalStorage(key);
    }
  }
  void deleteCachedRecords((record) => record.rootId === rootId);
}

export async function fetchFile(params: FetchFileParams): Promise<FilePayload | null> {
  const readMode = params.readMode || "incremental";
  const cursor = normalizeCursor(params.cursor);
  const cacheKey = buildCacheKey(params.rootId, params.path, readMode, cursor);
  const cachedFile = await getCachedFile({
    rootId: params.rootId,
    path: params.path,
    readMode,
    cursor,
  });
  const validationMTime =
    hasUsableCachedContent(cachedFile) && typeof cachedFile?.mtime === "string" && cachedFile.mtime
      ? cachedFile.mtime
      : "";
  const request = createFetchOptions(params.timeoutMs);

  try {
    const response = await fetchResponse(
      buildFileURL(params.rootId, params.path, readMode, cursor, validationMTime || undefined),
      request.init,
    );

    if (response.status === 304) {
      if (cachedFile) {
        return cachedFile;
      }
      const record = await loadCachedRecord(cacheKey);
      if (hasUsableCachedContent(record?.file)) {
        writeMemoryCache(cacheKey, record!.file);
        return record!.file;
      }
      const retry = await fetchResponse(
        buildFileURL(params.rootId, params.path, readMode, cursor),
        request.init,
      );
      if (!retry.ok) {
        throw new Error(`open file failed after 304 retry: status=${retry.status}`);
      }
      const retryPayload = (await retry.json()) as FileResponse;
      const retryFile = retryPayload?.file || null;
      if (!retryFile) {
        return null;
      }
      await persistExactCache(cacheKey, params.rootId, params.path, readMode, cursor, retryFile);
      return retryFile;
    }

    if (!response.ok) {
      throw new Error(`open file failed: status=${response.status}`);
    }

    const payload = (await response.json()) as FileResponse;
    const file = payload?.file || null;
    if (!file) {
      return null;
    }

    await persistExactCache(cacheKey, params.rootId, params.path, readMode, cursor, file);
    return file;
  } finally {
    if (request.timer !== null) {
      window.clearTimeout(request.timer);
    }
  }
}
