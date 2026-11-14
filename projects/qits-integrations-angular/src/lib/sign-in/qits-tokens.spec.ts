import { DOCUMENT, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { s256Challenge } from './pkce';
import {
  pendingKey,
  QITS_SIGN_IN_FETCH,
  QitsSignInError,
  QitsTokens,
  REFRESH_AHEAD_MS,
  TOKEN_REQUEST_TIMEOUT_MS,
  tokensKey,
  userKey,
} from './qits-tokens';
import { QITS_SIGN_IN } from './sign-in-settings';

const CLIENT_ID = 'qits-landing-dev';
const TOKENS_KEY = tokensKey(CLIENT_ID);
const PENDING_PREFIX = pendingKey(CLIENT_ID, '');
const USER_KEY = userKey(CLIENT_ID);

/** An unsigned JWT with the `sub` claim, as the idp's access token carries it. */
function jwt(sub: string): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'RS256' })}.${part({ sub, exp: 4102444800 })}.signature`;
}

/** The idp's token answer, as the idp sends it (fields per the idp's `/idp/token`). */
function answer(access: string, refresh: string, expiresIn = 900): Response {
  return new Response(
    JSON.stringify({
      access_token: access,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refresh,
      refresh_expires_in: 720 * 3600,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('QitsTokens', () => {
  const assign = vi.fn();
  let posts: { url: string; form: URLSearchParams; init: RequestInit }[];
  let replies: (() => Promise<Response>)[];

  function tokens(): QitsTokens {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: 'browser' },
        {
          provide: DOCUMENT,
          useValue: { location: { assign, origin: 'http://localhost:4200' } },
        },
        {
          provide: QITS_SIGN_IN,
          useValue: {
            clientId: CLIENT_ID,
            platformDomain: 'qits.example',
            idpOrigin: 'https://idp.qits.example',
          },
        },
        {
          provide: QITS_SIGN_IN_FETCH,
          useValue: (url: string, init: RequestInit) => {
            posts.push({ url, form: new URLSearchParams(String(init.body)), init });
            const reply = replies.shift();
            if (!reply) throw new Error('no reply queued');
            return reply();
          },
        },
        QitsTokens,
      ],
    });
    return TestBed.inject(QitsTokens);
  }

  /** Starts a sign-in and answers the `state` it sent to the idp. */
  async function login(service: QitsTokens, path = '/projects'): Promise<URL> {
    await service.login(path);
    return new URL(assign.mock.calls.at(-1)?.[0] as string);
  }

  /** Signs in completely: login, callback, code swap. */
  async function signIn(service: QitsTokens, access = 'A1', refresh = 'R1'): Promise<void> {
    const authorize = await login(service);
    replies.push(async () => answer(access, refresh));
    await service.complete(
      new URLSearchParams({ code: 'C', state: authorize.searchParams.get('state') ?? '' }),
    );
  }

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    assign.mockReset();
    posts = [];
    replies = [];
  });

  afterEach(() => localStorage.clear());

  it('sends the visitor to the authorize page with an S256 challenge of the kept verifier', async () => {
    const authorize = await login(tokens(), '/projects/qits/work');
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://idp.qits.example/idp/authorize',
    );
    const query = authorize.searchParams;
    expect(query.get('response_type')).toBe('code');
    expect(query.get('client_id')).toBe(CLIENT_ID);
    expect(query.get('redirect_uri')).toBe('http://localhost:4200/auth/callback');
    expect(query.get('code_challenge_method')).toBe('S256');
    const pending = JSON.parse(sessionStorage.getItem(PENDING_PREFIX + query.get('state')) ?? '{}');
    expect(pending.returnPath).toBe('/projects/qits/work');
    expect(query.get('code_challenge')).toBe(await s256Challenge(pending.verifier));
  });

  it('starts one sign-in per page', async () => {
    const service = tokens();
    await service.login('/a');
    await service.login('/b');
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('answers the authorize URL without leaving, once per page, and login then has nothing to start', async () => {
    const service = tokens();
    const url = await service.authorizeUrl('/projects/qits');
    expect(assign).not.toHaveBeenCalled();
    const authorize = new URL(url ?? '');
    expect(`${authorize.origin}${authorize.pathname}`).toBe(
      'https://idp.qits.example/idp/authorize',
    );
    const pending = JSON.parse(
      sessionStorage.getItem(PENDING_PREFIX + authorize.searchParams.get('state')) ?? '{}',
    );
    expect(pending.returnPath).toBe('/projects/qits');
    expect(await service.authorizeUrl('/b')).toBeNull();
    await service.login('/c');
    expect(assign).not.toHaveBeenCalled();
  });

  it('swaps the code with the verifier, keeps the tokens and answers the path to go back to', async () => {
    const service = tokens();
    const authorize = await login(service, '/projects/qits');
    const state = authorize.searchParams.get('state') ?? '';
    const { verifier } = JSON.parse(sessionStorage.getItem(PENDING_PREFIX + state) ?? '{}');
    replies.push(async () => answer('A1', 'R1'));
    expect(await service.complete(new URLSearchParams({ code: 'C', state }))).toBe(
      '/projects/qits',
    );
    const [post] = posts;
    expect(post.url).toBe('https://idp.qits.example/idp/token');
    expect(post.init.credentials).toBeUndefined();
    expect(Object.fromEntries(post.form)).toEqual({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: 'C',
      redirect_uri: 'http://localhost:4200/auth/callback',
      code_verifier: verifier,
    });
    expect(await service.accessToken()).toBe('A1');
    expect(sessionStorage.getItem(PENDING_PREFIX + state)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? '{}').refreshToken).toBe('R1');
  });

  it('refuses a state this tab did not start, and a state used twice', async () => {
    const service = tokens();
    await expect(
      service.complete(new URLSearchParams({ code: 'C', state: 'forged' })),
    ).rejects.toMatchObject({ reason: 'unknown-state' } satisfies Partial<QitsSignInError>);
    const state = (await login(service)).searchParams.get('state') ?? '';
    replies.push(async () => answer('A1', 'R1'));
    await service.complete(new URLSearchParams({ code: 'C', state }));
    await expect(service.complete(new URLSearchParams({ code: 'C', state }))).rejects.toMatchObject(
      { reason: 'unknown-state' } satisfies Partial<QitsSignInError>,
    );
    expect(posts).toHaveLength(1);
  });

  it("reports the idp's refusal", async () => {
    const service = tokens();
    const state = (await login(service)).searchParams.get('state') ?? '';
    await expect(
      service.complete(new URLSearchParams({ error: 'access_denied', state })),
    ).rejects.toMatchObject({
      reason: 'refused',
      message: expect.stringContaining('access_denied') as unknown as string,
    } satisfies Partial<QitsSignInError>);
    expect(posts).toHaveLength(0);
  });

  it('reports the idp being temporarily unavailable as unavailable, not as a refusal', async () => {
    const service = tokens();
    await expect(
      service.complete(new URLSearchParams({ error: 'temporarily_unavailable' })),
    ).rejects.toMatchObject({ reason: 'unavailable' } satisfies Partial<QitsSignInError>);
    expect(posts).toHaveLength(0);
  });

  it('refuses a callback with no code', async () => {
    const service = tokens();
    const state = (await login(service)).searchParams.get('state') ?? '';
    await expect(service.complete(new URLSearchParams({ state }))).rejects.toMatchObject({
      reason: 'no-code',
    } satisfies Partial<QitsSignInError>);
    expect(posts).toHaveLength(0);
  });

  it('reports a code swap the idp refuses', async () => {
    const service = tokens();
    const state = (await login(service)).searchParams.get('state') ?? '';
    replies.push(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(service.complete(new URLSearchParams({ code: 'C', state }))).rejects.toMatchObject(
      { reason: 'not-swapped' } satisfies Partial<QitsSignInError>,
    );
  });

  it('reports a code swap the idp does not answer as unavailable', async () => {
    const service = tokens();
    const state = (await login(service)).searchParams.get('state') ?? '';
    replies.push(async () => new Response('Bad Gateway', { status: 502 }));
    await expect(service.complete(new URLSearchParams({ code: 'C', state }))).rejects.toMatchObject(
      { reason: 'unavailable' } satisfies Partial<QitsSignInError>,
    );
    // A swap's failure is the error's to report: no refresh failed.
    expect(service.lastFailure()).toBeNull();
  });

  it('reports a 2xx code swap answer that is not JSON', async () => {
    const service = tokens();
    const state = (await login(service)).searchParams.get('state') ?? '';
    replies.push(async () => new Response('not json', { status: 200 }));
    await expect(service.complete(new URLSearchParams({ code: 'C', state }))).rejects.toMatchObject(
      { reason: 'not-swapped' } satisfies Partial<QitsSignInError>,
    );
  });

  it('answers null on refresh when the token endpoint answers a non-JSON 2xx body', async () => {
    const service = tokens();
    await signIn(service);
    replies.push(async () => new Response('not json', { status: 200 }));
    expect(await service.refresh()).toBeNull();
  });

  it('keeps the tokens across a reload', async () => {
    await signIn(tokens());
    TestBed.resetTestingModule();
    expect(await tokens().accessToken()).toBe('A1');
  });

  it('refreshes once for callers at the same time, and keeps the rotated refresh token', async () => {
    const service = tokens();
    await signIn(service);
    let release!: () => void;
    replies.push(() => new Promise((resolve) => (release = () => resolve(answer('A2', 'R2')))));
    const both = Promise.all([service.refresh(), service.refresh()]);
    release();
    expect(await both).toEqual(['A2', 'A2']);
    expect(posts.slice(1).map((post) => Object.fromEntries(post.form))).toEqual([
      { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: 'R1' },
    ]);
    replies.push(async () => answer('A3', 'R3'));
    expect(await service.refresh()).toBe('A3');
    expect(posts.at(-1)?.form.get('refresh_token')).toBe('R2');
  });

  it('retries with a token a refresh already brought, instead of refreshing again', async () => {
    const service = tokens();
    await signIn(service);
    replies.push(async () => answer('A2', 'R2'));
    await service.refresh();
    expect(await service.retryToken('A1')).toBe('A2');
    expect(posts).toHaveLength(2);
  });

  it('forgets the tokens when the idp refuses the refresh', async () => {
    const service = tokens();
    await signIn(service);
    replies.push(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    expect(await service.refresh()).toBeNull();
    expect(service.lastFailure()).toBe('refused');
    expect(await service.accessToken()).toBeNull();
    expect(sessionStorage.getItem(TOKENS_KEY)).toBeNull();
  });

  it('reports a refresh with nothing to refresh with as refused, without asking the idp', async () => {
    const service = tokens();
    await signIn(service);
    replies.push(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await service.refresh();
    expect(await service.refresh()).toBeNull();
    expect(service.lastFailure()).toBe('refused');
    expect(posts).toHaveLength(2);
  });

  it('keeps the tokens and reports unavailable when the idp answers the refresh with a 5xx', async () => {
    const service = tokens();
    await signIn(service);
    replies.push(async () => new Response('Bad Gateway', { status: 502 }));
    expect(await service.refresh()).toBeNull();
    expect(service.lastFailure()).toBe('unavailable');
    expect(JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? '{}').refreshToken).toBe('R1');
    // Back up: the kept refresh token still refreshes, and the failure is over.
    replies.push(async () => answer('A2', 'R2'));
    expect(await service.refresh()).toBe('A2');
    expect(posts.at(-1)?.form.get('refresh_token')).toBe('R1');
    expect(service.lastFailure()).toBeNull();
  });

  it('keeps the tokens and reports unavailable when the refresh request fails', async () => {
    const service = tokens();
    await signIn(service);
    replies.push(async () => Promise.reject(new TypeError('Failed to fetch')));
    expect(await service.refresh()).toBeNull();
    expect(service.lastFailure()).toBe('unavailable');
    expect(JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? '{}').refreshToken).toBe('R1');
  });

  it('gives up on a refresh the idp leaves hanging, after the timeout, as unavailable', async () => {
    const service = tokens();
    await signIn(service);
    // AbortSignal.timeout runs on a timer of its own that fake timers do not reach: stand it in.
    const timeout = new AbortController();
    const signalTimeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    try {
      replies.push(
        () =>
          new Promise<Response>((_, reject) => {
            const signal = posts.at(-1)?.init.signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
          }),
      );
      const refreshed = service.refresh();
      expect(signalTimeout).toHaveBeenCalledExactlyOnceWith(TOKEN_REQUEST_TIMEOUT_MS);
      expect(posts.at(-1)?.init.signal).toBe(timeout.signal);
      timeout.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      expect(await refreshed).toBeNull();
      expect(service.lastFailure()).toBe('unavailable');
      expect(JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? '{}').refreshToken).toBe('R1');
    } finally {
      signalTimeout.mockRestore();
    }
  });

  it('refreshes on its own before the access token expires', async () => {
    vi.useFakeTimers();
    try {
      const service = tokens();
      await signIn(service, 'A1', 'R1');
      replies.push(async () => answer('A2', 'R2'));
      await vi.advanceTimersByTimeAsync(900_000 - REFRESH_AHEAD_MS);
      expect(posts.at(-1)?.form.get('refresh_token')).toBe('R1');
      expect(await service.accessToken()).toBe('A2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets everything on logout', async () => {
    const service = tokens();
    await signIn(service);
    service.logout();
    expect(await service.accessToken()).toBeNull();
    expect(sessionStorage.getItem(TOKENS_KEY)).toBeNull();
  });

  it('remembers the sub alone in localStorage when the idp issues tokens, on sign-in and refresh', async () => {
    const service = tokens();
    await signIn(service, jwt('alice'), 'R1');
    expect(localStorage.getItem(USER_KEY)).toBe('alice');
    expect(service.user()).toBe('alice');
    localStorage.clear();
    replies.push(async () => answer(jwt('alice'), 'R2'));
    await service.refresh();
    expect(localStorage.getItem(USER_KEY)).toBe('alice');
  });

  it("replaces the remembered sub with another user's", async () => {
    const service = tokens();
    await signIn(service, jwt('alice'), 'R1');
    replies.push(async () => answer(jwt('bob'), 'R2'));
    await service.refresh();
    expect(localStorage.getItem(USER_KEY)).toBe('bob');
    expect(service.user()).toBe('bob');
  });

  it('keeps the remembered sub when the idp refuses the refresh', async () => {
    const service = tokens();
    await signIn(service, jwt('alice'), 'R1');
    replies.push(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
    expect(await service.refresh()).toBeNull();
    expect(service.subject()).toBeNull();
    expect(service.user()).toBe('alice');
    expect(localStorage.getItem(USER_KEY)).toBe('alice');
  });

  it('answers the remembered sub as the user without tokens, after a relaunch', async () => {
    await signIn(tokens(), jwt('alice'), 'R1');
    TestBed.resetTestingModule();
    sessionStorage.clear();
    const service = tokens();
    expect(await service.accessToken()).toBeNull();
    expect(service.subject()).toBeNull();
    expect(service.user()).toBe('alice');
  });

  it('answers no user with neither a token nor a remembered sub', () => {
    expect(tokens().user()).toBeNull();
  });

  it('forgets the remembered sub on forgetUser, and keeps the tokens', async () => {
    const service = tokens();
    await signIn(service, jwt('alice'), 'R1');
    service.forgetUser();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(sessionStorage.getItem(TOKENS_KEY)).not.toBeNull();
    expect(service.user()).toBe('alice');
    service.logout();
    expect(service.user()).toBeNull();
  });

  it('never writes a token to localStorage', async () => {
    const service = tokens();
    await signIn(service, jwt('alice'), 'R1');
    replies.push(async () => answer(jwt('alice'), 'R2'));
    await service.refresh();
    const stored = Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]);
    expect(stored).toEqual([[USER_KEY, 'alice']]);
    expect(JSON.stringify(stored)).not.toMatch(/R1|R2|signature/);
  });
});
