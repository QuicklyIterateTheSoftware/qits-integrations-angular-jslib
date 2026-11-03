import { isPlatformBrowser } from '@angular/common';
import { DOCUMENT, inject, InjectionToken, PLATFORM_ID } from '@angular/core';

/** What `provideQitsBearerSignIn` takes. */
export interface QitsBearerSignInOptions {
  /**
   * The idp's public PKCE client: `qits-spa` for a page deployed under the platform domain,
   * `qits-landing-dev` under `ng serve` (its only redirect is
   * `http://{localhost|127.0.0.1|[::1]}:<port>/auth/callback`).
   */
  readonly clientId: string;
  /**
   * The platform domain, e.g. `qits.example.com`: the landing app answers at its apex, every other
   * application at `<label>.<domain>`. Leave it out on a deployed page: it is then read from the
   * page's hostname ({@link platformDomainOf}). Set it under `ng serve`, where the page is on
   * localhost.
   */
  readonly platformDomain?: string | null;
  /** The idp's origin, no trailing slash. Default `https://idp.<platform domain>`. */
  readonly idpOrigin?: string | null;
  /**
   * Put `auth/callback` ({@link QitsAuthCallbackPage}) in front of the app's routes. Default true;
   * false when the app places `qitsAuthCallbackRoute` itself.
   */
  readonly callbackRoute?: boolean;
}

/** The sign-in's settings, resolved for this page. */
export interface QitsSignInSettings {
  readonly clientId: string;
  /** The platform domain; `''` on the server when none was given. */
  readonly platformDomain: string;
  /** The idp's origin, no trailing slash; `''` when there is no platform domain. */
  readonly idpOrigin: string;
}

/** The route the idp sends the visitor back to; the redirect URI is `<page origin>/auth/callback`. */
export const CALLBACK_PATH = '/auth/callback';

/** The sign-in's settings. `provideQitsBearerSignIn` provides it; a spec may give its own. */
export const QITS_SIGN_IN = new InjectionToken<QitsSignInSettings>('QITS_SIGN_IN');

/**
 * The platform domain a page at `hostname` belongs to. The landing app is served at the apex,
 * `qits.<domain>`; every other platform page at `<label>.qits.<domain>`. So a hostname whose first
 * label is `qits` is the apex itself, and any other loses its first label.
 */
export function platformDomainOf(hostname: string): string {
  const labels = hostname.split('.');
  if (labels.length < 2 || labels[0] === 'qits') return hostname;
  return labels.slice(1).join('.');
}

/** Resolves the options against this page (`provideQitsBearerSignIn`'s factory for {@link QITS_SIGN_IN}). */
export function resolveSignInSettings(options: QitsBearerSignInOptions): QitsSignInSettings {
  if (!options.clientId) throw new Error('provideQitsBearerSignIn needs a clientId.');
  const browser = isPlatformBrowser(inject(PLATFORM_ID));
  const hostname = browser ? inject(DOCUMENT).location.hostname : '';
  const platformDomain = options.platformDomain || (hostname ? platformDomainOf(hostname) : '');
  const idpOrigin = (
    options.idpOrigin || (platformDomain ? `https://idp.${platformDomain}` : '')
  ).replace(/\/+$/, '');
  return { clientId: options.clientId, platformDomain, idpOrigin };
}

/**
 * True for a URL that gets the bearer: this page's own origin (a relative URL included), or an
 * `https` host that is the platform domain or a name under it. Nothing else ever sees the token.
 */
export function isPlatformUrl(url: string, base: string, platformDomain: string): boolean {
  let target: URL;
  let page: URL;
  try {
    page = new URL(base);
    target = new URL(url, page);
  } catch {
    return false;
  }
  if (target.origin === page.origin) return true;
  if (!platformDomain || target.protocol !== 'https:') return false;
  const host = target.hostname;
  return host === platformDomain || host.endsWith(`.${platformDomain}`);
}
