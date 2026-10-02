import type { Attributes } from '@opentelemetry/api';
import type { LogRecordProcessor, SdkLogRecord } from '@opentelemetry/sdk-logs';
import type { Span as SdkSpan, SpanProcessor } from '@opentelemetry/sdk-trace-web';

// Current-route state: written by the route-telemetry router subscription, read by the stamping
// processors below. Before the first NavigationEnd only the concrete URL is known (covers
// documentLoad); the matched pattern is omitted rather than faked with a concrete URL, which
// would pollute the pattern attribute's grouping. On the server there is no `location`: importing
// this module during SSR must not throw, so the URL starts as '/' there.
const initialUrl = (): string => (typeof location === 'undefined' ? '/' : location.pathname);
let currentRoute: { path?: string; url: string } = { url: initialUrl() };

export function setCurrentRoute(route: { path?: string; url: string }): void {
  currentRoute = route;
}

/** The matched route pattern ("greeting/:name"), if a NavigationEnd has established one yet. */
export function currentRoutePattern(): string | undefined {
  return currentRoute.path;
}

export function routeAttributes(): Attributes {
  return {
    ...(currentRoute.path !== undefined && { 'app.route.path': currentRoute.path }),
    'app.route.url': currentRoute.url,
  };
}

/** Stamps the current route on every span, so "on which page" needs no query change. */
export class RouteStampingSpanProcessor implements SpanProcessor {
  onStart(span: SdkSpan): void {
    span.setAttributes(routeAttributes());
  }
  onEnd(): void {
    // Attributes are stamped at start; nothing to do at end.
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** The log-record twin of RouteStampingSpanProcessor: every log record answers "on which page". */
export class RouteStampingLogRecordProcessor implements LogRecordProcessor {
  onEmit(record: SdkLogRecord): void {
    record.setAttributes(routeAttributes());
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Test seam: the module-level route state would otherwise leak across specs. */
export function resetRouteContextForTesting(): void {
  currentRoute = { url: initialUrl() };
}
