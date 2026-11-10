import { DOCUMENT, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ɵsetOutcomeRecorder, type OutcomeRecord } from '../outcomes/outcome-recorder';
import { QitsSession } from './qits-session';
import { QitsTokens } from './qits-tokens';
import { QITS_SIGN_IN } from './sign-in-settings';

/** Let pending awaits run. The sign-in's own (a SHA-256 digest) may take longer: wait for it. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('QitsSession', () => {
  const assign = vi.fn();
  let records: OutcomeRecord[];

  function session(): QitsSession {
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
    assign.mockReset();
    records = [];
    ɵsetOutcomeRecorder((record) => records.push(record));
  });

  afterEach(() => ɵsetOutcomeRecorder(null));

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
});
