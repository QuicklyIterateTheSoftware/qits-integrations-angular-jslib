import { APP_BASE_HREF } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ɵsetOutcomeRecorder, type OutcomeRecord } from '../outcomes/outcome-recorder';
import { QitsAuthCallbackPage } from './auth-callback.page';
import { QitsSignInError, QitsSignInFailure, QitsTokens } from './qits-tokens';

/** The page's work runs after a few awaits; let them run. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('QitsAuthCallbackPage', () => {
  let navigate: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let records: OutcomeRecord[];

  function open(callback?: Pick<QitsTokens, 'complete'>): ComponentFixture<QitsAuthCallbackPage> {
    history.replaceState({}, '', '/auth/callback?code=C&state=S');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        // An app's `<base href="/">`.
        { provide: APP_BASE_HREF, useValue: '/' },
        ...(callback ? [{ provide: QitsTokens, useValue: callback }] : []),
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    return TestBed.createComponent(QitsAuthCallbackPage);
  }

  beforeEach(() => {
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    records = [];
    ɵsetOutcomeRecorder((record) => records.push(record));
  });

  afterEach(() => {
    ɵsetOutcomeRecorder(null);
    history.replaceState({}, '', '/');
    error.mockRestore();
  });

  it('finishes the sign-in with the query and goes on to the path it answers', async () => {
    const complete = vi.fn(async (_query: URLSearchParams) => '/projects/qits');
    open({ complete });
    await settle();
    expect(complete.mock.calls[0][0].toString()).toBe('code=C&state=S');
    expect(navigate).toHaveBeenCalledWith('/projects/qits', { replaceUrl: true });
    expect(records).toEqual([
      {
        interaction: 'sign-in',
        outcome: 'succeeded',
        kind: 'returnTo',
        to: null,
        url: '/projects/qits',
      },
    ]);
  });

  it('goes on to the root when the return path leads off the site', async () => {
    open({ complete: async () => '//elsewhere.example/' });
    await settle();
    expect(navigate).toHaveBeenCalledWith('/', { replaceUrl: true });
  });

  it('shows the signing-in state while complete is pending', async () => {
    let resolve!: (path: string) => void;
    const fixture = open({ complete: async () => new Promise((r) => (resolve = r)) });
    fixture.detectChanges();
    const status = fixture.nativeElement.querySelector('[role="status"]') as HTMLElement;
    expect(status).not.toBeNull();
    expect(status.textContent).toContain('Signing you in…');
    resolve('/');
    await settle();
  });

  it('stays put when the sign-in fails', async () => {
    const fixture = open({ complete: async () => Promise.reject(new Error('refused')) });
    await settle();
    fixture.detectChanges();
    expect(navigate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Sign-in failed');
    expect(fixture.nativeElement.textContent).toContain('Something went wrong while signing in.');
    expect(fixture.nativeElement.querySelector('a[href="/"]')?.textContent).toContain(
      'Start again',
    );
    expect(records).toEqual([
      { interaction: 'sign-in', outcome: 'failed', kind: 'stay', to: null },
    ]);
  });

  it('starts again through the declared exit to the root', async () => {
    const fixture = open({ complete: async () => Promise.reject(new Error('refused')) });
    await settle();
    fixture.detectChanges();
    const link = fixture.nativeElement.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/');
    expect(link.getAttribute('data-qits-outcome')).toBe('sign-in-failed:restarted');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/', undefined);
    expect(records.at(-1)).toEqual({
      interaction: 'sign-in-failed',
      outcome: 'restarted',
      kind: 'exit',
      to: '',
      url: '/',
    });
  });

  it('goes on to the root where nothing signs in this way', async () => {
    open();
    await settle();
    expect(navigate).toHaveBeenCalledWith('/', { replaceUrl: true });
  });

  it.each<[QitsSignInFailure, string]>([
    ['refused', 'The sign-in service refused the sign-in.'],
    ['unknown-state', 'This sign-in was started in another tab, or by an old link.'],
    ['no-code', 'The sign-in came back incomplete.'],
    [
      'not-swapped',
      'The sign-in could not be finished: its code was wrong, already used or expired.',
    ],
  ])('shows the %s sentence and a way to start again', async (reason, sentence) => {
    const fixture = open({
      complete: async () => Promise.reject(new QitsSignInError(reason, 'x')),
    });
    await settle();
    fixture.detectChanges();
    expect(navigate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Sign-in failed');
    expect(fixture.nativeElement.textContent).toContain(sentence);
    const link = fixture.nativeElement.querySelector('a[href="/"]') as HTMLAnchorElement;
    expect(link.textContent).toContain('Start again');
  });
});
