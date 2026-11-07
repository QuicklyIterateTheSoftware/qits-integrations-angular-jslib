import { inject, provideAppInitializer, type EnvironmentProviders } from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { trace, type Span } from '@opentelemetry/api';
import { isCaptureActive } from './capture-config';
import { isTelemetryActive } from './init-qits-integration';
import { routeAttributes, setCurrentRoute } from './route-context';

/**
 * Navigation spans + the route tracking behind the stamping processors. Router wiring needs the
 * injector, so it can't live in the pre-bootstrap initQitsIntegration(); as an app initializer it
 * subscribes before the router's initial navigation, so the first load and any redirect
 * component's replaceUrl hop are both captured. No-op while telemetry is dark.
 */
export function provideRouteTelemetry(): EnvironmentProviders {
  return provideAppInitializer(() => {
    // Also installed when only capture is lit: with no tracer provider registered the Navigation
    // spans are global no-ops, but the setCurrentRoute tracking is what gives a capture payload
    // its routePattern.
    if (!isTelemetryActive() && !isCaptureActive()) {
      return;
    }
    installRouteTelemetry(inject(Router));
  });
}

export function installRouteTelemetry(router: Router): void {
  const tracer = trace.getTracer('app-navigation');
  let navigationSpan: Span | undefined;
  const end = (result: string, url: string) => {
    navigationSpan?.setAttributes({
      ...routeAttributes(),
      'app.route.url': url,
      'app.navigation.result': result,
    });
    navigationSpan?.end();
    navigationSpan = undefined;
  };
  router.events.subscribe((event) => {
    if (event instanceof NavigationStart) {
      navigationSpan?.end(); // defensive: never leak a span across overlapping navigations
      // Started in the ambient context, never made active: fetches during navigation don't
      // parent under it — but a navigation triggered synchronously from a handler nests under
      // that interaction span, keeping cause and effect in one trace.
      navigationSpan = tracer.startSpan('Navigation', {
        attributes: { 'app.route.url': event.url },
      });
    } else if (event instanceof NavigationEnd) {
      setCurrentRoute({
        path: matchedRoutePath(router.routerState.snapshot),
        url: event.urlAfterRedirects,
      });
      end('success', event.urlAfterRedirects);
    } else if (event instanceof NavigationCancel) {
      end('cancel', event.url);
    } else if (event instanceof NavigationError) {
      end('error', event.url);
    } else if (event instanceof NavigationSkipped) {
      end('skipped', event.url);
    }
  });
}

/**
 * The matched config path ("greeting/:name"), not the concrete URL — groups without cardinality.
 * Exported: the golden-master guard (`@qits/angular/testing/browser`) records the same pattern as
 * the route a pact interaction happens on, so the pact and `app.route.path` name a route alike.
 */
export function matchedRoutePath(state: RouterStateSnapshot): string {
  const segments: string[] = [];
  for (let node: ActivatedRouteSnapshot | null = state.root; node; node = node.firstChild) {
    if (node.routeConfig?.path) {
      segments.push(node.routeConfig.path);
    }
  }
  return segments.join('/');
}
