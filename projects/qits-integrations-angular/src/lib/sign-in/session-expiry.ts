import { DOCUMENT, inject, Injectable } from '@angular/core';
import { exit, external, outcomes } from '../outcomes/outcomes';
import { QitsTokens, UNAVAILABLE_QUERY } from './qits-tokens';

/**
 * What `qitsBearerInterceptor` and `QitsBearerFetch` do when a platform call answers 401 and no
 * refresh helps. `provideQitsBearerSignIn` provides it.
 *
 * The visitor leaves for the idp through the declared outcome `session-expired:signedOut`, back to
 * this page. No element triggers it, so it is `triggered: false`.
 *
 * When the refresh failed only because the idp did not answer (`QitsTokens.lastFailure()` is
 * `unavailable`, qits-2250), its authorize page would not answer either: the visitor goes in-app to
 * `/auth/callback?error=temporarily_unavailable` instead, through `session-expired:unavailable`,
 * which says the sign-in service cannot be reached and offers to start again.
 */
@Injectable()
export class QitsSessionExpiry {
  private readonly tokens = inject(QitsTokens);
  private readonly location = inject(DOCUMENT).location;
  private readonly expired = outcomes(
    'session-expired',
    { signedOut: external('idp'), unavailable: exit('auth/callback') },
    { triggered: false },
  );

  /**
   * The session is over and no refresh helps: sign in again, back to this page. With the idp
   * unavailable, say so on the callback page instead (the refresh's tokens are kept for a retry).
   */
  signIn(): void {
    if (this.tokens.lastFailure() === 'unavailable') {
      void this.expired.unavailable.go({}, { queryParams: UNAVAILABLE_QUERY });
      return;
    }
    void this.tokens
      .authorizeUrl(`${this.location.pathname}${this.location.search}`)
      .then((href) => {
        if (href) this.expired.signedOut.leave(href);
      });
  }
}
