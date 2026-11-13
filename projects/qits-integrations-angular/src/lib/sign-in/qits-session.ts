import { isPlatformBrowser, isPlatformServer } from '@angular/common';
import { DestroyRef, DOCUMENT, inject, Injectable, PLATFORM_ID } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { external, outcomes } from '../outcomes/outcomes';
import { QitsTokens } from './qits-tokens';

/**
 * Signed in means holding a valid (or refreshable) token. `provideQitsBearerSignIn` provides it.
 *
 * A visitor who is not signed in leaves for the idp through the declared outcome
 * `session-guard:signedOut`. No element triggers it, so it is `triggered: false`.
 *
 * Offline, the idp cannot load: a visitor without a usable token whom this device remembers
 * (`QitsTokens.user()`, an offline relaunch or an expired token) is let through, so the offline
 * store answers, and leaves through the same outcome, back to the current page, once the network
 * is back.
 */
@Injectable()
export class QitsSession {
  private readonly tokens = inject(QitsTokens);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly location = inject(DOCUMENT).location;
  private readonly guard = outcomes(
    'session-guard',
    { signedOut: external('idp') },
    { triggered: false },
  );
  /** The `online` listener is armed: at most once per session. */
  private armed = false;

  private readonly onOnline = () => {
    void this.tokens.accessToken().then((token) => {
      if (!token) this.signIn(`${this.location.pathname}${this.location.search}`);
    });
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.armed) window.removeEventListener('online', this.onOnline);
    });
  }

  /**
   * True when the visitor is signed in. Offline, also true for a visitor this device remembers,
   * who signs in once the network is back. Otherwise starts the sign-in, which comes back to `url`
   * on this page, and answers false.
   */
  async ensure(url: string): Promise<boolean> {
    if (await this.tokens.accessToken()) return true;
    if (browserOffline() && this.tokens.user()) {
      this.signInWhenOnline();
      return true;
    }
    this.signIn(url);
    return false;
  }

  /** Arms the one `online` listener: back online, a refresh or else the sign-in. */
  private signInWhenOnline(): void {
    if (this.armed || !this.browser) return;
    this.armed = true;
    window.addEventListener('online', this.onOnline, { once: true });
  }

  private signIn(url: string): void {
    void this.tokens.authorizeUrl(url).then((href) => {
      if (href) this.guard.signedOut.leave(href);
    });
  }
}

/** Whether the browser says it is offline, as the offline store asks. Unknown counts as online. */
function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Sends a visitor who is not signed in to sign in ({@link QitsSession}), which brings them back to
 * the route they asked for; offline, a visitor this device remembers passes and signs in once the
 * network is back. The server render passes: it holds no token, and the browser checks right
 * after.
 */
export const qitsSignedInGuard: CanActivateFn = (_route, state) => {
  if (isPlatformServer(inject(PLATFORM_ID))) return true;
  return inject(QitsSession).ensure(state.url);
};
