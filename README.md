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
telemetry target gets `telemetry: null` and the library stays **dark** — the OpenTelemetry SDK is
never downloaded, `window.fetch` untouched. The SDK (~100 kB minified) is a separate lazy chunk that
`initQitsIntegration()` loads with a dynamic `import()` only when the relay reports a telemetry
target, so it is never part of a consumer's initial bundle; only `@opentelemetry/api` (~14 kB) is.
Errors the `ErrorHandler` sees while the config and the SDK load are held and shipped once it
arrives (dropped if telemetry turns out dark). There is no build-time configuration; the config relay
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

**Peers:** `@angular/common`, `@angular/core` and `@angular/router` (`^21.2.0 || ^22.1.0`), `rxjs`
(`^7.4.0`), and
`@ngrx/signals` (`^21.0.0 || ^22.0.1`). The ngrx peer is required even if you never call
`withQitsSnapshot` — the library's single bundle imports it statically, so it must be resolvable in
every consumer. The bundle is partial-compiled (`ɵɵngDeclare*` with a `minVersion` of at most
17.0.0), so an Angular 21.2 application's linker links it like any other library.

An Angular 21 consumer that does not already depend on `@ngrx/signals` has to name it itself
(`npm install -D @qits/angular @ngrx/signals@^21`): npm auto-installs a missing peer at the newest
version the range allows, ngrx 22, whose own `@angular/core ^22` peer then fails ERESOLVE against
the application's Angular 21 — npm does not backtrack to the ngrx 21 the range also admits.

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

Where the POST goes: the button posts to the relayed `ingestUrl` verbatim, which must then be
**browser-reachable** (deployed apps configure a public URL).

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

## Signing in with a bearer: `provideQitsBearerSignIn`

A platform page signs in with OIDC authorization code + PKCE against one of the idp's public
clients, keeps the tokens in `sessionStorage` (this tab), refreshes them ahead of expiry (one
refresh in flight: the idp revokes the family when a refresh token is used twice), and sends the
bearer on every platform call (epic qits-543).

```ts
// app.config.ts
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { provideQitsBearerSignIn, qitsBearerInterceptor } from '@qits/angular';

providers: [
  provideRouter(routes),
  provideHttpClient(withFetch(), withInterceptors([qitsBearerInterceptor])),
  provideQitsBearerSignIn({ clientId: 'qits-spa' }),
];
```

- **`clientId`**: `qits-spa` deployed (any `https://<name under the platform domain>/auth/callback`),
  `qits-landing-dev` under `ng serve` (only `http://{localhost|127.0.0.1|[::1]}:<port>/auth/callback`).
- **`platformDomain`**: leave it out deployed; it is read from the page's host (`qits.<domain>` is the
  apex, `<label>.qits.<domain>` loses its first label). Set it under `ng serve`, e.g.
  `platformDomain: 'qits.wohlben.eu'`. **`idpOrigin`** defaults to `https://idp.<platform domain>`.
- **The callback route** `auth/callback` (`QitsAuthCallbackPage`) is put in front of the app's routes
  by the provider, ahead of any guard or `**`. The redirect URI is `<page origin>/auth/callback`, so
  the app must be served at its host's root. `callbackRoute: false` opts out; then place
  `qitsAuthCallbackRoute` first in your routes yourself.
- **`qitsBearerInterceptor`** is the one piece the provider cannot wire (`HttpClient` takes functional
  interceptors only in `provideHttpClient`). It sends the bearer to this page's own origin (relative
  URLs included) and to `https` hosts at or under the platform domain, nowhere else. A 401 gets one
  refresh and one retry, then the sign-in, back to the current page.
