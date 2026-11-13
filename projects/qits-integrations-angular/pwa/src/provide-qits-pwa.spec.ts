import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwRegistrationOptions } from '@angular/service-worker';
import { provideQitsPwa } from './provide-qits-pwa';
import { QitsPwaUpdates } from './qits-pwa-updates';

/** A browser with service workers: jsdom has none, so the spec gives it a container to register in. */
function stubServiceWorker() {
  const container = {
    controller: null,
    register: vi.fn(async () => ({})),
    getRegistration: vi.fn(async () => undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  return container;
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('provideQitsPwa', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('registers ngsw-worker.js when enabled, as a production build is', async () => {
    const container = stubServiceWorker();
    TestBed.configureTestingModule({
      providers: [provideQitsPwa({ enabled: true, registrationStrategy: 'registerImmediately' })],
    });
    TestBed.inject(ApplicationRef);
    await settle();
    expect(container.register).toHaveBeenCalledWith('ngsw-worker.js', expect.anything());
  });

  it('defaults to production builds only, registering once stable or after 30 s', () => {
    stubServiceWorker();
    TestBed.configureTestingModule({ providers: [provideQitsPwa()] });
    // The specs run in dev mode, as `ng serve` does: no worker.
    expect(TestBed.inject(SwRegistrationOptions)).toEqual({
      enabled: false,
      registrationStrategy: 'registerWhenStable:30000',
    });
  });

  it('registers nothing in dev mode', async () => {
    const container = stubServiceWorker();
    TestBed.configureTestingModule({ providers: [provideQitsPwa()] });
    TestBed.inject(ApplicationRef);
    await settle();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('takes another script', async () => {
    const container = stubServiceWorker();
    TestBed.configureTestingModule({
      providers: [
        provideQitsPwa({
          script: 'custom-worker.js',
          enabled: true,
          registrationStrategy: 'registerImmediately',
        }),
      ],
    });
    TestBed.inject(ApplicationRef);
    await settle();
    expect(container.register).toHaveBeenCalledWith('custom-worker.js', expect.anything());
  });

  it('starts QitsPwaUpdates', () => {
    stubServiceWorker();
    const start = vi.spyOn(QitsPwaUpdates.prototype, 'start');
    TestBed.configureTestingModule({
      providers: [provideQitsPwa({ enabled: true, registrationStrategy: 'registerImmediately' })],
    });
    TestBed.inject(ApplicationRef);
    expect(start).toHaveBeenCalledTimes(1);
    start.mockRestore();
  });
});
