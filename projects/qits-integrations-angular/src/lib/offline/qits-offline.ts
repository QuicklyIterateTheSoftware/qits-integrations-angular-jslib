import {
  computed,
  inject,
  Injectable,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
  type EnvironmentProviders,
  type Signal,
} from '@angular/core';
import { QitsApiError } from '../resources/api-error';
import { QitsTokens } from '../sign-in/qits-tokens';
import { OfflineSync, type StoredWrite } from './offline-sync';
import {
  QITS_OFFLINE_OPTIONS,
  type QitsOfflineOptions,
  type QitsOutboxEntry,
  type QitsSignOutOptions,
  type QitsSignOutResult,
} from './offline-types';

/**
 * The offline store and its outbox, as the app sees them (ticket qits-2149): the queued writes,
 * whether one is on the wire, the two ways to resolve a refused one, and sign-out. Provided by
 * {@link provideQitsOffline}.
 */
@Injectable()
export class QitsOffline {
  private readonly sync = inject(OfflineSync);
  private readonly tokens = inject(QitsTokens, { optional: true });

  /**
   * The signed-in user's queued writes, oldest first. An entry stays here until the server takes
   * it or the person drops it; `conflict` and `failed` entries wait for {@link retry} or
   * {@link drop}.
   */
  readonly outbox: Signal<readonly QitsOutboxEntry[]> = computed(() => {
    this.sync.registered();
    return this.sync.writes().map((w) => this.entry(w));
  });

  /** True while a queued write is on the wire: a reload now could lose its answer. */
  readonly sending: Signal<boolean> = this.sync.sending;

  /**
   * Sends a refused entry again. A `conflict` entry is re-based on the server's version (its
   * `If-Match` names `currentVersion`), so it overwrites the record the person has now seen; a
   * `failed` entry is resent as it is. Either keeps its `Idempotency-Key`, which the server freed
   * when it refused. Does nothing to an entry in another state.
   */
  retry(seq: number): Promise<void> {
    return this.sync.retry(seq);
  }

  /**
   * Removes an entry, whatever its state, and reloads the resources it touched: the server's
   * record stays, and the local copy shows it again.
   */
  drop(seq: number): Promise<void> {
    return this.sync.drop(seq);
  }

  /**
   * Signs out on this device. With writes in the outbox and no `discardPending`, it changes
   * nothing and answers `{ signedOut: false, pending }`: show that as the warning, and call again
   * with `discardPending: true` once the person agrees to lose them. Otherwise it deletes the
   * user's store (stored answers and outbox), forgets the tokens when `provideQitsBearerSignIn`
   * is there, and answers `{ signedOut: true, pending }`.
   *
   * `QitsTokens.logout()` alone, which also runs when the idp refuses a refresh, clears nothing.
   */
  async signOut(options: QitsSignOutOptions = {}): Promise<QitsSignOutResult> {
    await this.sync.database();
    const pending = this.sync.writes().length;
    if (pending > 0 && options.discardPending !== true) return { signedOut: false, pending };
    await this.sync.deleteStore();
    this.tokens?.logout();
    return { signedOut: true, pending };
  }

  private entry(w: StoredWrite): QitsOutboxEntry {
    return {
      seq: w.seq,
      key: w.key,
      operation: w.operation,
      params: w.params,
      recordId: w.recordId,
      change: w.change,
      baseVersion: w.baseVersion,
      enqueuedAt: new Date(w.enqueuedAt),
      state: w.state,
      ...(w.conflict ? { conflict: w.conflict } : {}),
      ...(w.failure
        ? { error: new QitsApiError(w.failure.status, w.failure.error, w.operation) }
        : {}),
      ...(w.state === 'pending' && !this.sync.knows(w.operation)
        ? { waiting: 'unknown-operation' as const }
        : {}),
    };
  }
}

/**
 * Offline mode for `qitsResource` and `qitsMutation` (ticket qits-2149): a per-user IndexedDB
 * store, `qits-offline:<project>:<user>`, that `offline: 'cache'` resources answer from first and
 * `offline: 'queue'` mutations write to while the network is gone, and the outbox that sends those
 * writes once it is back. It provides {@link QitsOffline} and opens the store at start-up.
 *
 * Without it every `offline` option is inert: resources and mutations behave as they always did.
 */
export function provideQitsOffline(options: QitsOfflineOptions): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: QITS_OFFLINE_OPTIONS, useValue: options },
    OfflineSync,
    QitsOffline,
    provideEnvironmentInitializer(() => inject(OfflineSync).start()),
  ]);
}

/**
 * A reload guard for `@qits/angular/pwa`'s `QITS_PWA_RELOAD_GUARDS`: it refuses with
 * `'the outbox is sending'` while a queued write is on the wire, and lets the reload through
 * otherwise (and without `provideQitsOffline`). Call it in an injection context; as a factory:
 *
 * ```ts
 * { provide: QITS_PWA_RELOAD_GUARDS, multi: true, useFactory: qitsOfflineReloadGuard }
 * ```
 */
export function qitsOfflineReloadGuard(): () => true | string {
  const offline = inject(QitsOffline, { optional: true });
  return () => (offline?.sending() ? 'the outbox is sending' : true);
}
