import { DestroyRef, InjectionToken, Injector } from '@angular/core';
import { buffer, connect, debounceTime, filter, type Observable } from 'rxjs';

/**
 * A domain event as a resource sees it: a name and, perhaps, a payload. Kept loose on purpose, so
 * that an app's own events service, with a richer event type, can be provided with `useExisting`.
 */
export interface QitsDomainEvent {
  readonly name: string;
  readonly payload?: unknown;
}

/**
 * The app's domain event stream. The library never opens one itself: the app owns the connection
 * (and its sign-in), and provides it under {@link QITS_DOMAIN_EVENTS}.
 */
export interface QitsDomainEvents {
  /** The events whose name is one of `names`. */
  on(names: readonly string[]): Observable<QitsDomainEvent>;
}

/** Where a resource's `refreshOn` finds the app's domain events. Not provided by default. */
export const QITS_DOMAIN_EVENTS = new InjectionToken<QitsDomainEvents>('QITS_DOMAIN_EVENTS');

/**
 * The quiet period after the last event of a burst before a resource reloads: a burst of events
 * (a release touching ten rows) costs one request, not ten.
 */
export const REFRESH_DEBOUNCE_MS = 1_000;

/** When a resource reloads on its own. */
export interface QitsRefreshOn {
  /** The event names to listen to. */
  readonly names: readonly string[];
  /** Which of those events concern this resource; all of them by default. */
  readonly when?: (event: QitsDomainEvent) => boolean;
  /** The quiet period; {@link REFRESH_DEBOUNCE_MS} by default. */
  readonly debounceMs?: number;
}

/**
 * Calls `reload` once per burst of matching events, until `injector` is destroyed. One `on()` per
 * call. Throws when the app provides no {@link QITS_DOMAIN_EVENTS}: a resource told to refresh
 * that never would is a wiring mistake, better found at creation than in production.
 */
export function refreshOnEvents(
  injector: Injector,
  refreshOn: QitsRefreshOn,
  reload: () => void,
): void {
  const events = injector.get(QITS_DOMAIN_EVENTS, null, { optional: true });
  if (!events) {
    throw new Error(
      '[qits] refreshOn needs the app to provide QITS_DOMAIN_EVENTS (its domain event stream)',
    );
  }
  const when = refreshOn.when ?? (() => true);
  const ms = refreshOn.debounceMs ?? REFRESH_DEBOUNCE_MS;
  const subscription = events
    .on(refreshOn.names)
    .pipe(
      filter(when),
      connect((burst) => burst.pipe(buffer(burst.pipe(debounceTime(ms))))),
    )
    .subscribe(() => reload());
  injector.get(DestroyRef).onDestroy(() => subscription.unsubscribe());
}
