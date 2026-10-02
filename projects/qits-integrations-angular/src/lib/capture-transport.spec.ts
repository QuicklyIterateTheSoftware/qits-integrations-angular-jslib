import type { CapturePayload } from './capture-payload';
import {
  CaptureError,
  SERVICE_PROXY_BASE_PATTERN,
  captureApiAvailable,
  captureTargetUrl,
  postCapture,
} from './capture-transport';

const RELAY = {
  ingestUrl: 'http://qits:8080/api/capture',
  resourceAttributes: { 'qits.repository.id': 'r1' },
};

function payload(): CapturePayload {
  return {
    capturedAt: '2026-07-14T00:00:00.000Z',
    identity: { 'qits.repository.id': 'r1', 'qits.workspace.id': null },
    page: { url: location.href, appPath: '', routePattern: null, title: '' },
    environment: {
      viewport: { width: 1, height: 1, devicePixelRatio: 1 },
      userAgent: 'spec',
      prefersColorScheme: 'light',
    },
    dom: { html: '<html></html>', truncated: false, bytes: 13 },
  };
}

async function gunzipJson(body: ArrayBuffer): Promise<unknown> {
  const stream = new Response(body).body!.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

describe('captureTargetUrl', () => {
  const originalPath = location.pathname;

  afterEach(() => {
    history.replaceState(null, '', originalPath);
  });

  it('uses the relayed ingestUrl verbatim when not framed under the service proxy', () => {
    history.replaceState(null, '', '/greeting/anna');
    expect(captureTargetUrl(RELAY)).toBe('http://qits:8080/api/capture');
  });

  it('posts same-origin under a /workspaces/service/{ws}/{svc}/ base — the frame origin IS qits', () => {
    history.replaceState(null, '', '/workspaces/service/work/svc-1/greeting/anna');
    expect(captureTargetUrl(RELAY)).toBe(new URL('/workspaces/api/capture', location.origin).href);
  });

  it('carries qits-workspaces gateway segment: the gateway routes by prefix, verbatim', () => {
    history.replaceState(null, '', '/workspaces/service/work/svc-1/greeting/anna');
    expect(new URL(captureTargetUrl(RELAY)).pathname).toBe('/workspaces/api/capture');
  });

  it('the service proxy base needs both path parameters', () => {
    expect(SERVICE_PROXY_BASE_PATTERN.test('/workspaces/service/only-one/')).toBe(false);
    expect(SERVICE_PROXY_BASE_PATTERN.test('/workspaces/service/ws/svc-1/')).toBe(true);
  });
});

describe('captureApiAvailable', () => {
  let originalFetch: typeof fetch;
  const originalPath = location.pathname;

  beforeEach(() => {
    originalFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
    history.replaceState(null, '', originalPath);
  });

  it('is available when the target answers the OPTIONS probe (qits CORS route: 204)', async () => {
    const mock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    window.fetch = mock as unknown as typeof fetch;
    await expect(captureApiAvailable(RELAY)).resolves.toBe(true);
    expect(mock).toHaveBeenCalledWith(RELAY.ingestUrl, { method: 'OPTIONS' });
  });

  // The CORS preflight is a raw Vert.x route and moved to the segment by hand, separately from
  // the JAX-RS POST. Probe and POST must address the same path or the button silently vanishes.
  it('probes the same prefixed path the POST would use when framed under the proxy', async () => {
    history.replaceState(null, '', '/workspaces/service/work/svc-1/greeting/anna');
    const mock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    window.fetch = mock as unknown as typeof fetch;
    await expect(captureApiAvailable(RELAY)).resolves.toBe(true);
    expect(mock).toHaveBeenCalledWith(captureTargetUrl(RELAY), { method: 'OPTIONS' });
    expect(mock).toHaveBeenCalledWith(new URL('/workspaces/api/capture', location.origin).href, {
      method: 'OPTIONS',
    });
  });

  it('is unavailable on a 404 (backend without the ingest)', async () => {
    window.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch;
    await expect(captureApiAvailable(RELAY)).resolves.toBe(false);
  });

  it('is unavailable when the target is unreachable', async () => {
    window.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(captureApiAvailable(RELAY)).resolves.toBe(false);
  });
});

describe('postCapture', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  function stubFetch(response: Partial<Response> | Error): ReturnType<typeof vi.fn> {
    const mock =
      response instanceof Error
        ? vi.fn().mockRejectedValue(response)
        : vi.fn().mockResolvedValue(response);
    window.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  it('gzip-POSTs the payload; the body decompresses back to the JSON document', async () => {
    const mock = stubFetch({
      status: 201,
      json: () => Promise.resolve({ url: 'http://qits/workspace' }),
    } as Partial<Response>);
    const result = await postCapture(payload(), 'http://qits:8080/api/capture');

    expect(result).toEqual({ url: 'http://qits/workspace' });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://qits:8080/api/capture');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    });
    await expect(gunzipJson(init.body as ArrayBuffer)).resolves.toEqual(payload());
  });

  it('rejects with a CaptureError on a non-201 status', async () => {
    stubFetch({ status: 413 } as Partial<Response>);
    await expect(postCapture(payload(), 'http://x/api/capture')).rejects.toThrowError(CaptureError);
  });

  it('rejects with a CaptureError when the endpoint is unreachable', async () => {
    stubFetch(new Error('offline'));
    await expect(postCapture(payload(), 'http://x/api/capture')).rejects.toThrow(
      'Could not reach the qits capture endpoint',
    );
  });

  it('rejects when a 201 carries no workspace URL', async () => {
    stubFetch({ status: 201, json: () => Promise.resolve({}) } as Partial<Response>);
    await expect(postCapture(payload(), 'http://x/api/capture')).rejects.toThrow(
      'no workspace URL',
    );
  });
});
