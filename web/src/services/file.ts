import { appURL } from "./base";
import { e2eeService } from "./e2ee";

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
  type?: "file";
  key: string;
  rootId: string;
  path: string;
  readMode: ReadMode;
  cursor: number;
  touchedAt: number;
  file: FilePayload;
};

export type CachedGitDiffPayload = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  content: string;
  file_meta?: Array<{
    source_session: string;
    session_name?: string;
    agent?: string;
    created_at?: string;
    updated_at?: string;
    created_by?: string;
  }>;
};

type CachedGitDiffRecord = {
  type: "git-diff";
  key: string;
  rootId: string;
  path: string;
  touchedAt: number;
  diff: CachedGitDiffPayload;
};

type CacheRecord = CachedFileRecord | CachedGitDiffRecord;

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
const gitDiffMemoryCache = new Map<string, CachedGitDiffPayload>();
let dbPromise: Promise<IDBDatabase> | null = null;

function buildCacheKey(rootId: string, path: string, readMode: ReadMode, cursor: number): string {
  return [rootId, path, readMode, String(cursor)].join("::");
}

function buildGitDiffCacheKey(rootId: string, path: string, signature?: string): string {
  return ["git-diff", rootId, path, signature || ""].join("::");
}

function buildGitDiffCacheKeyPrefix(rootId: string, path: string): string {
  return `git-diff::${rootId}::${path}::`;
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
      requestToPromise(store.get(cacheKey) as IDBRequest<CacheRecord | undefined>),
    );
    return record?.type === "git-diff" ? null : record || null;
  } catch {
    return null;
  }
}

async function loadCachedGitDiffRecord(cacheKey: string): Promise<CachedGitDiffRecord | null> {
  try {
    const record = await withStore("readonly", (store) =>
      requestToPromise(store.get(cacheKey) as IDBRequest<CacheRecord | undefined>),
    );
    return record?.type === "git-diff" ? record : null;
  } catch {
    return null;
  }
}

async function saveCachedRecord(record: CachedFileRecord): Promise<void> {
  saveCachedRecordToLocalStorage(record);
  try {
    await withStore("readwrite", (store) => requestToPromise(store.put(record)));
  } catch {
  }
}

async function saveCachedGitDiffRecord(record: CachedGitDiffRecord): Promise<void> {
  try {
    await withStore("readwrite", (store) => requestToPromise(store.put(record)));
  } catch {
  }
}

async function deleteCachedRecords(match: (record: CacheRecord) => boolean): Promise<void> {
  try {
    await withStore("readwrite", async (store) => {
      const entries = (await requestToPromise(store.getAll() as IDBRequest<CacheRecord[]>)) || [];
      entries.forEach((entry) => {
        if (!match(entry)) {
          return;
        }
        store.delete(entry.key);
        if (entry.type === "git-diff") {
          gitDiffMemoryCache.delete(entry.key);
        } else {
          memoryCache.delete(entry.key);
          removeCachedRecordFromLocalStorage(entry.key);
        }
      });
    });
  } catch {
  }
}

