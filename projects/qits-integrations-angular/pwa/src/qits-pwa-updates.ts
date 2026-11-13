import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  DOCUMENT,
  EnvironmentInjector,
  inject,
  Injectable,
  InjectionToken,
  PLATFORM_ID,
  runInInjectionContext,
  signal,
  type Signal,
} from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

/**
 * Where the tab stands against the server: on the version it loaded (`current`), with a newer one
 * downloaded and ready (`ready`), or on a version the worker can no longer serve (`broken`).
 */
export type QitsPwaState = 'current' | 'ready' | 'broken';

/**
 * Asked before {@link QitsPwaUpdates.apply} reloads the tab: `true` lets it, a string refuses and
 * says why (the prompt shows it). It runs in the root injection context, so it may `inject()`.
 */
export type QitsPwaReloadGuard = () => true | string | Promise<true | string>;

/**
 * Every guard a reload must pass (multi). qits-2149's outbox provides one that refuses while it is
 * sending; an app may add its own, for example for an unsaved form:
 *
 * ```ts
 * { provide: QITS_PWA_RELOAD_GUARDS, multi: true, useValue: () => true }
 * ```
 */
export const QITS_PWA_RELOAD_GUARDS = new InjectionToken<readonly QitsPwaReloadGuard[]>(
  'QITS_PWA_RELOAD_GUARDS',
);

/** What {@link QitsPwaUpdates.apply} did: reloaded, or not, with every refusing guard's reason. */
export type QitsPwaApplyResult =
  { readonly applied: true } | { readonly applied: false; readonly reasons: readonly string[] };

/**
 * The tab's version against the server, and the one way to move to a newer one (ticket qits-2152).
 *
 * It never reloads, assigns `location` or activates a version on its own, not even when the worker
 * reports the tab's version `unrecoverable`: in an offline-first app a reload while the outbox is
 * writing drops what the person did, and they never chose it. It only sets {@link state}, which
 * `QitsPwaUpdatePrompt` shows; the person's Reload calls {@link apply}, which asks every
 * {@link QITS_PWA_RELOAD_GUARDS} entry first.
 *
 * Inert on the server and wherever the worker is off (`ng serve`, specs, a browser without service
 * workers): {@link state} stays `current` and {@link check} does nothing.
 */
@Injectable({ providedIn: 'root' })
export class QitsPwaUpdates {
  private readonly updates = inject(SwUpdate, { optional: true });
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(EnvironmentInjector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly guards = inject(QITS_PWA_RELOAD_GUARDS, { optional: true }) ?? [];
  private readonly active =
    isPlatformBrowser(inject(PLATFORM_ID)) && (this.updates?.isEnabled ?? false);

  readonly #state = signal<QitsPwaState>('current');
  readonly #readyCount = signal(0);
  private started = false;

  /** `current`, `ready` after `VERSION_READY`, `broken` after `unrecoverable`. */
  readonly state: Signal<QitsPwaState> = this.#state.asReadonly();

  /**
   * How many `VERSION_READY` events the tab has seen. The prompt's Later hides it until this
   * moves.
   */
  readonly readyCount: Signal<number> = this.#readyCount.asReadonly();

  /**
   * Starts watching the worker; `provideQitsPwa` calls it. A second call, the server, and a disabled
   * worker do nothing.
   */
  start(): void {
    const updates = this.updates;
    if (this.started || !this.active || !updates) return;
    this.started = true;

    const versions = updates.versionUpdates.subscribe((event) => {
      if (event.type !== 'VERSION_READY') return;
      this.#readyCount.update((n) => n + 1);
      // A broken tab stays broken: a newer version does not make its own loadable again.
      if (this.#state() !== 'broken') this.#state.set('ready');
    });
    const unrecoverable = updates.unrecoverable.subscribe(() => this.#state.set('broken'));
    const visible = () => {
      if (this.document.visibilityState === 'visible') void this.check();
    };
    this.document.addEventListener('visibilitychange', visible);
    this.destroyRef.onDestroy(() => {
      versions.unsubscribe();
      unrecoverable.unsubscribe();
      this.document.removeEventListener('visibilitychange', visible);
    });
  }

  /**
   * Asks the worker to look for a new version; resolves whether it found one. A failure (offline,
   * the server unreachable) resolves `false`: the next trigger tries again. Called when the tab
   * becomes visible; an app may call it too, for example on its own deployment event.
   */
  async check(): Promise<boolean> {
    if (!this.active || !this.updates) return false;
    try {
      return await this.updates.checkForUpdate();
    } catch {
      return false;
    }
  }

  /**
   * The only path to a reload. Asks every reload guard (each one, so every reason is known); if any
   * refuses, or throws, it resolves `{ applied: false, reasons }` and changes nothing. Otherwise it
   * activates the ready version (when there is one) and reloads the page.
   */
  async apply(): Promise<QitsPwaApplyResult> {
    const reasons: string[] = [];
    for (const guard of this.guards) {
      let answer: true | string;
      try {
        answer = await runInInjectionContext(this.injector, guard);
      } catch (error) {
        answer = error instanceof Error ? error.message : String(error);
      }
      if (answer !== true) reasons.push(answer);
    }
    if (reasons.length > 0) return { applied: false, reasons };

    if (this.active && this.updates && this.#state() === 'ready') {
      // The reload below loads the newest version anyway; activating first only makes it certain.
      await this.updates.activateUpdate().catch(() => undefined);
    }
    this.document.location.reload();
    return { applied: true };
  }
}
