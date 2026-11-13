import {
  type EnvironmentProviders,
  inject,
  isDevMode,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';
import { provideServiceWorker, type SwRegistrationOptions } from '@angular/service-worker';
import { QitsPwaUpdates } from './qits-pwa-updates';

/** How {@link provideQitsPwa} registers the worker. */
export interface QitsPwaOptions {
  /** The worker script, relative to the base href (default `ngsw-worker.js`). */
  readonly script?: string;
  /** Whether to register it (default: in production builds only, `!isDevMode()`). */
  readonly enabled?: boolean;
  /** When to register it (default `registerWhenStable:30000`). */
  readonly registrationStrategy?: SwRegistrationOptions['registrationStrategy'];
}

/**
 * The installable offline shell (ticket qits-2152): Angular's service worker, registered in
 * production builds once the app is stable (or after 30 s), and {@link QitsPwaUpdates} watching it.
 * Place `<qits-pwa-update-prompt />` in the app's shell so a ready version can be taken; nothing
 * reloads the tab otherwise.
 */
export function provideQitsPwa(options: QitsPwaOptions = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideServiceWorker(options.script ?? 'ngsw-worker.js', {
      enabled: options.enabled ?? !isDevMode(),
      registrationStrategy: options.registrationStrategy ?? 'registerWhenStable:30000',
    }),
    provideEnvironmentInitializer(() => inject(QitsPwaUpdates).start()),
  ]);
}
