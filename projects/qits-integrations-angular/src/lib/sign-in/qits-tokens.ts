import { isPlatformBrowser } from '@angular/common';
import {
  DestroyRef,
  DOCUMENT,
  inject,
  Injectable,
  InjectionToken,
  PLATFORM_ID,
  signal,
  type Signal,
} from '@angular/core';
import { randomToken, s256Challenge } from './pkce';
import { CALLBACK_PATH, QITS_SIGN_IN } from './sign-in-settings';

/** Refresh this long before the access token expires. */
export const REFRESH_AHEAD_MS = 60_000;

/** An access token this close to its end counts as expired: a call must not arrive late. */
export const EXPIRY_SKEW_MS = 10_000;

/**
 * How long a token request may take before it counts as the idp being unavailable (qits-2250).
 * Without it a hanging idp left `accessToken()`, and the guard waiting on it, pending for good.
 */
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** Where the tokens survive a reload: this tab only, one entry per client. */
export function tokensKey(clientId: string): string {
  return `qits.sign-in.${clientId}.tokens`;
}

/**
 * Who signed in last on this device, one entry per client: the access token's `sub` alone, in
 * `localStorage`, so an offline relaunch still knows whose store to open. Never a token.
 */
export function userKey(clientId: string): string {
  return `qits.sign-in.${clientId}.user`;
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

/**
 * The callback query that says the idp is down (qits-2250): RFC 6749's `temporarily_unavailable`.
 * The idp may send it itself; `QitsSession` and `QitsSessionExpiry` send it to `/auth/callback`
 * in-app when a refresh found the idp unavailable, so `complete()` throws the `unavailable` failure
 * and the callback page says so, rather than leaving for an authorize page that cannot load.
 */
export const UNAVAILABLE_QUERY = { error: 'temporarily_unavailable' } as const;

/**
 * Why `complete()` refused: the idp's query, this tab's own state, or the code swap. `unavailable`
 * (qits-2250) is the idp not answering at all (a 5xx, a failed or timed-out request, or the idp's
 * own `temporarily_unavailable`): nothing was wrong with the sign-in, so trying again later helps.
 */
export type QitsSignInFailure =
  'refused' | 'unknown-state' | 'no-code' | 'not-swapped' | 'unavailable';

/**
 * Why the last refresh issued no tokens (`QitsTokens.lastFailure()`, qits-2250). `refused`: there
 * was nothing to refresh with, or the idp answered and issued nothing, so signing in again is the
 * way on. `unavailable`: the idp did not answer (a 5xx, a failed request, or none within
 * {@link TOKEN_REQUEST_TIMEOUT_MS}), so the tokens are kept for the next try, and sending the
 * visitor to its authorize page would only show them the same outage as a blank error page.
 */
export type QitsTokenFailure = 'refused' | 'unavailable';

/** A sign-in that `complete()` could not finish, with the reason a caller can show. */
export class QitsSignInError extends Error {
  constructor(
    readonly reason: QitsSignInFailure,
    message: string,
  ) {
    super(message);
    this.name = 'QitsSignInError';
  }
}

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
 *   It starts at most one flow per page. `authorizeUrl(path)` is its first half: it starts the flow
 *   and answers the authorize page's URL, leaving the navigation to the caller (`QitsSession` and
 *   `QitsSessionExpiry` leave through their declared outcomes).
 * - `complete(query)` (the `/auth/callback` page) checks the `state`, swaps the code for tokens and
 *   answers the path to go back to. A `state` this tab did not start is refused. Every failure
 *   throws a {@link QitsSignInError} naming the {@link QitsSignInFailure} reason.
 * - `accessToken()` answers a token that is still valid, refreshing first when it is not.
 * - `lastFailure()` says why the last refresh issued no tokens: `refused` (sign in again) or
 *   `unavailable` (the idp did not answer; the tokens are kept for the next try). The guard and the
 *   session expiry read it so as not to send a visitor to an idp that is down; the token answers
 *   themselves stay `string | null`, so the bearer callers need not know. A code swap reports its
 *   own failure as a {@link QitsSignInError} instead.
 * - `refresh()` swaps the refresh token for new tokens. The idp rotates the refresh token on every
 *   use and revokes the whole family when one is used twice, so there is only ever one refresh in
 *   flight: a second caller gets the first one's answer.
 * - The tokens live in memory and in `sessionStorage` (this tab), so a reload keeps them and a
 *   relaunch does not. A refresh runs on its own {@link REFRESH_AHEAD_MS} before the access token
 *   expires. The access token's `sub` alone is also remembered in `localStorage` ({@link userKey})
 *   whenever the idp issues tokens; the next user's sign-in replaces it.
 * - `logout()` forgets the tokens, not the remembered `sub`. It runs on its own when the idp
 *   refuses a refresh, so it is not a sign-out: the offline store (`QitsOffline.signOut`) stays
 *   where it is.
 * - `subject()` is the access token's `sub` claim, and `renewals()` counts the tokens the idp has
 *   issued on this page (a sign-in or a refresh): the offline outbox resumes on it after a 401.
 * - `user()` is `subject()` while a token is held, else the remembered `sub`: who the offline store
 *   belongs to on a relaunch without tokens. `forgetUser()` forgets it (`QitsOffline.signOut`).
 */
