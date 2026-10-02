import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { QitsCaptureButton } from './capture-button.component';
import { resetCaptureForTesting, setCaptureRelay } from './capture-config';
import { setNavigateTopForTesting } from './capture-navigation';
import type { CapturePayload } from './capture-payload';

/**
 * The full gesture — pick an element, then freeze this very document — needs a real layout engine,
 * so this runs in Vitest browser mode.
 */

const RELAY = {
  ingestUrl: 'http://qits:8080/api/capture',
  resourceAttributes: { 'qits.repository.id': 'repo-1', 'qits.workspace.id': 'work-1' },
};

async function gunzipJson(body: ArrayBuffer): Promise<CapturePayload> {
  const stream = new Response(body).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json() as Promise<CapturePayload>;
}

describe('QitsCaptureButton', () => {
  let fixture: ComponentFixture<QitsCaptureButton>;
  let originalFetch: typeof fetch;
  let navigate: ReturnType<typeof vi.fn<(url: string) => void>>;
  let target: HTMLElement;

  beforeEach(() => {
    originalFetch = window.fetch;
    navigate = vi.fn<(url: string) => void>();
    setNavigateTopForTesting(navigate);
    setCaptureRelay(RELAY);
    // The pick target: a leaf inside a custom app-* component, appended to the real document.
    target = document.createElement('app-widget');
    target.innerHTML = '<button id="go">Go</button>';
    document.body.appendChild(target);
    fixture = TestBed.createComponent(QitsCaptureButton);
    fixture.detectChanges();
  });

  afterEach(() => {
    window.fetch = originalFetch;
    setNavigateTopForTesting(undefined);
    resetCaptureForTesting();
    target.remove();
    document.querySelectorAll('[data-qits-pick-overlay]').forEach((n) => {
      if (n.tagName.toLowerCase() !== 'qits-capture-button') {
        n.remove();
      }
    });
  });

  function stubFetch(
    response: Partial<Response> | Promise<Partial<Response>>,
  ): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockReturnValue(Promise.resolve(response));
    window.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  function pressButton(): void {
    (fixture.nativeElement as HTMLElement).querySelector('button')!.click();
  }

  function pick(element: Element): void {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  it('press → pick → gzip POST carrying the frozen page, picked component and identity → navigate', async () => {
    let releaseIngest!: (r: Partial<Response>) => void;
    const mock = stubFetch(new Promise<Partial<Response>>((r) => (releaseIngest = r)));

    pressButton();
    // Picking: the button reflects the armed state and won't re-arm.
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    expect(button.classList.contains('qits-capture-picking')).toBe(true);
    expect(button.disabled).toBe(true);
    expect(mock).not.toHaveBeenCalled();

    pick(target.querySelector('#go')!);
    await vi.waitFor(() => expect(mock).toHaveBeenCalled());

    releaseIngest({ status: 201, json: () => Promise.resolve({ url: 'http://qits/new-ws' }) });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('http://qits/new-ws'));

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RELAY.ingestUrl);
    const payload = await gunzipJson(init.body as ArrayBuffer);
    expect(payload.identity).toEqual({
      'qits.repository.id': 'repo-1',
      'qits.workspace.id': 'work-1',
    });
    // The whole-page snapshot is body-trimmed; the button never captures itself.
    expect(payload.dom.html).toContain('<!doctype html>');
    expect(payload.dom.html).not.toContain('<qits-capture-button');
    // The pick's owning app-* component is frozen alongside, with its provenance.
    expect(payload.selection?.component).toBe('app-widget');
    expect(payload.selection?.tag).toBe('button');
    expect(payload.selection?.selector).toBe('#go');
    expect(payload.selection?.html.startsWith('<app-widget')).toBe(true);
  });

  it('cancelling the pick (Escape) returns to idle without posting', async () => {
    const mock = stubFetch({ status: 201, json: () => Promise.resolve({ url: 'x' }) });

    pressButton();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    await vi.waitFor(() => {
      fixture.detectChanges();
      const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
      expect(button.classList.contains('qits-capture-picking')).toBe(false);
      expect(button.disabled).toBe(false);
    });
    expect(mock).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a failed ingest shows a retry-able toast, never navigates — and a re-pick re-posts', async () => {
    const failing = stubFetch({ status: 500 } as Partial<Response>);

    pressButton();
    pick(target.querySelector('#go')!);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        (fixture.nativeElement as HTMLElement).querySelector('.qits-capture-toast'),
      ).not.toBeNull();
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(failing).toHaveBeenCalledTimes(1);

    // The app is undisturbed and the button pressable — the next press re-arms the whole gesture.
    stubFetch({ status: 201, json: () => Promise.resolve({ url: 'http://qits/new-ws' }) });
    pressButton();
    pick(target.querySelector('#go')!);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('http://qits/new-ws'));
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.qits-capture-toast')).toBeNull();
  });
});
