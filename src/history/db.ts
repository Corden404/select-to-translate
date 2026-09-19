import type { LookupHistoryRecord } from "./types";

const DB_NAME = "selection-lookup";
const DB_VERSION = 1;
const STORE_NAME = "lookupRecords";

export interface HistoryRetentionPolicy {
  retentionDays: number;
  maxEntries: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("selectedText", "selectedText");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开历史数据库"));
  });

  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, mode);
  const result = await requestToPromise(operation(tx.objectStore(STORE_NAME)));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("历史数据库事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("历史数据库事务被取消"));
  });
  return result;
}

export async function putHistoryRecord(
  record: LookupHistoryRecord,
  retention?: HistoryRetentionPolicy
): Promise<void> {
  await withStore("readwrite", store => store.put(record));
  if (retention) await pruneHistory(retention);
}

export async function pruneHistory(retention: HistoryRetentionPolicy): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const index = tx.objectStore(STORE_NAME).index("createdAt");
  const cutoff = retention.retentionDays > 0
    ? Date.now() - retention.retentionDays * 24 * 60 * 60 * 1000
    : Number.NEGATIVE_INFINITY;
  let kept = 0;

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    request.onerror = () => reject(request.error ?? new Error("清理历史记录失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const record = cursor.value as LookupHistoryRecord;
      const expired = record.createdAt < cutoff;
      const overLimit = kept >= retention.maxEntries;
      if (expired || overLimit) {
        cursor.delete();
      } else {
        kept += 1;
      }
      cursor.continue();
    };
  });

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("清理历史记录事务失败"));
    tx.onabort = () => reject(tx.error ?? new Error("清理历史记录事务被取消"));
  });
}

export async function getHistoryRecord(id: string): Promise<LookupHistoryRecord | undefined> {
  return withStore("readonly", store => store.get(id)) as Promise<LookupHistoryRecord | undefined>;
}

export async function deleteHistoryRecord(id: string): Promise<void> {
  await withStore("readwrite", store => store.delete(id));
}

export async function clearHistory(): Promise<void> {
  await withStore("readwrite", store => store.clear());
}

export async function listHistory(limit = 300): Promise<LookupHistoryRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const index = tx.objectStore(STORE_NAME).index("createdAt");
  const records: LookupHistoryRecord[] = [];

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    request.onerror = () => reject(request.error ?? new Error("读取历史记录失败"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || records.length >= limit) {
        resolve();
        return;
      }
      records.push(cursor.value as LookupHistoryRecord);
      cursor.continue();
    };
  });

  return records;
}
