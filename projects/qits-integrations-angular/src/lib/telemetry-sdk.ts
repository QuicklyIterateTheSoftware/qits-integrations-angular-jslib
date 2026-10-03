import type { Logger } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { UserInteractionInstrumentation } from '@opentelemetry/instrumentation-user-interaction';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { BatchSpanProcessor, WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { installFetchCallerAttribution } from './fetch-caller-attribution';
import { enrichInteractionSpan } from './interaction-telemetry';
import { RouteStampingLogRecordProcessor, RouteStampingSpanProcessor } from './route-context';

/** What initQitsIntegration hands the lazily loaded SDK. */
export interface TelemetrySdkSettings {
  resourceAttributes: Record<string, string>;
  serviceName: string;
  traceExportUrl: string;
  logExportUrl: string;
  ignoreUrls: RegExp[];
  propagateTraceHeaderCorsUrls: (string | RegExp)[];
}

/**
 * The browser OpenTelemetry SDK. initQitsIntegration loads this module with a dynamic import()
 * only when the config relay reports a telemetry target, so its ~140 kB stay out of a consumer's
 * initial bundle, and a dark app never downloads them. Import nothing from here statically.
 *
 * Returns the logger the TelemetryErrorHandler ships errors through.
 */
export function startTelemetrySdk(settings: TelemetrySdkSettings): Logger {
  const resource = resourceFromAttributes({
    ...settings.resourceAttributes,
    // The distinct service name is what makes the qits log-tail service filter useful.
    'service.name': `${settings.serviceName}-browser`,
  });

  // Flush every second, not the default five: the qits web view is an iframe, and removing an
  // iframe (closing the floaty) fires no pagehide/visibilitychange — anything still buffered is
  // lost. A short interval shrinks that window to <=1s; dev traffic is tiny, so it costs nothing.
  const flush = { scheduledDelayMillis: 1000 };

  const tracerProvider = new WebTracerProvider({
    resource,
    spanProcessors: [
      new RouteStampingSpanProcessor(),
      new BatchSpanProcessor(new OTLPTraceExporter({ url: settings.traceExportUrl }), flush),
    ],
  });
  // Defaults: StackContextManager (zoneless apps) + W3C trace-context/baggage propagators.
  tracerProvider.register();

  // Before FetchInstrumentation patches fetch, so its patch wraps the wrapper — see the function.
  installFetchCallerAttribution();

  registerInstrumentations({
    instrumentations: [
      // Safe to register late: when the page has already loaded, it builds the documentLoad
      // spans from the performance timeline at once instead of waiting for the load event.
      new DocumentLoadInstrumentation(),
      new FetchInstrumentation({
        ignoreUrls: settings.ignoreUrls,
        // Sibling platform apps are cross-origin: without this they get no traceparent, and
        // their server spans start a new trace instead of joining the browser's.
        propagateTraceHeaderCorsUrls: settings.propagateTraceHeaderCorsUrls,
      }),
      // Clicks/submits become spans; synchronous work in the handler (zoneless apps use the
      // stack context manager) nests under them, so a submit-fired POST gets the interaction as
      // its trace root. Work behind an await/setTimeout escapes — accepted, no zone.js shipped.
      new UserInteractionInstrumentation({
        eventNames: ['click', 'submit'],
        shouldPreventSpanCreation: (_eventName, element, span) =>
          enrichInteractionSpan(element, span),
      }),
    ],
  });

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new RouteStampingLogRecordProcessor(),
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: settings.logExportUrl }),
        ...flush,
      }),
    ],
  });
  // No extra flush wiring: both batch processors also auto-flush on document hide by default
  // (tab switches); the short interval above covers iframe removal, which hides nothing.
  return loggerProvider.getLogger('browser-errors');
}
