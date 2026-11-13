import { untracked, type Injector } from '@angular/core';
import type { QitsOperationIdentity } from '../resources/operation';
import { deleteStore } from './idb';
import { entryKey, OfflineSync, operationKey, pinCacheClock } from './offline-sync';
import type { QitsOutboxState } from './offline-types';

/**
 * The offline layer as a screenshot sees it (ticket qits-2151), for `@qits/angular/testing/browser`
 * only: it reaches the main entry by package name, as the guard reaches `matchedRoutePath`, and
 * `OfflineSync` stays internal. Not app API: the `ɵ` prefix says so, and the README does not name it.
 */

/** The prefix of every offline store's name, `qits-offline:<project>:<user>`. */
export const ɵQITS_OFFLINE_STORE_PREFIX = 'qits-offline:';

/**
 * One outbox entry as a freeze records it: its operation's key, its state, the record it touches
 * and, in `conflict`, the server's version (ticket qits-2153).
 */
export interface ɵQitsOfflineOutboxEntry {
  /** `<provider>#<operationId>`. */
  readonly operation: string;
  readonly state: QitsOutboxState;
  /** The record it touches, as a string (a numeric id stringified); null when it names none. */
  readonly recordId: string | null;
  /**
   * Only in `conflict`: the version the server answered with, as a string; null when it named
   * none (a 404). Absent in every other state.
   */
  readonly currentVersion?: string | null;
}

/** One operation whose shown value a live `cache` resource read from the store (qits-2153). */
export interface ɵQitsOfflineCachedRead {
  /** `<provider>#<operationId>`. */
  readonly operation: string;
  /** When the shown value was stored; the latest, when several resources show the operation. */
  readonly cachedAt: Date;
}

/** What {@link ɵqitsOfflineState} answers: the page's offline layer at the moment of the call. */
export interface ɵQitsOfflineState {
  /** The operation keys (`<provider>#<operationId>`) of the live `cache` resources, sorted. */
  readonly cacheResources: readonly string[];
  /** The operation keys of the live mutations created with `offline: 'queue'`, sorted. */
  readonly queueMutations: readonly string[];
  /**
   * The operations whose value a live `cache` resource shows from the store now, one each, sorted
   * by operation key.
   */
  readonly cached: readonly ɵQitsOfflineCachedRead[];
  /** The signed-in user's outbox, oldest first. */
  readonly outbox: readonly ɵQitsOfflineOutboxEntry[];
  /**
   * Stores `body` as the answer of `operation` for `params` (the entry a `cache` resource with
   * those params reads), and makes the resources showing it read it again. `cachedAt` is the
   * instant the entry says it was stored (the cache clock without it). Answers the entry key;
   * rejects when nobody is signed in, since there is no store then.
   */
  store(
    operation: QitsOperationIdentity,
    params: unknown,
    body: unknown,
    cachedAt?: Date,
  ): Promise<string>;
}

/** An id or a version as a freeze records it: a string, a number stringified, else null. */
const asText = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;

/**
 * The offline layer of `injector` (the TestBed's), or `null` without `provideQitsOffline`. The
 * lists are read now; call it again for a later state.
 */
export function ɵqitsOfflineState(injector: Injector): ɵQitsOfflineState | null {
  const sync = injector.get(OfflineSync, null, { optional: true });
  if (!sync) return null;
  return Object.freeze({
    cacheResources: Object.freeze(sync.liveCacheOperations()),
    queueMutations: Object.freeze(sync.liveQueueOperations()),
    cached: Object.freeze(sync.liveCachedReads().map((read) => Object.freeze(read))),
    outbox: Object.freeze(
      untracked(sync.writes).map((w) =>
        Object.freeze({
          operation: operationKey(w.operation),
          state: w.state,
          recordId: asText(w.recordId),
          ...(w.state === 'conflict'
            ? { currentVersion: asText(w.conflict?.currentVersion ?? null) }
            : {}),
        }),
      ),
    ),
    store: async (
      operation: QitsOperationIdentity,
      params: unknown,
      body: unknown,
      cachedAt?: Date,
    ) => {
      const key = entryKey(operation, params);
      const at = cachedAt?.getTime();
      if (at !== undefined && Number.isNaN(at)) {
        throw new Error(
          `The offline store cannot stamp ${operationKey(operation)}: an invalid cachedAt.`,
        );
      }
      if (!(await sync.seed(key, body, at))) {
        throw new Error(
          `The offline store cannot hold the answer of ${operationKey(operation)}: nobody is ` +
            'signed in (provideQitsOffline({ user }) answered null, or QitsTokens has no subject).',
        );
      }
      return key;
    },
  });
}

/**
 * Deletes every `qits-offline:*` IndexedDB database of this origin, whoever's it is, and answers
 * their names. A live store closes itself on the deletion's `versionchange`. Nothing without
 * IndexedDB or `indexedDB.databases()`.
 */
export async function ɵdeleteQitsOfflineStores(): Promise<string[]> {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return [];
  const names = (await indexedDB.databases())
    .map((db) => db.name ?? '')
    .filter((name) => name.startsWith(ɵQITS_OFFLINE_STORE_PREFIX))
    .sort();
  for (const name of names) await deleteStore(name);
  return names;
}

/**
 * Pins the instant every cache write stamps as `cachedAt` (a stored answer, a landed write, a
 * conflict's record) to `at`, or puts the real clock back with `null` (ticket qits-2153).
 * `freezeScreenshots({ offline: true })` pins it before every test, so a freeze's `cached` list is
 * the same on every run. The outbox's `enqueuedAt` keeps the real clock.
 */
export function ɵpinQitsOfflineCacheClock(at: Date | null): void {
  pinCacheClock(at === null ? null : at.getTime());
}
