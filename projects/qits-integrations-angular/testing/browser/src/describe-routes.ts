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
  /**
   * `true` when the route is entered from outside the app — an idp redirect, an old bookmarked
   * address — rather than by an exit this app declares (ticket qits-2049): `route.data`'s
   * `qitsEntry` key, as `QITS_ENTRY` sets it. The outcome check reads it to tell a legitimate entry
   * point from a route no exit leads to.
   */
  readonly entry?: true;
  /**
   * `true` when the route renders nothing of its own (ticket qits-2076): no `component`, no
   * `loadComponent`, no `loadChildren`, no `redirectTo` (a string or a function), a `path` other than
   * `**`, and every child (if it has any) renders nothing too. A layout's `''` child, or a `:tab`
   * child that only feeds the layout a parameter, is one; a componentless route grouping real pages
   * is not. The outcome check reads it to tell a page from a route that only stands for its parent.
   */
  readonly rendersNothing?: true;
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
      entry?: true;
      rendersNothing?: true;
      children?: RouteDescription[];
    } = { path, fullPath };
    if (typeof route.redirectTo === 'string') description.redirectTo = route.redirectTo;
    if (route.data?.['qitsEntry'] === true) description.entry = true;
    const children = route.children?.length ? describeUnder(route.children, fullPath) : undefined;
    if (
      !route.component &&
      !route.loadComponent &&
      !route.loadChildren &&
      route.redirectTo === undefined &&
      path !== '**' &&
      (children ?? []).every((child) => child.rendersNothing === true)
    ) {
      description.rendersNothing = true;
    }
    if (children) description.children = children;
    return description;
  });
}
