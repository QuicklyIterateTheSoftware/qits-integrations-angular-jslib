import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  effect,
  inject,
  Injectable,
  PendingTasks,
  PLATFORM_ID,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import { answerValue, QitsApiError } from '../resources/api-error';
import { headersRecord, headerValue, withHeaders } from '../resources/headers';
import { identityOf, type QitsAnswer, type QitsOperationIdentity } from '../resources/operation';
import { QitsTokens } from '../sign-in/qits-tokens';
import {
  deleteStore,
  ENTRIES,
  openStore,
  OUTBOX,
  read,
  readAll,
  RECORDS,
  recordsOf,
  write,
} from './idb';
import {
  QITS_OFFLINE_OPTIONS,
  type QitsConflict,
  type QitsOfflineOperation,
  type QitsOutboxParams,
  type QitsOutboxState,
  type QitsRecordChange,
  type QitsRecordId,
} from './offline-types';

/**
 * The machinery behind `provideQitsOffline` (ticket qits-2149): the per-user IndexedDB store, the
 * cache a `cache` resource reads through, and the outbox a `queue` mutation writes to. Internal:
 * the app sees it through `QitsOffline`, `qitsResource` and `qitsMutation`.
 *
 * The store holds the server's answers only. A queued write is never written into it: it is laid
 * over the stored answer whenever a resource reads it, for as long as the write is `pending` or
 * `sending`. So a write the server refuses, or the person drops, vanishes from the page by itself,
 * and nothing local ever has to be rolled back.
 */

/** Where a `cache` resource keeps the key of the entry it shows; read by mutations' `affects`. */
export const OFFLINE_ENTRY = Symbol('qits.offline.entry');

/** A resource that can say which store entry it shows. */
export interface OfflineEntryHandle {
  readonly [OFFLINE_ENTRY]?: () => string | undefined;
}

/** The problem `type` of a 410 to a `since` that is older than the server's tombstones. */
export const CURSOR_EXPIRED = 'urn:qits:problem:cursor-expired';

/** The first wait after a failed send, doubled after every further failure up to the cap. */
export const BACKOFF_START_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;

/** One stored answer, under its entry key. A collection has `cursor` and its records apart. */
interface StoredEntry {
  readonly value: unknown;
  /** Epoch milliseconds. */
  readonly cachedAt: number;
  /** A single record's version, from its `ETag`, when the answer carried one. */
  readonly version?: number;
  readonly cursor?: string | null;
}

/** One record of a collection entry, under `[entryKey, id]`. */
interface StoredRecord {
  readonly record: Record<string, unknown>;
  readonly version: number;
}

/** An outbox entry as the store keeps it. */
export interface StoredWrite {
  readonly seq: number;
  readonly key: string;
  readonly operation: QitsOperationIdentity;
  readonly params: QitsOutboxParams;
  readonly recordId: QitsRecordId | null;
  readonly change: QitsRecordChange | null;
  readonly baseVersion: number | null;
  /** Epoch milliseconds. */
  readonly enqueuedAt: number;
  readonly state: QitsOutboxState;
  readonly conflict?: QitsConflict;
  readonly failure?: { readonly status?: number; readonly error?: unknown };
  /** The entry keys of the resources it was laid over: its mutation's `affects`. */
  readonly affects: readonly string[];
}

/** A write ready to be sent or queued: the params with its headers, and the entry to queue. */
export interface PreparedWrite {
  readonly params: unknown;
  readonly draft: Omit<StoredWrite, 'seq' | 'enqueuedAt' | 'state'>;
}

/** What a direct send came to. */
export type DirectOutcome =
  | { readonly kind: 'done'; readonly value: unknown }
  | { readonly kind: 'network'; readonly error: unknown }
  | { readonly kind: 'conflict'; readonly conflict: QitsConflict; readonly error: QitsApiError }
  | { readonly kind: 'error'; readonly error: QitsApiError };

/** What became of a queued write, for the mutation that queued it. */
export type SettledWrite =
  | { readonly seq: number; readonly outcome: 'done'; readonly value: unknown }
  | { readonly seq: number; readonly outcome: 'conflict'; readonly conflict: QitsConflict }
  | { readonly seq: number; readonly outcome: 'error'; readonly error: QitsApiError }
  | { readonly seq: number; readonly outcome: 'pending' };

