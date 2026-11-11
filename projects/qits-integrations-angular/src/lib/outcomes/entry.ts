/**
 * Route `data` for a route entered from outside the app — an idp redirect, an old bookmarked
 * address — rather than by an exit this app declares (ticket qits-2049, epic qits-2000). Route
 * data is plain, so `describeRoutes()` (`@qits/angular/testing/browser`) can read it into the
 * freeze manifest's `routes[].entry` without parsing source, and the outcome check
 * (`outcomeGaps()`) skips an entry point instead of asking for an inbound exit. The manifest key
 * is fixed at `qitsEntry`, so plain `data: { qitsEntry: true }` keeps working; this constant is
 * only the typed way to write it:
 *
 *   { path: '', data: QITS_ENTRY, ... }
 */
export const QITS_ENTRY = { qitsEntry: true } as const;
