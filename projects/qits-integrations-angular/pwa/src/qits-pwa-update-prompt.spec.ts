import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { QitsPwaUpdatePrompt } from './qits-pwa-update-prompt';
import { type QitsPwaApplyResult, type QitsPwaState, QitsPwaUpdates } from './qits-pwa-updates';

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('QitsPwaUpdatePrompt', () => {
  let state: ReturnType<typeof signal<QitsPwaState>>;
  let readyCount: ReturnType<typeof signal<number>>;
  let apply: ReturnType<typeof vi.fn<() => Promise<QitsPwaApplyResult>>>;
  let fixture: ComponentFixture<QitsPwaUpdatePrompt>;

  beforeEach(async () => {
    state = signal<QitsPwaState>('current');
    readyCount = signal(0);
    apply = vi.fn(async (): Promise<QitsPwaApplyResult> => ({ applied: true }));
    TestBed.configureTestingModule({
      providers: [{ provide: QitsPwaUpdates, useValue: { state, readyCount, apply } }],
    });
    fixture = TestBed.createComponent(QitsPwaUpdatePrompt);
    await fixture.whenStable();
  });

  const host = (): HTMLElement => fixture.nativeElement;
  const button = (event: string) =>
    host().querySelector<HTMLButtonElement>(`button[data-track-event="${event}"]`);
  const text = () => host().textContent?.replace(/\s+/g, ' ').trim() ?? '';

  async function become(next: QitsPwaState) {
    if (next === 'ready') readyCount.update((n) => n + 1);
    state.set(next);
    await fixture.whenStable();
  }

  it('is hidden while current', () => {
    expect(host().children).toHaveLength(0);
  });

  it('offers Reload and Later when a version is ready', async () => {
    await become('ready');
    expect(text()).toContain('A new version is ready');
    expect(button('pwa-update-reload')?.textContent?.trim()).toBe('Reload');
    expect(button('pwa-update-later')?.textContent?.trim()).toBe('Later');
  });

  it('applies on Reload', async () => {
    await become('ready');
    button('pwa-update-reload')?.click();
    await fixture.whenStable();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('hides on Later until the next VERSION_READY', async () => {
    await become('ready');
    button('pwa-update-later')?.click();
    await fixture.whenStable();
    expect(host().children).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
    await become('ready');
    expect(text()).toContain('A new version is ready');
  });

  it('offers only Reload when the version can no longer be loaded', async () => {
    await become('broken');
    expect(text()).toContain('This version can no longer be loaded');
    expect(button('pwa-update-reload')).not.toBeNull();
    expect(button('pwa-update-later')).toBeNull();
  });

  it('shows itself when broken even after Later', async () => {
    await become('ready');
    button('pwa-update-later')?.click();
    await become('broken');
    expect(text()).toContain('This version can no longer be loaded');
  });

  it("shows a refusing guard's reasons", async () => {
    apply.mockResolvedValueOnce({
      applied: false,
      reasons: ['The outbox is sending 2 changes', 'A form has unsaved changes'],
    });
    await become('ready');
    button('pwa-update-reload')?.click();
    await settle();
    await fixture.whenStable();
    const reasons = [...host().querySelectorAll('li')].map((li) => li.textContent?.trim());
    expect(reasons).toEqual(['The outbox is sending 2 changes', 'A form has unsaved changes']);
    expect(text()).toContain('A new version is ready');
  });
});
