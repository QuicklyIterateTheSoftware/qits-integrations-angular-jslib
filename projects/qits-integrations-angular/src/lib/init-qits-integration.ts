import { resetCaptureForTesting, setCaptureRelay } from './capture-config';
import { beginErrorBuffering, setErrorLogger } from './telemetry-error-handler';

export interface QitsIntegrationOptions {
  /** Where to fetch the identity relay; default 'api/config.json' (base-relative). */
  configUrl?: string;
  /**
   * Cross-origin URLs whose fetches carry the trace headers (`traceparent`, `tracestate`,
   * `baggage`), as OpenTelemetry's `propagateTraceHeaderCorsUrls`. Same-origin fetches always
   * carry them. Default: the page's own host and its subdomains (see `ownDomainUrlPattern`).
   * Pass `[]` to propagate same-origin only. Name only origins whose CORS allows those headers:
   * the browser refuses a request whose preflight does not.
   */
  propagateTraceHeaderCorsUrls?: (string | RegExp)[];
}

interface TelemetryRelay {
  resourceAttributes: Record<string, string>;
  serviceName: string;
}

let initialized = false;
let telemetryActive = false;

type TelemetrySdkModule = typeof import('./telemetry-sdk');

// The one place the OpenTelemetry SDK is imported. Dynamic on purpose: the consumer's bundler
// splits it into a lazy chunk, so a dark app never downloads it.
const defaultSdkLoader = (): Promise<TelemetrySdkModule> => import('./telemetry-sdk');
let sdkLoader = defaultSdkLoader;

/** Test seam: replace the SDK loader, to count calls or simulate a failed chunk load. */
export function setTelemetrySdkLoaderForTesting(loader: () => Promise<TelemetrySdkModule>): void {
  sdkLoader = loader;
}

/** Whether initQitsIntegration found a telemetry relay and lit the SDKs. */
export function isTelemetryActive(): boolean {
  return telemetryActive;
}

// The proto exporters POST via fetch() — FetchInstrumentation must exclude them or every export
// spawns a span exporting itself, forever.
export const OTLP_PASSTHROUGH_URL_PATTERN = /\/api\/otel\/v1\//;

/**
 * Matches http(s) URLs on `hostname` or any of its subdomains, on any port. With the app at the
 * platform apex (`qits.example.org`), that is every sibling app (`projects.qits.example.org`);
 * other domains stay out, so a third-party API never sees a header its CORS may refuse.
 */
export function ownDomainUrlPattern(hostname: string): RegExp {
  const host = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^https?://([^/?#@]+\\.)?${host}(:\\d+)?([/?#]|$)`, 'i');
}

// The exporters use a user-provided url verbatim (no /v1/<signal> appended) and resolve it
// against location.href, not <base> — so build absolute per-signal URLs from the rebased base.
//
// Base-relative on purpose: this addresses the *consumer app's own* backend (its OtelProxyResource
// copy), never qits directly. It therefore does NOT carry a qits gateway segment, and adding one
// would point every consumer app at a path its own backend does not serve.
export function otlpExportUrl(signal: 'traces' | 'logs'): string {
  return new URL(`api/otel/v1/${signal}`, document.baseURI).href;
}

/**
 * Browser telemetry, gated by the backend's identity relay: fetch the base-relative
 * api/config.json and stay dark when it reports `telemetry: null` (app running standalone, or the
 * qits daemon's otel toggle is off). When lit, export OTLP protobuf to the backend's own
 * api/otel/v1/* passthrough — base-relative like every other API call, so it works at `/` and
 * under the qits daemon web-view prefix alike.
 *
 * Two hops, and only the second one is qits'. The browser reaches the app's own backend
 * (`OtelProxyResource`, the byte-verbatim copy from the qits fixture); that resource forwards to
 * `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/{signal}`, which is now
 * `POST /observability/api/otel/v1/{traces,logs,metrics}` on qits-observability behind its own
 * gateway segment. Repointing the upstream is the backend's config, not this URL: the library
 * stays base-relative so the app keeps working standalone, at `/`, and framed under qits alike.
 *
 * The OpenTelemetry SDK itself (telemetry-sdk.ts) is loaded with a dynamic import() only once the
 * relay reports a telemetry target: it stays out of the consumer's initial bundle, and a dark app
 * never downloads it. The returned promise settles after that load, so awaiting it still means
 * "fetch is patched".
 *
 * Must complete before bootstrapApplication: Angular's FetchBackend captures window.fetch when it
 * is first used, so the fetch instrumentation has to patch it first for the app's API calls to
 * get client spans and traceparent propagation. The documented main.ts contract:
 *
 * ```ts
 * initQitsIntegration()
 *   .catch(() => undefined)
 *   .then(() => bootstrapApplication(App, appConfig))
 *   .catch((err) => console.error(err));
 * ```
 */
export async function initQitsIntegration(options?: QitsIntegrationOptions): Promise<void> {
  if (initialized) {
    return;
  }
  initialized = true;

  // Errors raised while the config and the SDK load are held, then shipped or dropped.
  beginErrorBuffering();

  let relay: TelemetryRelay | null;
  try {
    const configUrl = options?.configUrl ?? 'api/config.json';
    const response = await fetch(new URL(configUrl, document.baseURI).href);
    if (!response.ok) {
      setErrorLogger(undefined);
      return;
    }
    const config = await response.json();
    // Independently nullable sections: capture can be lit while telemetry is dark (and vice
    // versa), so stash it before the telemetry gate below.
    setCaptureRelay(config.capture ?? null);
    relay = config.telemetry ?? null;
  } catch {
    setErrorLogger(undefined);
    return; // telemetry is best-effort; never block the app
  }
  if (!relay) {
    setErrorLogger(undefined); // dark: the SDK is never loaded
    return;
  }

  let sdk: TelemetrySdkModule;
  try {
    sdk = await sdkLoader();
  } catch {
    setErrorLogger(undefined); // the chunk failed to load: stay dark rather than block the app
    return;
  }
  telemetryActive = true;
  setErrorLogger(
    sdk.startTelemetrySdk({
      resourceAttributes: relay.resourceAttributes,
      serviceName: relay.serviceName,
      traceExportUrl: otlpExportUrl('traces'),
      logExportUrl: otlpExportUrl('logs'),
      ignoreUrls: [OTLP_PASSTHROUGH_URL_PATTERN],
      propagateTraceHeaderCorsUrls: options?.propagateTraceHeaderCorsUrls ?? [
        ownDomainUrlPattern(location.hostname),
      ],
    }),
  );
}

/** Test seam: the module-level init guard would otherwise leak across specs. */
export function resetQitsIntegrationForTesting(): void {
  initialized = false;
  telemetryActive = false;
  sdkLoader = defaultSdkLoader;
  setErrorLogger(undefined);
  resetCaptureForTesting();
}
