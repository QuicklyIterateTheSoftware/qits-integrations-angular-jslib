import { DOCUMENT, inject, Injectable } from '@angular/core';
import { external, outcomes } from '../outcomes/outcomes';
import { QitsTokens } from './qits-tokens';

/**
 * What `qitsBearerInterceptor` and `QitsBearerFetch` do when a platform call answers 401 and no
 * refresh helps. `provideQitsBearerSignIn` provides it.
 *
 * The visitor leaves for the idp through the declared outcome `session-expired:signedOut`, back to
 * this page. No element triggers it, so it is `triggered: false`.
 */
@Injectable()
export class QitsSessionExpiry {
  private readonly tokens = inject(QitsTokens);
  private readonly location = inject(DOCUMENT).location;
  private readonly expired = outcomes(
    'session-expired',
    { signedOut: external('idp') },
    { triggered: false },
  );

  /** The session is over and no refresh helps: sign in again, back to this page. */
  signIn(): void {
    void this.tokens
      .authorizeUrl(`${this.location.pathname}${this.location.search}`)
      .then((href) => {
        if (href) this.expired.signedOut.leave(href);
      });
  }
}