/** A stored answer as a resource shows it, with the queued writes laid over it. */
export interface OfflineView {
  readonly value: unknown;
  readonly cachedAt: Date;
  /** Whether a queued write changed what the stored answer says. */
  readonly overlaid: boolean;
}

/** A read the store can refresh: the resource's operation. */
interface ReadOperation {
  readonly provider: string;
  readonly operationId: string;
  readonly method: QitsOperationIdentity['method'];
  fetch(params: never): Promise<QitsAnswer<unknown, unknown>>;
}

/** The answer of an offline collection read (qits-2148's `ChangesPage`). */
interface ChangesPage {
  readonly items: readonly Record<string, unknown>[];
  readonly deleted: readonly { readonly id: QitsRecordId; readonly version: number }[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** `<provider>#<operationId>`: how an outbox entry finds its operation again. */
function operationKey(op: QitsOperationIdentity): string {
  return `${op.provider}#${op.operationId}`;
}

/** `value` with every object's keys sorted, so equal params give one JSON. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** The store key of a read: `<provider>#<operationId>|<stable JSON of the params, no headers>`. */
export function entryKey(op: QitsOperationIdentity, params: unknown): string {
  const rest: Record<string, unknown> = { ...(params as Record<string, unknown> | undefined) };
  delete rest['headers'];
  return `${operationKey(op)}|${JSON.stringify(sorted(rest)) ?? 'null'}`;
}

/** Whether the browser says it is offline. Unknown (no `navigator`) counts as online. */
export function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function isChangesPage(value: unknown): value is ChangesPage {
  const page = value as Partial<ChangesPage> | null;
  return (
    !!page &&
    typeof page === 'object' &&
    Array.isArray(page.items) &&
    Array.isArray(page.deleted) &&
    typeof page.hasMore === 'boolean' &&
    'nextCursor' in page
  );
}

function isCollection(entry: StoredEntry): boolean {
  return 'cursor' in entry;
}

function sameId(a: unknown, b: unknown): boolean {
  return a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);
}

/** Numbers before strings, each in their natural order: IndexedDB's own key order. */
function compareIds(a: unknown, b: unknown): number {
  if (typeof a === typeof b) return (a as string) < (b as string) ? -1 : a === b ? 0 : 1;
  return typeof a === 'number' ? -1 : 1;
}

function validId(id: unknown): id is QitsRecordId {
  return typeof id === 'string' || (typeof id === 'number' && !Number.isNaN(id));
}

/** The version a strong `ETag` or `If-Match` names: `"<digits>"`, the quotes optional. */
function versionOfTag(tag: string | undefined): number | null {
  const match = tag?.trim().match(/^"?(\d{1,18})"?$/);
  return match ? Number(match[1]) : null;
}

function versionOfRecord(record: unknown): number | null {
  const version = (record as { version?: unknown } | null)?.version;
  return typeof version === 'number' ? version : null;
}

/** The `ETag` of an answer whose `response` carries headers (the generated clients' does). */
function etagOf(answer: QitsAnswer<unknown, unknown>): number | null {
  const headers = (answer.response as { headers?: unknown } | undefined)?.headers;
  return versionOfTag(headers ? headerValue(headers, 'ETag') : undefined);
}

/** `params` reading on from `since`. */
function withSince(params: unknown, since: string): unknown {
  const p = (params ?? {}) as { query?: Record<string, unknown> };
  return { ...p, query: { ...p.query, since } };
}

/** A queued write's change applied to one record (or to nothing, for a create). */
function applied(
  record: Record<string, unknown> | undefined,
  write: StoredWrite,
): Record<string, unknown> | undefined {
  const change = write.change;
  if (!change) return record;
  if (change.change === 'create') return { ...change.fields, id: write.recordId };
  if (!record || !sameId(record['id'], change.id)) return record;
  return change.change === 'update' ? { ...record, ...change.fields } : undefined;
}

/** The conflict a refusal stands for: a 412, or a 404 to an update or a delete. */
function conflictOf(
  write: Pick<StoredWrite, 'recordId' | 'change'>,
  error: QitsApiError,
  seq?: number,
): QitsConflict | undefined {
  const change = write.change?.change;
  if (error.status === 412) {
    const problem = (error.error ?? {}) as { current?: unknown; currentVersion?: unknown };
    return {
      seq,
      recordId: write.recordId,
      current: problem.current ?? null,
      currentVersion: typeof problem.currentVersion === 'number' ? problem.currentVersion : null,
    };
  }
  if (error.status === 404 && (change === 'update' || change === 'delete')) {
    return { seq, recordId: write.recordId, current: null, currentVersion: null };
  }
  return undefined;
}

@Injectable()
export class OfflineSync {
  private readonly options = inject(QITS_OFFLINE_OPTIONS);
  private readonly tokens = inject(QitsTokens, { optional: true });
  private readonly pendingTasks = inject(PendingTasks);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly user: () => string | null =
    this.options.user ?? (() => this.tokens?.user() ?? null);

