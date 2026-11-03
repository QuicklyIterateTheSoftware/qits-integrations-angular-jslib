import { isPlatformBrowser } from '@angular/common';
import { ChangeDetectionStrategy, Component, DOCUMENT, inject, PLATFORM_ID } from '@angular/core';
import { Router, type Route } from '@angular/router';
import { QitsTokens } from './qits-tokens';

/**
 * Where the idp sends the visitor back after signing in (`<page origin>/auth/callback`): finishes
 * the sign-in ({@link QitsTokens.complete}), then goes on to the page the sign-in started from,
 * replacing this one in the browser history.
 *
 * A failed sign-in stays here, with the reason in the console: going on would only start the next
 * sign-in, and a refusal would loop. Without `provideQitsBearerSignIn` nothing signs in this way,
 * and the page goes on to the root.
 */
@Component({
  selector: 'qits-auth-callback',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ``,
})
export class QitsAuthCallbackPage {
  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    const router = inject(Router);
    const tokens = inject(QitsTokens, { optional: true });
    const query = new URLSearchParams(inject(DOCUMENT).location.search);
    (tokens ? tokens.complete(query) : Promise.resolve('/')).then(
      (path) => router.navigateByUrl(path, { replaceUrl: true }),
      (error: unknown) => console.error('Sign-in failed; open / to try again.', error),
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
