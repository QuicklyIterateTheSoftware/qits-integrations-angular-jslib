import { isPlatformServer } from '@angular/common';
import {
  HttpErrorResponse,
  type HttpEvent,
  type HttpHandlerFn,
  type HttpInterceptorFn,
  type HttpRequest,
} from '@angular/common/http';
import { DOCUMENT, inject, Injector, PLATFORM_ID } from '@angular/core';
import { catchError, from, Observable, switchMap, throwError } from 'rxjs';
import { QitsTokens } from './qits-tokens';
import { QitsSessionExpiry } from './session-expiry';
import { isPlatformUrl, QITS_SIGN_IN } from './sign-in-settings';

/**
 * Puts `Authorization: Bearer` on every call to a platform URL (`isPlatformUrl`: this page's own
 * origin, or an `https` host under the platform domain), and on nothing else. A 401 gets one
 * refresh and one retry; when there is nothing to refresh with, the visitor leaves for the idp to
 * sign in, back to this page, through the declared outcome `session-expired:signedOut`
 * ({@link QitsSessionExpiry}).
 *
 * `HttpClient` takes functional interceptors only through `provideHttpClient`, so this is the one
 * piece `provideQitsBearerSignIn` cannot wire: add it there,
 * `provideHttpClient(withFetch(), withInterceptors([qitsBearerInterceptor]))`.
 */
export const qitsBearerInterceptor: HttpInterceptorFn = (req, next) => {
  if (isPlatformServer(inject(PLATFORM_ID))) return next(req);
  const injector = inject(Injector);
  const location = inject(DOCUMENT).location;
  const { platformDomain } = inject(QITS_SIGN_IN);
  if (!isPlatformUrl(req.url, location.href, platformDomain)) return next(req);
  const tokens = inject(QitsTokens);

  let used: string | null = null;
  return from(tokens.accessToken()).pipe(
    switchMap((token) => {
      used = token;
      return send(req, token, next);
    }),
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }
      return from(tokens.retryToken(used)).pipe(
        switchMap((fresh) => {
          if (fresh) return send(req, fresh, next);
          // Resolved here, not above: its outcomes() inject the Router, which only this path needs.
          injector.get(QitsSessionExpiry).signIn();
          return throwError(() => error);
        }),
      );
    }),
  );
};

function send(
  req: HttpRequest<unknown>,
  token: string | null,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> {
  return next(token ? req.clone({ setHeaders: { authorization: `Bearer ${token}` } }) : req);
}
