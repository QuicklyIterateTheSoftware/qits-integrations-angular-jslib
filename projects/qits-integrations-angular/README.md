# @qits/angular

Integration library for Angular apps managed by [qits](https://github.com/wohlben/qits):
config.json-gated browser OTEL telemetry (traces + logs, route/interaction/caller enrichment,
error shipping), feature capture, state snapshots, and the platform's bearer sign-in
(`provideQitsBearerSignIn`). The telemetry is gated by the backend's
`api/config.json` relay — an app whose backend reports no telemetry target gets a library that
stays dark.

This file is the package's README: ng-packagr copies it into the published tarball, so it is what
the registry shows. The repository README is the full contract.

Published to qits' own registry under the `@qits` scope, so point the scope at it in `.npmrc`:

```ini
@qits:registry=https://registry.qits.wohlben.eu/artifacts/npm/npm/
```

```bash
pnpm add @qits/angular
```

**Peers:** `@angular/common`, `@angular/compiler`, `@angular/core` and `@angular/router` (`^21.2.0 || ^22.1.0`), `rxjs`
(`^7.4.0`), and
`@ngrx/signals` (`^21.0.0 || ^22.0.1`). The ngrx peer is required even if you never call
`withQitsSnapshot` — the single bundle imports it statically. On Angular 21, install
`@ngrx/signals@^21` alongside unless you already depend on it: npm auto-installs a missing peer at
its newest version, ngrx 22, which then fails ERESOLVE against Angular 21.

```ts
// main.ts — initQitsIntegration MUST complete before bootstrapApplication
initQitsIntegration()
  .catch(() => undefined)
  .then(() => bootstrapApplication(App, appConfig));

// app.config.ts
providers: [provideQitsIntegration(withFeatureCapture())];
```

Where an interaction leads is declared with `outcomes('<interaction>', { done: exit('projects/:slug'),
refused: stay() })`, linked with the `QitsExit` directive (`[exitQueryParams]`, `[exitFragment]`, an `isActive()`
signal with `aria-current="page"` in place of `routerLinkActive`, and `[exitCurrent]` to override that
`aria-current` with a token or `null`) and marked with `QitsTriggers`; an
exit's `go(params, { queryParams, fragment, replaceUrl })` takes the query and fragment too. The paths
are checked against the `RoutePath` type `qits/route-paths` generates. That file is opt-in: it is
only checked once the app creates it. `qits-angular screenshots --check` also flags a route no
declared exit leads to, unless its own route `data` marks it an **entry point** (reached from
outside the app, such as an idp redirect) with `QITS_ENTRY` — see the repository README.

More entry points (the package's own), all documented in the repository README:

- `@qits/angular/testing`: golden masters and Pact V4 consumer pacts for specs (Node only; needs
  `@pact-foundation/pact`).
- `@qits/angular/testing/browser`: the golden-master guard, the screenshot freezes (each shot's
  `kind`, `toMatchScreenshot(name, { kind: 'DATA' })`, the PHONE / TABLET / DESKTOP widths of
  `freezeScreenshots({ viewportSpecs })`, and the LIGHT / DARK schemes of
  `freezeScreenshots({ colorSchemes })`: `prefers-color-scheme` emulated and `data-theme` set on
  `<html>`, every shot taken in each as `<name>[-<viewport>]-light` / `-dark`, a shot opting out
  with `{ colorSchemes: ['LIGHT'], reason }`, and `qits-angular screenshots --check` failing on a
  page shot missing a scheme; expect twice the references, regenerated through the
  screenshot-baselines job) and `recordOutcomes()` for browser specs.
- `@qits/angular/pwa`: the installable offline shell, opt-in per app (`qits-pwa.json`):
  `provideQitsPwa()` registers Angular's service worker, `QitsPwaUpdates` watches for a new version
  and never reloads on its own, and `<qits-pwa-update-prompt />` lets the person reload, past every
  `QITS_PWA_RELOAD_GUARDS` entry. Needs the optional peer `@angular/service-worker`.
  `qits-angular pwa --write` writes the web manifest from the theme tokens, and
  `qits-angular pwa --check --dist <dir>` fails a build that does not install or start offline.
- `@qits/angular/eslint`: lint rules (`client-only-in-stores`, `store-has-pact`, `pact-names`, the route rules,
  `page-has-screenshots`, `page-screenshots-through-routes`, `page-screenshot-whole-page`, `screenshot-kind`, `route-paths`, which generates `src/app/route-paths.ts`, and `theme-colors`, off until an app turns it on) as
  a flat-config plugin: `export default [...yourConfig, ...qits.configs.recommended];`

The rest of the consumer contract — the backend endpoints, the capture and state-snapshot APIs,
serving under a path prefix — is in the
[repository README](https://github.com/QuicklyIterateTheSoftware/qits-integrations-angular-jslib#readme).
