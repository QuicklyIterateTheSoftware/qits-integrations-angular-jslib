import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DOCUMENT, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { qitsBearerInterceptor } from './bearer-interceptor';
import { QitsTokens } from './qits-tokens';
import { QITS_SIGN_IN } from './sign-in-settings';

const SETTINGS = {
  clientId: 'qits-spa',
  platformDomain: 'qits.example',
  idpOrigin: 'https://idp.qits.example',
};

const API = 'https://projects.qits.example/projects/api/projects';

/** A stand-in for {@link QitsTokens}: a current token, and what a refresh brings. */
class FakeTokens {
  current: string | null = 'A1';
  next: string | null = 'A2';
  refreshes = 0;
  logins: string[] = [];
  async accessToken() {
    return this.current;
  }
  async retryToken() {
    this.refreshes++;
    this.current = this.next;
    return this.next;
  }
  async login(path: string) {
    this.logins.push(path);
  }
}

/** The interceptor's work runs after a few awaits; let them run. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('qitsBearerInterceptor', () => {
  let tokens: FakeTokens;
  let http: HttpTestingController;
  let client: HttpClient;

  beforeEach(() => {
    tokens = new FakeTokens();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DOCUMENT,
          useValue: {
            location: {
              href: 'https://ci.qits.example/projects/qits?x=1',
              pathname: '/projects/qits',
              search: '?x=1',
            },
          },
        },
        { provide: QITS_SIGN_IN, useValue: SETTINGS },
        { provide: QitsTokens, useValue: tokens },
        provideHttpClient(withInterceptors([qitsBearerInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
  });

  afterEach(() => http.verify());

  it('puts the bearer on calls to a platform host', async () => {
    const answer = firstValueFrom(client.get(API));
    await settle();
    const request = http.expectOne(API);
    expect(request.request.headers.get('authorization')).toBe('Bearer A1');
    expect(request.request.withCredentials).toBe(false);
    request.flush([]);
    await answer;
  });

  it("puts the bearer on this page's own calls, relative ones included", async () => {
    const answer = firstValueFrom(client.get('/ci/api/runs'));
    await settle();
    const request = http.expectOne('/ci/api/runs');
    expect(request.request.headers.get('authorization')).toBe('Bearer A1');
    request.flush([]);
    await answer;
  });

  it('puts the bearer on the apex too', async () => {
    const answer = firstValueFrom(client.get('https://qits.example/main-navigation'));
    await settle();
    const request = http.expectOne('https://qits.example/main-navigation');
    expect(request.request.headers.get('authorization')).toBe('Bearer A1');
    request.flush([]);
    await answer;
  });

  it('sends nothing over plain http to a platform name, nor to a look-alike host', async () => {
    for (const url of [
      'http://projects.qits.example/projects/api/projects',
      'https://evilqits.example/projects/api/projects',
    ]) {
      const answer = firstValueFrom(client.get(url));
      await settle();
      const request = http.expectOne(url);
      expect(request.request.headers.has('authorization')).toBe(false);
      request.flush([]);
      await answer;
    }
  });

  it('sends nothing to any other host', async () => {
    const answer = firstValueFrom(client.get('https://elsewhere.example/projects/api/projects'));
    await settle();
    const request = http.expectOne('https://elsewhere.example/projects/api/projects');
    expect(request.request.headers.has('authorization')).toBe(false);
    request.flush([]);
    await answer;
  });

  it('refreshes once after a 401 and retries with the new token', async () => {
    const answer = firstValueFrom(client.get(API));
    await settle();
    http.expectOne(API).flush(null, { status: 401, statusText: 'Unauthorized' });
    await settle();
    const retry = http.expectOne(API);
    expect(retry.request.headers.get('authorization')).toBe('Bearer A2');
    retry.flush(['ok']);
    expect(await answer).toEqual(['ok']);
    expect(tokens.refreshes).toBe(1);
    expect(tokens.logins).toEqual([]);
  });

  it('sends the visitor to sign in when the refresh brings nothing', async () => {
    tokens.next = null;
    const answer = firstValueFrom(client.get(API));
    await settle();
    http.expectOne(API).flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(answer).rejects.toMatchObject({ status: 401 });
    expect(tokens.logins).toEqual(['/projects/qits?x=1']);
  });

  it('does not refresh twice when the retry is refused too', async () => {
    const answer = firstValueFrom(client.get(API));
    await settle();
    http.expectOne(API).flush(null, { status: 401, statusText: 'Unauthorized' });
    await settle();
    http.expectOne(API).flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(answer).rejects.toMatchObject({ status: 401 });
    expect(tokens.refreshes).toBe(1);
  });

  it('passes other errors on untouched', async () => {
    const answer = firstValueFrom(client.get(API));
    await settle();
    http.expectOne(API).flush(null, { status: 500, statusText: 'Server Error' });
    await expect(answer).rejects.toMatchObject({ status: 500 });
    expect(tokens.refreshes).toBe(0);
  });
});
