import {
  assertInInjectionContext,
  DestroyRef,
  inject,
  Injector,
  signal,
  type Signal,
} from '@angular/core';
import {
  browserOffline,
  OFFLINE_ENTRY,
  OfflineSync,
  type OfflineEntryHandle,
} from '../offline/offline-sync';
import {
  QitsOfflineError,
  type QitsConflict,
  type QitsMutationOfflinePolicy,
  type QitsOfflineOperation,
  type QitsRecordChange,
} from '../offline/offline-types';
import { answerValue } from './api-error';
import { withHeaders } from './headers';
import { identityOf, type QitsOperation, type QitsOperationIdentity } from './operation';
import type { QitsMutationStatus } from './status';

/** What a mutation refreshes once it lands: anything with a `reload()`, a resource usually. */
export interface QitsReloadable {
  reload(): unknown;
}

/** Options of {@link qitsMutation}; `Params` are the operation's, for `record`. */
export interface QitsMutationOptions<Params = never> {
  /**
   * The resources to reload after a successful run. A function is called at run time, so it can
   * name resources created after the mutation.
   */
  readonly affects?: readonly QitsReloadable[] | (() => readonly QitsReloadable[]);
  /** The injector to use outside an injection context. */
  readonly injector?: Injector;
  /**
   * `'queue'` keeps a write the network cannot take in the outbox (`provideQitsOffline`) and sends
   * it when the network is back: offline, behind writes already queued, or after a direct send
   * failed on the network. `'online-only'`, the default, sends at once and refuses with
   * {@link QitsOfflineError} `'offline'` while the browser is offline. Without
   * `provideQitsOffline` both behave as a mutation always did.
   */
  readonly offline?: QitsMutationOfflinePolicy;
  /**
   * Which record a run touches. With `provideQitsOffline`, an update or a delete sends
   * `If-Match: "<version>"` with the version the `affects` resources have stored for it (unless
   * the params carry one), and a queued run is laid over those resources until it lands.
   */
  readonly record?: (params: Params) => QitsRecordChange;
}

/** A write through one operation. */
export interface QitsMutation<Params, Value> {
  readonly operation: QitsOperationIdentity;
  /** The latest run's status: an earlier run that settles later does not overwrite it. */
  readonly status: Signal<QitsMutationStatus>;
  /** The latest run's failure, a `QitsApiError` for an error answer. */
  readonly error: Signal<unknown>;
  /**
   * The latest run's conflict, while its status is `conflict`: the server's record and version.
   * Resolve a queued one with `QitsOffline.retry(seq)` or `drop(seq)`.
   */
  readonly conflict: Signal<QitsConflict | undefined>;
  /**
   * Calls the operation with a new `Idempotency-Key` header, so a retry of the same run cannot
   * apply twice while a second run is a second write. Rejects with a `QitsApiError` on an error
   * answer. A queued run resolves `undefined` at once, with `status()` `pending`; every send of it
   * carries the same key.
   */
  run(params: Params): Promise<Value | undefined>;
}

/** One key per run. `crypto.randomUUID` is in every supported browser and in Node. */
function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** A mutation writing through `op`, a `'write'` operation (any method but `GET`). */
export function qitsMutation<Params, Value, Err>(
  op: QitsOperation<Params, Value, 'write', Err>,
  options: QitsMutationOptions<Params> = {},
): QitsMutation<Params, Value> {
  if (!options.injector) {
    assertInInjectionContext(qitsMutation);
  }
  const injector = options.injector ?? inject(Injector);
  const operation = identityOf(op);
  const status = signal<QitsMutationStatus>('idle');
  const error = signal<unknown>(undefined);
  const conflict = signal<QitsConflict | undefined>(undefined);
  let latest = 0;
  // The outbox entry of the latest run, while it is queued.
  let queued: number | undefined;
  let destroyed = false;
  const destroyRef = injector.get(DestroyRef);
  destroyRef.onDestroy(() => (destroyed = true));

  // A destroyed owner's signals are read by nobody; the write itself still completes.
  const settle = (
    run: number,
    next: QitsMutationStatus,
    failure: unknown,
    refused?: QitsConflict,
  ) => {
    if (run === latest && !destroyed) {
      status.set(next);
      error.set(failure);
      conflict.set(refused);
    }
  };

  const targets = () =>
    typeof options.affects === 'function' ? options.affects() : (options.affects ?? []);

  const sync = injector.get(OfflineSync, null, { optional: true });
  const writeOp = op as unknown as QitsOfflineOperation;
  if (sync) {
    sync.register(writeOp);
    const unwatch = sync.onSettled((settled) => {
      if (settled.seq !== queued) return;
      const run = latest;
      switch (settled.outcome) {
        case 'done':
          queued = undefined;
          settle(run, 'done', undefined);
          // The outbox reloads the `cache` resources itself.
          for (const target of targets()) {
            if (!(target as OfflineEntryHandle)[OFFLINE_ENTRY]) target.reload();
          }
          break;
        case 'conflict':
          settle(run, 'conflict', undefined, settled.conflict);
          break;
        case 'error':
          settle(run, 'error', settled.error);
          break;
        case 'pending':
          settle(run, 'pending', undefined);
          break;
      }
    });
    destroyRef.onDestroy(unwatch);
  }

  const runOnline = async (run: number, params: Params) => {
    const headers = (params as { headers?: unknown } | undefined)?.headers;
    const keyed = {
      ...params,
      headers: withHeaders(headers, { 'Idempotency-Key': idempotencyKey() }),
    } as Params;
    let value: Value | undefined;
    try {
      value = answerValue(await op.fetch(keyed), operation);
    } catch (e) {
      settle(run, 'error', e);
      throw e;
    }
    settle(run, 'done', undefined);
    for (const target of targets()) {
      target.reload();
    }
    return value;
  };

  const runOffline = async (store: OfflineSync, run: number, params: Params) => {
    const policy = options.offline ?? 'online-only';
    if (policy === 'online-only' && browserOffline()) {
      const refused = new QitsOfflineError('offline');
      settle(run, 'error', refused);
      throw refused;
    }
    if (policy === 'queue' && !(await store.database())) {
      const refused = new QitsOfflineError('signed-out');
      settle(run, 'error', refused);
      throw refused;
    }
    const affects = targets();
    const prepared = await store.prepare(
      operation,
      params,
      options.record?.(params),
      store.keysOf(affects),
    );
    const enqueue = async () => {
      await store.enqueue(prepared, (seq) => {
        if (run === latest) queued = seq;
        settle(run, 'pending', undefined);
      });
      return undefined;
    };
    if (policy === 'queue' && (browserOffline() || store.writes().length > 0)) {
      return enqueue();
    }
    const outcome = await store.direct(writeOp, prepared);
    switch (outcome.kind) {
      case 'done':
        settle(run, 'done', undefined);
        for (const target of affects) target.reload();
        return outcome.value as Value | undefined;
      case 'network':
        if (policy === 'queue') return enqueue();
        settle(run, 'error', outcome.error);
        throw outcome.error;
      case 'conflict':
        settle(run, 'conflict', undefined, outcome.conflict);
        throw outcome.error;
      case 'error':
        settle(run, 'error', outcome.error);
        throw outcome.error;
    }
  };

  return Object.freeze({
    operation,
    status: status.asReadonly(),
    error: error.asReadonly(),
    conflict: conflict.asReadonly(),
    run: async (params: Params) => {
      const run = ++latest;
      queued = undefined;
      status.set('running');
      error.set(undefined);
      conflict.set(undefined);
      return sync ? runOffline(sync, run, params) : runOnline(run, params);
    },
  });
}
