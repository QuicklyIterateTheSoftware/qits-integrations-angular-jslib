import { untracked, type Injector } from '@angular/core';
import type { QitsOperationIdentity } from '../resources/operation';
import { deleteStore } from './idb';
import { entryKey, OfflineSync, operationKey } from './offline-sync';
import type { QitsOutboxState } from './offline-types';

/**
 * The offline layer as a screenshot sees it (ticket qits-2151), for `@qits/angular/testing/browser`
 * only: it reaches the main entry by package name, as the guard reaches `matchedRoutePath`, and
 * `OfflineSync` stays internal. Not app API: the `ɵ` prefix says so, and the README does not name it.
 */

/** The prefix of every offline store's name, `qits-offline:<project>:<user>`. */
export const ɵQITS_OFFLINE_STORE_PREFIX = 'qits-offline:';

/** One outbox entry as a freeze records it: its operation's key and its state. */
export interface ɵQitsOfflineOutboxEntry {
  /** `<provider>#<operationId>`. */
  readonly operation: string;
  readonly state: QitsOutboxState;
}

/** What {@link ɵqitsOfflineState} answers: the page's offline layer at the moment of the call. */
export interface ɵQitsOfflineState {
  /** The operation keys (`<provider>#<operationId>`) of the live `cache` resources, sorted. */
  readonly cacheResources: readonly string[];
  /** The operation keys of the live mutations created with `offline: 'queue'`, sorted. */
  readonly queueMutations: readonly string[];
  /** The signed-in user's outbox, oldest first. */
  readonly outbox: readonly ɵQitsOfflineOutboxEntry[];
  /**
   * Stores `body` as the answer of `operation` for `params` (the entry a `cache` resource with
   * those params reads), and makes the resources showing it read it again. Answers the entry key;
   * rejects when nobody is signed in, since there is no store then.
   */
  store(operation: QitsOperationIdentity, params: unknown, body: unknown): Promise<string>;
}

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
    outbox: Object.freeze(
      untracked(sync.writes).map((w) =>
        Object.freeze({ operation: operationKey(w.operation), state: w.state }),
      ),
    ),
    store: async (operation: QitsOperationIdentity, params: unknown, body: unknown) => {
      const key = entryKey(operation, params);
      if (!(await sync.seed(key, body))) {
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