async function pruneCache(): Promise<void> {
  try {
    await withStore("readwrite", async (store) => {
      const entries = (await requestToPromise(store.getAll() as IDBRequest<CacheRecord[]>)) || [];
      if (entries.length <= MAX_CACHE_ENTRIES) {
        return;
      }
      entries
        .sort((a, b) => a.touchedAt - b.touchedAt)
        .slice(0, entries.length - MAX_CACHE_ENTRIES)
        .forEach((entry) => {
          store.delete(entry.key);
          if (entry.type === "git-diff") {
            gitDiffMemoryCache.delete(entry.key);
          } else {
            memoryCache.delete(entry.key);
            removeCachedRecordFromLocalStorage(entry.key);
          }
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
    if (record.type === "git-diff") {
      return false;
    }
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
    type: "file",
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
  return appURL("/api/file", queryParams);
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
  const diffPrefix = buildGitDiffCacheKeyPrefix(rootId, path);
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) {
      memoryCache.delete(key);
      removeCachedRecordFromLocalStorage(key);
    }
  }
  for (const key of gitDiffMemoryCache.keys()) {
    if (key.startsWith(diffPrefix)) {
      gitDiffMemoryCache.delete(key);
    }
  }
  void deleteCachedRecords((record) => record.rootId === rootId && record.path === path);
}

export function clearFileCacheForRoot(rootId: string): void {
  const prefix = `${rootId}::`;
  const diffPrefix = `git-diff::${rootId}::`;
  for (const key of memoryCache.keys()) {
    if (key.startsWith(prefix)) {
      memoryCache.delete(key);
      removeCachedRecordFromLocalStorage(key);
    }
  }
  for (const key of gitDiffMemoryCache.keys()) {
    if (key.startsWith(diffPrefix)) {
      gitDiffMemoryCache.delete(key);
    }
  }
  void deleteCachedRecords((record) => record.rootId === rootId);
}

export async function getCachedGitDiff(
  rootId: string,
  path: string,
  signature?: string,
): Promise<CachedGitDiffPayload | null> {
  const cacheKey = buildGitDiffCacheKey(rootId, path, signature);
  const inMemory = gitDiffMemoryCache.get(cacheKey);
  if (inMemory) {
    return inMemory;
  }

  const record = await loadCachedGitDiffRecord(cacheKey);
  if (!record?.diff) {
    return null;
  }

  gitDiffMemoryCache.set(cacheKey, record.diff);
  void saveCachedGitDiffRecord({
    ...record,
    touchedAt: Date.now(),
  });
  return record.diff;
}

export async function setCachedGitDiff(
  rootId: string,
  path: string,
  diff: CachedGitDiffPayload,
  signature?: string,
): Promise<void> {
  const cacheKey = buildGitDiffCacheKey(rootId, path, signature);
  gitDiffMemoryCache.set(cacheKey, diff);
  await saveCachedGitDiffRecord({
    type: "git-diff",
    key: cacheKey,
    rootId,
    path,
    touchedAt: Date.now(),
    diff,
  });
  void pruneCache();
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
    const requestURL = buildFileURL(params.rootId, params.path, readMode, cursor, validationMTime || undefined);
    const headers = e2eeService.isRequired()
      ? await e2eeService.fileProofHeaders("GET", requestURL)
      : undefined;
    const response = await fetchResponse(
      requestURL,
      { ...request.init, headers },
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
      const retryURL = buildFileURL(params.rootId, params.path, readMode, cursor);
      const retry = await fetchResponse(
        retryURL,
        {
          ...request.init,
          headers: e2eeService.isRequired()
            ? await e2eeService.fileProofHeaders("GET", retryURL)
            : headers,
        },
      );
      if (!retry.ok) {
        throw new Error(`open file failed after 304 retry: status=${retry.status}`);
      }
      const retryPayload = (await retry.json()) as FileResponse;
      const retryFile = await unwrapFileResponse(retryPayload);
      if (!retryFile) {
        return null;
      }
      await persistExactCache(cacheKey, params.rootId, params.path, readMode, cursor, retryFile);
      return retryFile;
    }

    if (!response.ok) {
      if (response.status === 401 && e2eeService.isRequired()) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (e2eeService.handleServerError(String(payload.error || ""))) {
          return fetchFile(params);
        }
      }
      throw new Error(`open file failed: status=${response.status}`);
    }

    const payload = (await response.json()) as FileResponse;
    const file = await unwrapFileResponse(payload);
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

export async function fetchProofProtectedBlob(params: {
  rootId: string;
  path: string;
  timeoutMs?: number;
}): Promise<Blob> {
  const request = createFetchOptions(params.timeoutMs);
  try {
    const baseURL = buildFileURL(params.rootId, params.path, "full", 0);
    const rawURL = withRawFlag(
      baseURL,
    );
    const headers = e2eeService.isRequired()
      ? await e2eeService.fileProofHeaders("GET", rawURL)
      : undefined;
    const response = await fetchResponse(rawURL, { ...request.init, headers });
    if (!response.ok) {
      if (response.status === 401 && e2eeService.isRequired()) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (e2eeService.handleServerError(String(payload.error || ""))) {
          return fetchProofProtectedBlob(params);
        }
      }
      throw new Error(`open raw file failed: status=${response.status}`);
    }
    return response.blob();
  } finally {
    if (request.timer !== null) {
      window.clearTimeout(request.timer);
    }
  }
}

async function unwrapFileResponse(payload: FileResponse): Promise<FilePayload | null> {
  if (payload?.file) {
    return payload.file;
  }
  return null;
}

function withRawFlag(url: string): string {
  const target = new URL(url, window.location.origin);
  target.searchParams.set("raw", "1");
  if (target.origin === window.location.origin) {
    return `${target.pathname}${target.search}`;
  }
  return target.toString();
}
