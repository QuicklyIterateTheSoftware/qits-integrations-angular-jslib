import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  resource,
  signal,
  untracked,
  type ResourceRef,
  type Signal,
} from '@angular/core';
import { registerCaptureState } from '../capture-state';
import { answerValue, QitsApiError } from './api-error';
import { refreshOnEvents, type QitsRefreshOn } from './domain-events';
import { identityOf, type QitsOperation, type QitsOperationIdentity } from './operation';
import type { QitsResourceStatus } from './status';

/** Options of {@link qitsResource}. */
export interface QitsResourceOptions {
  /** Reload on these domain events; needs `QITS_DOMAIN_EVENTS`. Nothing is subscribed without it. */
  readonly refreshOn?: QitsRefreshOn;
  /**
   * Put the value into feature captures (`registerCaptureState`) under this name; `true` names it
   * `<provider>#<operationId>`. Off by default: two resources on one operation would otherwise
   * share a name, and the second registration would replace the first.
   */
  readonly captureAs?: string | boolean;
  /** The injector to use outside an injection context, as Angular's `resource()` takes it. */
  readonly injector?: Injector;
}

/** A resource over a read operation: Angular's `ResourceRef`, plus what qits knows about it. */
export interface QitsResourceRef<Value> extends ResourceRef<Value | undefined> {
  readonly operation: QitsOperationIdentity;
  /** `status()` with the offline states; online it mirrors `status()`. */
  readonly qitsStatus: Signal<QitsResourceStatus>;
  /** When a `cached` value was stored; always undefined online. */
  readonly cachedAt: Signal<Date | undefined>;
  /**
   * Why the latest reload failed while the value was kept; cleared by the next successful load.
   * Usually a {@link QitsApiError}; anything else the call threw (a network failure) passes as is.
   */
  readonly reloadError: Signal<unknown>;
}

/**
 * A resource reading `op` with the params `params()` gives; `undefined` keeps it idle. Built on
 * Angular's `resource()`, so it loads again when the params change and on `reload()`.
 *
 * A failed reload keeps the value: the page goes on showing what it had, and `reloadError()` says
 * why it is not fresh, rather than a transient failure blanking the page. A 404 is the exception,
 * because the thing is gone, and so is a load after a params change, which has no value of its own
 * to keep. Both put the resource in `error`.
 */
export function qitsResource<Params, Value, Err>(
  op: QitsOperation<Params, Value, 'read', Err>,
  params: () => Params | undefined,
  options: QitsResourceOptions = {},
): QitsResourceRef<Value> {
  if (!options.injector) {
    assertInInjectionContext(qitsResource);
  }
  const injector = options.injector ?? inject(Injector);
  const operation = identityOf(op);
  const reloadError = signal<unknown>(undefined);

  // The params of the latest successful load: a reload loads the very same object again (Angular
  // keeps it), while a params change brings a new one. `previous.status` cannot tell them apart.
  let loaded: { params: Params } | undefined;

  const ref: ResourceRef<Value | undefined> = resource({
    params,
    injector,
    loader: async ({ params: current, previous }) => {
      try {
        const value = answerValue(await op.fetch(current), operation);
        loaded = { params: current };
        reloadError.set(undefined);
        return value;
      } catch (e) {
        const reloading =
          loaded?.params === current &&
          (previous.status === 'resolved' || previous.status === 'local');
        if (!reloading || (e instanceof QitsApiError && e.status === 404)) {
          // `error()` says it now; a kept-value note from before would only contradict it.
          reloadError.set(undefined);
          throw e;
        }
        reloadError.set(e);
        return untracked(ref.value);
      }
    },
  });

  if (options.refreshOn) {
    // Angular refuses a reload during the first load, and that load may already have been answered
    // before the change the event announces: reload once it settles instead of dropping the event.
    const owed = signal(false);
    effect(
      () => {
        if (owed() && ref.status() !== 'loading') {
          owed.set(false);
          ref.reload();
        }
      },
      { injector },
    );
    refreshOnEvents(injector, options.refreshOn, () => {
      if (!ref.reload() && untracked(ref.status) === 'loading') owed.set(true);
    });
  }

  if (options.captureAs) {
    const name =
      typeof options.captureAs === 'string'
        ? options.captureAs
        : `${operation.provider}#${operation.operationId}`;
    // value() throws in `error`; the registry records that as the entry's $error.
    const unregister = registerCaptureState(name, () => untracked(ref.value));
    injector.get(DestroyRef).onDestroy(unregister);
  }

  return Object.assign(ref, {
    operation,
    qitsStatus: computed<QitsResourceStatus>(() => ref.status()),
    cachedAt: signal<Date | undefined>(undefined).asReadonly(),
    reloadError: reloadError.asReadonly(),
  });
}
