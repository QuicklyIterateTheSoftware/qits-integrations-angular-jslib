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

- document-load + fetch spans (client spans with `traceparent` propagation into the backend trace).
  Same-origin fetches always carry the trace headers; cross-origin ones only to the page's own host
  and its subdomains (the sibling apps of a platform app at the apex). Change that with
  `initQitsIntegration({ propagateTraceHeaderCorsUrls: [/^https:\/\/api\.example\.org\//] })`, or `[]`
  for same-origin only. Name only origins whose CORS allows `traceparent`, `tracestate` and
  `baggage`: the browser refuses a request whose preflight does not;
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
in the capture's goal as JSON — what the app _knew_, not just what it rendered.

## Install

`@qits/angular` is published to qits' own npm registry, hosted by qits-artifacts. Nothing is
published to npmjs.org, so a consumer routes the `@qits` scope — and, ideally, everything else —
through the platform. One committed `.npmrc` carries the routing:

```ini
registry=https://mirror.qits.wohlben.eu/npm/npmjs/        # pull-through cache of npmjs
@qits:registry=https://registry.qits.wohlben.eu/artifacts/npm/npm/
```

```bash
pnpm add @qits/angular
```

Those two hosts are code under the platform's public domain (qits-731) — `wohlben.eu` is the live
platform's — the same addresses from a workstation, from `qits-net`, from anywhere: there is no
separate in-network alias any more. qits-ci's own pipelines derive the identical pair from
`QITS_DOMAIN`; a consumer repo's committed file only has to carry the same two lines. Both hosts
answer 401 anonymously — put a bearer or the commissioned client pair's Basic credential in
`~/.npmrc`, keyed by the scheme-less URL (`//mirror.qits.wohlben.eu/npm/npmjs/:_authToken=...` and
the hosted equivalent) — see the qits-artifacts-service README for the posture.

The tarball ships **prebuilt** (the ng-packagr output), so an install runs no build: no `prepare`
hook, no `pnpm.onlyBuiltDependencies` allowlist, no Angular toolchain in the consumer.

**Peers:** `@angular/core`, `@angular/router`, and `@ngrx/signals` (^22). The ngrx peer is
required even if you never call `withQitsSnapshot` — the library's single bundle imports it
statically, so it must be resolvable in every consumer.