- **`qitsSignedInGuard`** / **`QitsSession.ensure(url)`**: start the sign-in before a page renders.
- **`QITS_EVENT_SOURCE`** opens a `FetchEventSource` (an `EventSource` stand-in over `fetch`, with the
  bearer). It behaves like `EventSource`: `onopen` on a 2xx; a dropped stream is `CONNECTING` and
  reconnects after 3 s (or the stream's `retry:`), sending `Last-Event-ID` once ids were seen; a
  non-2xx answer is final (`CLOSED`, `onerror`, no reconnect), except that a 401 first gets one
  token refresh and one retry; `close()` stops it all. **`QITS_WEB_SOCKET`** a `BearerWebSocket`, which offers `['qits.bearer', <token>, ...]` as
  subprotocols. Without the provider both are the browser's own.
- **`QitsBearerFetch`**: `fetch(url, init)` with the bearer; `fetchObjectUrl(url)` for an `<img>` of a
  role-guarded route (revoke the URL when done); `download(url, fileName)` for a download link.
- **`QitsTokens`**: `accessToken()`, `login(returnPath)`, `logout()`, `refresh()`.

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
  recorded shape" (`arrayContaining`); other arrays match the recorded length exactly, each element
  like the first, when every element has one shape, and otherwise `arrayContaining` with each
  shape's own template. A shape is which keys each object has, which leaves are null, strings,
  numbers or booleans, and every nested array's elements: a BACK transition without `gates`, or a
  `predicate: {}` next to a populated one, is a shape of its own.
- **Every interaction carries `comments.references`** (`qits-call`, `qits-trigger`). The provider's
  verification refuses one without them.
- **A call a library makes for the app names the library**: `via: { repository, artifact, version }`
  (type `Via`) adds `comments.references.qits-via` with those three strings, as the Java
  `qits-pact-consumer` writes it (`qits-ui-components-jslib`, `@qits/ui-components`, the version the
  app resolves). `trigger.app` stays the app. Without `via` there is no `qits-via`.
- **An answer that is not JSON** (a blob's bytes) is recorded with `file: null`, and its
  `responseHeaders` hold the `Content-Type` when the provider records it. Give the interaction
  `consumes: []` and `response: { contentType: 'image/png', body: <example bytes> }` (type
  `NonJsonResponse`): the pact binds the status, `Content-Type` as `image/png.*` (refused when the
  recording names another media type), and a body of that media type by Pact's content-type matcher,
  never the bytes. The mock server answers with the example bytes; without `body` only the header
  is bound.
- **An interaction names the routes it happens on**, when known: `routes: ['projects/:slug']`
  adds `comments.references.qits-trigger.route`, the route patterns sorted, without duplicates and
  joined with `, ` (`projects/:slug, projects/:slug/repositories`). Without `routes`, the lookup
  set once with `useRouteLookup(lookup)` answers, called with the interaction's provider, state and
  operationId; usually `routeLedger('src/testing/browser/routes.json')`, the ledger the browser
  specs write (see
  [Which routes a pact interaction happens on](#which-routes-a-pact-interaction-happens-on)). With
  neither, or `routes: []`, the interaction has no `route` and is written exactly as before.
- The path is a provider-state expression only when it has a `{param}`.
- **The library's version is no contract.** `assertPactFile` and `assertPactPart` mask
  `qits-via.version` on both sides: a difference in it alone rewrites the committed file and logs
  `qits-via version refreshed <old> → <new> (<file>)`, without `QITS_GOLDEN_UPDATE`. Any other
  difference still fails.

**Several specs, one pact file.** Where each store's pact spec writes its own calls to one provider,
each checks only its part with `assertPactPart(generated, committed, operations, updateSwitch)`:
`operations` are the `qits-call.operationId`s the spec owns, or `{ operationId, interactions }` to own
an operation's interactions for the named UI interactions only (`qits-trigger.interaction`). It
ignores metadata and order, refuses an interaction the spec does not own, and with
`QITS_GOLDEN_UPDATE=true` replaces only its part, under a lock file.

## Browser spec data comes from golden masters: `@qits/angular/testing/browser`

Every browser spec (`*.browser.spec.ts`) shows backend data from golden masters only (epic
qits-112): pages, layouts, patterns and every other component. **Only UI components may use
synthetic data**: by default the specs under `src/app/ui/`. Three parts enforce it:

- **Recordings.** `recorded(body)` deep-freezes a golden master body and registers it, and every
  object and array inside it, in a `WeakMap`. `fromGoldenMasters(read, source?)` wraps a reader so
  every body it gives is registered; `source` maps the reader's arguments to `{ provider, state,
operationId }`, so errors name them. A part of a recording (`list.entries`, `list.entries[0]`) is a
  recording too; a copy, a spread, a `slice()` or a `map()` is not.
- **The guard.** `guardGoldenMasters()` makes `TestRequest.flush` (and `event`) throw, naming the
  method and URL, when a 2xx answer carries anything that is not a recording. Any other status
  reaches the app as an error and may carry any body: `flush(null, { status: 500, statusText:
'Server Error' })` is fine. A 2xx answer with no body fails too, because an empty list is a
  recorded state like any other; an operation that answers 204 No Content says so:
  `flush(null, { status: 204, statusText: 'No Content' })`. A bare `flush(null)` (which Angular
  turns into a 204) fails, so an empty answer is never an accident. By default the guard checks
  every browser spec except those `syntheticAllowed` names (default `['src/app/ui/**']`, as the
  lint rule; a glob matches the end of the absolute test path at a `/`). It reads the test file
  from Vitest's `expect.getState().testPath`, so Vitest globals must be on, and checks every test
  when it cannot. Pass `{ syntheticAllowed: [...] }` to name other places, or `{ when }` to choose
  freely. `goldenMastersRequired(file, syntheticAllowed?)` is the default test.
- **Frozen.** A recording cannot be changed in place: a write throws in strict mode (every ES
  module). Note that the app gets the frozen object too, so code that sorts or changes a response
  in place throws in these specs; copy before changing.

Data that does not come over HTTP, such as an event a fake event stream sends, goes through
`assertRecorded(payload, 'event')`, which throws unless the payload is a recording.

Browser-safe, unlike `@qits/angular/testing`. The golden masters are read on the Node side (a
Vitest browser command) and arrive as fresh JSON, so identity is made in the browser: wrap the
command, not the Node-side reader.

**Every body a browser spec shows is one the provider verifies.** `pactedGoldenMasters(masters,
pactFile)` from `@qits/angular/testing` (Node-side) wraps a reader so `body(state, operationId)`
throws unless an interaction in the consumer's committed pact uses that provider state and
`qits-call` operationId. Use it where the browser command reads the golden masters.

**Every error says how to fix it.** The guard, `assertRecorded`, `pactedGoldenMasters` and the lint
rule all end in the same advice: if no recorded state fits the case, add a provider state to the
provider repository (ProviderStates + golden-master recorder), record it, and add a pact
interaction for it in the consumer's pact spec next to the store, so the provider verifies it; then
answer with `goldenMaster('<new state>', '<operationId>')`. The run-time errors name the provider
and operation when the reader's `source` gives them. An empty 2xx answer asks for a recorded empty
state (such as `'no projects exist'`); `patchState` and replaced providers ask for the data to come
through HTTP from a golden master instead.

```ts
// vitest-browser.config.ts (Node side): the command gives only bodies the pacts verify
import { goldenMasters, pactedGoldenMasters } from '@qits/angular/testing';
const projects = pactedGoldenMasters(
  goldenMasters('@qits/projects-golden-masters', 'qits-projects'),
  'pacts/qits-landing-app_qits-projects-service.json',
);
// … commands: { goldenMaster: (_ctx, state, operationId) => projects.body(state, operationId) }

// src/testing/browser/golden-master.ts: the one place that registers recordings
import { commands } from 'vitest/browser';
import { fromGoldenMasters } from '@qits/angular/testing/browser';

const REPOSITORY = {
  'qits-projects': 'qits-projects-service',
  'qits-githost': 'qits-githost-service',
};
type Provider = keyof typeof REPOSITORY;
export const goldenMaster = fromGoldenMasters(
  (state: string, operationId: string, provider?: Provider) =>
    commands.goldenMaster(state, operationId, provider),
  (state, operationId, provider = 'qits-projects') => ({
    provider: REPOSITORY[provider],
    state,
    operationId,
  }),
);

// src/testing/browser/setup.ts (the browser specs' setup file)
import { guardGoldenMasters } from '@qits/angular/testing/browser';
guardGoldenMasters();

// a page spec
const list = await goldenMaster('a project exists', 'listProjects');
http.expectOne('/projects/api/projects').flush(list);
```

### Which routes a pact interaction happens on

A pact interaction names the routes its call happens on (ticket qits-1946), and the browser specs
are where that is known: they navigate to a route and answer its requests with golden masters.
The guard notes it, and a committed ledger carries it to the pact specs.

- **The guard notes it.** Whenever it is installed, and whether or not it checks the running test,
  `guardGoldenMasters()` notes every 2xx `flush` (or `HttpResponse` event) whose body is a
  recording with a full source (`provider`, `state`, `operationId`, so give `fromGoldenMasters`
  its `source`), while the TestBed has a router (`provideRouter(...)`) that has matched a route:
  `{ provider, state, operationId, route }` (type `RouteRecord`), the route as the matched pattern
  (`projects/:slug/repositories`, from `matchedRoutePath` in `@qits/angular`, which also names
  `app.route.path` in telemetry). Nothing is noted without a router or a matched route, for a body
  that is not a recording, or for an answer without a body: **a status-only answer
  (`flush(null, { status: 204 })`) is not recorded**, so a 204 operation's interaction gets its
  routes only from `routes`. `takeRouteRecords()` returns what was noted, sorted and without
  duplicates, and forgets it; `clearRouteRecords()` only forgets.
- **The ledger keeps it.** `goldenMasterRoutes(ledgerPath, root?)` (from `@qits/angular/testing`)
  is the Vitest browser command the setup file sends the records to after each spec file, and
  `.plugin` on it is the Vite plugin that adds its reporter to the run: put the command in
  `browser.commands` and the plugin in the config's `plugins`, or nothing is written. A call only
  stages the spec's records; when the run ends, the reporter rewrites the section of every spec
  file that ran completely (it passed, and so did every test in it) and nothing else:
  `{ "<spec path relative to root>": [records] }`, records sorted and without duplicates, keys
  sorted, two-space JSON with a trailing newline, written only when the text changed. A spec file
  that ran completely and recorded nothing loses its section; a file that failed (in a test or in
  a hook such as `beforeAll`), was skipped or ran in part (`-t`, `.only`) keeps its section as it
  was, so a broken run never empties the ledger. The sections of spec files that no longer exist
  are dropped. `root` defaults to the cwd. Keep it at `src/testing/browser/routes.json` and commit
  it: that is the path the `screenshot-baselines` automation commits and QA checks for staleness,
  beside the references.
- **The pact specs read it.** `routeLedger(ledgerPath)` gives `(provider, state, operationId) =>
routes`, the routes of every section, sorted and without duplicates (`[]` without a ledger);
  `useRouteLookup(...)` makes `addGoldenInteraction` ask it. A changed ledger changes the pacts, so
  regenerate them (`QITS_GOLDEN_UPDATE=true`) after the browser run that changed it.

```ts
// vitest-browser.config.ts (Node side)
import { goldenMasterRoutes } from '@qits/angular/testing';
const routes = goldenMasterRoutes('src/testing/browser/routes.json');
// … plugins: [routes.plugin], browser: { commands: { goldenMaster, goldenMasterRoutes: routes } }

// src/testing/browser/setup.ts
import { guardGoldenMasters, takeRouteRecords } from '@qits/angular/testing/browser';
guardGoldenMasters();
afterAll(() => commands.goldenMasterRoutes(takeRouteRecords()));

// src/testing/golden-masters.ts (a module every pact spec imports)
import { routeLedger, useRouteLookup } from '@qits/angular/testing';
useRouteLookup(routeLedger('src/testing/browser/routes.json'));
```

The lint rule `qits/browser-spec-data-from-golden-masters` reports the common mistakes where they
are written: `patchState`, replaced providers, stores and state-tree tokens, store imports, recordings made in the
spec, and a `flush` whose body does not trace back to a call named like `goldenMaster`. The trace
is a heuristic: a function parameter, or options that are not an object literal with a literal
`status`, cannot be traced and pass. **The run-time guard is the real guarantee.** Option
`allowTokens` (default `[]`) exempts named state-tree tokens from the provider check; it is for
transport seams only, never data (for example `['EVENT_SOURCE']`, a fake event stream that never
connects). It never exempts a `*Store`. Option `syntheticAllowed` (default `['src/app/ui/**']`,
globs relative to the nearest `package.json`) names the browser specs that may use synthetic data;
the rule skips them. Giving it replaces the default.

## Lint rules: `@qits/angular/eslint`

An ESLint flat-config plugin. Spread its `recommended` config after your own; your config must
already parse TypeScript (typescript-eslint or angular-eslint does):

```js
// eslint.config.mjs
import qits from '@qits/angular/eslint';
export default [...yourConfig, ...qits.configs.recommended];
```

| Rule                                         | What it enforces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qits/client-only-in-stores`                 | Only `*.store.ts` files and specs import a generated client, so every backend call goes through a store. Type-only imports are fine. Files in `allow` (default `src/app/app.config*.ts`, `src/main*.ts`) may import it to set the client up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `qits/consume-client-calls`                  | In a store, every call to a generated client function is the first argument of `consume(call, paths)`. Awaiting it on its own, `.then`, passing the promise or the function elsewhere, and `…Resource` helpers (no promise to wrap) are reported. Option `consume` renames the wrapper.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `qits/store-has-pact`                        | A store that imports a generated client has `<name>.store.pact.spec.ts` beside it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `qits/pact-names`                            | In a `*.pact.spec.ts`, `new PactV4({ consumer, provider })` and `addGoldenInteraction(…, { provider, trigger: { app } })`: the consumer and trigger app equal the nearest `package.json` `name`; the provider is a repository name ending in a role (`-service`, `-frontend`, `-app`, `-daemon`, `-oci`, `-cli`, `-javalib`, `-jslib`). Give names as string literals or consts, or the rule cannot check them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `qits/page-location`                         | A `*.page.ts` or `*.layout.ts` file lives under the routes directory (a `*.layout.ts` also under the `$layout` alias directory, when the project has one), and every component class under the routes directory lives in such a file. Other files there (a resolver, a guard, a `*.routes.ts`) and specs are fine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `qits/page-suffix`                           | The exported component in a `*.page.ts` ends in `Page`, the one in a `*.layout.ts` ends in `Layout`, and a component named `…Page` / `…Layout` lives in such a file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `qits/page-has-screenshots`                  | Every `*.page.ts` and `*.layout.ts` under the routes directory, and every `*.layout.ts` under the `$layout` alias directory, has `<name>.page.browser.spec.ts` / `<name>.layout.browser.spec.ts` beside it, and that spec calls `toMatchScreenshot`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `qits/route-matches-directory`               | In a route table, every route with `component` or `loadComponent` (and every `loadChildren`) imports from the directory its URL names: the `path`s from the top of the table through `children`, `''` skipped, `:param` as `[param]`, relative to the routes directory. `path: '**'` may render any page; `redirectTo` routes are skipped. A route table under the routes directory is mounted at its own directory. A `*.layout.ts` under the `$layout` alias directory is shared and not checked. Imports through a path alias and non-literal paths are not checked.                                                                                                                                                                                                                                                                                                                |
| `qits/browser-spec-data-from-golden-masters` | In every `*.browser.spec.ts` except the UI components' (option `syntheticAllowed`, default `['src/app/ui/**']`): no `patchState`, no `TestBed.overrideProvider`, no `useValue`/`useFactory`/`useClass`/`useExisting` for a `*Store` token or for any token imported from the app's state tree (`$core/…` or a path with `/core/`, such as `SelectedProject`; option `allowTokens: ['EVENT_SOURCE']` exempts named state-tree tokens that are transport seams only, never data, and never a `*Store`), no import from a `*.store` file except `import type`, no `recorded`/`fromGoldenMasters` import; the first argument of `flush(…)` traces back to a golden-master call, unless the options give a literal `status` of 400 or more (or 204 with `null`). See [Browser spec data comes from golden masters](#browser-spec-data-comes-from-golden-masters-qitsangulartestingbrowser). |

Generated clients are `src/app/api/**` (relative to the nearest `package.json`) unless you pass
`{ clients: ['<glob>', …] }` to `client-only-in-stores`, `consume-client-calls` and `store-has-pact`. A path alias such as
`@api/**` is matched as written.

**Routes on the filesystem.** `src/app/routes/` mirrors the URL. A routed component is a page,
`<name>.page.ts` with a class ending in `Page`, in the directory of its route: the route
`projects/:slug/work` renders `src/app/routes/projects/[slug]/work/project-work.page.ts`
(`ProjectWorkPage`). A route with `children` renders a layout, `<name>.layout.ts` with a class
ending in `Layout`, in the directory of its own path (path `''` is `src/app/routes/`). Components
that are not routed stay outside (`ui/components/`, `patterns/`). The four route rules take
`{ routes: 'src/app/routes', routeTables: ['src/app/app.routes.ts', 'src/app/**/*.routes.ts'] }`
(the defaults shown), relative to the nearest `package.json`; `page-has-screenshots` reads only
`routes`. A shared layout may also live outside `routes/`: point the `$layout/*` path alias in
the project's `tsconfig.json` (next to `package.json`, `extends` followed) at a directory, such as
`"$layout/*": ["./src/app/layout/*"]`, and a `*.layout.ts` there is allowed and needs its
screenshots too. Without the alias, layouts live under `routes/` only.

**Every page has screenshots.** A page or layout with no screenshots fails `page-has-screenshots`.
A page with nothing to show, such as one that only redirects, is not exempt by itself. Turn the
rule off for it above its `@Component`, and say why:

```ts
// eslint-disable-next-line qits/page-has-screenshots -- redirects to /projects, renders nothing
@Component({ selector: 'app-old', template: '' })
export class OldPage {}
```

## Reference screenshots no test uses: `@qits/angular/screenshots`

Vitest writes a reference screenshot (`__screenshots__/<spec file>/<name>-<browser>-<platform>.png`)
but never deletes one. A deleted spec or a renamed screenshot leaves its image behind. The
`qits-angular screenshots` command finds these orphans.

The browser run is the source of truth, not the spec's source text: the `screenshotReferences()`
Vitest plugin records every reference a `toMatchScreenshot` call resolves, per spec file, so a name
made in an `it.each` table, a loop or a template string counts exactly as Vitest resolves it. Add it
to the browser tests' Vitest config (with the Angular builder, the `runnerConfig` file):

```ts
// vitest-browser.config.ts
import { screenshotReferences } from '@qits/angular/screenshots';

export default defineConfig({ plugins: [screenshotReferences()], test: { browser: { … } } });
```

At the end of the run it writes `node_modules/.cache/@qits/angular/screenshot-references.json`.
Then:

```sh
qits-angular screenshots --check   # lists the orphans, exits 1 if there are any
qits-angular screenshots --prune   # deletes them (only the platform's baselines job runs this)
```

A reference is an orphan when:

- its spec file is gone (found without a test run, so `--check` is useful in `lint` too);
- or the recorded run ran its spec completely (every test passed, nothing skipped or filtered), the
  spec has not changed since, and no test asked for that reference.

A spec that the record does not cover that way is not judged, so a partial run never reports a
false orphan. With `UPDATE_SNAPSHOT` set (an update run, as Vitest reads it), `--check` lists the
orphans and exits 0: the job that runs it prunes them next. The command understands Vitest's
default reference layout only.

## Screenshots frozen as HTML: `freezeScreenshots()` and the `freezes` option

A PNG cannot be searched, followed or inspected. With freezes on, every **passing**
`toMatchScreenshot` also writes the element it compared as a standalone HTML document, with the CSS
rules that style it, the route it was on and the golden-master recordings the test showed (ticket
qits-1947). The two halves:

```ts
// src/testing/browser/setup.ts (browser side, beside guardGoldenMasters())
import { freezeScreenshots } from '@qits/angular/testing/browser';
import { routes } from '../../app/app.routes';
freezeScreenshots({ routes }); // routes: optional; sent once per spec file, no lazy route is loaded

// vitest-browser.config.ts (Node side)
plugins: [screenshotReferences({ freezes: true })];
// or { freezes: { dir: 'src/testing/browser/freezes', routeSpecs: /\.page\.browser\.spec\.ts$/ } }
```

`freezeScreenshots()` overwrites the matcher once (`chai.util.overwriteMethod` on
`chai.Assertion.prototype`, `chai` from `vitest`): Vitest's matcher runs first, and when it passed,
the element `expect.element` resolved is serialized (`freezeShot()`) and sent through the browser
command `qitsFreeze`; the route tree goes through `qitsFreezeRoutes`. Both are registered by the
`freezes` option. A failing shot fails the test and freezes nothing. It also clears the guard's
per-test records before every test (`currentTestRecords()`, the recorded answers flushed since the
test started, router or not).

What the run writes, under `dir` (default `src/testing/browser/freezes`, the tree the
`screenshot-baselines` automation commits):

- `<spec path relative to the root>/<name>.html`: one file per screenshot. `<name>` is the
  screenshot's name slugged as Vitest slugs the PNG's (`menu/open` → `menu/open.html`,
  `detail: an epic` → `detail-an-epic.html`); an unnamed shot is Vitest's default `<test name> <n>`.
- `assets/<file name>`: the same-origin files a freeze uses (the test fonts), copied once from the
  path the URL names under the root (`/src/testing/browser/fonts/x.woff2` →
  `<root>/src/testing/browser/fonts/x.woff2`), referred to relatively (`../../…/assets/x.woff2`).
  Two different files with the same name fail the run. A copy no freeze uses any more is deleted.
- `manifest.json`: `routes` (the tree as `describeRoutes()` gives it: `{path, fullPath, redirectTo?,
children?}`), `freezes` (`{file, spec, test, name, route, records}`, sorted by `file`, which is
  relative to `dir`) and `byRoute` (route pattern → files). `route` is the pattern the TestBed's
  router had matched, and only for specs `routeSpecs` matches (default the page specs,
  `*.page.browser.spec.ts`): layout and pattern specs mount stand-in routes, so theirs is `null`.
  Two-space JSON, stable key order, trailing newline.

Every run writes, update run or not, and replaces only what it saw completely: a spec whose tests
all ran and passed gets exactly the freezes it sent (a shot no test takes any more loses its file),
a spec file that no longer exists loses its freezes, and a spec that failed, was filtered (`-t`,
`.only`) or did not run keeps the freezes it had. Never edit a freeze by hand.

The same bytes on every machine and in every test order, so a freeze is a DOM, never pixels:

- `<!doctype html><html><head><meta charset="utf-8"><style>…</style></head><body>…</body></html>`;
  the ancestors between `<body>` and the element stay as empty shells (tag and attributes), so
  descendant selectors and `body` styles still apply. A shot of the page freezes `<body>`.
- Nothing runs: no `<script>`, `<noscript>`, `<template>`, preload links, `on*` attributes,
  `srcdoc` or `javascript:` URLs.
- Live state is written into attributes: input `value`/`checked`, option `selected`, textarea
  text, `open` on `<details>`/`<dialog>`; a `<canvas>` becomes an `<img>` of its pixels.
- Comments, `ng-reflect-*` and `ng-version` go. `_ngcontent-*`/`_nghost-*` are renamed `c0`, `c1`,
  … and ids `f0`, `f1`, … in order of appearance, with every reference (`for`, `aria-*`, `list`,
  `href="#…"`, `url(#…)`, `#id` in the CSS).
- Class names a page-wide counter numbers are renumbered in order of appearance, in the HTML and
  the CSS: `freezeScreenshots({ renameClasses })`, whole-name patterns, default
  `DEFAULT_RENAMED_CLASSES` (xterm's `xterm-dom-renderer-owner-<n>`); giving it replaces the
  default. Never a broad `-\d+` pattern: Tailwind's `p-4` would be renumbered too.
- Inline style properties a library measures at run time are dropped from the elements a selector
  matches: `freezeScreenshots({ dropInlineStyles })`, `{ selector, properties }[]`, default
  `DEFAULT_DROPPED_INLINE_STYLES` (`transform` on `.xterm-accessibility-tree > div`, the invisible
  rows xterm scales by the text width it measured); giving it replaces the default.
- A rule already kept in the same at-rule context is kept once, so a sheet the setup injects again
  for every spec file in the shared page does not repeat in later freezes.
- `blob:` URLs (random per run, dead afterwards): a loaded `<img>` from one is inlined as a PNG
  `data:` URL, any other `blob:` URL (in the HTML or a CSS `url()`) becomes `about:blank`.
- The CSS is the page's own rules, filtered: a style rule stays when its selector, without
  pseudo-classes and pseudo-elements, matches the element, something in it or a shell; `@media`,
  `@supports`, `@container`, `@layer` and `@scope` blocks are filtered the same way; `@layer`
  statements and `@property` stay; `@font-face` only for the families in use; `@keyframes` and
  `@starting-style` go, and so do Vitest's own sheets and sheets the page may not read.

Gaps, on purpose:

- **Cross-origin and stubbed images keep their URL** (`https://projects.test/…`, a stubbed
  figure), so a freeze shows them only where that URL answers. `data:` URLs stay inline.
- **Status-only answers are not recorded**: as for the route ledger, `flush(null, { status: 204 })`
  is in no freeze's `records`.
- **`assets/` is relative to the file.** A consumer that shows a freeze through `srcdoc` (no base
  URL) must resolve or rewrite the `assets/` URLs itself.

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

| Command              | What it does                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`         | `ng build qits-integrations-angular` → APF output in `dist/qits-integrations-angular/`                                                                                                                     |
| `pnpm test`          | the lint-rule and screenshot-command tests (`pnpm test:eslint`, `pnpm test:screenshots`, `node --test`), then `ng test qits-integrations-angular` (vitest builder, jsdom)                                  |
| `pnpm test:browser`  | `*.browser.spec.ts` in headless Chromium (style freezing needs a real layout engine), then `screenshotReferences()` in a real Vitest browser run; needs a one-time `pnpm exec playwright install chromium` |
| `pnpm lint`          | `ng lint qits-integrations-angular`                                                                                                                                                                        |
| `pnpm check-exports` | verify `dist/qits-integrations-angular` is publishable (run it after `pnpm build`)                                                                                                                         |
