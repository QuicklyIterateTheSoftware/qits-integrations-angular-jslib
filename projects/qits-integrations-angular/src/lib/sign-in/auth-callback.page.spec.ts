import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { QitsAuthCallbackPage } from './auth-callback.page';
import { QitsTokens } from './qits-tokens';

/** The page's work runs after a few awaits; let them run. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('QitsAuthCallbackPage', () => {
  let navigate: ReturnType<typeof vi.spyOn>;

  function open(callback?: Pick<QitsTokens, 'complete'>) {
    history.replaceState({}, '', '/auth/callback?code=C&state=S');
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        ...(callback ? [{ provide: QitsTokens, useValue: callback }] : []),
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    TestBed.createComponent(QitsAuthCallbackPage);
  }

  afterEach(() => history.replaceState({}, '', '/'));

  it('finishes the sign-in with the query and goes on to the path it answers', async () => {
    const complete = vi.fn(async (_query: URLSearchParams) => '/projects/qits');
    open({ complete });
    await settle();
    expect(complete.mock.calls[0][0].toString()).toBe('code=C&state=S');
    expect(navigate).toHaveBeenCalledWith('/projects/qits', { replaceUrl: true });
  });

  it('stays put when the sign-in fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    open({ complete: async () => Promise.reject(new Error('refused')) });
    await settle();
    expect(navigate).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('goes on to the root where nothing signs in this way', async () => {
    open();
    await settle();
    expect(navigate).toHaveBeenCalledWith('/', { replaceUrl: true });
  });
});