> **Historical note.** Before the registry existed, distribution was git-only: consumers ran
> `pnpm add "git+https://…#<sha>"`, which installed the **repo root** and built it on their
> machine through a `prepare` hook — and needed `{"pnpm": {"onlyBuiltDependencies":
["@qits/angular"]}}` in their own manifest to let that hook run under pnpm 10. Both are gone.
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
event **target or an ancestor** (a submit event's target is the _form_, so name forms, not their
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
origin _is_ qits, so the button posts same-origin to `/workspaces/api/capture` — the capture ingest
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
  withQitsSnapshot('cart'), // registers on init, unregisters on destroy
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
<base href="/" />
<script>
  (function () {
    var match = location.pathname.match(/^\/daemon\/[^/]+\/[^/]+\//);
    if (match) document.querySelector('base').setAttribute('href', match[0]);
  })();
</script>
```

## What a store reads: `consume` and `Consumed`

A store lists the body paths it reads from each call, once, as an `as const` array, and wraps
the generated client call in `consume`. `data` comes back typed to those paths only, so reading
any other field fails `tsc` and Angular's strict templates. The store's pact spec passes the same
array as `consumes`, so the pact binds exactly what the code reads.

```ts
import { consume } from '@qits/angular';

export const LIST_PROJECTS = ['entries[].project.id', 'entries[].project.name'] as const;

const { data, error } = await consume(getProjectsApiProjects(), LIST_PROJECTS);
data?.entries?.[0].project?.name; // fine
data?.entries?.[0].project?.slug; // error: not listed
```

`a.b` is a field (whole, if it is an object or array), `list[].x` a field in every element,
`list[]` the elements without their fields. `error` is narrowed too: to nothing, unless a third
argument lists paths. `NOTHING` is the empty list. At run time `consume` returns the answer
unchanged. `qits/consume-client-calls` makes every client call in a store go through it.

## Pacts and golden masters: `@qits/angular/testing`

For an app that consumes a qits provider (epic qits-546). The provider records its real answer for
each (provider state, operation) and publishes them as an npm package of **golden masters**. The
app's specs answer with those, and its pact spec turns them into a Pact V4 contract the provider
verifies. Node-side only: import it from specs, never from app code. Needs
`@pact-foundation/pact` (optional peer) for the pact part.

```ts
import { addGoldenInteraction, assertPactFile, goldenMasters } from '@qits/angular/testing';

const masters = goldenMasters('@qits/projects-golden-masters', 'qits-projects');
masters.body('a project exists', 'listProjects'); // the recorded answer, for flush(...)

const pact = new PactV4({ consumer: 'qits-landing-app', provider: 'qits-projects-service', dir });
addGoldenInteraction(pact, masters, {
  provider: 'qits-projects-service',
  state: 'a project exists',
  operationId: 'listProjects',
  trigger: { kind: 'ui', app: 'qits-landing-app', interaction: 'list-projects' },
  consumes: ['entries[].project.id', 'entries[].project.name'], // what the app reads
}).executeTest(async (server) => {
  /* drive the store against server.url */
});

// afterAll: fail when the committed pact is stale; QITS_GOLDEN_UPDATE=true rewrites it
assertPactFile(
  join(dir, 'qits-landing-app-qits-projects-service.json'),
  'pacts/qits-landing-app_qits-projects-service.json',
  'QITS_GOLDEN_UPDATE',
);
```

- **Names are repository names**, both sides: `qits-landing-app`, `qits-projects-service`, never
  the bare `qits-projects`. A component's frontend and backend must stay distinct. The committed
  file is `pacts/<consumer>_<provider>.json`.
- **The pact binds only what the consumer reads.** The golden master holds the whole answer; each
  interaction names the body paths its code reads in `consumes` (required), and the pact holds
  only those. `a.b` is a field (whole, if it is an object or array), `list[].x` a field in every
  element, `list[]` the elements without their fields (a count). `consumes: []` binds the status
  only: no body, no `Content-Type`. A path the recorded body does not hold throws (an empty array holds every path below it).
- **Matchers come from the index's `frozen` lists**: ids get a uuid regex, instants an ISO-8601
  regex, every other leaf a type match. `listFilteredTo` arrays match "contains an element of each
  recorded shape" (`arrayContaining`); other arrays match the recorded length exactly, or
  `arrayContaining` when their elements differ in which fields are null or which arrays are empty.
- **Every interaction carries `comments.references`** (`qits-call`, `qits-trigger`). The provider's
  verification refuses one without them.
- The path is a provider-state expression only when it has a `{param}`.

## Lint rules: `@qits/angular/eslint`

An ESLint flat-config plugin. Spread its `recommended` config after your own; your config must
already parse TypeScript (typescript-eslint or angular-eslint does):

```js
// eslint.config.mjs
import qits from '@qits/angular/eslint';
export default [...yourConfig, ...qits.configs.recommended];
```

| Rule                           | What it enforces                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qits/client-only-in-stores`   | Only `*.store.ts` files and specs import a generated client, so every backend call goes through a store. Type-only imports are fine. Files in `allow` (default `src/app/app.config*.ts`, `src/main*.ts`) may import it to set the client up.                                                                                                                                                                                                                                             |
| `qits/consume-client-calls`    | In a store, every call to a generated client function is the first argument of `consume(call, paths)`. Awaiting it on its own, `.then`, passing the promise or the function elsewhere, and `…Resource` helpers (no promise to wrap) are reported. Option `consume` renames the wrapper.                                                                                                                                                                                                  |
| `qits/store-has-pact`          | A store that imports a generated client has `<name>.store.pact.spec.ts` beside it.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `qits/pact-names`              | In a `*.pact.spec.ts`, `new PactV4({ consumer, provider })` and `addGoldenInteraction(…, { provider, trigger: { app } })`: the consumer and trigger app equal the nearest `package.json` `name`; the provider is a repository name ending in a role (`-service`, `-frontend`, `-app`, `-daemon`, `-oci`, `-cli`, `-javalib`, `-jslib`). Give names as string literals or consts, or the rule cannot check them.                                                                          |
| `qits/page-location`           | A `*.page.ts` or `*.layout.ts` file lives under the routes directory, and every component class under the routes directory lives in such a file. Other files there (a resolver, a guard, a `*.routes.ts`) and specs are fine.                                                                                                                                                                                                                                                            |
| `qits/page-suffix`             | The exported component in a `*.page.ts` ends in `Page`, the one in a `*.layout.ts` ends in `Layout`, and a component named `…Page` / `…Layout` lives in such a file.                                                                                                                                                                                                                                                                                                                     |
| `qits/route-matches-directory` | In a route table, every route with `component` or `loadComponent` (and every `loadChildren`) imports from the directory its URL names: the `path`s from the top of the table through `children`, `''` skipped, `:param` as `[param]`, relative to the routes directory. `path: '**'` may render any page; `redirectTo` routes are skipped. A route table under the routes directory is mounted at its own directory. Imports through a path alias and non-literal paths are not checked. |

Generated clients are `src/app/api/**` (relative to the nearest `package.json`) unless you pass
`{ clients: ['<glob>', …] }` to `client-only-in-stores`, `consume-client-calls` and `store-has-pact`. A path alias such as
`@api/**` is matched as written.

**Routes on the filesystem.** `src/app/routes/` mirrors the URL. A routed component is a page,
`<name>.page.ts` with a class ending in `Page`, in the directory of its route: the route
`projects/:slug/work` renders `src/app/routes/projects/[slug]/work/project-work.page.ts`
(`ProjectWorkPage`). A route with `children` renders a layout, `<name>.layout.ts` with a class
ending in `Layout`, in the directory of its own path (path `''` is `src/app/routes/`). Components
that are not routed stay outside (`ui/components/`, `patterns/`). The three route rules take
`{ routes: 'src/app/routes', routeTables: ['src/app/app.routes.ts', 'src/app/**/*.routes.ts'] }`
(the defaults shown), relative to the nearest `package.json`.

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
  manifest, so a field that must reach the registry is added _there_.
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

pnpm dlx @angular/cli@22 new smoke --minimal --skip-git --defaults && cd smoke
printf '@qits:registry=https://registry.qits.wohlben.eu/artifacts/npm/npm/\n' > .npmrc
pnpm add @qits/angular
pnpm ng build                                            # compiles against the installed types
```

## Commands

| Command              | What it does                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`         | `ng build qits-integrations-angular` → APF output in `dist/qits-integrations-angular/`                                                         |
| `pnpm test`          | the lint-rule tests (`pnpm test:eslint`, `node --test`), then `ng test qits-integrations-angular` (vitest builder, jsdom)                      |
| `pnpm test:browser`  | `*.browser.spec.ts` in headless Chromium (style freezing needs a real layout engine); needs a one-time `pnpm exec playwright install chromium` |
| `pnpm lint`          | `ng lint qits-integrations-angular`                                                                                                            |
| `pnpm check-exports` | verify `dist/qits-integrations-angular` is publishable (run it after `pnpm build`)                                                             |
