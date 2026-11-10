import { DOCUMENT, inject, Injectable } from '@angular/core';
import { QITS_SIGN_IN_FETCH, QitsTokens } from './qits-tokens';
import { QitsSessionExpiry } from './session-expiry';
import { isPlatformUrl, QITS_SIGN_IN } from './sign-in-settings';

/**
 * `fetch()` with the bearer, for what cannot go through `HttpClient` or cannot send a header at
 * all: an `<img>` of a role-guarded route, a download behind a plain link, HTML for an iframe's
 * `srcdoc`. Same rules as `qitsBearerInterceptor`: the bearer only to a platform URL, one refresh
 * and one retry on a 401, then the sign-in, through the declared outcome `session-expired:signedOut`
 * ({@link QitsSessionExpiry}). `provideQitsBearerSignIn` provides it.
 */
@Injectable()
export class QitsBearerFetch {
  private readonly tokens = inject(QitsTokens);
  private readonly fetchFn = inject(QITS_SIGN_IN_FETCH);
  private readonly document = inject(DOCUMENT);
  private readonly location = this.document.location;
  private readonly settings = inject(QITS_SIGN_IN);
  private readonly expiry = inject(QitsSessionExpiry);

  /** `fetch(url, init)`, with `Authorization: Bearer` when `url` is a platform URL. */
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (!isPlatformUrl(url, this.location.href, this.settings.platformDomain)) {
      return this.fetchFn(url, init);
    }
    const used = await this.tokens.accessToken();
    const response = await this.fetchFn(url, withBearer(init, used));
    if (response.status !== 401) return response;
    const fresh = await this.tokens.retryToken(used);
    if (!fresh) {
      this.expiry.signIn();
      return response;
    }
    return this.fetchFn(url, withBearer(init, fresh));
  }

  /**
   * The body at `url` as an object URL (`URL.createObjectURL`), for an `<img src>` or a link's
   * `href`. Rejects when the answer is not 2xx. The caller owns the URL: revoke it
   * (`URL.revokeObjectURL`) when it is no longer shown.
   */
  async fetchObjectUrl(url: string): Promise<string> {
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return URL.createObjectURL(await response.blob());
  }

  /** Saves the body at `url` as a file named `fileName`, as a download link would. */
  async download(url: string, fileName: string): Promise<void> {
    const objectUrl = await this.fetchObjectUrl(url);
    try {
      const link = this.document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl));
    }
  }
}

function withBearer(init: RequestInit, token: string | null): RequestInit {
  if (!token) return init;
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
}
