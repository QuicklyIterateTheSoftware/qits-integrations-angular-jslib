import { isPlatformBrowser, isPlatformServer } from '@angular/common';
import { DestroyRef, DOCUMENT, inject, Injectable, PLATFORM_ID } from '@angular/core';
import { Router, type CanActivateFn, type UrlTree } from '@angular/router';
import { recordOutcome } from '../outcomes/outcome-recorder';
import { exit, external, exitUrlTree, outcomes } from '../outcomes/outcomes';
import { QitsTokens, UNAVAILABLE_QUERY } from './qits-tokens';

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
 *
 * Online, an idp that does not answer the refresh (`QitsTokens.lastFailure()` is `unavailable`,
 * qits-2250) would not answer its authorize page either: leaving for it showed an empty 502. The
 * guard sends the visitor to `/auth/callback?error=temporarily_unavailable` instead, through the
 * declared outcome `session-guard:unavailable` (as a `UrlTree`, the guard's own redirect). That
 * route sits outside every guard, says the sign-in service cannot be reached, and its Start again
 * link reruns this guard, which retries the refresh with the tokens the outage kept.
 */
@Injectable()
export class QitsSession {
  private readonly tokens = inject(QitsTokens);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly location = inject(DOCUMENT).location;
  private readonly guard = outcomes(
    'session-guard',
    { signedOut: external('idp'), unavailable: exit('auth/callback') },
    { triggered: false },
  );
  private readonly router = inject(Router);
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
   * who signs in once the network is back. Online with the idp unavailable, the callback page's
   * `UrlTree` saying so. Otherwise starts the sign-in, which comes back to `url` on this page, and
   * answers false.
   */
  async ensure(url: string): Promise<boolean | UrlTree> {
    if (await this.tokens.accessToken()) return true;
    const offline = browserOffline();
    if (offline && this.tokens.user()) {
      this.signInWhenOnline();
      return true;
    }
    if (!offline && this.tokens.lastFailure() === 'unavailable') return this.unavailable();
    this.signIn(url);
    return false;
  }

  /**
   * `session-guard:unavailable` as the guard answers it: a `UrlTree`, which the router follows in
   * place of the refused navigation, so the outcome is recorded here rather than by `go()`.
   */
  private unavailable(): UrlTree {
    const entry = this.guard.unavailable;
    const tree = exitUrlTree(this.router, entry.url(), { queryParams: UNAVAILABLE_QUERY });
    recordOutcome({
      interaction: entry.interaction,
      outcome: entry.outcome,
      kind: entry.kind,
      to: entry.to,
      url: this.router.serializeUrl(tree),
    });
    return tree;
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
 * network is back. Online with the idp down, it redirects to the callback page saying so. The
 * server render passes: it holds no token, and the browser checks right after.
 */
export const qitsSignedInGuard: CanActivateFn = (_route, state) => {
  if (isPlatformServer(inject(PLATFORM_ID))) return true;
  return inject(QitsSession).ensure(state.url);
};
