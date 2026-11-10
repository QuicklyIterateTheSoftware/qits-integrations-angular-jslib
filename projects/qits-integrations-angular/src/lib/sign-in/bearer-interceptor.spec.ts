import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ɵsetOutcomeRecorder, type OutcomeRecord } from '../outcomes/outcome-recorder';
import { QITS_LEAVE_APP } from '../outcomes/outcomes';
import { qitsBearerInterceptor } from './bearer-interceptor';
import { QitsTokens } from './qits-tokens';
import { QitsSessionExpiry } from './session-expiry';
import { QITS_SIGN_IN } from './sign-in-settings';

const SETTINGS = {
  clientId: 'qits-spa',
  platformDomain: 'qits.example',
  idpOrigin: 'https://idp.qits.example',
};

const API = 'https://projects.qits.example/projects/api/projects';

const AUTHORIZE = 'https://idp.example.test/idp/authorize?x';

/**
 * A stand-in for {@link QitsTokens}: a current token, what a refresh brings, and the authorize URL
 * once per page, as the real one answers it.
 */
class FakeTokens {
  current: string | null = 'A1';
  next: string | null = 'A2';
  refreshes = 0;
  signIns: string[] = [];
  async accessToken() {
    return this.current;
  }
  async retryToken() {
    this.refreshes++;
    this.current = this.next;
    return this.next;
  }
  async authorizeUrl(path: string) {
    this.signIns.push(path);
    return this.signIns.length === 1 ? AUTHORIZE : null;
  }
}

/** The interceptor's work runs after a few awaits; let them run. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('qitsBearerInterceptor', () => {
  let tokens: FakeTokens;
  let http: HttpTestingController;
  let client: HttpClient;
  let leave: ReturnType<typeof vi.fn>;
  let records: OutcomeRecord[];

  beforeEach(() => {
    tokens = new FakeTokens();
    leave = vi.fn();
    records = [];
    ɵsetOutcomeRecorder((record) => records.push(record));
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
        { provide: QITS_LEAVE_APP, useValue: leave },
        provideRouter([]),
        QitsSessionExpiry,
        provideHttpClient(withInterceptors([qitsBearerInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
  });

  afterEach(() => {
    http.verify();
    ɵsetOutcomeRecorder(null);
  });

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
    await settle();
    expect(tokens.signIns).toEqual([]);
    expect(leave).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('leaves for the idp through session-expired:signedOut when the refresh brings nothing', async () => {
    tokens.next = null;
    const answer = firstValueFrom(client.get(API));
    await settle();
    http.expectOne(API).flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(answer).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(leave).toHaveBeenCalled());
    expect(tokens.signIns).toEqual(['/projects/qits?x=1']);
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

  it('leaves once when two calls answer 401 together', async () => {
    tokens.next = null;
    const first = firstValueFrom(client.get(API));
    const second = firstValueFrom(client.get(`${API}/2`));
    await settle();
    http.expectOne(API).flush(null, { status: 401, statusText: 'Unauthorized' });
    http.expectOne(`${API}/2`).flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(first).rejects.toMatchObject({ status: 401 });
    await expect(second).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(leave).toHaveBeenCalled());
    await settle();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
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
