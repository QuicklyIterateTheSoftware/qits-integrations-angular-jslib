/**
 * The app's route tree as data (ticket qits-1947): what the freeze manifest's `routes` holds, so a
 * reader can walk the frozen pages by route. No component is named and no lazy route is loaded:
 * `loadComponent` and `loadChildren` are never called.
 */
import type { Routes } from '@angular/router';

/** One route of {@link describeRoutes}. */
export interface RouteDescription {
  /** The route's own `path` (`''` when it has none, as a matcher route). */
  readonly path: string;
  /** The parents' paths and its own, joined by `/`, without the empty ones: `projects/:slug`. */
  readonly fullPath: string;
  /** The route's `redirectTo`, when it is a string. */
  readonly redirectTo?: string;
  /** The routes `children` declares (never those `loadChildren` would load). */
  readonly children?: RouteDescription[];
}

/** `routes` as {@link RouteDescription}s, in declaration order. */
export function describeRoutes(routes: Routes): RouteDescription[] {
  return describeUnder(routes, '');
}

function describeUnder(routes: Routes, parent: string): RouteDescription[] {
  return routes.map((route) => {
    const path = route.path ?? '';
    const fullPath = [parent, path].filter((part) => part !== '').join('/');
    const description: {
      path: string;
      fullPath: string;
      redirectTo?: string;
      children?: RouteDescription[];
    } = { path, fullPath };
    if (typeof route.redirectTo === 'string') description.redirectTo = route.redirectTo;
    if (route.children?.length) description.children = describeUnder(route.children, fullPath);
    return description;
  });
}
