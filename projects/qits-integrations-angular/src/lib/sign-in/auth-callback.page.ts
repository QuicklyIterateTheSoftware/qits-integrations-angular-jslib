import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DOCUMENT,
  inject,
  PLATFORM_ID,
  signal,
} from '@angular/core';
import { Router, type Route } from '@angular/router';
import { QitsSignInError, QitsTokens, type QitsSignInFailure } from './qits-tokens';

/** What the page shows for each failure reason; `null` is an error that is not a {@link QitsSignInError}. */
const MESSAGES: Record<QitsSignInFailure | 'null', string> = {
  refused: 'The sign-in service refused the sign-in.',
  'unknown-state': 'This sign-in was started in another tab, or by an old link.',
  'no-code': 'The sign-in came back incomplete.',
  'not-swapped': 'The sign-in could not be finished: its code was wrong, already used or expired.',
  null: 'Something went wrong while signing in.',
};

type State =
  | { readonly kind: 'signing-in' }
  | { readonly kind: 'failed'; readonly reason: QitsSignInFailure | null };

/**
 * Where the idp sends the visitor back after signing in (`<page origin>/auth/callback`): finishes
 * the sign-in ({@link QitsTokens.complete}), then goes on to the page the sign-in started from,
 * replacing this one in the browser history.
 *
 * While that is in flight the page shows a signing-in state. On failure it stays here instead,
 * showing a message naming the cause and a link to start again — going on would only start the
 * next sign-in, and a refusal would loop — while still logging the technical reason to the
 * console. Without `provideQitsBearerSignIn` nothing signs in this way, and the page goes on to
 * the root.
 */
@Component({
  selector: 'qits-auth-callback',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @switch (state().kind) {
      @case ('signing-in') {
        <div role="status">
          <span class="qits-auth-spinner" aria-hidden="true"></span>
          <p>Signing you in…</p>
        </div>
      }
      @case ('failed') {
        <div>
          <h1>Sign-in failed</h1>
          <p>{{ message() }}</p>
          <a href="/">Start again</a>
        </div>
      }
    }
  `,
  styles: `
    :host {
      min-height: 100vh;
      display: grid;
      place-items: center;
      text-align: center;
      font-family: system-ui, sans-serif;
    }
    .qits-auth-spinner {
      display: inline-block;
      width: 2rem;
      height: 2rem;
      border: 0.25rem solid rgba(0, 0, 0, 0.15);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: qits-auth-spin 0.8s linear infinite;
      margin-bottom: 0.5rem;
    }
    @keyframes qits-auth-spin {
      to {
        transform: rotate(360deg);
      }
    }
  `,
})
export class QitsAuthCallbackPage {
  protected readonly state = signal<State>({ kind: 'signing-in' });
  protected readonly message = computed(() => {
    const state = this.state();
    return state.kind === 'failed' ? MESSAGES[state.reason ?? 'null'] : '';
  });

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    const router = inject(Router);
    const tokens = inject(QitsTokens, { optional: true });
    const query = new URLSearchParams(inject(DOCUMENT).location.search);
    (tokens ? tokens.complete(query) : Promise.resolve('/')).then(
      (path) => router.navigateByUrl(path, { replaceUrl: true }),
      (error: unknown) => {
        console.error('Sign-in failed; open / to try again.', error);
        this.state.set({
          kind: 'failed',
          reason: error instanceof QitsSignInError ? error.reason : null,
        });
      },
    );
  }
}

/**
 * The `auth/callback` route. `provideQitsBearerSignIn` puts it in front of the app's routes on its
 * own; an app that passes `callbackRoute: false` places it itself, outside any guard and before
 * any `**`.
 */
export const qitsAuthCallbackRoute: Route = {
  path: 'auth/callback',
  component: QitsAuthCallbackPage,
};
