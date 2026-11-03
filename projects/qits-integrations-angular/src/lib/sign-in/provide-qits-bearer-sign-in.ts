import {
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
  type EnvironmentProviders,
  type Provider,
} from '@angular/core';
import { Router } from '@angular/router';
import { qitsAuthCallbackRoute } from './auth-callback.page';
import { QitsBearerFetch } from './bearer-fetch';
import { BearerWebSocket, QITS_WEB_SOCKET, type WebSocketLike } from './bearer-web-socket';
import { FetchEventSource, QITS_EVENT_SOURCE } from './fetch-event-source';
import { QitsSession } from './qits-session';
import { QitsTokens } from './qits-tokens';
import {
  QITS_SIGN_IN,
  resolveSignInSettings,
  type QitsBearerSignInOptions,
} from './sign-in-settings';

/**
 * The bearer sign-in for a platform page (epic qits-543): OIDC authorization code with PKCE against
 * the idp's public client `options.clientId`, the bearer on every platform call, the event stream
 * through `fetch()` with the bearer, WebSockets with the bearer as a subprotocol.
 *
 * - {@link QitsTokens}: the flow, the token store (`sessionStorage`, this tab), the refresh ahead
 *   of expiry, one refresh in flight.
 * - {@link QitsSession} (and `qitsSignedInGuard`): signed in means holding a usable token.
 * - `auth/callback` ({@link QitsAuthCallbackPage}) in front of the app's routes, unless
 *   `callbackRoute: false`. The redirect URI is `<page origin>/auth/callback`.
 * - {@link QITS_EVENT_SOURCE} opens a {@link FetchEventSource}; {@link QITS_WEB_SOCKET} a
 *   {@link BearerWebSocket}.
 * - {@link QitsBearerFetch}: `fetch()` with the bearer, and object URLs for `<img>`s and downloads.
 *
 * Not wired here, because `HttpClient` takes it only there: add `qitsBearerInterceptor` to
 * `provideHttpClient(withFetch(), withInterceptors([qitsBearerInterceptor]))`.
 */
export function provideQitsBearerSignIn(options: QitsBearerSignInOptions): EnvironmentProviders {
  const providers: (Provider | EnvironmentProviders)[] = [
    { provide: QITS_SIGN_IN, useFactory: () => resolveSignInSettings(options) },
    QitsTokens,
    QitsSession,
    QitsBearerFetch,
    {
      provide: QITS_EVENT_SOURCE,
      useFactory: () => {
        const tokens = inject(QitsTokens);
        return (url: string) => new FetchEventSource(url, () => tokens.accessToken());
      },
    },
    {
      provide: QITS_WEB_SOCKET,
      useFactory: () => {
        const tokens = inject(QitsTokens);
        return (url: string, protocols?: string[]) =>
          new BearerWebSocket(
            url,
            () => tokens.accessToken(),
            (to, offered) => new WebSocket(to, offered) as WebSocketLike,
            protocols,
          );
      },
    },
  ];
  if (options.callbackRoute !== false) {
    providers.push(provideEnvironmentInitializer(prependCallbackRoute));
  }
  return makeEnvironmentProviders(providers);
}

/**
 * Puts `auth/callback` first in the router's config, so no guard, no `''` shell and no `**` of the
 * app's own comes before it. Runs before the initial navigation; an app without a router, or whose
 * config already has the route at the top, is left as it is.
 */
function prependCallbackRoute(): void {
  const router = inject(Router, { optional: true });
  if (!router || router.config.some((route) => route.path === qitsAuthCallbackRoute.path)) return;
  router.resetConfig([qitsAuthCallbackRoute, ...router.config]);
}
