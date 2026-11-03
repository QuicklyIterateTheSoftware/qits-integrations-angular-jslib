import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  DOCUMENT,
  inject,
  Injectable,
  InjectionToken,
  PLATFORM_ID,
} from '@angular/core';
import { randomToken, s256Challenge } from './pkce';
import { CALLBACK_PATH, QITS_SIGN_IN } from './sign-in-settings';

/** Refresh this long before the access token expires. */
export const REFRESH_AHEAD_MS = 60_000;

/** An access token this close to its end counts as expired: a call must not arrive late. */
export const EXPIRY_SKEW_MS = 10_000;

/** Where the tokens survive a reload: this tab only, one entry per client. */
export function tokensKey(clientId: string): string {
  return `qits.sign-in.${clientId}.tokens`;
}

/** One sign-in in progress, by its `state`: the PKCE verifier and the path to go back to. */
export function pendingKey(clientId: string, state: string): string {
  return `qits.sign-in.${clientId}.pkce.${state}`;
}

/**
 * The `fetch` the sign-in's own calls use (the idp's token endpoint, `QitsBearerFetch`); a spec
 * gives its own. It reads the global at call time, so a wrapper installed later (telemetry) is used.
 */
export const QITS_SIGN_IN_FETCH = new InjectionToken<typeof fetch>('QITS_SIGN_IN_FETCH', {
  providedIn: 'root',
  factory: () => (input, init) => fetch(input, init),
});

interface Tokens {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly accessExpiresAt: number;
  readonly refreshToken: string | null;
  /** Epoch milliseconds; {@link Number.MAX_SAFE_INTEGER} when the idp named no end. */
  readonly refreshExpiresAt: number;
}

interface Pending {
  readonly verifier: string;
  readonly returnPath: string;
}

/** The idp's token answer, as far as this reads it. */
interface TokenAnswer {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly refresh_token?: unknown;
  readonly refresh_expires_in?: unknown;
}

/**
 * The bearer sign-in (epic qits-543; first written for `ng serve` in epic qits-112): the idp's
 * authorization-code flow with PKCE for the public client the settings name (`QITS_SIGN_IN`).
 *
 * - `login(path)` starts the authorization-code flow with PKCE: the verifier goes into
 *   `sessionStorage` under the flow's `state`, and the tab navigates to the idp's authorize page.
 *   It starts at most one flow per page.
 * - `complete(query)` (the `/auth/callback` page) checks the `state`, swaps the code for tokens and
 *   answers the path to go back to. A `state` this tab did not start is refused.
 * - `accessToken()` answers a token that is still valid, refreshing first when it is not.
 * - `refresh()` swaps the refresh token for new tokens. The idp rotates the refresh token on every
 *   use and revokes the whole family when one is used twice, so there is only ever one refresh in
 *   flight: a second caller gets the first one's answer.
 * - The tokens live in memory and in `sessionStorage`, so a reload keeps them. A refresh runs on
 *   its own {@link REFRESH_AHEAD_MS} before the access token expires.
 * - `logout()` forgets the tokens.
 */
@Injectable()
export class QitsTokens {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly location = inject(DOCUMENT).location;
  private readonly settings = inject(QITS_SIGN_IN);
  private readonly idp = this.settings.idpOrigin;
  private readonly clientId = this.settings.clientId;
  private readonly tokensKey = tokensKey(this.clientId);
  private readonly fetch = inject(QITS_SIGN_IN_FETCH);

