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
import type { Route } from '@angular/router';
import { QITS_ENTRY } from '../outcomes/entry';
import { exit, outcomes, returnTo, stay } from '../outcomes/outcomes';
import { QitsExit } from '../outcomes/qits-exit.directive';
import { QitsSignInError, QitsTokens, type QitsSignInFailure } from './qits-tokens';

/** What the page shows for each failure reason; `null` is an error that is not a {@link QitsSignInError}. */
const MESSAGES: Record<QitsSignInFailure | 'null', string> = {
  refused: 'The sign-in service refused the sign-in.',
  'unknown-state': 'This sign-in was started in another tab, or by an old link.',
  'no-code': 'The sign-in came back incomplete.',
  'not-swapped': 'The sign-in could not be finished: its code was wrong, already used or expired.',
  unavailable: 'The sign-in service cannot be reached right now. Try again in a moment.',
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
 *
 * Both ends are declared outcomes: `sign-in` (`succeeded`, the return; `failed`, the stay) has no
 * trigger on the page, so it is `triggered: false`; `sign-in-failed:restarted` is the link.
 */
@Component({
  selector: 'qits-auth-callback',
  imports: [QitsExit],
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
          <a [qitsExit]="failure.restarted">Start again</a>
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
    }
    /* The app's own font, and a heading and link an app's CSS reset cannot flatten. */
    h1 {
      margin: 0 0 0.5rem;
      font-size: 1.5rem;
      font-weight: 600;
    }
    p {
      margin: 0 0 1rem;
    }
    a {
      color: inherit;
      text-decoration: underline;
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
  private readonly signIn = outcomes(
    'sign-in',
    { succeeded: returnTo(), failed: stay() },
    { triggered: false },
  );
  protected readonly failure = outcomes('sign-in-failed', { restarted: exit('') });
  protected readonly state = signal<State>({ kind: 'signing-in' });
  protected readonly message = computed(() => {
    const state = this.state();
    return state.kind === 'failed' ? MESSAGES[state.reason ?? 'null'] : '';
  });

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    const tokens = inject(QitsTokens, { optional: true });
    const query = new URLSearchParams(inject(DOCUMENT).location.search);
    (tokens ? tokens.complete(query) : Promise.resolve('/')).then(
      (path) => this.signIn.succeeded.go(path, { replaceUrl: true }),
      (error: unknown) => {
        console.error('Sign-in failed; open / to try again.', error);
        this.signIn.failed.reach();
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
 * any `**`. Carries `data: QITS_ENTRY` (ticket qits-2049): the idp redirects here from outside the
 * app, so no exit of this app's needs to lead to it, and every app that imports this route gets
 * the entry point for free.
 */
export const qitsAuthCallbackRoute: Route = {
  path: 'auth/callback',
  component: QitsAuthCallbackPage,
  data: QITS_ENTRY,
};
