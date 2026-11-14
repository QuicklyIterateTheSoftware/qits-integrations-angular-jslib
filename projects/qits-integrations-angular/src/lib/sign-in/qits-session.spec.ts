import { DOCUMENT, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { ɵsetOutcomeRecorder, type OutcomeRecord } from '../outcomes/outcome-recorder';
import { QitsSession } from './qits-session';
import { QITS_SIGN_IN_FETCH, QitsTokens, tokensKey, userKey } from './qits-tokens';
import { QITS_SIGN_IN } from './sign-in-settings';

/** Let pending awaits run. The sign-in's own (a SHA-256 digest) may take longer: wait for it. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

/** Switches `navigator.onLine`, and sends the window event the browser sends. */
function network(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

describe('QitsSession', () => {
  const assign = vi.fn();
  let records: OutcomeRecord[];

  /** The session; with `idp`, the idp's token endpoint answers every request with it. */
  function session(idp?: () => Promise<Response>): QitsSession {
    TestBed.configureTestingModule({
      providers: [
        ...(idp ? [{ provide: QITS_SIGN_IN_FETCH, useValue: idp }] : []),
        { provide: PLATFORM_ID, useValue: 'browser' },
        {
          provide: DOCUMENT,
          useValue: {
            location: {
              assign,
              origin: 'http://localhost:4200',
              pathname: '/projects/qits',
              search: '?tab=work',
            },
          },
        },
        {
          provide: QITS_SIGN_IN,
          useValue: {
            clientId: 'qits-spa',
            platformDomain: 'qits.example',
            idpOrigin: 'https://idp.qits.example',
          },
        },
        QitsTokens,
        QitsSession,
      ],
    });
    return TestBed.inject(QitsSession);
  }

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    assign.mockReset();
    records = [];
    ɵsetOutcomeRecorder((record) => records.push(record));
  });

  afterEach(() => {
    ɵsetOutcomeRecorder(null);
    TestBed.resetTestingModule();
    network(true);
    localStorage.clear();
  });

  it('lets a visitor with a token through, and leaves for nowhere', async () => {
    const service = session();
    vi.spyOn(TestBed.inject(QitsTokens), 'accessToken').mockResolvedValue('A1');
    expect(await service.ensure('/projects')).toBe(true);
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('leaves for the idp through session-guard:signedOut without one, back to the asked page', async () => {
    const service = session();
    expect(await service.ensure('/projects/qits/work')).toBe(false);
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    expect(assign).toHaveBeenCalledTimes(1);
    const href = assign.mock.calls[0][0] as string;
    expect(href).toMatch(/^https:\/\/idp\.qits\.example\/idp\/authorize\?/);
    const state = new URL(href).searchParams.get('state');
    const pending = JSON.parse(
      sessionStorage.getItem(`qits.sign-in.qits-spa.pkce.${state}`) ?? '{}',
    );
    expect(pending.returnPath).toBe('/projects/qits/work');
    expect(records).toEqual([
      {
        interaction: 'session-guard',
        outcome: 'signedOut',
        kind: 'external',
        to: 'idp',
        url: href,
      },
    ]);
  });

  it('leaves once per page, however often it is asked', async () => {
    const service = session();
    await service.ensure('/a');
    await service.ensure('/b');
    await vi.waitFor(() => expect(assign).toHaveBeenCalled());
    await settle();
    expect(assign).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
  });

  describe('the idp failing the refresh (qits-2250)', () => {
    /** Tokens kept from before, the access token expired: the next ask refreshes. */
    function heldTokens(): void {
      sessionStorage.setItem(
        tokensKey('qits-spa'),
        JSON.stringify({
          accessToken: 'A1',
          accessExpiresAt: Date.now() - 1000,
          refreshToken: 'R1',
          refreshExpiresAt: Date.now() + 3_600_000,
        }),
      );
    }

    it('answers the callback page saying so, through session-guard:unavailable, and never leaves', async () => {
      heldTokens();
      const service = session(async () => new Response('Bad Gateway', { status: 502 }));
      const answer = await service.ensure('/projects/qits/work');
      expect(answer).toBeInstanceOf(UrlTree);
      const url = TestBed.inject(Router).serializeUrl(answer as UrlTree);
      expect(url).toBe('/auth/callback?error=temporarily_unavailable');
      await settle();
      expect(assign).not.toHaveBeenCalled();
      expect(records).toEqual([
        {
          interaction: 'session-guard',
          outcome: 'unavailable',
          kind: 'exit',
          to: 'auth/callback',
          url,
        },
      ]);
      // The outage kept the tokens: the guard's next run retries the refresh with them.
      expect(JSON.parse(sessionStorage.getItem(tokensKey('qits-spa')) ?? '{}').refreshToken).toBe(
        'R1',
      );
    });

    it('answers the callback page when the token request fails outright', async () => {
      heldTokens();
      const service = session(async () => Promise.reject(new TypeError('Failed to fetch')));
      expect(await service.ensure('/projects')).toBeInstanceOf(UrlTree);
      await settle();
      expect(assign).not.toHaveBeenCalled();
    });

    it('still leaves for the idp when the idp refuses the refresh', async () => {
      heldTokens();
      const service = session(
        async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
      );
      expect(await service.ensure('/projects/qits/work')).toBe(false);
      await vi.waitFor(() => expect(assign).toHaveBeenCalled());
      expect(records).toMatchObject([{ interaction: 'session-guard', outcome: 'signedOut' }]);
    });
  });

  describe('offline', () => {
    /** The `sub` the idp last issued tokens for on this device. */
    const remembered = (sub: string) => localStorage.setItem(userKey('qits-spa'), sub);

    it('lets a remembered visitor without a token through, and leaves for nowhere', async () => {
      remembered('alice');
      network(false);
      const service = session();
      expect(await service.ensure('/projects/qits/work')).toBe(true);
      await settle();
      expect(assign).not.toHaveBeenCalled();
      expect(records).toEqual([]);
    });

    it('leaves for the idp as before when nobody is remembered', async () => {
      network(false);
      const service = session();
      expect(await service.ensure('/projects/qits/work')).toBe(false);
      await vi.waitFor(() => expect(assign).toHaveBeenCalled());
      expect(records).toMatchObject([{ interaction: 'session-guard', outcome: 'signedOut' }]);
    });

    it('leaves for the idp online without a token, though somebody is remembered', async () => {
      remembered('alice');
      const service = session();
      expect(await service.ensure('/projects/qits/work')).toBe(false);
      await vi.waitFor(() => expect(assign).toHaveBeenCalled());
      expect(records).toMatchObject([{ interaction: 'session-guard', outcome: 'signedOut' }]);
    });

    it('signs in once the network is back, through session-guard:signedOut to the current page', async () => {
      remembered('alice');
      network(false);
      const service = session();
      const authorize = vi.spyOn(TestBed.inject(QitsTokens), 'authorizeUrl');
      expect(await service.ensure('/a')).toBe(true);
      expect(await service.ensure('/b')).toBe(true);
      await settle();
      expect(assign).not.toHaveBeenCalled();

      network(true);
      await vi.waitFor(() => expect(assign).toHaveBeenCalled());
      network(false);
      network(true);
      await settle();
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(assign).toHaveBeenCalledTimes(1);
      const href = assign.mock.calls[0][0] as string;
      const state = new URL(href).searchParams.get('state');
      const pending = JSON.parse(
        sessionStorage.getItem(`qits.sign-in.qits-spa.pkce.${state}`) ?? '{}',
      );
      expect(pending.returnPath).toBe('/projects/qits?tab=work');
      expect(records).toEqual([
        {
          interaction: 'session-guard',
          outcome: 'signedOut',
          kind: 'external',
          to: 'idp',
          url: href,
        },
      ]);
    });

    it('stops listening when the session is destroyed', async () => {
      remembered('alice');
      network(false);
      expect(await session().ensure('/a')).toBe(true);
      TestBed.resetTestingModule();
      network(true);
      await settle();
      expect(assign).not.toHaveBeenCalled();
    });
  });
});