  private tokens: Tokens | null = null;
  private inflight: Promise<string | null> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private redirecting = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    if (!this.browser) return;
    const stored = read<Tokens>(this.tokensKey);
    if (stored) this.keep(stored);
  }

  private get redirectUri(): string {
    return `${this.location.origin}${CALLBACK_PATH}`;
  }

  /** Starts a sign-in that comes back to `returnPath`. Once per page: later calls do nothing. */
  async login(returnPath: string): Promise<void> {
    if (!this.browser || this.redirecting || !this.idp) return;
    this.redirecting = true;
    const state = randomToken(16);
    const verifier = randomToken();
    write(pendingKey(this.clientId, state), { verifier, returnPath } satisfies Pending);
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code_challenge: await s256Challenge(verifier),
      code_challenge_method: 'S256',
      state,
    });
    this.location.assign(`${this.idp}/idp/authorize?${query}`);
  }

  /**
   * Finishes a sign-in that came back to `/auth/callback` (`QitsAuthCallbackPage`): takes the
   * callback's query, answers the path to go on to, or throws.
   */
  async complete(query: URLSearchParams): Promise<string> {
    const state = query.get('state') ?? '';
    const key = pendingKey(this.clientId, state);
    const pending = state ? read<Pending>(key) : null;
    if (state) remove(key);
    const error = query.get('error');
    if (error) {
      throw new Error(
        `The idp refused the sign-in: ${error} ${query.get('error_description') ?? ''}`,
      );
    }
    if (!pending) throw new Error('The sign-in came back with a state this tab did not start.');
    const code = query.get('code');
    if (!code) throw new Error('The sign-in came back without a code.');
    const answer = await this.post({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    });
    if (!answer) throw new Error('The idp did not swap the code for tokens.');
    return pending.returnPath;
  }

  /** A valid access token, refreshed first when needed; null when there is no way to get one. */
  async accessToken(): Promise<string | null> {
    const tokens = this.tokens;
    if (!tokens) return null;
    if (fresh(tokens)) return tokens.accessToken;
    return this.refresh();
  }

  /**
   * A token to retry with after `used` got a 401: the current one when a refresh already replaced
   * `used`, else a fresh one. Null when the refresh fails.
   */
  async retryToken(used: string | null): Promise<string | null> {
    const tokens = this.tokens;
    if (tokens && tokens.accessToken !== used && fresh(tokens)) return tokens.accessToken;
    return this.refresh();
  }

  /** Swaps the refresh token for new tokens. One at a time; null when it fails. */
  refresh(): Promise<string | null> {
    this.inflight ??= this.runRefresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** Forgets the tokens, here and in `sessionStorage`. */
  logout(): void {
    clearTimeout(this.timer);
    this.tokens = null;
    if (this.browser) remove(this.tokensKey);
  }

  private async runRefresh(): Promise<string | null> {
    const tokens = this.tokens;
    if (!tokens?.refreshToken || tokens.refreshExpiresAt <= Date.now()) {
      this.logout();
      return null;
    }
    const answer = await this.post({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: tokens.refreshToken,
    });
    return answer?.accessToken ?? null;
  }

  /** One form POST to the token endpoint, without credentials. Keeps what it answers. */
  private async post(form: Record<string, string>): Promise<Tokens | null> {
    let response: Response;
    try {
      response = await this.fetch(`${this.idp}/idp/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
    } catch {
      return null;
    }
    if (!response.ok) {
      // The idp refused the grant (spent, revoked or expired): nothing left to refresh with.
      if (response.status >= 400 && response.status < 500) this.logout();
      return null;
    }
    const tokens = parse((await response.json()) as TokenAnswer, this.tokens);
    if (!tokens) return null;
    this.keep(tokens);
    write(this.tokensKey, tokens);
    return tokens;
  }

  private keep(tokens: Tokens): void {
    clearTimeout(this.timer);
    if (!tokens.refreshToken && tokens.accessExpiresAt <= Date.now()) {
      this.logout();
      return;
    }
    this.tokens = tokens;
    if (!tokens.refreshToken) return;
    const wait = Math.max(0, tokens.accessExpiresAt - REFRESH_AHEAD_MS - Date.now());
    this.timer = setTimeout(() => void this.refresh(), wait);
  }
}

function fresh(tokens: Tokens): boolean {
  return tokens.accessExpiresAt - EXPIRY_SKEW_MS > Date.now();
}

/** The idp's answer as {@link Tokens}; a refresh answer without a new refresh token keeps the old. */
function parse(answer: TokenAnswer, previous: Tokens | null): Tokens | null {
  if (typeof answer.access_token !== 'string' || typeof answer.expires_in !== 'number') return null;
  const now = Date.now();
  const refreshToken =
    typeof answer.refresh_token === 'string'
      ? answer.refresh_token
      : (previous?.refreshToken ?? null);
  const refreshExpiresAt =
    typeof answer.refresh_expires_in === 'number'
      ? now + answer.refresh_expires_in * 1000
      : (previous?.refreshExpiresAt ?? Number.MAX_SAFE_INTEGER);
  return {
    accessToken: answer.access_token,
    accessExpiresAt: now + answer.expires_in * 1000,
    refreshToken,
    refreshExpiresAt,
  };
}

function read<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage off: the tokens still live in memory until a reload.
  }
}

function remove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Storage off: nothing was kept.
  }
}