@Injectable()
export class QitsTokens {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly location = inject(DOCUMENT).location;
  private readonly settings = inject(QITS_SIGN_IN);
  private readonly idp = this.settings.idpOrigin;
  private readonly clientId = this.settings.clientId;
  private readonly tokensKey = tokensKey(this.clientId);
  private readonly userKey = userKey(this.clientId);
  private readonly fetch = inject(QITS_SIGN_IN_FETCH);

  private tokens: Tokens | null = null;
  private inflight: Promise<string | null> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private redirecting = false;
  readonly #accessToken = signal<string | null>(null);
  readonly #renewals = signal(0);
  readonly #remembered = signal<string | null>(null);
  readonly #lastFailure = signal<QitsTokenFailure | null>(null);

  /**
   * How many times the idp issued tokens on this page, a sign-in or a refresh. Tokens read back
   * from `sessionStorage` do not count.
   */
  readonly renewals: Signal<number> = this.#renewals.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    if (!this.browser) return;
    this.#remembered.set(readLocal(this.userKey));
    const stored = read<Tokens>(this.tokensKey);
    if (stored) this.keep(stored);
  }

  private get redirectUri(): string {
    return `${this.location.origin}${CALLBACK_PATH}`;
  }

  /** Starts a sign-in that comes back to `returnPath`. Once per page: later calls do nothing. */
  async login(returnPath: string): Promise<void> {
    const url = await this.authorizeUrl(returnPath);
    if (url) this.location.assign(url);
  }

  /**
   * Starts a sign-in that comes back to `returnPath` and answers the idp's authorize URL for the
   * caller to leave for. Null outside a browser, without an idp, and once a sign-in has started on
   * this page (once per page, as {@link login}).
   */
  async authorizeUrl(returnPath: string): Promise<string | null> {
    if (!this.browser || this.redirecting || !this.idp) return null;
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
    return `${this.idp}/idp/authorize?${query}`;
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
    if (error === UNAVAILABLE_QUERY.error) {
      throw new QitsSignInError('unavailable', 'The idp is temporarily unavailable.');
    }
    if (error) {
      throw new QitsSignInError(
        'refused',
        `The idp refused the sign-in: ${error} ${query.get('error_description') ?? ''}`,
      );
    }
    if (!pending) {
      throw new QitsSignInError(
        'unknown-state',
        'The sign-in came back with a state this tab did not start.',
      );
    }
    const code = query.get('code');
    if (!code) throw new QitsSignInError('no-code', 'The sign-in came back without a code.');
    const answer = await this.post({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      code,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier,
    });
    if (answer === 'unavailable') {
      throw new QitsSignInError('unavailable', 'The idp did not answer the code swap.');
    }
    if (typeof answer === 'string') {
      throw new QitsSignInError('not-swapped', 'The idp did not swap the code for tokens.');
    }
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

  /**
   * Why the last refresh issued no tokens; null before one failed, once the idp issues tokens
   * again, and after {@link logout}. `unavailable` therefore means tokens are still held, so the
   * next {@link accessToken} tries again: an unavailable code swap is not recorded here, or a
   * visitor holding no tokens would be told of an outage without the idp ever being asked again.
   * A signal read.
   */
  lastFailure(): QitsTokenFailure | null {
    return this.#lastFailure();
  }

  /** Swaps the refresh token for new tokens. One at a time; null when it fails. */
  refresh(): Promise<string | null> {
    this.inflight ??= this.runRefresh().finally(() => (this.inflight = null));
    return this.inflight;
  }

  /**
   * The `sub` claim of the access token held now, decoded without verification (the token is
   * only ever checked by the services it is sent to); null with no token or no claim. A signal
   * read, so it is reactive.
   */
  subject(): string | null {
    const token = this.#accessToken();
    return token ? subjectOf(token) : null;
  }

  /**
   * Who is signed in on this device: {@link subject} while a token is held, else the `sub` the idp
   * last issued tokens for here (an offline relaunch, a refused refresh); null when neither. A
   * signal read, so it is reactive.
   */
  user(): string | null {
    return this.subject() ?? this.#remembered();
  }

  /** Forgets the remembered `sub`, here and in `localStorage` (`QitsOffline.signOut`). */
  forgetUser(): void {
    this.#remembered.set(null);
    if (this.browser) removeLocal(this.userKey);
  }

  /** Forgets the tokens, here and in `sessionStorage`. The remembered `sub` stays. */
  logout(): void {
    clearTimeout(this.timer);
    this.tokens = null;
    this.#lastFailure.set(null);
    this.#accessToken.set(null);
    if (this.browser) remove(this.tokensKey);
  }

  private async runRefresh(): Promise<string | null> {
    const tokens = this.tokens;
    if (!tokens?.refreshToken || tokens.refreshExpiresAt <= Date.now()) {
      // Nothing to refresh with: no idp could help, so it is a refusal, not an outage.
      this.logout();
      this.#lastFailure.set('refused');
      return null;
    }
    const answer = await this.post({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: tokens.refreshToken,
    });
    if (typeof answer !== 'string') return answer.accessToken;
    this.#lastFailure.set(answer);
    return null;
  }

  /** One form POST to the token endpoint, without credentials. Keeps what it answers. */
  private async post(form: Record<string, string>): Promise<Tokens | QitsTokenFailure> {
    const answer = await this.request(form);
    if (typeof answer !== 'string') {
      this.#lastFailure.set(null);
      this.keep(answer);
      write(this.tokensKey, answer);
      this.remember(answer.accessToken);
      this.#renewals.update((n) => n + 1);
      return answer;
    }
    // The idp refused the grant (spent, revoked or expired): nothing left to refresh with. An
    // unavailable idp, or a 2xx without tokens, is no verdict on the refresh token: it is kept.
    if (answer === 'refused') this.logout();
    return answer === 'unavailable' ? 'unavailable' : 'refused';
  }

  /**
   * The POST itself, read as tokens or as what went wrong. A 4xx is the idp's refusal. A 5xx (its
   * gateway's 502 included), a rejected `fetch` and one still unanswered after
   * {@link TOKEN_REQUEST_TIMEOUT_MS} (the signal aborts it, the body's read too) are the idp being
   * unavailable. A 2xx without tokens in it (not JSON, fields missing) is `no-tokens`: the idp
   * answered, so it is no outage, but it did not refuse the grant either.
   */
  private async request(
    form: Record<string, string>,
  ): Promise<Tokens | 'refused' | 'unavailable' | 'no-tokens'> {
    const signal = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetch(`${this.idp}/idp/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal,
      });
    } catch {
      return 'unavailable';
    }
    if (response.status >= 400 && response.status < 500) return 'refused';
    if (!response.ok) return 'unavailable';
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return signal.aborted ? 'unavailable' : 'no-tokens';
    }
    return parse(body as TokenAnswer, this.tokens) ?? 'no-tokens';
  }

  /** Remembers the `sub` of a token the idp issued, for {@link user}; none changes nothing. */
  private remember(accessToken: string): void {
    const sub = subjectOf(accessToken);
    if (!sub || !this.browser) return;
    this.#remembered.set(sub);
    writeLocal(this.userKey, sub);
  }

  private keep(tokens: Tokens): void {
    clearTimeout(this.timer);
    if (!tokens.refreshToken && tokens.accessExpiresAt <= Date.now()) {
      this.logout();
      return;
    }
    this.tokens = tokens;
    this.#accessToken.set(tokens.accessToken);
    if (!tokens.refreshToken) return;
    const wait = Math.max(0, tokens.accessExpiresAt - REFRESH_AHEAD_MS - Date.now());
    this.timer = setTimeout(() => void this.refresh(), wait);
  }
}

/** The `sub` claim of a JWT's payload, unverified; null when it does not decode. */
function subjectOf(token: string): string | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (c) =>
        c.charCodeAt(0),
      ),
    );
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub ? sub : null;
  } catch {
    return null;
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

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage off: the user is known on this page only.
  }
}

function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage off: nothing was kept.
  }
}
