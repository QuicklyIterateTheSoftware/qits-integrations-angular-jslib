# @qits/angular

Integration library for Angular apps managed by [qits](https://github.com/wohlben/qits):
config.json-gated browser OTEL telemetry (traces + logs, route/interaction/caller enrichment,
error shipping), feature capture, and state snapshots. Everything is gated by the backend's
`api/config.json` relay — an app whose backend reports no telemetry target gets a library that
stays dark.

This file is the package's README: ng-packagr copies it into the published tarball, so it is what
the registry shows. The repository README is the full contract.

Published to qits' internal registry under the `@qits` scope, so point the scope at it in `.npmrc`:

```ini
@qits:registry=http://localhost:8081/artifacts/npm/npm/
```

```bash
pnpm add @qits/angular
```

**Peers:** `@angular/core`, `@angular/router` and `@ngrx/signals` (^21). The ngrx peer is required
even if you never call `withQitsSnapshot` — the single bundle imports it statically.

```ts
// main.ts — initQitsIntegration MUST complete before bootstrapApplication
initQitsIntegration()
  .catch(() => undefined)
  .then(() => bootstrapApplication(App, appConfig));

// app.config.ts
providers: [provideQitsIntegration(withFeatureCapture())];
```

The rest of the consumer contract — the backend endpoints, the capture and state-snapshot APIs,
serving under a path prefix — is in the
[repository README](https://github.com/QuicklyIterateTheSoftware/qits-integrations-angular-jslib#readme).
