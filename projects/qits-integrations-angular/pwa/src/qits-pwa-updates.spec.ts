import { DOCUMENT, inject, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SwUpdate, type UnrecoverableStateEvent, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import {
  QITS_PWA_RELOAD_GUARDS,
  QitsPwaUpdates,
  type QitsPwaReloadGuard,
} from './qits-pwa-updates';

/** A `SwUpdate` the spec drives: its two streams are Subjects, its two calls spies. */
function fakeSwUpdate(isEnabled = true) {
  return {
    isEnabled,
    versionUpdates: new Subject<VersionEvent>(),
    unrecoverable: new Subject<UnrecoverableStateEvent>(),
    checkForUpdate: vi.fn(async () => true),
    activateUpdate: vi.fn(async () => true),
  };
}

/** The page: a `location` whose `reload` and `assign` are spies, and a visibility the spec sets. */
function fakeDocument() {
  const listeners = new Map<string, () => void>();
  return {
    visibilityState: 'visible' as DocumentVisibilityState,
    location: { reload: vi.fn(), assign: vi.fn(), replace: vi.fn(), href: 'http://localhost/' },
    addEventListener: vi.fn((type: string, listener: () => void) => listeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => listeners.delete(type)),
    fire: (type: string) => listeners.get(type)?.(),
  };
}

const READY: VersionEvent = {
  type: 'VERSION_READY',
  currentVersion: { hash: 'a' },
  latestVersion: { hash: 'b' },
};
const UNRECOVERABLE: UnrecoverableStateEvent = { type: 'UNRECOVERABLE_STATE', reason: 'gone' };

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('QitsPwaUpdates', () => {
  let sw: ReturnType<typeof fakeSwUpdate>;
  let doc: ReturnType<typeof fakeDocument>;

  function updates(
    options: { enabled?: boolean; platform?: string; guards?: QitsPwaReloadGuard[] } = {},
  ): QitsPwaUpdates {
    sw = fakeSwUpdate(options.enabled ?? true);
    doc = fakeDocument();
    TestBed.configureTestingModule({
      providers: [
        { provide: SwUpdate, useValue: sw },
        { provide: DOCUMENT, useValue: doc },
        { provide: PLATFORM_ID, useValue: options.platform ?? 'browser' },
        ...(options.guards ?? []).map((guard) => ({
          provide: QITS_PWA_RELOAD_GUARDS,
          multi: true,
          useValue: guard,
        })),
      ],
    });
    const service = TestBed.inject(QitsPwaUpdates);
    service.start();
    return service;
  }

  /** Nothing reloaded, navigated or activated. */
  function expectNoReload() {
    expect(doc.location.reload).not.toHaveBeenCalled();
    expect(doc.location.assign).not.toHaveBeenCalled();
    expect(doc.location.replace).not.toHaveBeenCalled();
    expect(sw.activateUpdate).not.toHaveBeenCalled();
  }

  it('starts current', () => {
    expect(updates().state()).toBe('current');
  });

  it('is ready after VERSION_READY, and neither reloads nor activates', async () => {
    const service = updates();
    sw.versionUpdates.next({ type: 'VERSION_DETECTED', version: { hash: 'b' } });
    expect(service.state()).toBe('current');
    sw.versionUpdates.next(READY);
    await settle();
    expect(service.state()).toBe('ready');
    expect(service.readyCount()).toBe(1);
    expectNoReload();
  });

  it('is broken after unrecoverable, and neither reloads nor activates', async () => {
    const service = updates();
    sw.unrecoverable.next(UNRECOVERABLE);
    await settle();
    expect(service.state()).toBe('broken');
    expectNoReload();
  });

  it('stays broken when a new version is ready after', () => {
    const service = updates();
    sw.unrecoverable.next(UNRECOVERABLE);
    sw.versionUpdates.next(READY);
    expect(service.state()).toBe('broken');
  });

  it('checks for a new version when the tab becomes visible, and swallows a failure', async () => {
    const service = updates();
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
    doc.visibilityState = 'visible';
    sw.checkForUpdate.mockRejectedValueOnce(new Error('offline'));
    doc.fire('visibilitychange');
    expect(sw.checkForUpdate).toHaveBeenCalledTimes(1);
    await expect(service.check()).resolves.toBe(true);
  });

  it('resolves a check that fails offline as false', async () => {
    const service = updates();
    sw.checkForUpdate.mockRejectedValueOnce(new Error('offline'));
    await expect(service.check()).resolves.toBe(false);
  });

  it('applies a ready version: activates it, then reloads', async () => {
    const service = updates({ guards: [() => true, async () => true as const] });
    sw.versionUpdates.next(READY);
    const order: string[] = [];
    sw.activateUpdate.mockImplementation(async () => (order.push('activate'), true));
    doc.location.reload.mockImplementation(() => order.push('reload'));
    await expect(service.apply()).resolves.toEqual({ applied: true });
    expect(order).toEqual(['activate', 'reload']);
  });

  it('reloads a broken tab without activating', async () => {
    const service = updates();
    sw.unrecoverable.next(UNRECOVERABLE);
    await expect(service.apply()).resolves.toEqual({ applied: true });
    expect(doc.location.reload).toHaveBeenCalledTimes(1);
    expect(sw.activateUpdate).not.toHaveBeenCalled();
  });

  it('holds apply on a refusing guard and resolves every reason', async () => {
    const service = updates({
      guards: [
        () => 'The outbox is sending 2 changes',
        () => true,
        async () => 'A form has unsaved changes',
        () => {
          throw new Error('guard broke');
        },
      ],
    });
    sw.versionUpdates.next(READY);
    await expect(service.apply()).resolves.toEqual({
      applied: false,
      reasons: ['The outbox is sending 2 changes', 'A form has unsaved changes', 'guard broke'],
    });
    expectNoReload();
    expect(service.state()).toBe('ready');
  });

  it('runs a guard in the injection context', async () => {
    const service = updates({ guards: [() => (inject(PLATFORM_ID) === 'browser' ? 'no' : true)] });
    await expect(service.apply()).resolves.toEqual({ applied: false, reasons: ['no'] });
  });

  it('is inert when the worker is disabled', async () => {
    const service = updates({ enabled: false });
    sw.versionUpdates.next(READY);
    sw.unrecoverable.next(UNRECOVERABLE);
    expect(service.state()).toBe('current');
    expect(doc.addEventListener).not.toHaveBeenCalled();
    await expect(service.check()).resolves.toBe(false);
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
  });

  it('is inert on the server', async () => {
    const service = updates({ platform: 'server' });
    sw.versionUpdates.next(READY);
    sw.unrecoverable.next(UNRECOVERABLE);
    expect(service.state()).toBe('current');
    expect(doc.addEventListener).not.toHaveBeenCalled();
    await expect(service.check()).resolves.toBe(false);
    expect(sw.checkForUpdate).not.toHaveBeenCalled();
  });

  it('starts once', () => {
    const service = updates();
    service.start();
    expect(doc.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('stops watching when the injector is destroyed', () => {
    updates();
    TestBed.resetTestingModule();
    expect(sw.versionUpdates.observed).toBe(false);
    expect(sw.unrecoverable.observed).toBe(false);
    expect(doc.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});
