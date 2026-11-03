import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { QitsBearerFetch } from './bearer-fetch';
import { QITS_SIGN_IN_FETCH, QitsTokens } from './qits-tokens';
import { QITS_SIGN_IN } from './sign-in-settings';

const ASSET = 'https://projects.qits.example/projects/api/work/w1/dossier/assets/a1/content';

describe('QitsBearerFetch', () => {
  let calls: { url: string; authorization: string | null }[];
  let replies: Response[];
  let tokens: { current: string | null; next: string | null; logins: string[] };

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
            login: async (path: string) => void tokens.logins.push(path),
          },
        },
        {
          provide: QITS_SIGN_IN_FETCH,
          useValue: async (url: string, init: RequestInit = {}) => {
            calls.push({ url, authorization: new Headers(init.headers).get('authorization') });
            return replies.shift() ?? new Response('', { status: 500 });
          },
        },
        QitsBearerFetch,
      ],
    });
    return TestBed.inject(QitsBearerFetch);
  }

  beforeEach(() => {
    calls = [];
    replies = [];
    tokens = { current: 'A1', next: 'A2', logins: [] };
  });

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
  });

  it('starts the sign-in when the refresh brings nothing, and rejects the object URL', async () => {
    tokens.next = null;
    replies.push(new Response('', { status: 401 }));
    await expect(service().fetchObjectUrl(ASSET)).rejects.toThrow(/401/);
    expect(tokens.logins).toEqual(['/work']);
  });

  it('sends no bearer to any other host', async () => {
    replies.push(new Response('', { status: 200 }));
    await service().fetch('https://elsewhere.example/a.png');
    expect(calls).toEqual([{ url: 'https://elsewhere.example/a.png', authorization: null }]);
  });
});