  private readonly operations = new Map<string, QitsOfflineOperation>();
  private readonly watchers = new Set<(keys: ReadonlySet<string>) => void>();
  private readonly settledWatchers = new Set<(settled: SettledWrite) => void>();
  private readonly live = new Set<OfflineEntryHandle & { reload(): unknown }>();

  private opened: { name: string; db: Promise<IDBDatabase> } | null = null;
  private started = false;
  private destroyed = false;
  private draining = false;
  private again = false;
  /** A send answered 401: wait for new tokens before the next one. */
  private paused = false;
  private backoff = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  readonly #writes = signal<readonly StoredWrite[]>([]);
  readonly #sending = signal(false);
  readonly #registered = signal(0);

  /** The current user's outbox, in `seq` order. */
  readonly writes: Signal<readonly StoredWrite[]> = this.#writes.asReadonly();
  /** True while a write is on the wire. */
  readonly sending: Signal<boolean> = this.#sending.asReadonly();
  /** Moves whenever an operation is registered. */
  readonly registered: Signal<number> = this.#registered.asReadonly();

  private readonly onOnline = () => {
    this.clearBackoff();
    for (const resource of this.live) resource.reload();
    void this.drain();
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.clearBackoff();
      if (this.browser) window.removeEventListener('online', this.onOnline);
      this.close();
    });
    // Another user signs in: the store switches, and that user's outbox is sent.
    effect(() => {
      this.user();
      untracked(() => {
        if (this.started) void this.drain();
      });
    });
    // New tokens end the pause a 401 started.
    effect(() => {
      this.tokens?.renewals();
      untracked(() => {
        if (this.paused) {
          this.paused = false;
          void this.drain();
        }
      });
    });
  }

  /** Opens the store and starts the outbox: the environment initializer's work. */
  start(): void {
    if (this.started || !this.browser) return;
    this.started = true;
    for (const op of this.options.operations ?? []) this.operations.set(operationKey(op), op);
    window.addEventListener('online', this.onOnline);
    void this.drain();
  }

  /** Lets the outbox send through `op`; a `qitsMutation` registers its own. */
  register(op: QitsOfflineOperation): void {
    const key = operationKey(op);
    if (this.operations.get(key) === op) return;
    this.operations.set(key, op);
    this.#registered.update((n) => n + 1);
    if (this.started) void this.drain();
  }

  /** Whether the outbox can send through an operation with this identity. */
  knows(op: QitsOperationIdentity): boolean {
    return this.operations.has(operationKey(op));
  }

  /** The store of the user signed in now, opened on first use; null without a user or IndexedDB. */
  async database(): Promise<IDBDatabase | null> {
    if (this.destroyed || !this.browser || typeof indexedDB === 'undefined') return null;
    const user = untracked(this.user);
    if (!user) {
      this.close();
      return null;
    }
    const name = this.storeName(user);
    if (this.opened?.name !== name) {
      this.close();
      this.paused = false;
      const db = openStore(name).then(async (opened) => {
        const writes = await this.loadOutbox(opened);
        if (this.opened?.name === name) this.#writes.set(writes);
        return opened;
      });
      this.opened = { name, db };
    }
    const opened = this.opened;
    try {
      const db = await opened.db;
      return this.opened === opened ? db : null;
    } catch {
      return null;
    }
  }

  /** Calls `watcher` with the entry keys whose view changed. Answers the unsubscribe. */
  watch(watcher: (keys: ReadonlySet<string>) => void): () => void {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  /** Calls `watcher` when a queued write settles. Answers the unsubscribe. */
  onSettled(watcher: (settled: SettledWrite) => void): () => void {
    this.settledWatchers.add(watcher);
    return () => this.settledWatchers.delete(watcher);
  }

  /** Reloads `resource` when the network comes back. Answers the unregister. */
  addLive(resource: OfflineEntryHandle & { reload(): unknown }): () => void {
    this.live.add(resource);
    return () => this.live.delete(resource);
  }

  /** The entry keys the `targets` show now: those that are `cache` resources. */
  keysOf(targets: readonly unknown[]): string[] {
    const keys = new Set<string>();
    for (const target of targets) {
      const key = (target as OfflineEntryHandle)[OFFLINE_ENTRY]?.();
      if (key) keys.add(key);
    }
    return [...keys];
  }

  // ---- the cache ----

  /**
   * The stored answer of `key` with the queued writes laid over it; undefined when none is stored,
   * or when the store cannot be read (closed by a sign-out or a user switch).
   */
  async view(key: string): Promise<OfflineView | undefined> {
    const db = await this.database();
    if (!db) return undefined;
    try {
      return await this.viewIn(db, key);
    } catch {
      return undefined;
    }
  }

  private async viewIn(db: IDBDatabase, key: string): Promise<OfflineView | undefined> {
    const stored = await read<StoredEntry>(db, ENTRIES, key);
    if (!stored) return undefined;
    const overlay = this.#writes().filter(
      (w) => (w.state === 'pending' || w.state === 'sending') && w.affects.includes(key),
    );
    let value: unknown;
    if (isCollection(stored)) {
      const records = new Map<QitsRecordId, Record<string, unknown>>();
      for (const { record } of await readAll<StoredRecord>(db, RECORDS, recordsOf(key))) {
        records.set(record['id'] as QitsRecordId, record);
      }
      for (const w of overlay) {
        const id = w.recordId;
        if (id === null) continue;
        const next = applied(records.get(id), w);
        if (next) records.set(id, next);
        else records.delete(id);
      }
      value = {
        items: [...records.values()].sort((a, b) => compareIds(a['id'], b['id'])),
        deleted: [],
        hasMore: false,
        nextCursor: stored.cursor ?? null,
      };
    } else {
      value = stored.value;
      for (const w of overlay) {
        if (w.change && w.change.change !== 'create') {
          value = applied(value as Record<string, unknown> | undefined, w);
        }
      }
    }
    return { value, cachedAt: new Date(stored.cachedAt), overlaid: overlay.length > 0 };
  }

  /**
   * Reads `key` from the server through `op` and stores the answer. A collection reads on from its
   * stored cursor until `hasMore` is false, and starts over when the cursor has expired (410).
   * Answers the new view; throws what the read threw.
   */
  async refresh(key: string, op: ReadOperation, params: unknown): Promise<OfflineView | undefined> {
    const db = await this.database();
    if (!db) return undefined;
    const identity = identityOf(op);
    const fetchValue = async (p: unknown) => {
      const answer = await op.fetch(p as never);
      return { answer, value: answerValue(answer, identity) };
    };
    const stored = await read<StoredEntry>(db, ENTRIES, key);
    const since = stored && isCollection(stored) ? stored.cursor : null;
    let first: { answer: QitsAnswer<unknown, unknown>; value: unknown };
    try {
      first = await fetchValue(since ? withSince(params, since) : params);
    } catch (e) {
      const expired =
        !!since &&
        e instanceof QitsApiError &&
        e.status === 410 &&
        (e.error as { type?: unknown } | undefined)?.type === CURSOR_EXPIRED;
      if (!expired) throw e;
      await this.forgetIn(db, key);
      first = await fetchValue(params);
    }
    if (isChangesPage(first.value)) {
      let page: ChangesPage = first.value;
      for (;;) {
        await this.merge(db, key, page);
        if (!page.hasMore || !page.nextCursor) break;
        const next = (await fetchValue(withSince(params, page.nextCursor))).value;
        if (!isChangesPage(next)) break;
        page = next;
      }
    } else {
      const version = etagOf(first.answer) ?? versionOfRecord(first.value);
      const entry: StoredEntry = {
        value: first.value,
        cachedAt: Date.now(),
        ...(version !== null ? { version } : {}),
      };
      await write(db, ENTRIES, (tx) => {
        tx.objectStore(ENTRIES).put(entry, key);
        return () => undefined;
      });
    }
    return this.view(key);
  }

  /** Drops the stored answer of `key`, records and all. */
  async forget(key: string): Promise<void> {
    const db = await this.database();
    if (db) await this.forgetIn(db, key);
  }

  private forgetIn(db: IDBDatabase, key: string): Promise<void> {
    return write(db, [ENTRIES, RECORDS], (tx) => {
      tx.objectStore(ENTRIES).delete(key);
      tx.objectStore(RECORDS).delete(recordsOf(key));
      return () => undefined;
    });
  }

  /** Upserts a page's items by version, applies its tombstones, and stores its cursor. */
  private merge(db: IDBDatabase, key: string, page: ChangesPage): Promise<void> {
    return write(db, [ENTRIES, RECORDS], (tx) => {
      const records = tx.objectStore(RECORDS);
      for (const item of page.items) {
        const id = item['id'];
        const version = versionOfRecord(item);
        if (!validId(id) || version === null) continue;
        const request = records.get([key, id]);
        request.onsuccess = () => {
          const current = request.result as StoredRecord | undefined;
          if (!current || version >= current.version) {
            records.put({ record: item, version } satisfies StoredRecord, [key, id]);
          }
        };
      }
      for (const tombstone of page.deleted) {
        if (!validId(tombstone.id)) continue;
        const request = records.get([key, tombstone.id]);
        request.onsuccess = () => {
          const current = request.result as StoredRecord | undefined;
          if (current && tombstone.version >= current.version) {
            records.delete([key, tombstone.id]);
          }
        };
      }
      const entry: StoredEntry = { value: null, cachedAt: Date.now(), cursor: page.nextCursor };
      tx.objectStore(ENTRIES).put(entry, key);
      return () => undefined;
    });
  }

  /** The version the store holds for record `id` in any of `keys`; null when none does. */
  async versionOf(keys: readonly string[], id: QitsRecordId): Promise<number | null> {
    const db = await this.database();
    if (!db) return null;
    for (const key of keys) {
      const stored = await read<StoredEntry>(db, ENTRIES, key);
      if (!stored) continue;
      if (isCollection(stored)) {
        const record = await read<StoredRecord>(db, RECORDS, [key, id]);
        if (record) return record.version;
      } else if (sameId((stored.value as { id?: unknown } | null)?.id, id)) {
        return stored.version ?? versionOfRecord(stored.value);
      }
    }
    return null;
  }

  /** Writes the server's answer to a write into the stored entries it affects. */
  private async storeAnswer(
    db: IDBDatabase,
    w: Pick<StoredWrite, 'recordId' | 'change' | 'affects'>,
    value: unknown,
  ): Promise<void> {
    const answer = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    const answerId = answer?.['id'];
    const answerVersion = versionOfRecord(answer);
    const change = w.change?.change;
    if (!change) return;
    for (const key of w.affects) {
      const stored = await read<StoredEntry>(db, ENTRIES, key);
      if (!stored) continue;
      await write(db, [ENTRIES, RECORDS], (tx) => {
        const records = tx.objectStore(RECORDS);
        const entries = tx.objectStore(ENTRIES);
        if (isCollection(stored)) {
          if (change === 'create' && validId(w.recordId)) records.delete([key, w.recordId]);
          if (change === 'delete' && validId(w.recordId)) records.delete([key, w.recordId]);
          if (change !== 'delete' && answer && validId(answerId) && answerVersion !== null) {
            const request = records.get([key, answerId]);
            request.onsuccess = () => {
              const current = request.result as StoredRecord | undefined;
              if (!current || answerVersion >= current.version) {
                records.put({ record: answer, version: answerVersion }, [key, answerId]);
              }
            };
          }
        } else {
          const storedId = (stored.value as { id?: unknown } | null)?.id;
          if (change === 'delete' && sameId(storedId, w.recordId)) entries.delete(key);
          if (change === 'update' && answer && sameId(storedId, answerId)) {
            entries.put(
              {
                value: answer,
                cachedAt: Date.now(),
                ...(answerVersion !== null ? { version: answerVersion } : {}),
              } satisfies StoredEntry,
              key,
            );
          }
        }
        return () => undefined;
      });
    }
  }

  /** Writes the server's side of a conflict: its record, or its absence (a 404). */
  private async storeConflict(
    db: IDBDatabase,
    w: Pick<StoredWrite, 'recordId' | 'affects'>,
    conflict: QitsConflict,
  ): Promise<void> {
    const id = w.recordId;
    if (!validId(id)) return;
    const current =
      conflict.current && typeof conflict.current === 'object'
        ? (conflict.current as Record<string, unknown>)
        : null;
    const version = conflict.currentVersion ?? versionOfRecord(current);
    for (const key of w.affects) {
      const stored = await read<StoredEntry>(db, ENTRIES, key);
      if (!stored) continue;
      await write(db, [ENTRIES, RECORDS], (tx) => {
        if (isCollection(stored)) {
          if (current && version !== null) {
            tx.objectStore(RECORDS).put({ record: current, version }, [key, id]);
          } else if (!current) {
            tx.objectStore(RECORDS).delete([key, id]);
          }
        } else if (sameId((stored.value as { id?: unknown } | null)?.id, id)) {
          if (current) {
            tx.objectStore(ENTRIES).put(
              {
                value: current,
                cachedAt: Date.now(),
                ...(version !== null ? { version } : {}),
              } satisfies StoredEntry,
              key,
            );
          } else {
            tx.objectStore(ENTRIES).delete(key);
          }
        }
        return () => undefined;
      });
    }
  }

  // ---- writes ----

  /**
   * Gives a write its one `Idempotency-Key`, and an update or a delete the `If-Match` of the
   * version stored for its record (unless the params already carry one).
   */
  async prepare(
    op: QitsOperationIdentity,
    params: unknown,
    change: QitsRecordChange | undefined,
    affects: readonly string[],
  ): Promise<PreparedWrite> {
    const key = globalThis.crypto.randomUUID();
    const given = (params as { headers?: unknown } | undefined)?.headers;
    const recordId =
      change?.change === 'create' ? `local:${key}` : change ? (change.id as QitsRecordId) : null;
    const added: Record<string, string> = { 'Idempotency-Key': key };
    let baseVersion: number | null = null;
    if (change && change.change !== 'create') {
      const ifMatch = headerValue(given, 'If-Match');
      if (ifMatch !== undefined) {
        baseVersion = versionOfTag(ifMatch);
      } else {
        baseVersion = await this.versionOf(affects, change.id);
        if (baseVersion !== null) added['If-Match'] = `"${baseVersion}"`;
      }
    }
    const headers = withHeaders(given, added);
    const p = (params ?? {}) as { path?: unknown; query?: unknown; body?: unknown };
    const plain = JSON.parse(
      JSON.stringify({ path: p.path, query: p.query, body: p.body }),
    ) as Omit<QitsOutboxParams, 'headers'>;
    return {
      params: { ...(params as object), headers },
      draft: {
        key,
        operation: identityOf(op),
        params: { ...plain, headers: headersRecord(headers) },
        recordId,
        change: change ?? null,
        baseVersion,
        affects: [...affects],
      },
    };
  }

  /** Sends a prepared write at once, and writes what the server answered into the store. */
  async direct(op: QitsOfflineOperation, prepared: PreparedWrite): Promise<DirectOutcome> {
    let value: unknown;
    try {
      value = answerValue(await op.fetch(prepared.params as never), identityOf(op));
    } catch (e) {
      if (!(e instanceof QitsApiError)) return { kind: 'network', error: e };
      const conflict = conflictOf(prepared.draft, e);
      if (!conflict) return { kind: 'error', error: e };
      const db = await this.database();
      if (db) await this.storeConflict(db, prepared.draft, conflict);
      this.notify(prepared.draft.affects);
      return { kind: 'conflict', conflict, error: e };
    }
    const db = await this.database();
    if (db) await this.storeAnswer(db, prepared.draft, value);
    this.notify(prepared.draft.affects);
    return { kind: 'done', value };
  }

  /**
   * Queues a prepared write and starts sending. `queued` hears the `seq` before any send can
   * settle it. Answers the `seq`, or null when nobody is signed in and there is no store.
   */
  async enqueue(prepared: PreparedWrite, queued: (seq: number) => void): Promise<number | null> {
    const db = await this.database();
    if (!db) return null;
    const entry = { ...prepared.draft, enqueuedAt: Date.now(), state: 'pending' as const };
    const seq = await write(db, OUTBOX, (tx) => {
      const request = tx.objectStore(OUTBOX).add(entry);
      return () => request.result as number;
    });
    this.#writes.update((writes) => [...writes, { ...entry, seq }]);
    queued(seq);
    this.notify(entry.affects);
    void this.drain();
    return seq;
  }

  /** Sends a `conflict` entry again on the server's version, or a `failed` one as it is. */
  async retry(seq: number): Promise<void> {
    const db = await this.database();
    const w = this.#writes().find((entry) => entry.seq === seq);
    if (!db || !w || (w.state !== 'conflict' && w.state !== 'failed')) return;
    const version = w.conflict?.currentVersion;
    const cleared: { -readonly [K in keyof StoredWrite]: StoredWrite[K] } = {
      ...w,
      state: 'pending',
    };
    delete cleared.conflict;
    delete cleared.failure;
    let next: StoredWrite = cleared;
    if (w.state === 'conflict' && version !== null && version !== undefined) {
      next = {
        ...next,
        baseVersion: version,
        params: {
          ...next.params,
          headers: withHeaders(next.params.headers, { 'If-Match': `"${version}"` }) as Record<
            string,
            string
          >,
        },
      };
    }
    await this.save(db, next);
    this.notify(w.affects);
    this.settle({ seq, outcome: 'pending' });
    this.clearBackoff();
    void this.drain();
  }

  /** Removes an entry; the resources it touched reload, so the server's record stays. */
  async drop(seq: number): Promise<void> {
    const db = await this.database();
    const w = this.#writes().find((entry) => entry.seq === seq);
    if (!db || !w) return;
    await this.remove(db, seq);
    this.notify(w.affects);
    this.reloadLive(w.affects);
    void this.drain();
  }

  /** Closes and deletes the store of the user signed in now, outbox and all. */
  async deleteStore(): Promise<void> {
    const user = untracked(this.user);
    const name = this.opened?.name ?? (user ? this.storeName(user) : null);
    const opened = this.opened;
    this.opened = null;
    this.#writes.set([]);
    this.clearBackoff();
    if (opened) {
      try {
        (await opened.db).close();
      } catch {
        // It never opened: nothing to close.
      }
    }
    if (name && typeof indexedDB !== 'undefined') await deleteStore(name);
  }

  // ---- the outbox ----

  /**
   * Sends the outbox, oldest first, one at a time: on start-up, after each enqueue, when the
   * network comes back, and after a backoff. One tab sends at a time (`navigator.locks`).
   */
  async drain(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return;
    }
    this.draining = true;
    const done = this.pendingTasks.add();
    try {
      do {
        this.again = false;
        const db = await this.database();
        if (!db || !this.opened) break;
        const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
        if (locks?.request) {
          await locks.request(this.opened.name, () => this.sendAll());
        } else {
          await this.sendAll();
        }
      } while (this.again && !this.destroyed);
    } catch {
      // The store closed under the outbox (a sign-out, a user switch, the app torn down): what was
      // not sent stays queued in it, and the next drain goes on from there.
    } finally {
      this.draining = false;
      this.#sending.set(false);
      done();
    }
  }

  private async sendAll(): Promise<void> {
    while (!this.destroyed && !this.paused && this.timer === undefined && !browserOffline()) {
      const db = await this.database();
      const next = db ? this.next() : undefined;
      if (!db || !next || !(await this.send(db, next))) return;
    }
  }

  /**
   * The first `pending` entry whose operation is known and that no earlier entry for the same
   * record holds back: a `conflict` or `failed` one, or one still waiting.
   */
  private next(): StoredWrite | undefined {
    const held = new Set<string>();
    for (const w of this.#writes()) {
      const chain = w.recordId !== null ? `${w.operation.provider}|${String(w.recordId)}` : null;
      if (chain && held.has(chain)) continue;
      if (w.state === 'pending' && this.knows(w.operation)) return w;
      if (chain) held.add(chain);
    }
    return undefined;
  }

  /** Sends one entry. Answers whether the outbox may go on with the next one. */
  private async send(db: IDBDatabase, w: StoredWrite): Promise<boolean> {
    const op = this.operations.get(operationKey(w.operation));
    if (!op) return true;
    await this.save(db, { ...w, state: 'sending' });
    this.#sending.set(true);
    let value: unknown;
    try {
      value = answerValue(await op.fetch({ ...w.params } as never), w.operation);
    } catch (e) {
      return this.refused(db, w, e);
    } finally {
      this.#sending.set(false);
    }
    await this.remove(db, w.seq);
    await this.storeAnswer(db, w, value);
    await this.rebaseFollowers(db, w, value);
    this.backoff = 0;
    this.notify(w.affects);
    this.reloadLive(w.affects);
    this.settle({ seq: w.seq, outcome: 'done', value });
    return true;
  }

  private async refused(db: IDBDatabase, w: StoredWrite, e: unknown): Promise<boolean> {
    const status = e instanceof QitsApiError ? e.status : undefined;
    if (!(e instanceof QitsApiError) || status === undefined || status >= 500) {
      await this.save(db, { ...w, state: 'pending' });
      this.scheduleBackoff();
      return false;
    }
    if (status === 401) {
      await this.save(db, { ...w, state: 'pending' });
      this.paused = true;
      return false;
    }
    const conflict = conflictOf(w, e, w.seq);
    if (conflict) {
      await this.save(db, { ...w, state: 'conflict', conflict });
      await this.storeConflict(db, w, conflict);
      this.notify(w.affects);
      this.settle({ seq: w.seq, outcome: 'conflict', conflict });
      return true;
    }
    await this.save(db, { ...w, state: 'failed', failure: { status, error: e.error } });
    this.notify(w.affects);
    this.reloadLive(w.affects);
    this.settle({ seq: w.seq, outcome: 'error', error: e });
    return true;
  }

  /**
   * After a write lands, the later writes to the same record were made on top of it: an update
   * moves their `If-Match` to the answer's version, and a create gives them the real id.
   */
  private async rebaseFollowers(db: IDBDatabase, landed: StoredWrite, value: unknown) {
    const answer = value as { id?: unknown } | null;
    const version = versionOfRecord(answer);
    if (version === null || landed.recordId === null) return;
    const created = landed.change?.change === 'create' && validId(answer?.id);
    for (const w of this.#writes()) {
      if (w.seq <= landed.seq || w.state !== 'pending' || w.recordId !== landed.recordId) continue;
      if (w.operation.provider !== landed.operation.provider) continue;
      if (!created && w.baseVersion !== landed.baseVersion) continue;
      let next: StoredWrite = w;
      if (created) {
        const id = answer?.id as QitsRecordId;
        const path = Object.fromEntries(
          Object.entries(w.params.path ?? {}).map(([k, v]) => [k, v === w.recordId ? id : v]),
        );
        next = {
          ...next,
          recordId: id,
          change:
            next.change && next.change.change !== 'create' ? { ...next.change, id } : next.change,
          params: { ...next.params, ...(w.params.path ? { path } : {}) },
        };
      }
      if (next.change && next.change.change !== 'create') {
        next = {
          ...next,
          baseVersion: version,
          params: {
            ...next.params,
            headers: withHeaders(next.params.headers, { 'If-Match': `"${version}"` }) as Record<
              string,
              string
            >,
          },
        };
      }
      await this.save(db, next);
    }
  }

  private scheduleBackoff(): void {
    this.backoff = this.backoff ? Math.min(this.backoff * 2, BACKOFF_CAP_MS) : BACKOFF_START_MS;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, this.backoff);
  }

  private clearBackoff(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async loadOutbox(db: IDBDatabase): Promise<StoredWrite[]> {
    const stored = await readAll<StoredWrite>(db, OUTBOX);
    // A page that closed mid-send left `sending`: send it again, under the same key.
    const writes = stored.map((w) =>
      w.state === 'sending' ? { ...w, state: 'pending' as const } : w,
    );
    await write(db, OUTBOX, (tx) => {
      for (const w of writes) tx.objectStore(OUTBOX).put(w);
      return () => undefined;
    });
    return writes;
  }

  private async save(db: IDBDatabase, w: StoredWrite): Promise<void> {
    await write(db, OUTBOX, (tx) => {
      tx.objectStore(OUTBOX).put(w);
      return () => undefined;
    });
    this.#writes.update((writes) => writes.map((entry) => (entry.seq === w.seq ? w : entry)));
  }

  private async remove(db: IDBDatabase, seq: number): Promise<void> {
    await write(db, OUTBOX, (tx) => {
      tx.objectStore(OUTBOX).delete(seq);
      return () => undefined;
    });
    this.#writes.update((writes) => writes.filter((entry) => entry.seq !== seq));
  }

  private notify(keys: readonly string[]): void {
    if (!keys.length) return;
    const changed = new Set(keys);
    for (const watcher of this.watchers) watcher(changed);
  }

  private reloadLive(keys: readonly string[]): void {
    for (const resource of this.live) {
      const key = resource[OFFLINE_ENTRY]?.();
      if (key && keys.includes(key)) resource.reload();
    }
  }

  private settle(settled: SettledWrite): void {
    for (const watcher of this.settledWatchers) watcher(settled);
  }

  private storeName(user: string): string {
    return `qits-offline:${this.options.project}:${user}`;
  }

  private close(): void {
    const opened = this.opened;
    if (!opened) return;
    this.opened = null;
    this.#writes.set([]);
    opened.db.then(
      (db) => db.close(),
      () => undefined,
    );
  }
}
