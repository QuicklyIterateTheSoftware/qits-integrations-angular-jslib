import { isPlatformServer } from '@angular/common';
import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { QitsTokens } from './qits-tokens';

/** Signed in means holding a valid (or refreshable) token. `provideQitsBearerSignIn` provides it. */
@Injectable()
export class QitsSession {
  private readonly tokens = inject(QitsTokens);

  /**
   * True when the visitor is signed in. Otherwise starts the sign-in, which comes back to `url`
   * on this page, and answers false.
   */
  async ensure(url: string): Promise<boolean> {
    if (await this.tokens.accessToken()) return true;
    void this.tokens.login(url);
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
