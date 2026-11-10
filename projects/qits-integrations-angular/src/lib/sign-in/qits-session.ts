import { isPlatformServer } from '@angular/common';
import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { external, outcomes } from '../outcomes/outcomes';
import { QitsTokens } from './qits-tokens';

/**
 * Signed in means holding a valid (or refreshable) token. `provideQitsBearerSignIn` provides it.
 *
 * A visitor who is not signed in leaves for the idp through the declared outcome
 * `session-guard:signedOut`. No element triggers it, so it is `triggered: false`.
 */
@Injectable()
export class QitsSession {
  private readonly tokens = inject(QitsTokens);
  private readonly guard = outcomes(
    'session-guard',
    { signedOut: external('idp') },
    { triggered: false },
  );

  /**
   * True when the visitor is signed in. Otherwise starts the sign-in, which comes back to `url`
   * on this page, and answers false.
   */
  async ensure(url: string): Promise<boolean> {
    if (await this.tokens.accessToken()) return true;
    void this.tokens.authorizeUrl(url).then((href) => {
      if (href) this.guard.signedOut.leave(href);
    });
    return false;
  }
}

/**
 * Sends a visitor who is not signed in to sign in ({@link QitsSession}), which brings them back to
 * the route they asked for. The server render passes: it holds no token, and the browser checks
 * right after.
 */
export const qitsSignedInGuard: CanActivateFn = (_route, state) => {
  if (isPlatformServer(inject(PLATFORM_ID))) return true;
  return inject(QitsSession).ensure(state.url);
};
