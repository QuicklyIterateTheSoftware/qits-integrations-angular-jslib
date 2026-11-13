import {
  assertInInjectionContext,
  computed,
  DestroyRef,
  effect,
  inject,
  Injector,
  PendingTasks,
  resource,
  signal,
  untracked,
  type ResourceRef,
  type ResourceStatus,
  type ResourceStreamItem,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import { registerCaptureState } from '../capture-state';
import {
  browserOffline,
  entryKey,
  OFFLINE_ENTRY,
  OfflineSync,
  type OfflineView,
} from '../offline/offline-sync';
import type { QitsResourceOfflinePolicy } from '../offline/offline-types';
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
  /**
   * `'cache'` keeps every answer in the offline store (`provideQitsOffline`) and answers from it
   * first: `qitsStatus()` is `cached` until the fresh answer arrives, the stored value stays while
   * the network is gone, and it outlives a page reload. `'online-only'`, the default, keeps nothing.
   * Without `provideQitsOffline`, or with nobody signed in, `'cache'` acts `'online-only'`.
   */
  readonly offline?: QitsResourceOfflinePolicy;
}

/** A resource over a read operation: Angular's `ResourceRef`, plus what qits knows about it. */
export interface QitsResourceRef<Value> extends ResourceRef<Value | undefined> {
  readonly operation: QitsOperationIdentity;
  /**
   * `status()` with the offline states. It mirrors `status()`, except that a resolved `cache`
   * resource is `cached` while it shows the stored value (before the fresh answer, while the
   * network is gone, or with a queued write laid over it) and `offline` when the network is gone
   * and nothing is stored. An `online-only` resource never reaches either.
   */
  readonly qitsStatus: Signal<QitsResourceStatus>;
  /** When the value shown while `cached` was stored; undefined in every other state. */
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
 *
 * With `offline: 'cache'` and `provideQitsOffline` (ticket qits-2149) the kept value outlives the
 * page: a load answers the stored value at once (`cached`) and then fetches. A network failure keeps
 * the stored value at `cached`, or is `offline`, without `error()`, when nothing is stored; a
 * `QitsApiError` behaves as above. An answer of the `ChangesPage` shape (`items`, `deleted`,
 * `nextCursor`, `hasMore`) is kept as records: the next load reads only the changes since its stored
 * cursor (`query.since`), and the value is the page shape over the whole merged collection, `items`
 * in id order. The `online` window event reloads every live `cache` resource.
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

  const load = async (current: Params, previous: { status: ResourceStatus }) => {
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
  };

  const sync =
    options.offline === 'cache' ? injector.get(OfflineSync, null, { optional: true }) : null;
  // What a resolved `cache` resource shows: the fresh answer, the stored one, or nothing offline.
  const phase = signal<'resolved' | 'cached' | 'offline'>('resolved');
  const cachedAt = signal<Date | undefined>(undefined);
  let shownKey: string | undefined;
  let shown: WritableSignal<ResourceStreamItem<Value | undefined>> | undefined;

  const showStored = (view: OfflineView | undefined, into = shown) => {
    if (!into || into !== shown) return;
    into.set({ value: view?.value as Value | undefined });
    phase.set('cached');
    cachedAt.set(view?.cachedAt);
  };

  // Fetches the fresh answer through the store, and shows it, or keeps what is shown.
  const refresh = async (
    key: string,
    current: Params,
    into: WritableSignal<ResourceStreamItem<Value | undefined>>,
    stored: OfflineView | undefined,
  ) => {
    const active = () => into === shown;
    if (browserOffline()) {
      if (active() && !stored) {
        phase.set('offline');
        cachedAt.set(undefined);
      }
      return;
    }
    try {
      const view = await sync!.refresh(key, op, current);
      if (!active()) return;
      reloadError.set(undefined);
      into.set({ value: view?.value as Value | undefined });
      phase.set(view?.overlaid ? 'cached' : 'resolved');
      cachedAt.set(view?.overlaid ? view.cachedAt : undefined);
    } catch (e) {
      if (!active()) return;
      if (!(e instanceof QitsApiError)) {
        // The network: the stored value stays, or there is nothing to show.
        if (stored) {
          reloadError.set(e);
        } else {
          phase.set('offline');
          cachedAt.set(undefined);
        }
        return;
      }
      if (e.status === 404) {
        await sync!.forget(key);
        if (!active()) return;
        reloadError.set(undefined);
        into.set({ error: e });
        return;
      }
      if (stored) {
        reloadError.set(e);
        return;
      }
      reloadError.set(undefined);
      into.set({ error: e });
    }
  };

  const ref: ResourceRef<Value | undefined> = sync
    ? resource({
        params,
        injector,
        stream: async ({ params: current, previous }) => {
          if (!(await sync.database())) {
            // Nobody signed in: no store, so the resource acts `online-only`.
            shownKey = undefined;
            shown = undefined;
            phase.set('resolved');
            cachedAt.set(undefined);
            try {
              return signal({ value: await load(current, previous) });
            } catch (e) {
              return signal({ error: e as Error });
            }
          }
          const key = entryKey(operation, current);
          const into = signal<ResourceStreamItem<Value | undefined>>({ value: undefined });
          shownKey = key;
          shown = into;
          const stored = await sync.view(key);
          if (!stored) {
            await refresh(key, current, into, undefined);
            return into;
          }
          showStored(stored, into);
          const done = injector.get(PendingTasks).add();
          void refresh(key, current, into, stored).finally(done);
          return into;
        },
      })
    : resource({
        params,
        injector,
        loader: ({ params: current, previous }) => load(current, previous),
      });

  if (sync) {
    // A queued write, a conflict or a landed write changed what the store says.
    const unwatch = sync.watch((keys) => {
      const key = shownKey;
      const into = shown;
      if (!key || !into || !keys.has(key)) return;
      const done = injector.get(PendingTasks).add();
      void sync
        .view(key)
        .then((view) => {
          if (shownKey === key) showStored(view, into);
        })
        .finally(done);
    });
    const handle = Object.defineProperty(ref, OFFLINE_ENTRY, { value: () => shownKey });
    const unlive = sync.addLive(handle, operation);
    injector.get(DestroyRef).onDestroy(() => {
      unwatch();
      unlive();
    });
  }

  if (options.refreshOn) {
    // Angular refuses a reload during any read in flight, a first load or a reload, and that
    // read may already have been answered before the change the event announces: reload once it
    // settles instead of dropping the event.
    const owed = signal(false);
    effect(
      () => {
        if (owed() && !ref.isLoading()) {
          owed.set(false);
          ref.reload();
        }
      },
      { injector },
    );
    refreshOnEvents(injector, options.refreshOn, () => {
      if (!ref.reload() && untracked(ref.isLoading)) owed.set(true);
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
    qitsStatus: computed<QitsResourceStatus>(() => {
      const status = ref.status();
      return sync && status === 'resolved' ? phase() : status;
    }),
    cachedAt: computed(() => (ref.status() === 'resolved' ? cachedAt() : undefined)),
    reloadError: reloadError.asReadonly(),
  });
}
