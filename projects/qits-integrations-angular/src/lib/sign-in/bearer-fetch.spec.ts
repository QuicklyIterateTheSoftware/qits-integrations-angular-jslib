import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ɵsetOutcomeRecorder, type OutcomeRecord } from '../outcomes/outcome-recorder';
import { QITS_LEAVE_APP } from '../outcomes/outcomes';
import { QitsBearerFetch } from './bearer-fetch';
import { QITS_SIGN_IN_FETCH, QitsTokens } from './qits-tokens';
import { QitsSessionExpiry } from './session-expiry';
import { QITS_SIGN_IN } from './sign-in-settings';

const ASSET = 'https://projects.qits.example/projects/api/work/w1/dossier/assets/a1/content';

const AUTHORIZE = 'https://idp.example.test/idp/authorize?x';

describe('QitsBearerFetch', () => {
  let calls: { url: string; authorization: string | null }[];
  let replies: Response[];
  let tokens: { current: string | null; next: string | null; signIns: string[] };
  let leave: ReturnType<typeof vi.fn>;
  let records: OutcomeRecord[];

  function service(): QitsBearerFetch {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DOCUMENT,
          useValue: {
            location: { href: 'https://qits.example/work', pathname: '/work', search: '' },
          },
        },
        {
          provide: QITS_SIGN_IN,
          useValue: { clientId: 'qits-spa', platformDomain: 'qits.example', idpOrigin: '' },
        },
        {
          provide: QitsTokens,
          useValue: {
            accessToken: async () => tokens.current,
            retryToken: async () => (tokens.current = tokens.next),
            // Once per page, as the real one answers.
            authorizeUrl: async (path: string) =>
              tokens.signIns.push(path) === 1 ? AUTHORIZE : null,
          },
        },
        {
          provide: QITS_SIGN_IN_FETCH,
          useValue: async (url: string, init: RequestInit = {}) => {
            calls.push({ url, authorization: new Headers(init.headers).get('authorization') });
            return replies.shift() ?? new Response('', { status: 500 });
          },
        },
        { provide: QITS_LEAVE_APP, useValue: leave },
        provideRouter([]),
        QitsSessionExpiry,
        QitsBearerFetch,
      ],
    });
    return TestBed.inject(QitsBearerFetch);
  }

  beforeEach(() => {
    calls = [];
    replies = [];
    tokens = { current: 'A1', next: 'A2', signIns: [] };
    leave = vi.fn();
    records = [];
    ɵsetOutcomeRecorder((record) => records.push(record));
  });

  afterEach(() => ɵsetOutcomeRecorder(null));

  it('answers a platform body as an object URL, fetched with the bearer', async () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    try {
      replies.push(new Response('png', { status: 200 }));
      expect(await service().fetchObjectUrl(ASSET)).toBe('blob:x');
      expect(calls).toEqual([{ url: ASSET, authorization: 'Bearer A1' }]);
      expect(create).toHaveBeenCalledWith(expect.any(Blob));
    } finally {
      create.mockRestore();
    }
  });

  it('refreshes once on a 401 and retries', async () => {
    replies.push(new Response('', { status: 401 }), new Response('ok', { status: 200 }));
    const response = await service().fetch(ASSET);
    expect(await response.text()).toBe('ok');
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer A1', 'Bearer A2']);
    expect(tokens.signIns).toEqual([]);
    expect(leave).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('leaves for the idp through session-expired:signedOut when the refresh brings nothing, and still answers the 401', async () => {
    tokens.next = null;
    replies.push(new Response('', { status: 401 }));
    const response = await service().fetch(ASSET);
    expect(response.status).toBe(401);
    await vi.waitFor(() => expect(leave).toHaveBeenCalled());
    expect(tokens.signIns).toEqual(['/work']);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith(AUTHORIZE);
    expect(records).toEqual([
      {
        interaction: 'session-expired',
        outcome: 'signedOut',
        kind: 'external',
        to: 'idp',
        url: AUTHORIZE,
      },
    ]);
  });

  it('rejects the object URL when the refresh brings nothing', async () => {
    tokens.next = null;
    replies.push(new Response('', { status: 401 }));
    await expect(service().fetchObjectUrl(ASSET)).rejects.toThrow(/401/);
    await vi.waitFor(() => expect(leave).toHaveBeenCalledTimes(1));
  });

  it('leaves once when two fetches answer 401 together', async () => {
    tokens.next = null;
    replies.push(new Response('', { status: 401 }), new Response('', { status: 401 }));
    const fetcher = service();
    await Promise.all([fetcher.fetch(ASSET), fetcher.fetch(ASSET)]);
    await vi.waitFor(() => expect(leave).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    expect(leave).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
  });

  it('sends no bearer to any other host', async () => {
    replies.push(new Response('', { status: 200 }));
    await service().fetch('https://elsewhere.example/a.png');
    expect(calls).toEqual([{ url: 'https://elsewhere.example/a.png', authorization: null }]);
  });
});
