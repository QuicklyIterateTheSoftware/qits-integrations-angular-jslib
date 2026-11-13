/**
 * A thin promise wrapper over raw IndexedDB, just wide enough for the offline store (ticket
 * qits-2149): no runtime dependency, and every write resolves only once its transaction commits.
 *
 * The database has three object stores, at version 1:
 *
 * - `entries`: one stored answer per resource entry, keyed by the entry key;
 * - `records`: the records of a collection entry, keyed by `[entryKey, id]`;
 * - `outbox`: the queued writes, keyed by an auto-incremented `seq`.
 */

export const ENTRIES = 'entries';
export const RECORDS = 'records';
export const OUTBOX = 'outbox';

/** The store's schema version. */
export const STORE_VERSION = 1;

/** Opens (and on first use creates) the database `name`. It closes itself when another tab deletes it. */
export function openStore(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, STORE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(ENTRIES);
      db.createObjectStore(RECORDS);
      db.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Deletes the database `name`; the open connections close on their `versionchange`. */
export function deleteStore(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/** The value under `key` in `store`, or undefined. */
export function read<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Every value in `store`, in key order, within `range` when one is given. */
export function readAll<T>(db: IDBDatabase, store: string, range?: IDBKeyRange): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll(range);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Runs `work` in one read-write transaction over `stores` and resolves with what it answers once
 * the transaction commits. `work` issues its requests synchronously, or from their own `onsuccess`
 * callbacks, which keep the transaction open: never across an `await`.
 */
export function write<T = void>(
  db: IDBDatabase,
  stores: string | string[],
  work: (tx: IDBTransaction) => () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    const result = work(tx);
    tx.oncomplete = () => resolve(result());
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new DOMException('The transaction aborted', 'AbortError'));
  });
}

/** The key range of every record of the entry `entryKey`: `[entryKey, <any id>]`. */
export function recordsOf(entryKey: string): IDBKeyRange {
  // An array sorts after every number and string, so `[entryKey, []]` bounds any scalar id.
  return IDBKeyRange.bound([entryKey], [entryKey, []]);
}
