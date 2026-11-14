import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type UrlTree } from '@angular/router';
import { ɵsetOutcomeRecorder, type OutcomeRecord } from '../outcomes/outcome-recorder';
import { QITS_LEAVE_APP } from '../outcomes/outcomes';
import { QitsTokens, type QitsTokenFailure } from './qits-tokens';
import { QitsSessionExpiry } from './session-expiry';

const AUTHORIZE = 'https://idp.example.test/idp/authorize?x';

/** Let pending awaits run. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('QitsSessionExpiry', () => {
  let failure: QitsTokenFailure | null;
  let signIns: string[];
  let leave: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.spyOn>;
  let records: OutcomeRecord[];

  function expiry(): QitsSessionExpiry {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DOCUMENT,
          useValue: { location: { pathname: '/projects/qits', search: '?tab=work' } },
        },
        {
          provide: QitsTokens,
          useValue: {
            lastFailure: () => failure,
            authorizeUrl: async (path: string) => (signIns.push(path), AUTHORIZE),
          },
        },
        { provide: QITS_LEAVE_APP, useValue: leave },
        provideRouter([]),
        QitsSessionExpiry,
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    return TestBed.inject(QitsSessionExpiry);
  }

  beforeEach(() => {
    failure = 'refused';
    signIns = [];
    leave = vi.fn();
    records = [];
    ɵsetOutcomeRecorder((record) => records.push(record));
  });

  afterEach(() => {
    ɵsetOutcomeRecorder(null);
    TestBed.resetTestingModule();
  });

  it('leaves for the idp through session-expired:signedOut, back to this page', async () => {
    expiry().signIn();
    await settle();
    expect(signIns).toEqual(['/projects/qits?tab=work']);
    expect(leave).toHaveBeenCalledExactlyOnceWith(AUTHORIZE);
    expect(navigate).not.toHaveBeenCalled();
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

  it('says so in-app through session-expired:unavailable when the idp did not answer the refresh', async () => {
    failure = 'unavailable';
    expiry().signIn();
    await settle();
    expect(signIns).toEqual([]);
    expect(leave).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
    const url = TestBed.inject(Router).serializeUrl(navigate.mock.calls[0][0] as UrlTree);
    expect(url).toBe('/auth/callback?error=temporarily_unavailable');
    expect(records).toEqual([
      {
        interaction: 'session-expired',
        outcome: 'unavailable',
        kind: 'exit',
        to: 'auth/callback',
        url,
      },
    ]);
  });
});
