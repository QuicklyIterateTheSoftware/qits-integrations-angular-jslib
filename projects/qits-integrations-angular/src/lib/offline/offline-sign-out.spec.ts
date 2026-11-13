import { TestBed } from '@angular/core/testing';
import { QITS_SIGN_IN_FETCH, QitsTokens, tokensKey, userKey } from '../sign-in/qits-tokens';
import { QITS_SIGN_IN } from '../sign-in/sign-in-settings';
import {
  boot,
  databases,
  network,
  reloadPage,
  resetWorld,
  settle,
  type FakeBackend,
  type ThingsPage,
} from './offline.fixture';
import type { QitsOffline } from './qits-offline';

const CLIENT_ID = 'qits-fixture';
const ALICE_STORE = 'qits-offline:fixture:alice';
const USER_KEY = userKey(CLIENT_ID);

/** An unsigned JWT with the `sub` claim, as the idp's access token carries it. */
function jwt(sub: string): string {
  const part = (value: object) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${part({ alg: 'RS256' })}.${part({ sub, exp: 4102444800 })}.signature`;
}

/**
 * Tokens in `sessionStorage` and the remembered `sub` in `localStorage`, as a finished sign-in
 * leaves them.
 */
function signedIn(sub: string): void {
  localStorage.setItem(USER_KEY, sub);
  sessionStorage.setItem(
    tokensKey(CLIENT_ID),
    JSON.stringify({
      accessToken: jwt(sub),
      accessExpiresAt: Date.now() + 15 * 60_000,
      refreshToken: 'R1',
      refreshExpiresAt: Number.MAX_SAFE_INTEGER,
    }),
  );
}

/** The idp's token answer. */
function issued(sub: string): Response {
  return new Response(
    JSON.stringify({ access_token: jwt(sub), expires_in: 900, refresh_token: 'R2' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const rename = (id: string, name: string) => ({ path: { id }, body: { name } });

describe('offline mode: sign-in and sign-out', () => {
  let server: FakeBackend;
  let page: ThingsPage;
  let offline: QitsOffline;
  let tokens: QitsTokens;
  const idp = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

  /** Boots with the bearer sign-in and the default user: the access token's `sub`. */
  async function start(): Promise<void> {
    ({ page, offline } = boot({
      options: { user: undefined },
      providers: [
        {
          provide: QITS_SIGN_IN,
          useValue: {
            clientId: CLIENT_ID,
            platformDomain: 'qits.example',
            idpOrigin: 'https://idp.qits.example',
          },
        },
        { provide: QITS_SIGN_IN_FETCH, useValue: idp },
        QitsTokens,
      ],
    }));
    tokens = TestBed.inject(QitsTokens);
    await settle();
  }

  /** A write queued while offline: the outbox holds one entry. */
  async function queueOne(): Promise<void> {
    network(false);
    await page.rename.run(rename('t1', 'mine'));
    expect(offline.outbox()).toHaveLength(1);
  }

  beforeEach(async () => {
    server = resetWorld();
    server.seed('t1', 'one');
    sessionStorage.clear();
    localStorage.clear();
    idp.mockReset();
    signedIn('alice');
    await start();
  });

  afterEach(() => {
    network(true);
    sessionStorage.clear();
    localStorage.clear();
  });

  it('names the store after the signed-in user', async () => {
    expect(tokens.subject()).toBe('alice');
    expect(tokens.user()).toBe('alice');
    expect(await databases()).toEqual([ALICE_STORE]);
    expect(page.thing.qitsStatus()).toBe('resolved');
  });

  it('Sign-out with pending writes warns and clears nothing', async () => {
    await queueOne();
    await expect(offline.signOut()).resolves.toEqual({ signedOut: false, pending: 1 });
    await expect(offline.signOut({ discardPending: false })).resolves.toEqual({
      signedOut: false,
      pending: 1,
    });
    expect(await databases()).toEqual([ALICE_STORE]);
    expect(offline.outbox()).toMatchObject([{ state: 'pending', recordId: 't1' }]);
    expect(tokens.subject()).toBe('alice');
    expect(sessionStorage.getItem(tokensKey(CLIENT_ID))).not.toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBe('alice');

    // Nothing was lost: back online, the write is sent.
    network(true);
    await settle();
    expect(server.thing('t1')?.name).toBe('mine');
  });

  it('Confirmed sign-out deletes the store and the outbox', async () => {
    await queueOne();
    await expect(offline.signOut({ discardPending: true })).resolves.toEqual({
      signedOut: true,
      pending: 1,
    });
    expect(await databases()).toEqual([]);
    expect(offline.outbox()).toEqual([]);
    expect(tokens.subject()).toBeNull();
    expect(tokens.user()).toBeNull();
    expect(sessionStorage.getItem(tokensKey(CLIENT_ID))).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();

    network(true);
    await settle();
    expect(server.seen('updateThing')).toEqual([]);
    expect(await databases()).toEqual([]);
  });

  it('signs out at once with an empty outbox', async () => {
    await expect(offline.signOut()).resolves.toEqual({ signedOut: true, pending: 0 });
    expect(await databases()).toEqual([]);
    expect(tokens.subject()).toBeNull();
    expect(tokens.user()).toBeNull();
  });

  it('A refused token refresh clears nothing', async () => {
    await queueOne();
    idp.mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 400 }));
    await expect(tokens.refresh()).resolves.toBeNull();
    // The refusal ran `logout()`: no token, but the remembered user keeps her store open.
    expect(tokens.subject()).toBeNull();
    expect(tokens.user()).toBe('alice');
    await settle();
    expect(await databases()).toEqual([ALICE_STORE]);
    expect(offline.outbox()).toMatchObject([{ state: 'pending', recordId: 't1' }]);
    expect(page.thing.value()?.name).toBe('mine');

    // The same person signs in again: the outbox is still there, and is sent.
    signedIn('alice');
    reloadPage();
    await start();
    expect(offline.outbox()).toMatchObject([{ state: 'pending', recordId: 't1' }]);
    network(true);
    await settle();
    expect(server.thing('t1')?.name).toBe('mine');
    expect(offline.outbox()).toEqual([]);
  });

  it('pauses the outbox on a 401 until the next token refresh', async () => {
    await queueOne();
    server.unauthorized = true;
    network(true);
    await settle();
    expect(server.seen('updateThing')).toHaveLength(1);
    expect(offline.outbox()).toMatchObject([{ state: 'pending' }]);
    expect(page.rename.status()).toBe('pending');

    // Neither the network nor another enqueue moves it while paused.
    server.unauthorized = false;
    network(true);
    await settle();
    expect(server.seen('updateThing')).toHaveLength(1);

    idp.mockResolvedValueOnce(issued('alice'));
    await tokens.refresh();
    await settle();
    expect(server.seen('updateThing')).toHaveLength(2);
    expect(offline.outbox()).toEqual([]);
    expect(page.rename.status()).toBe('done');
  });

  it('switches to the store of another user who signs in', async () => {
    await queueOne();
    idp.mockResolvedValueOnce(issued('bob'));
    await tokens.refresh();
    await settle();
    expect(tokens.subject()).toBe('bob');
    expect(offline.outbox()).toEqual([]);
    expect(await databases()).toEqual([ALICE_STORE, 'qits-offline:fixture:bob']);
  });

  it("opens the remembered user's store on an offline relaunch, without the idp", async () => {
    // Alice signs in online: the idp issues her tokens, and her `sub` is remembered.
    localStorage.clear();
    idp.mockResolvedValueOnce(issued('alice'));
    await tokens.refresh();
    expect(localStorage.getItem(USER_KEY)).toBe('alice');
    expect(page.thing.qitsStatus()).toBe('resolved');
    await queueOne();

    // The installed app is closed and started again offline: the tab's tokens are gone.
    sessionStorage.clear();
    reloadPage();
    idp.mockClear();
    network(false);
    await start();
    expect(tokens.subject()).toBeNull();
    expect(tokens.user()).toBe('alice');
    expect(await databases()).toEqual([ALICE_STORE]);
    expect(page.thing.qitsStatus()).toBe('cached');
    expect(page.thing.value()?.name).toBe('mine');
    expect(offline.outbox()).toMatchObject([{ state: 'pending', recordId: 't1' }]);
    expect(idp).not.toHaveBeenCalled();

    // Signing out on this device forgets her too.
    await expect(offline.signOut({ discardPending: true })).resolves.toEqual({
      signedOut: true,
      pending: 1,
    });
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(tokens.user()).toBeNull();
    expect(await databases()).toEqual([]);
  });
});
