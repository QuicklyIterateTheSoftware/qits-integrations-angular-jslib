import { HttpHeaders } from '@angular/common/http';
import {
  assertInInjectionContext,
  DestroyRef,
  inject,
  Injector,
  signal,
  type Signal,
} from '@angular/core';
import { answerValue } from './api-error';
import { identityOf, type QitsOperation, type QitsOperationIdentity } from './operation';
import type { QitsMutationStatus } from './status';

/** What a mutation refreshes once it lands: anything with a `reload()`, a resource usually. */
export interface QitsReloadable {
  reload(): unknown;
}

/** Options of {@link qitsMutation}. */
export interface QitsMutationOptions {
  /**
   * The resources to reload after a successful run. A function is called at run time, so it can
   * name resources created after the mutation.
   */
  readonly affects?: readonly QitsReloadable[] | (() => readonly QitsReloadable[]);
  /** The injector to use outside an injection context. */
  readonly injector?: Injector;
}

/** A write through one operation. */
export interface QitsMutation<Params, Value> {
  readonly operation: QitsOperationIdentity;
  /** The latest run's status: an earlier run that settles later does not overwrite it. */
  readonly status: Signal<QitsMutationStatus>;
  /** The latest run's failure, a `QitsApiError` for an error answer. */
  readonly error: Signal<unknown>;
  /**
   * Calls the operation with a new `Idempotency-Key` header, so a retry of the same run cannot
   * apply twice while a second run is a second write. Rejects with a `QitsApiError` on an error
   * answer.
   */
  run(params: Params): Promise<Value | undefined>;
}

/** One key per run. `crypto.randomUUID` is in every supported browser and in Node. */
function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** `headers` with the key added, in whatever form the app passed them. */
function withKey(headers: unknown, key: string): unknown {
  if (headers instanceof HttpHeaders) {
    return headers.set('Idempotency-Key', key);
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const copy = new Headers(headers);
    copy.set('Idempotency-Key', key);
    return copy;
  }
  return { ...(headers as Record<string, unknown> | undefined), 'Idempotency-Key': key };
}

/** A mutation writing through `op`, a `'write'` operation (any method but `GET`). */
export function qitsMutation<Params, Value, Err>(
  op: QitsOperation<Params, Value, 'write', Err>,
  options: QitsMutationOptions = {},
): QitsMutation<Params, Value> {
  if (!options.injector) {
    assertInInjectionContext(qitsMutation);
  }
  const injector = options.injector ?? inject(Injector);
  const operation = identityOf(op);
  const status = signal<QitsMutationStatus>('idle');
  const error = signal<unknown>(undefined);
  let latest = 0;
  let destroyed = false;
  injector.get(DestroyRef).onDestroy(() => (destroyed = true));

  // A destroyed owner's signals are read by nobody; the write itself still completes.
  const settle = (run: number, next: QitsMutationStatus, failure: unknown) => {
    if (run === latest && !destroyed) {
      status.set(next);
      error.set(failure);
    }
  };

  return Object.freeze({
    operation,
    status: status.asReadonly(),
    error: error.asReadonly(),
    run: async (params: Params) => {
      const run = ++latest;
      status.set('running');
      error.set(undefined);
      const headers = (params as { headers?: unknown } | undefined)?.headers;
      const keyed = { ...params, headers: withKey(headers, idempotencyKey()) } as Params;
      let value: Value | undefined;
      try {
        value = answerValue(await op.fetch(keyed), operation);
      } catch (e) {
        settle(run, 'error', e);
        throw e;
      }
      settle(run, 'done', undefined);
      const affects =
        typeof options.affects === 'function' ? options.affects() : (options.affects ?? []);
      for (const target of affects) {
        target.reload();
      }
      return value;
    },
  });
}
