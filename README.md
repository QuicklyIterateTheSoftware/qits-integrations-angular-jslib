# @qits/angular

The integration library for Angular apps managed by [qits](https://github.com/wohlben/qits) —
a tool that runs each git branch as a containerized workspace with dev-server daemons, telemetry,
a web view, and a coding agent. Instead of copy-pasting integration files from a fixture repo,
an app takes this library as a dependency.

The library packages the SPA half of the qits observability convention
([spa-observability](https://github.com/wohlben/qits/blob/main/docs/features/2026-07-06_spa-observability.md),
[meta-enrichment](https://github.com/wohlben/qits/blob/main/docs/features/2026-07-11_spa-telemetry-meta-enrichment.md)).
When the backend's identity relay reports a telemetry target, the app exports OTLP protobuf
traces + logs through its own backend's passthrough:

- document-load + fetch spans (client spans with `traceparent` propagation into the backend trace);
- `Navigation` spans and `app.route.path`/`app.route.url` stamped on **every** span and log record;
- click/submit interaction spans, named by a `data-track-event` DOM attribute;
- `code.*` caller attribution on fetch spans (which file/method issued the request);
- uncaught errors shipped as ERROR-severity log records via a provided Angular `ErrorHandler`.

Everything is gated by the backend's `api/config.json` relay: an app whose backend reports no
telemetry target gets `telemetry: null` and the library stays **dark** — no SDK objects constructed,
`window.fetch` untouched, inert dead weight. There is no build-time configuration; the config relay
is the only runtime channel.

That is the standalone case today and also the qits case: qits currently injects no
`OTEL_EXPORTER_OTLP_ENDPOINT` into the services it launches, so a workspace's dev server has no
telemetry target to report. This library needs no change when that comes back — the relay is the
only thing it reads.

The library also ships **feature capture** (`withFeatureCapture()`): a floaty button that
snapshots the running app — the rendered DOM with effective styles frozen inline, route, viewport
metadata — POSTs it to qits' capture ingest, and lands the user in a freshly created qits
workspace whose goal carries the captured context. Gated by the relay's `capture` section, same
dark-by-default stance. **State snapshots** ride along: state the app registers (one line per
`@ngrx/signals` store via `withQitsSnapshot`, or `registerCaptureState` for anything else) lands
in the capture's goal as JSON — what the app *knew*, not just what it rendered.

## Install

`@qits/angular` is published to qits' own npm registry, hosted by qits-artifacts. Nothing is
published to npmjs.org, so a consumer routes the `@qits` scope — and, ideally, everything else —
through the platform. One committed `.npmrc` carries the routing and no credential:

```ini
registry=http://localhost:8082/artifacts/npm/npmjs/   # pull-through cache of npmjs
@qits:registry=http://localhost:8081/artifacts/npm/npm/
```

```bash
pnpm add @qits/angular
```

Those are the **local platform's** host-published addresses — the ports a developer on the
deployment host already dials. They are two services since the byte-plane split: the cache belongs
to qits-platform-mirror, the hosted scope to qits-artifacts. Inside the platform's own network the
aliases are `http://qits-platform-mirror:8080/artifacts/npm/npmjs/` and
`http://qits-artifacts:8080/artifacts/npm/npm/`, which is what qits-ci's pipelines write
into `~/.npmrc` from `$QITS_NPM_PROXY_URL` / `$QITS_NPM_REGISTRY_URL`; a consumer repo's committed
file is overwritten by that preamble in CI, so it only has to be right for humans. The registry
takes no credential in either direction — see the qits-artifacts-service README for the posture.

The tarball ships **prebuilt** (the ng-packagr output), so an install runs no build: no `prepare`
hook, no `pnpm.onlyBuiltDependencies` allowlist, no Angular toolchain in the consumer.

**Peers:** `@angular/core`, `@angular/router`, and `@ngrx/signals` (^21). The ngrx peer is
required even if you never call `withQitsSnapshot` — the library's single bundle imports it
statically, so it must be resolvable in every consumer.

> **Historical note.** Before the registry existed, distribution was git-only: consumers ran
> `pnpm add "git+https://…#<sha>"`, which installed the **repo root** and built it on their
> machine through a `prepare` hook — and needed `{"pnpm": {"onlyBuiltDependencies":
> ["@qits/angular"]}}` in their own manifest to let that hook run under pnpm 10. Both are gone.
> A `#<sha>` pin still resolves against the commits that carried that shape, but nothing on `main`
> supports it: the root manifest is a workspace harness now and installs as an empty package.

**Zoneless apps:** `@opentelemetry/instrumentation-user-interaction` (a dependency of this
library) declares a hard `zone.js` peer it doesn't actually need in a zoneless app. Mark it
optional in the consumer's `package.json` so the lockfile stays zone-free (a peer-warning
silencer only — the install works without it):

```json
{
  "pnpm": {
    "packageExtensions": {
      "@opentelemetry/instrumentation-user-interaction": {
        "peerDependenciesMeta": { "zone.js": { "optional": true } }
      }
    }
  }
}
```

## Usage

Two lines, and the ordering of the first is load-bearing:

```ts
// main.ts — initQitsIntegration MUST complete before bootstrapApplication: Angular's
// FetchBackend captures window.fetch on first use, so the fetch instrumentation has to patch it
// first for API calls to get client spans and traceparent propagation.
initQitsIntegration()
  .catch(() => undefined)
  .then(() => bootstrapApplication(App, appConfig))
  .catch((err) => console.error(err));
```

```ts
// app.config.ts
providers: [
  provideBrowserGlobalErrorListeners(), // keep the scaffold default: feeds global errors into the ErrorHandler
  provideRouter(routes),
  provideQitsIntegration(),             // ErrorHandler + Navigation spans + app.route.* stamping
  provideHttpClient(withFetch()),       // required: the default XHR backend is invisible to the fetch instrumentation
],
```

Name interactions with a framework-free DOM attribute — put `data-track-event="<name>"` on the
event **target or an ancestor** (a submit event's target is the *form*, so name forms, not their
buttons):

```html
<form data-track-event="save-greeting" (ngSubmit)="submit()">…</form>
```

### Feature capture

```ts
provideQitsIntegration(withFeatureCapture()),
```

renders a fixed bottom-left capture button (bottom-left so it never collides with qits' own
bottom-right floaties when the app runs framed in the qits web view; styling is self-contained).
The button appears only when the config relay reports a `capture` section (below) **and** the
ingest answers an `OPTIONS` availability probe — qits' CORS route replies 204 where the API
exists; a backend without it 404s and an unreachable target throws, both of which keep the
button hidden instead of doomed. Pressing it is
the whole gesture: spinner → document-scoped style freeze → gzip POST to the ingest → on `201`
the **top** window navigates to the created workspace (so a capture from inside the qits web view
lands the qits tab there, not the framed app). On failure: a retry-able toast, the app
undisturbed.

Bring your own trigger with `withFeatureCapture({ renderButton: false })` and the exported
`captureNow(): Promise<{url}>` — it resolves instead of navigating. `maxDomBytes` (default 2 MB
pre-compression) caps the frozen DOM; over it the snapshot truncates depth-first and sets
`dom.truncated`. The freeze core is exported as `freezeDocument()` for reuse.

Where the POST goes: framed under the qits service proxy (`/workspaces/service/{ws}/{svc}/` base) the frame
origin *is* qits, so the button posts same-origin to `/workspaces/api/capture` — the capture ingest
is `qits-workspaces`, and the qits gateway routes `/<segment>/*` verbatim by prefix, so the segment
is part of the address and not something the gateway adds. Everywhere else it uses the relayed
`ingestUrl` verbatim — which must then be **browser-reachable** (deployed apps configure a public
URL).

### State snapshots

A frozen DOM shows the symptom; state shows the cause. Registered state is serialized into the
capture payload's `state` field and rendered as JSON in the workspace goal. For an
`@ngrx/signals` store, one self-registering line:

```ts
export const CartStore = signalStore(
  { providedIn: 'root' },
  withState(initialCart),
  withQitsSnapshot('cart'),   // registers on init, unregisters on destroy
);
```

Only `withState` slices are captured (computeds are derivable and excluded). For everything else
— plain signals, services, anything callable — the escape hatch:

```ts
const unregister = registerCaptureState('session', () => ({ user: auth.user()?.name ?? null }));
```

Suppliers run **lazily at capture time only**: zero cost until the button is pressed, and the
snapshot is of that moment. Captures never fail because of one bad store — a throwing supplier
contributes `{"$error": …}`, and every value passes a JSON-safe sanitizer: depth cap 8
(`"$depth-capped"`), 64 kB per entry (`{"$truncated": true}`), cycles → `"$circular"`,
functions / DOM nodes / class instances / typed arrays → `"$unserializable(<type>)"`, `Map`/`Set`
converted, `Date` → ISO string, `BigInt` → decimal string.

**Redaction is your job.** The library cannot guess what is sensitive — register a projection
instead of the raw state:

```ts
registerCaptureState('profile', () => ({ ...getState(store), token: undefined }));
```

### The backend contract

The library talks only to its own backend, base-relative (so it works at `/` and under the qits
web-view path prefix alike):

- `GET api/config.json` — the identity relay. `{ "telemetry": null }` keeps the library dark;
  `{ "telemetry": { "serviceName": …, "resourceAttributes": … } }` lights it (the browser's
  service name gets a `-browser` suffix). Override the path via
  `initQitsIntegration({ configUrl: … })`. Feature capture reads its own independently-nullable
  section from the same relay: `{ "capture": { "ingestUrl": …, "resourceAttributes": … } }` —
  built from `QITS_CAPTURE_ENDPOINT` under a qits daemon, an `application.properties` value in a
  deployed build; `capture: null` hides the button. The library self-stamps the relayed
  `qits.repository.id`/`qits.workspace.id` into the payload; the ingest fails closed on identity
  it can't resolve.
- `POST api/otel/v1/{traces|logs}` — verbatim OTLP protobuf passthrough to the real collector,
  which is `POST /observability/api/otel/v1/{traces|logs|metrics}` on qits-observability behind
  its gateway segment. That upstream is the backend's `OTEL_EXPORTER_OTLP_ENDPOINT`, not this
  path: the library stays base-relative and carries **no** qits segment, because it addresses the
  app's own backend and not qits.
  (Capture has **no** passthrough: the browser posts straight to qits' CORS-open ingest URL.)

Both resources are small app-side copies for Quarkus backends — see the
[qits integration guide](https://github.com/wohlben/qits/blob/main/docs/guides/quarkus-angular-integration.md)
(Tier 5) for `ConfigResource`/`OtelProxyResource` and the required
`quarkus.otel.traces.suppress-application-uris` property.

### Serving under a path prefix

Apps served under the qits daemon web view get their prefix at runtime. The rebase must run
before any module code, so it stays an inline `index.html` script — the canonical snippet:

```html
<base href="/">
<script>
  (function () {
    var match = location.pathname.match(/^\/daemon\/[^/]+\/[^/]+\//);
    if (match) document.querySelector('base').setAttribute('href', match[0]);
  })();
</script>
```

## Releasing

There is no release command, and there is no longer a push that publishes anything.

**A release starts as a release REQUEST.** Ask qits-projects for one against this repository:

```
POST /projects/api/repositories/<repoId>/release-requests
{ "branch": "<your branch>", "summary": "<the release's subject>" }
```

It folds `main`, that branch and any released tags still in flight onto a backing branch
`release/<id>`, and re-folds whenever the set changes. Nothing merges and nothing publishes at that
call.

**The fold is what gets proved.** `.config/qits/ci-event-release-request.yml` runs lint, the jsdom
specs and the build against `release/<id>`, and every step is gating, because a fold publishes
nothing. Auto Release stamps the CalVer into
`projects/qits-integrations-angular/package.json`, tags it and publishes `SCMRelease` only over a
green verdict; `main` is finalized after the release lands. The old push pipeline's prerelease leg —
`<version>-main.g<sha7>` under the `main` dist-tag — went with the pushes that justified it, and the
dist-tag was repointed rather than dropped: `@qits/angular@main` is now **the latest released
main**, moved there by the release pipeline itself.

**A release publishes the version itself.** `.config/qits/ci-event-release.yml` reacts to
`SCMRelease`, checks the release tag out, builds it and publishes with no `--tag`, so `latest` moves
forward exactly once per release — then moves `main` onto the same version with `npm dist-tag add`,
which is a second call because a publish can claim exactly one dist-tag and a published version is
immutable. Where that green run meets the `SCMRelease`, qits-ci announces one
`SoftwareRelease` naming `@qits/angular`, which is the event a downstream consumer can act on: the
tarball exists by then. The tag stays the durable stamp but triggers nothing on its own — a
bootstrap replay pushes it quietly and re-presents the `SCMRelease` through qits-ci's manual trigger
door, republishing without waking a train.

It is **publish-if-absent**: it asks the registry whether its version exists and skips,
successfully, when it does. Re-runs, reverts and redelivered events stay green without touching the
registry. Published versions are immutable — the registry rejects a re-publish, which is why the
step never tries one.

## Developing against a consumer

Iterate with a local override — **never bump versions to move code**:

```bash
pnpm add "file:../../qits-integrations/qits-integrations-angular-jslib/dist/qits-integrations-angular"   # after pnpm build
```

Note the path: the installable artifact is the build output, not the repo root. Drop the override
and bump the version once the change is worth publishing.

## Packaging invariants (don't break these)

- **The package is `dist/qits-integrations-angular`**, the ng-packagr output — never the repo root.
  `npm publish` is pointed at that directory and the manifest ng-packagr wrote inside it.
- **`projects/qits-integrations-angular/package.json` is the single source of truth** for name,
  version, description, license, peers and runtime deps. ng-packagr copies it into the published
  manifest, so a field that must reach the registry is added *there*.
- **The root `package.json` keeps `private: true`** and carries no `name` worth publishing, no
  `files`, no `exports` and no `prepare`. It is the workspace harness: the devDependencies that
  build and test the library, and the runtime deps the sources resolve against while doing so.
- **Root `dependencies` mirror the published manifest's** — the workspace builds against its own
  `node_modules` while a consumer resolves what the manifest declares, and either direction of
  drift ships a package whose imports resolve for nobody but us.
- **`pnpm check-exports` guards all of the above** against `dist/` after a build, and both CI
  pipelines run it. Do not hand-edit anything in `dist/`.

## Regression check (smoke the published shape)

```bash
pnpm build && pnpm check-exports
cd dist/qits-integrations-angular && npm pack --dry-run   # prebuilt fesm + types + manifest, no sources

pnpm dlx @angular/cli@21 new smoke --minimal --skip-git --defaults && cd smoke
printf '@qits:registry=http://localhost:8081/artifacts/npm/npm/\n' > .npmrc
pnpm add @qits/angular
pnpm ng build                                            # compiles against the installed types
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm build` | `ng build qits-integrations-angular` → APF output in `dist/qits-integrations-angular/` |
| `pnpm test` | `ng test qits-integrations-angular` (vitest builder, jsdom) |
| `pnpm test:browser` | `*.browser.spec.ts` in headless Chromium (style freezing needs a real layout engine); needs a one-time `pnpm exec playwright install chromium` |
| `pnpm lint` | `ng lint qits-integrations-angular` |
| `pnpm check-exports` | verify `dist/qits-integrations-angular` is publishable (run it after `pnpm build`) |
