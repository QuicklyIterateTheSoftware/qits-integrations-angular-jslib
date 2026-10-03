import { captureRelay, isCaptureActive } from './capture-config';
import {
  OTLP_PASSTHROUGH_URL_PATTERN,
  initQitsIntegration,
  isTelemetryActive,
  otlpExportUrl,
  ownDomainUrlPattern,
  resetQitsIntegrationForTesting,
  setTelemetrySdkLoaderForTesting,
} from './init-qits-integration';
import { TelemetryErrorHandler, setErrorLogger } from './telemetry-error-handler';

describe('initQitsIntegration', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
    resetQitsIntegrationForTesting();
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  function stubConfig(body: unknown, ok = true): ReturnType<typeof vi.fn> {
    const mock = vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) });
    window.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  it('stays dark on telemetry: null — no SDK constructed, window.fetch untouched', async () => {
    const mock = stubConfig({ telemetry: null });
    await initQitsIntegration();
    expect(isTelemetryActive()).toBe(false);
    expect(window.fetch).toBe(mock);
  });

  it('stays dark on a non-ok config response', async () => {
    stubConfig({}, false);
    await initQitsIntegration();
    expect(isTelemetryActive()).toBe(false);
  });

  it('stays dark, never throws, when the config fetch rejects', async () => {
    window.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    await expect(initQitsIntegration()).resolves.toBeUndefined();
    expect(isTelemetryActive()).toBe(false);
  });

  it('fetches the identity relay base-relative from api/config.json by default', async () => {
    const mock = stubConfig({ telemetry: null });
    await initQitsIntegration();
    expect(mock).toHaveBeenCalledWith(new URL('api/config.json', document.baseURI).href);
  });

  it('honors a custom configUrl, still base-relative', async () => {
    const mock = stubConfig({ telemetry: null });
    await initQitsIntegration({ configUrl: 'custom/relay.json' });
    expect(mock).toHaveBeenCalledWith(new URL('custom/relay.json', document.baseURI).href);
  });

  it('initializes once — a second call skips the config fetch', async () => {
    const mock = stubConfig({ telemetry: null });
    await initQitsIntegration();
    await initQitsIntegration();
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('stashes the capture relay even when telemetry is dark (independently nullable)', async () => {
    stubConfig({
      telemetry: null,
      capture: {
        ingestUrl: 'http://qits:8080/api/capture',
        resourceAttributes: { 'qits.repository.id': 'r1' },
      },
    });
    await initQitsIntegration();
    expect(isTelemetryActive()).toBe(false);
    expect(isCaptureActive()).toBe(true);
    expect(captureRelay()).toEqual({
      ingestUrl: 'http://qits:8080/api/capture',
      resourceAttributes: { 'qits.repository.id': 'r1' },
    });
  });

  it('capture stays dark on capture: null and on a config without the section', async () => {
    stubConfig({ telemetry: null, capture: null });
    await initQitsIntegration();
    expect(isCaptureActive()).toBe(false);

    resetQitsIntegrationForTesting();
    stubConfig({ telemetry: null });
    await initQitsIntegration();
    expect(isCaptureActive()).toBe(false);
  });

  it('goes lit on a relay: patches window.fetch (caller attribution + instrumentation)', async () => {
    const mock = stubConfig({
      telemetry: { serviceName: 'demo', resourceAttributes: { 'qits.workspace.id': 'w1' } },
    });
    await initQitsIntegration();
    expect(isTelemetryActive()).toBe(true);
    // installFetchCallerAttribution + FetchInstrumentation both wrap the stubbed fetch.
    expect(window.fetch).not.toBe(mock);
  });

  describe('the lazily loaded SDK', () => {
    const lit = { telemetry: { serviceName: 'demo', resourceAttributes: {} } };
    type Loaded = Awaited<ReturnType<Parameters<typeof setTelemetrySdkLoaderForTesting>[0]>>;

    /** A loader whose promise the test settles, around an SDK that hands out `emit`. */
    function deferredLoader(emit: ReturnType<typeof vi.fn>) {
      let settle!: (sdk: Loaded) => void;
      let fail!: (error: Error) => void;
      const loader = vi.fn(
        () =>
          new Promise<Loaded>((resolve, reject) => {
            settle = resolve;
            fail = reject;
          }),
      );
      setTelemetrySdkLoaderForTesting(loader);
      const sdk = { startTelemetrySdk: vi.fn(() => ({ emit }) as never) } as unknown as Loaded;
      return { loader, resolve: () => settle(sdk), reject: (e: Error) => fail(e) };
    }

    beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
    afterEach(() => vi.restoreAllMocks());

    it('is never loaded while dark', async () => {
      const loader = vi.fn();
      setTelemetrySdkLoaderForTesting(loader);
      stubConfig({ telemetry: null });
      await initQitsIntegration();
      stubConfig({}, false);
      resetQitsIntegrationForTesting();
      setTelemetrySdkLoaderForTesting(loader);
      await initQitsIntegration();
      expect(loader).not.toHaveBeenCalled();
    });

    it('is loaded once when lit, and errors reach the real SDK logger', async () => {
      // Wraps the real module: the export itself runs on Node's http transport under vitest, out
      // of reach of a fetch stub, so the test stops at the SDK logger the exporter drains.
      let emit: ReturnType<typeof vi.spyOn> | undefined;
      let settings: unknown;
      const real = vi.fn(async (): Promise<Loaded> => {
        const sdk = await import('./telemetry-sdk');
        return {
          startTelemetrySdk: (s: Parameters<typeof sdk.startTelemetrySdk>[0]) => {
            settings = s;
            const logger = sdk.startTelemetrySdk(s);
            emit = vi.spyOn(logger, 'emit');
            return logger;
          },
        };
      });
      setTelemetrySdkLoaderForTesting(real);
      const mock = stubConfig(lit);
      await initQitsIntegration();
      await initQitsIntegration();
      expect(real).toHaveBeenCalledTimes(1);
      expect(isTelemetryActive()).toBe(true);
      expect(window.fetch).not.toBe(mock);
      expect(settings).toMatchObject({
        serviceName: 'demo',
        traceExportUrl: otlpExportUrl('traces'),
        logExportUrl: otlpExportUrl('logs'),
      });

      new TelemetryErrorHandler().handleError(new Error('shipped'));
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ body: 'shipped' }));
    });

    it('ships errors raised while the SDK loads, once it arrives', async () => {
      const emit = vi.fn();
      const { loader, resolve } = deferredLoader(emit);
      stubConfig(lit);
      const init = initQitsIntegration();
      new TelemetryErrorHandler().handleError(new Error('early'));
      await vi.waitFor(() => expect(loader).toHaveBeenCalled());
      new TelemetryErrorHandler().handleError(new Error('while loading'));
      expect(emit).not.toHaveBeenCalled();
      resolve();
      await init;
      expect(emit.mock.calls.map(([record]) => record.body)).toEqual(['early', 'while loading']);
      expect(emit).toHaveBeenCalledWith(expect.objectContaining({ timestamp: expect.any(Number) }));
    });

    it('drops errors held during the config fetch when telemetry turns out dark', async () => {
      const emit = vi.fn();
      stubConfig({ telemetry: null });
      const init = initQitsIntegration();
      new TelemetryErrorHandler().handleError(new Error('early'));
      await init;
      // A logger set later must not receive the dropped record.
      setErrorLogger({ emit } as never);
      expect(emit).not.toHaveBeenCalled();
    });

    it('stays dark, never throws, when the SDK chunk fails to load', async () => {
      const { loader, reject } = deferredLoader(vi.fn());
      stubConfig(lit);
      const init = initQitsIntegration();
      await vi.waitFor(() => expect(loader).toHaveBeenCalled());
      reject(new Error('ChunkLoadError'));
      await expect(init).resolves.toBeUndefined();
      expect(isTelemetryActive()).toBe(false);
    });
  });

  describe('trace headers on cross-origin fetches', () => {
    const lit = { telemetry: { serviceName: 'demo', resourceAttributes: {} } };

    /** The headers the stub saw for `url`, as a plain lower-case map. */
    async function headersSent(mock: ReturnType<typeof vi.fn>, url: string) {
      await window.fetch(url);
      const init = mock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
      return Object.fromEntries(new Headers(init?.headers).entries());
    }

    it('by default, sends traceparent to subdomains of the page host only', async () => {
      const mock = stubConfig(lit);
      await initQitsIntegration();
      const sibling = `${location.protocol}//projects.${location.host}/projects/api/x`;
      expect(await headersSent(mock, sibling)).toHaveProperty('traceparent');
      expect(await headersSent(mock, 'https://elsewhere.test/x')).not.toHaveProperty('traceparent');
    });

    it('honors propagateTraceHeaderCorsUrls instead of the default', async () => {
      const mock = stubConfig(lit);
      await initQitsIntegration({ propagateTraceHeaderCorsUrls: [/^https:\/\/api\.test\//] });
      expect(await headersSent(mock, 'https://api.test/x')).toHaveProperty('traceparent');
      const sibling = `${location.protocol}//projects.${location.host}/x`;
      expect(await headersSent(mock, sibling)).not.toHaveProperty('traceparent');
    });
  });
});

describe('ownDomainUrlPattern', () => {
  const pattern = ownDomainUrlPattern('qits.example.org');

  it('matches the host and its subdomains, on any port and scheme http(s)', () => {
    expect(pattern.test('https://qits.example.org/x')).toBe(true);
    expect(pattern.test('https://projects.qits.example.org/projects/api/x')).toBe(true);
    expect(pattern.test('http://a.b.qits.example.org:8080')).toBe(true);
    expect(pattern.test('https://ci.qits.example.org?x=1')).toBe(true);
  });

  it('matches nothing else', () => {
    expect(pattern.test('https://example.org/x')).toBe(false);
    expect(pattern.test('https://evilqits.example.org/x')).toBe(false);
    expect(pattern.test('https://qits.example.org.evil.test/x')).toBe(false);
    expect(pattern.test('https://evil.test/qits.example.org')).toBe(false);
    expect(pattern.test('https://qits-example.org/x')).toBe(false);
  });
});

describe('otlpExportUrl', () => {
  it('builds absolute per-signal URLs from document.baseURI (exporters resolve verbatim)', () => {
    expect(otlpExportUrl('traces')).toBe(new URL('api/otel/v1/traces', document.baseURI).href);
    expect(otlpExportUrl('logs')).toBe(new URL('api/otel/v1/logs', document.baseURI).href);
  });
});

describe('OTLP_PASSTHROUGH_URL_PATTERN', () => {
  it('excludes the passthrough exports and nothing else', () => {
    expect(OTLP_PASSTHROUGH_URL_PATTERN.test('http://app/api/otel/v1/traces')).toBe(true);
    expect(
      OTLP_PASSTHROUGH_URL_PATTERN.test('http://app/workspaces/service/ws/svc-1/api/otel/v1/logs'),
    ).toBe(true);
    expect(OTLP_PASSTHROUGH_URL_PATTERN.test('http://app/api/greetings')).toBe(false);
  });
});
