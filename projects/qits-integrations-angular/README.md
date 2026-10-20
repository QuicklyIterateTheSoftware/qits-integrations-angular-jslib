# @qits/angular

Integration library for Angular apps managed by [qits](https://github.com/wohlben/qits):
config.json-gated browser OTEL telemetry (traces + logs, route/interaction/caller enrichment,
error shipping), feature capture, and state snapshots. Everything is gated by the backend's
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

**Peers:** `@angular/common`, `@angular/core` and `@angular/router` (`^21.2.0 || ^22.1.0`), and
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

Two more entry points, both documented in the repository README:

- `@qits/angular/testing`: golden masters and Pact V4 consumer pacts for specs (Node only; needs
  `@pact-foundation/pact`).
- `@qits/angular/eslint`: lint rules (`client-only-in-stores`, `store-has-pact`, `pact-names`, the route rules,
  `page-has-screenshots`) as
  a flat-config plugin: `export default [...yourConfig, ...qits.configs.recommended];`

The rest of the consumer contract — the backend endpoints, the capture and state-snapshot APIs,
serving under a path prefix — is in the
[repository README](https://github.com/QuicklyIterateTheSoftware/qits-integrations-angular-jslib#readme).
