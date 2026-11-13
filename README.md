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

**Peers:** `@angular/common`, `@angular/compiler`, `@angular/core` and `@angular/router`
(`^21.2.0 || ^22.1.0`; every Angular app already has the compiler, and the lint rule
`qits/navigation-through-outcomes` parses templates with it), `rxjs`
(`^7.4.0`), and
`@ngrx/signals` (`^21.0.0 || ^22.0.1`). The ngrx peer is required even if you never call
`withQitsSnapshot` — the library's single bundle imports it statically, so it must be resolvable in
every consumer. `@angular/service-worker` (`^21.2.0 || ^22.1.0`) is an **optional** peer: only the
`@qits/angular/pwa` entry imports it, so only an app that opts in to the
[installable offline shell](#installable-offline-shell-qitsangularpwa) installs it. The bundle is partial-compiled (`ɵɵngDeclare*` with a `minVersion` of at most
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
bearer on every platform call (epic qits-543). The access token's `sub` alone is remembered in
`localStorage` (`qits.sign-in.<clientId>.user`) each time the idp issues tokens, so an offline
relaunch still knows who signed in last; no token ever goes there.

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
  Offline (`navigator.onLine === false`), a visitor without a usable token whom the device
  remembers is let through instead (the idp cannot load), and the sign-in starts, back to the
  current page, when the browser goes `online` again (unless a refresh then brings a token).
- **`QITS_EVENT_SOURCE`** opens a `FetchEventSource` (an `EventSource` stand-in over `fetch`, with the
  bearer). It behaves like `EventSource`: `onopen` on a 2xx; a dropped stream is `CONNECTING` and
  reconnects after 3 s (or the stream's `retry:`), sending `Last-Event-ID` once ids were seen; a
  non-2xx answer is final (`CLOSED`, `onerror`, no reconnect), except that a 401 first gets one
  token refresh and one retry; `close()` stops it all. **`QITS_WEB_SOCKET`** a `BearerWebSocket`, which offers `['qits.bearer', <token>, ...]` as
  subprotocols. Without the provider both are the browser's own.
- **`QitsBearerFetch`**: `fetch(url, init)` with the bearer; `fetchObjectUrl(url)` for an `<img>` of a
  role-guarded route (revoke the URL when done); `download(url, fileName)` for a download link.
- **`QitsTokens`**: `accessToken()`, `login(returnPath)`, `logout()`, `refresh()`, `subject()` (the
  access token's `sub`), `user()` (`subject()`, else the remembered `sub`) and `forgetUser()`.
  `logout()` keeps the remembered `sub`; `QitsOffline.signOut()` forgets it.

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

## API reads and writes: `qitsResource` and `qitsMutation`

A store that reshapes API data into its own state hides its provenance: a value on the template
no longer says which read produced it, and a store serving several components can mix reads with
different lifetimes under one shape. A resource is the opposite shape (ticket qits-2145): one
backend read per signal, carrying the operation's identity (`provider` + `operationId`), which the
data marks (qits-2141) read to say where a rendered value came from. **Stores are no longer used for API reads** —
a page reads with `qitsResource` and writes with `qitsMutation`, both over a `qitsOperation`; a
store is UI state only now, and `qits/reads-through-resources` (below) reports a store that still
calls a client.

A `qitsOperation` is declared once, in an `x.operations.ts` file, beside the `x.consumes.ts`
constants a store would have used:

```ts
// agents.operations.ts
import { NOTHING, qitsOperation } from '@qits/angular';
import { listAgents, stopAgent } from '../api';
import { PROJECT_AGENTS } from './agents.consumes';

export const LIST_PROJECT_AGENTS = qitsOperation({
  provider: 'qits-workspaces-service',
  operationId: 'listAgents',
  method: 'GET',
  call: listAgents,
  consumes: PROJECT_AGENTS,
});

// illustrative: a write, picked for shape only
export const STOP_PROJECT_AGENT = qitsOperation({
  provider: 'qits-workspaces-service',
  operationId: 'stopAgent',
  method: 'POST',
  call: stopAgent,
  consumes: NOTHING,
});
```

`method` decides `kind` — `GET` is `'read'`, everything else `'write'` — and the compiler holds
to it: `qitsResource` refuses a write operation, `qitsMutation` refuses a read one. The operation's
pact spec, `agents.operations.pact.spec.ts`, passes the same `OP.provider`, `OP.operationId` and
`OP.consumes` straight to `addGoldenInteraction` instead of repeating the strings, so the pact and
the operation cannot drift apart; `qits/consume-client-calls` holds the operations file to the one
accepted shape (`call: listAgents` in the object literal `qitsOperation` takes, nothing else), and
`qits/store-has-pact` requires the sibling spec exists.

A page builds its resources and mutations as fields, over the operations it imports:

```ts
// agents.page.ts
readonly agents = qitsResource(LIST_PROJECT_AGENTS, () =>
  this.projectId() ? { query: { projectId: this.projectId(), state: 'ACTIVE' } } : undefined,
  { refreshOn: { names: ['AgentStarted', 'AgentStopped'], when: (e) => e.payload?.projectId === this.projectId() } },
);

readonly stopAgent = qitsMutation(STOP_PROJECT_AGENT, { affects: [this.agents] });
```

`params()` returning `undefined` keeps the resource idle — here, until a project is picked.
`refreshOn` needs the app's domain events: provide them once, in `app.config.ts`, as
`{ provide: QITS_DOMAIN_EVENTS, useExisting: DomainEvents }` (or any class implementing
`on(names)`). The library never opens a stream itself. `names` is an OR of event names; `when`
narrows further. Matching events are debounced (`REFRESH_DEBOUNCE_MS`, 1 s) so a burst that
touches ten rows costs one reload, not ten; an event that arrives during the resource's first
load cannot reload it yet (Angular's `resource()` refuses a reload while loading), so it is
remembered and fired once that load settles, rather than dropped. `refreshOn` throws at creation
when the app provides no `QITS_DOMAIN_EVENTS` — a resource told to refresh that never would is a
wiring mistake, better caught there than in production.

A failed answer throws `QitsApiError` (`status`, the error body narrowed to `errorConsumes`, and
the operation identity). On a resource, a failed _reload_ keeps the resource's current value and
reports the failure through `reloadError()` instead of blanking the page — except a 404
(the thing really is gone) and a load after a params change (there is no old value for the new
params to keep), both of which go to Angular's own `error()` as usual. A mutation's `run()`
always rejects on failure; it never keeps a stale value, because a write has none to keep.

Each `run()` sends a fresh `Idempotency-Key` header, so retrying the same run cannot apply twice
while a second, distinct run is still a second write. `affects` — resources to reload — runs only
after a successful run, as a plain array or, when a later-created resource needs naming, a
function evaluated at run time. `status()` and `error()` are latest-run-wins: an earlier run that
settles after a later one has already started does not overwrite what the later run reported.

`captureAs` puts a resource's value into feature captures (`registerCaptureState`) under a name;
it is off by default because the obvious default name, `<provider>#<operationId>`, collides the
moment two resources read the same operation, and the second registration would silently replace
the first. Pass `true` for that default name or a string for your own, once you are sure it is
the only resource using it.

**The status sets are wider than what an online app reaches.** `qitsStatus()` is `QitsResourceStatus`
— Angular's own `status()` plus `'cached'` (served from the local store) and `'offline'` (no network,
nothing stored) — because Angular's `status()` is a closed union a library cannot extend.
`QitsMutationStatus` similarly adds `'pending'` (queued in the outbox) and `'conflict'` (the server
refused the write because the record changed) beside the ordinary `'idle'` / `'running'` / `'done'` /
`'error'`. An online-only resource or mutation, and every one in an app without `provideQitsOffline`,
never reaches the extra values; the next section says when the others do.

### Offline mode: `provideQitsOffline`

Opt-in per app (ticket qits-2149), for offline-first PWAs. The server stays authoritative: a queued
write that meets a record someone else changed is refused with a conflict for the person to resolve,
never last-write-wins. It targets the conventions of `qits-offline-core` (qits-2148, in
`qits-integrations-quarkus-javalib`): `ETag` / `If-Match: "<version>"`, `Idempotency-Key` replay,
`ChangesPage` collection reads with `since` cursors and tombstones, and problem bodies with
`current` / `currentVersion`.

```ts
// app.config.ts
providers: [
  provideQitsBearerSignIn({ clientId: 'my-app' }),
  provideQitsOffline({ project: 'my-project', operations: [RENAME_THING, DELETE_THING] }),
];
```

- **The store** is IndexedDB, one database per user, `qits-offline:<project>:<user>`, opened at
  start-up. `user` defaults to `QitsTokens.user()`: the `sub` claim of the access token, or without
  one the `sub` remembered on this device, so an installed app relaunched offline (empty
  `sessionStorage`) still opens its store; pass `user: () => …` without the bearer sign-in. No user
  means no store: `cache` resources act `online-only` and `queue` mutations refuse with
  `QitsOfflineError('signed-out')`. Another user signing in switches to their database.
- **`operations`** lists every write the outbox may replay after a page reload; a `qitsMutation`
  registers its own operation as it is created. An entry whose operation nobody registered waits,
  and shows `waiting: 'unknown-operation'` in `outbox()`.

Without `provideQitsOffline` every `offline` option below is inert, and resources and mutations behave
exactly as described above.

**Resources: `offline: 'cache' | 'online-only'`** (default `'online-only'`).

```ts
readonly thing = qitsResource(GET_THING, () => ({ path: { id: this.id() } }), { offline: 'cache' });
readonly things = qitsResource(LIST_THINGS, () => ({}), { offline: 'cache' });
```

A `cache` resource answers the stored value at once, `qitsStatus()` `'cached'` and `cachedAt()` its
time, then fetches; the fresh answer is stored and the resource becomes `'resolved'`. When the fetch
fails on the network (it rejects with anything but a `QitsApiError`, or `navigator.onLine` is `false`)
the stored value stays at `'cached'`, with `reloadError()` saying why; with nothing stored the resource
is `'offline'`, its value undefined and no `error()`. A `QitsApiError` behaves as it does online. The
`online` window event reloads every live `cache` resource.

An answer of the `ChangesPage` shape (`items[]`, `deleted[]`, `nextCursor`, `hasMore`) is kept as
records by `id` and `version`. The next load sends `query.since` with the stored cursor and follows
`hasMore` until it is `false`; an item replaces a stored record only at the same or a higher
version, and a tombstone deletes one at the same or a higher version. The resource's value is the
page shape over the whole merged collection: every record in id order (numbers before strings, as
IndexedDB orders keys), `deleted: []`, `hasMore: false`, `nextCursor` the stored cursor. A 410
`urn:qits:problem:cursor-expired` drops the stored collection and reads it again from scratch.

**Mutations: `offline: 'queue' | 'online-only'`** (default `'online-only'`), and `record`.

```ts
readonly rename = qitsMutation(RENAME_THING, {
  offline: 'queue',
  affects: () => [this.thing, this.things],
  record: (p) => ({ change: 'update', id: p.path.id, fields: p.body }),
});
```

`record(params)` says which record a run touches: `{ change: 'create', fields }`,
`{ change: 'update', id, fields }` or `{ change: 'delete', id }`. With it, an update or a delete sends
`If-Match: "<version>"` with the version the `affects` resources have stored for that id (unless the
params carry an `If-Match` already), in either mode: a qits-2148 operation answers 428 to an update
without one. Each run makes one `Idempotency-Key`, and every send of that write carries it, so a
lost answer cannot apply twice.

A `queue` run goes to the outbox when the browser is offline, when the outbox already holds entries
(order is kept), or when the direct send fails on the network. `run()` then resolves `undefined` at
once and `status()` is `'pending'`. An `online-only` run while `navigator.onLine` is `false` rejects
with `QitsOfflineError('offline')`.

While an entry is `pending` (or `sending`) it is laid over the stored answers of the `affects`
resources: they show the change at once, still `'cached'`, and keep showing it across a page reload.
A create appears under the id `local:<key>` until the server's answer replaces it. The store itself
only ever holds what the server answered, so a refused or dropped write vanishes from the page by
itself and an optimistic change never overwrites the server.

The outbox sends one entry at a time, oldest first: at start-up, after each enqueue, on the `online`
event, and after a backoff (1 s, doubling to 60 s) following a network failure or a 5xx. One tab sends
at a time (`navigator.locks`, where the browser has it). An entry waits behind an earlier `conflict` or
`failed` entry for the same record; other records go on. What the server answers:

| Answer                                     | The entry                                 | The store and the mutation                                     |
| ------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------- |
| 2xx                                        | removed                                   | the answer is stored, `affects` reload, the run is `'done'`    |
| 412 `urn:qits:problem:stale-version`       | `conflict`, `{ current, currentVersion }` | the record reverts to `current`, the run is `'conflict'`       |
| 404 to an update or a delete               | `conflict`, `current: null`               | the record is removed locally, the run is `'conflict'`         |
| 401                                        | stays `pending`                           | the outbox pauses until the next token refresh or sign-in      |
| any other 4xx (428, 422, a validation 400) | `failed`, with its `QitsApiError`         | the change is reverted, `affects` reload, the run is `'error'` |
| 5xx, or the network                        | stays `pending`                           | sent again after the backoff, with the same key                |

A later write to a record is re-based when an earlier one lands: its `If-Match` moves to the version
the server answered, and a write to a `local:<key>` record gets the created id.

**Resolving a conflict.** `QitsOffline` holds the outbox:

- `outbox()`: every queued write, `QitsOutboxEntry` (`seq`, `key`, `operation`, `params` as plain
  JSON, `recordId`, `change`, `baseVersion`, `enqueuedAt`, `state`, `conflict`, `error`, `waiting`);
  `sending()`: whether one is on the wire;
- `retry(seq)`: a `conflict` entry is re-based on `currentVersion` (a new `If-Match`), laid over the
  store again and sent; it keeps its key, which the server freed when it refused. A `failed` entry is
  resent as it is;
- `drop(seq)`: removes the entry and reloads its resources, so the server's record stays.

A mutation's `conflict()` is its latest run's conflict, a direct send's (online) included.

```ts
readonly offline = inject(QitsOffline);
readonly conflicts = computed(() => this.offline.outbox().filter((e) => e.state === 'conflict'));
// "Theirs: {{ e.conflict.current.name }}" with buttons calling offline.retry(e.seq) / offline.drop(e.seq)
```

**Sign-out.** `QitsOffline.signOut()` answers `{ signedOut: false, pending: n }` and changes nothing
while the outbox holds entries: show that as the warning, and call `signOut({ discardPending: true })`
once the person agrees to lose them. Otherwise it deletes the user's database (stored answers and
outbox), calls `QitsTokens.logout()` and `QitsTokens.forgetUser()` when the bearer sign-in is
provided, and answers `{ signedOut: true, pending: n }`. `QitsTokens.logout()` on its own, which
also runs when the idp refuses a refresh, clears nothing: the remembered user keeps the store open,
since an expired refresh token offline must not throw the outbox away.

**The PWA reload guard.** A reload while a write is on the wire can lose its answer. With
`@qits/angular/pwa`, add the guard (the main entry does not import the pwa entry; the guard is a plain
function of the same shape):

```ts
{ provide: QITS_PWA_RELOAD_GUARDS, multi: true, useFactory: qitsOfflineReloadGuard },
```

It refuses with `'the outbox is sending'` while `sending()` is true.

**Screenshots.** A page's offline, pending and conflict states are screenshots like any other:
`freezeScreenshots({ offline: true })` records each shot's connectivity, the helpers of
`@qits/angular/testing/browser` take the page offline, seed the store and answer a conflict, and
`qits-angular screenshots --check` asks every route for them — see
[Offline shots](#offline-shots-offline).

Not covered yet: caching API answers in the service worker.

## What a page shows: data marks

The UI builder needs to know, for any part of a screenshot, which read produced it, which record
it shows and which attribute of that record a given element renders (ticket qits-2141). Data marks
answer that: plain attributes a few directives set, so they survive into a frozen page the same way
`data-qits-outcome` does (see [outcomes](#where-an-interaction-leads-outcomes) below). Everything
outside a mark is static design copy — a heading, an icon, a label — and nothing reads it.

| Attribute           | Value                                     | Set on                                                                                  |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `data-qits-source`  | `<provider>#<operationId>` (`sourceMark`) | A list container, a detail root, or a joined record.                                    |
| `data-qits-item`    | `<key>=<value>` (`itemMark`)              | A record.                                                                               |
| `data-qits-field`   | A dot path                                | An element showing one field of the nearest record as is.                               |
| `data-qits-derived` | The input paths, space-separated          | An element showing a value computed from fields; never together with `data-qits-field`. |

An element's source and item are the nearest ones above it, itself included —
`element.closest('[data-qits-source]')` and `element.closest('[data-qits-item]')` — so a join
element that carries its own `data-qits-source` and `data-qits-item` resolves to itself rather than
to an ancestor's.

Three directives set the attributes. Each adds only attributes, never a wrapping element, so a
`<ul>`/`<li>` list, a `<section>`, and the layout around them stay exactly as written:

- **`QitsEntityList`** (`<ul [qitsEntityList]="agents">`) sets `data-qits-source` on the list's
  container to the resource's `sourceMark`; only the resource's `operation` is read.
- **`QitsEntity`** (`<li [qitsEntity]="agent" entityKey="agentId">`) sets `data-qits-item` to the
  entity's `itemMark`, `<entityKey>=<value>`; the attribute is left off while that field is null or
  undefined. With `[entitySource]`, the same element also gets `data-qits-source` — for a detail
  root, where one element names both the read and the entity, or for a join, where the read is not
  the enclosing `QitsEntityList`'s.
- **`QitsField`** (`<span [fieldOf]="agent" qitsField="owner.name">`) sets `data-qits-field` to the
  path. `[qitsField]="{ derived: [...] }"` sets `data-qits-derived` to those paths instead
  (deduplicated, space-separated, in the order given) and leaves `data-qits-field` off.

**The compiler checks the names.** `entityKey` and `qitsField` are checked against the type of
`qitsEntity` / `fieldOf`: `QitsFieldPath<T>` is `T`'s dot paths — `owner.name` for a field of a
field, stepping through `null`/`undefined` on the way; an array, a primitive, a `Date` or a
function is a leaf, with no stepping into it (`tags`, never `tags.length` or `history.at`); at most
five keys deep. Over a `Consumed` value (see [`consume`](#what-a-store-reads-consume-and-consumed)
above) or a `qitsResource` value — whose `Value` is the operation's consumed shape (see
[`qitsResource`](#api-reads-and-writes-qitsresource-and-qitsmutation) above) — only the paths the
app actually reads exist: a typo, an unconsumed field, a wrong derived path, or a static
`entityKey="…"` naming the wrong field all fail `ng build` under `strictTemplates`, not only a
bound one. `QitsFieldPath<T>` takes `T`, not `T | undefined`, and a `qitsResource`'s `value()` can
be `undefined`, so narrow it first: `@if (res.value(); as v)`.

The Agents route — a list, a workspace slot's join back to its hosting agent, and a detail root:

```ts
// agents.page.ts: the list
template: `
  @if (agents.value(); as list) {
    <ul [qitsEntityList]="agents">
      @for (agent of list.entries; track agent.agentId) {
        <li [qitsEntity]="agent" entityKey="agentId">
          <span [fieldOf]="agent" qitsField="runtimeStatus">{{ agent.runtimeStatus }}</span>
          <span [fieldOf]="agent" [qitsField]="{ derived: ['runtimeStatus'] }">
            {{ runtime(agent.runtimeStatus) }}
          </span>
        </li>
      }
    </ul>
  }
`;

// workspaces.page.ts: a workspace slot row, joined to the agent it hosts — read from `agents`,
// not from the slot's own `[qitsEntityList]`
template: `
  <li [qitsEntity]="slot" entityKey="slotId">
    @if (hosted(slot.slotId); as host) {
      <span [qitsEntity]="host" entityKey="agentId" [entitySource]="agents" qitsField="name" [fieldOf]="host">
        {{ host.name }}
      </span>
    }
  </li>
`;

// agent-detail.page.ts: a detail root — one element names both the read and the entity
template: `
  @if (detail.value(); as agent) {
    <section [qitsEntity]="agent" entityKey="agentId" [entitySource]="detail">…</section>
  }
`;
```

**The manifest.** Each frozen screenshot carries `dataMarks`: one `{ source, item, field, derived }`
entry per visibly marked element (`visibleDataMarks()`, `@qits/angular/testing/browser`), under the
same visibility rule as `triggers` — `checkVisibility` with CSS, no `hidden` ancestor, a non-zero
box meeting the shot's element or the page's scroll area — deduplicated and sorted. It is written
only when non-empty; a manifest without it, or an older one written before this ticket, reads as
`[]`. See [the manifest](#screenshots-frozen-as-html-freezescreenshots-and-the-freezes-option)
below.

### Holding a page to its marks: `qits/data-through-fields`

The compiler checks that a mark names a real field; it cannot see data rendered with no mark at all,
a mark naming a field the element does not show, or a computed value marked as a plain field. The
lint rule `qits/data-through-fields` (ticket qits-2142, see [the rules table](#lint-rules-qitsangulareslint))
does: it traces each component template's API data from its roots — a `qitsResource` field's
`value()`, or an `input()` / `model()` whose type comes from the generated clients — and wants
every rendered piece of it under a `qitsField` that names it, inside a `qitsEntity` or
`qitsEntityList`:

```ts
@Component({
  template: `
    <ul [qitsEntityList]="agents">
      @for (agent of items(); track agent.agentId) {
        <li [qitsEntity]="agent" entityKey="agentId">
          <span [fieldOf]="agent" qitsField="owner.name">{{ agent.owner?.name }}</span>
          <span [fieldOf]="agent" [qitsField]="{ derived: ['createdAt'] }">
            {{ agent.createdAt | date }}
          </span>
        </li>
      }
    </ul>
  `,
})
export class AgentsPage {
  readonly agents = qitsResource(LIST_AGENTS, () => ({}));
  // A computed over one plain path is that path: its items are still the list's entities.
  readonly items = computed(() => this.agents.value()?.items ?? []);
}
```

`agent.owner?.name` is a plain path, so its mark is the field path `owner.name`; the pipe makes
`createdAt` derived, so its mark lists the paths it reads. A bound mark the rule cannot read
(`[qitsField]="mark()"`) is trusted for the path. It is off in `recommended`: an app turns it on
for the routes whose templates carry the marks, and it needs typed linting (the `input()` roots
are found by their type), so the same override sets `projectService`; without it the rule reports
that once per component instead of passing:

```js
// eslint.config.mjs
import tseslint from 'typescript-eslint';
export default [
  ...yourConfig,
  ...qits.configs.recommended,
  {
    files: ['src/app/routes/agents/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { 'qits/data-through-fields': 'error' },
  },
];
```

Its options: `clients` (the generated clients' globs, as the other client rules take them),
`resource` (default `qitsResource`) and `display` (the tag prefixes whose inputs show their value,
default `['ui-']`).

## Installable offline shell: `@qits/angular/pwa`

An offline-first app has to install, start without a network, and never lose what the person did to
a reload they did not choose (ticket qits-2152). The `@qits/angular/pwa` entry point is that shell:
Angular's service worker, a watcher for new versions that never reloads on its own, and the prompt
that lets the person take one. The `qits-angular pwa` command writes the web manifest from the
app's theme and fails a build that would not install or start offline.

It is **opt-in per repository**, like the light/dark screenshots: an app without `qits-pwa.json`
gets nothing new, and the qits landing app does not opt in. It is a separate entry point because it
imports `@angular/service-worker`, an **optional peer** (`^21.2.0 || ^22.1.0`) the main entry never
imports, so the ~28 apps that never opt in need not install it (the main entry's own `@ngrx/signals`
peer shows the cost of the other way round).

To opt in, an app:

1. installs `@angular/service-worker` (the same version as its `@angular/core`);
2. provides the shell and places the prompt in its shell component:

   ```ts
   // app.config.ts
   import { provideQitsPwa } from '@qits/angular/pwa';

   providers: [provideQitsPwa()], // ngsw-worker.js, production builds only, once stable or after 30 s
   ```

   ```ts
   // app.ts
   import { QitsPwaUpdatePrompt } from '@qits/angular/pwa';

   @Component({ imports: [QitsPwaUpdatePrompt], template: `<router-outlet /><qits-pwa-update-prompt />` })
   ```

3. commits a `qits-pwa.json` beside `angular.json` (fields below), runs `qits-angular pwa --write`,
   commits the `public/manifest.webmanifest` it writes, and links it from `src/index.html`:
   `<link rel="manifest" href="manifest.webmanifest" />`, with the icons it names in `public/`;
4. commits an `ngsw-config.json` (below) and sets `"serviceWorker": "ngsw-config.json"` in the
   production configuration of its build in `angular.json`;
5. checks the build in its build script:

   ```json
   "build": "ng build && qits-angular pwa --check --dist dist/<app>/browser"
   ```

`provideQitsPwa({ script?, enabled?, registrationStrategy? })` takes the worker script (default
`ngsw-worker.js`), whether to register it (default `!isDevMode()`, so never under `ng serve`) and
when (default `registerWhenStable:30000`). It starts `QitsPwaUpdates`, which does nothing on the
server or where the worker is off.

### No reload the person did not choose

The one service worker the estate had before reloaded silently: after a new version was ready, the
next navigation loaded as a full page, and a version the worker could no longer serve reloaded at
once. In an offline-first app that drops whatever the outbox was sending or writing, so here nothing
reloads unless the person presses Reload:

- `QitsPwaUpdates.state()` is `'current'`, `'ready'` after `VERSION_READY`, or `'broken'` after the
  worker reports the tab's version `unrecoverable`. Neither event reloads, assigns `location` or
  activates anything; they only change the state.
- `check()` asks the worker for a new version and swallows a failure (offline). It runs when the tab
  becomes visible; an app may call it too, for example on its own deployment event.
- `apply()` is the only path to a reload. It first asks every `QITS_PWA_RELOAD_GUARDS` entry (a
  multi token of `() => true | string | Promise<true | string>`, run in the root injection context
  so a guard may `inject()`). A string refuses and says why; a guard that throws refuses with its
  message. If any refuses, `apply()` resolves `{ applied: false, reasons }` and does nothing.
  Otherwise it activates the ready version and calls `document.location.reload()`, resolving
  `{ applied: true }`.

```ts
// a guard of the app's own: never reload over an unsaved form
{
  provide: QITS_PWA_RELOAD_GUARDS,
  multi: true,
  useFactory: () => {
    const form = inject(DraftForm);
    return () => (form.dirty() ? 'A form has unsaved changes' : true);
  },
}
```

`qitsOfflineReloadGuard` (see [Offline mode](#offline-mode-provideqitsoffline)) is the outbox's own:
it refuses while a queued write is on the wire.

`<qits-pwa-update-prompt />` shows that state. It is hidden while `current`; at `ready` it shows
"A new version is ready" with **Reload** (`apply()`) and **Later**, which hides it until the next
`VERSION_READY`; at `broken` it shows "This version can no longer be loaded" with **Reload** only. A
refused Reload lists the guards' reasons in the prompt. The buttons are named
`data-track-event="pwa-update-reload"` and `"pwa-update-later"`, and the prompt is styled only
with `var(--color-surface)`, `var(--color-fg)` and `var(--color-accent)`, so it follows the app's
theme, dark too, and passes `qits/theme-colors`.

### `qits-pwa.json`

| Field               | Default                       | Meaning                                                                                             |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `name`, `shortName` | required                      | the manifest's `name` and `short_name`                                                              |
| `description`       | none                          | the manifest's `description`                                                                        |
| `startUrl`, `scope` | `./`                          | `start_url` and `scope`                                                                             |
| `display`           | `standalone`                  | `display`; an installable app needs `standalone`, `fullscreen` or `minimal-ui`                      |
| `icons`             | `[]`                          | `[{ src, sizes, type, purpose? }]`, `src` relative to the build output; a 192x192 and a 512x512 PNG |
| `themeColor`        | `accent`                      | a semantic token **name**, resolved to its light value                                              |
| `backgroundColor`   | `surface`                     | the same, for `background_color`                                                                    |
| `theme`             | `src/styles.css`              | the stylesheet the tokens are read from, through its `@import`s                                     |
| `output`            | `public/manifest.webmanifest` | where `--write` writes; the check looks for this file's name in the build output                    |
| `shell`             | `app-root`                    | the selector the offline start looks for                                                            |

A manifest cannot name a CSS variable, so `--write` resolves the two colours at build time: through
the theme `qits/theme-colors` reads (`@qits/ui-components/theme.css` and the app's own tokens),
following each `--color-<name>` to its light value (`accent` is `#1d4ed8` with the qits design
library). A name that is not a semantic `@theme` colour (a palette step such as `blue-700`
included), or that leads to no literal colour, exits 1 and names it. The manifest is written as
stable JSON with sorted keys, so a rerun with nothing changed changes nothing.

### A recommended `ngsw-config.json`

```json
{
  "$schema": "./node_modules/@angular/service-worker/config/schema.json",
  "index": "/index.html",
  "assetGroups": [
    {
      "name": "app",
      "installMode": "prefetch",
      "resources": {
        "files": [
          "/favicon.ico",
          "/index.html",
          "/manifest.webmanifest",
          "/*.css",
          "/*.js",
          "/icons/*.png"
        ]
      }
    }
  ],
  "navigationUrls": ["/**", "!/**/*.*", "!/**/*__*", "!/**/*__*/**", "!/api/**"]
}
```

The `app` group prefetches the whole shell at install, so the first offline start already has it.
`navigationUrls` keeps `/api/**` away from the index fallback: an API request the worker answered
with `index.html` would parse as garbage instead of failing as offline.

### The installability check: `qits-angular pwa --check --dist <dir>`

`<dir>` is the built browser output. Each failure is one line, and the command exits 1 if any check
fails:

1. **fresh**: the committed manifest holds what `--write` would write now (compared as JSON, so a
   formatter's whitespace does not count). A stale one says `run qits-angular pwa --write`.
2. **manifest**: `<dir>/manifest.webmanifest` parses and has `name` or `short_name`, `start_url`,
   `display` `standalone`, `fullscreen` or `minimal-ui`, and a 192x192 and a 512x512 PNG icon; every
   icon is in `<dir>`, and each PNG's real size (its IHDR) is one of its `sizes`.
3. **linked**: `index.html` (`index.csr.html` for an SSR build) has a `<link rel="manifest">` to it.
4. **worker**: `ngsw-worker.js` and `ngsw.json` are built, `ngsw.json`'s `index` is `/index.html`
   (or `/index.csr.html`), and a `prefetch` asset group holds it.
5. **offline start**: `<dir>` is served from an in-process static server on `127.0.0.1` (a random
   port, unknown paths without an extension falling back to the index; localhost is a secure
   context) and opened in Playwright's Chromium, imported from the app's own `playwright`. The check
   waits until a worker controls the page (reloading once if one is active but not yet in control)
   and has cached every prefetched URL, then takes the browser context offline and reloads. It
   passes when the `shell` element is there with at least one child element. `--timeout <seconds>`
   (default 60) bounds each wait. A worker that never takes control fails with
   `service worker not registered`.

**Step 5 needs the `app` recipe's renderer image.** Only qits-ci's `app` recipe builds on
`node-browser-base`, which carries Playwright's Chromium; a `spa-frontend` repository builds on
`node-base`, where the check fails with `needs the renderer image`. An offline-first app is an
`app`-archetype repository, so its `npm run build` runs the check, and a build that would not
install or start offline fails its release request.

## Where an interaction leads: `outcomes`

An interaction declares, once, where it can end (ticket qits-2001): each **exit** is a route of
the app, each **stay** an end on the same page (a refusal, a validation error). The declaration
is a field initializer, because `outcomes()` injects the `Router`:

```ts
import { exit, outcomes, QitsExit, QitsTriggers, stay } from '@qits/angular';

@Component({
  imports: [QitsExit, QitsTriggers],
  template: `
    <a [qitsExit]="create.cancelled" [exitParams]="{ slug: slug() }">Cancel</a>
    <button [qitsTriggers]="[create.created, create.refused]" (click)="submit()">Create</button>
  `,
})
export class WorkCreatePage {
  readonly create = outcomes('create-work-item', {
    created: exit('projects/:slug/work/detail/:id'),
    cancelled: exit('projects/:slug/work'),
    refused: stay(),
  });

  async submit() {
    const { data, error } = await this.store.create(/* … */);
    if (error || !data) return this.create.refused.reach();
    await this.create.created.go({ slug: this.slug(), id: data.id }, { replaceUrl: true });
  }
}
```

- **Entries.** Each declared key is a frozen entry carrying `interaction`, `outcome` (the key),
  `kind` (`'exit'`, `'stay'`, `'returnTo'` or `'external'`) and `to` (the path pattern, the
  external's name; `null` for a stay or a return).
- **An exit** has `url(params)`, the absolute URL (`/projects/demo/work`, and `/` for the root
  path `''`) with each param `encodeURIComponent`ed, and `go(params, options?)`, which records
  the outcome and returns `router.navigateByUrl(url, options)`. `options` (`ExitGoOptions`) is the
  router's `NavigationBehaviorOptions` (`replaceUrl`, `state`, …) plus `queryParams` and
  `fragment` (ticket qits-2038): with either, `go()` navigates to the URL tree they make with the
  path (`go({ slug }, { queryParams: { tab: 'work' }, fragment: 'open' })` goes to
  `/projects/demo?tab=work#open`) and records that URL; `url()` stays the path alone. A path
  without params takes no argument (`go(undefined, { queryParams })` or `go({}, { fragment })`
  when it needs options); a missing param throws.
- **A stay** has `reach()`, which records the outcome and does nothing else.
- **A return** (`returnTo()`) goes back to a URL the interaction was handed, such as a sign-in's
  return path: `go(url, behaviour?)` records it and returns `router.navigateByUrl`. Only a URL of
  the app is followed (one leading `/`, not `//host` or `/\host`); anything else goes to `/`.
- **An external** (`external('idp')`) leaves the app for another site, named, not routed:
  `leave(href)` records it with the `href`, then calls `QITS_LEAVE_APP` (an injection token,
  `providedIn: 'root'`, by default `DOCUMENT.location.assign(href)`). A routed browser test that
  reaches an external (the session guard's `session-guard:signedOut`, or the session expiry's
  `session-expired:signedOut` when a platform call answers 401) provides its own, such as
  `{ provide: QITS_LEAVE_APP, useValue: vi.fn() }`, so the test page is not navigated away;
  overriding the `DOCUMENT` instead breaks rendering.
- **Untriggered interactions.** `outcomes(interaction, declared, { triggered: false })` says no
  element triggers it (a guard, a callback page), so no screenshot is asked to show its trigger.
  The option is read from the source only, and it must be an object literal there.
- **Nothing navigates past them.** The lint rule `qits/navigation-through-outcomes` (see
  [Lint rules](#lint-rules-qitsangulareslint)) reports `Router.navigate` / `navigateByUrl` and raw
  `routerLink`s in the app's code, so every navigation is a declared outcome.
- **`QitsExit`** (`<a [qitsExit]="…" [exitParams]="…">`, on `<a>` only) renders a real `href`,
  through the `LocationStrategy` as `RouterLink` does, so the base href is honoured. A plain
  primary click records and navigates; a click with ctrl, meta, shift or alt, a middle click, or
  a `target` other than `_self` is left to the browser and records nothing. `[exitQueryParams]`
  and `[exitFragment]` (ticket qits-2038) add a query and a fragment, as `RouterLink`'s
  `queryParams` and `fragment` do: the `href` carries them and the click goes to that same URL.
- **Active links.** `QitsExit` replaces `routerLinkActive` (ticket qits-2038). Its `isActive()`
  signal is true while the router's URL contains the exit's path, so a parent route's link stays
  active on its children (`RouterLinkActive`'s default; the query, the fragment and matrix params
  do not count), and then the link carries `aria-current="page"`, as
  `ariaCurrentWhenActive="page"` set it. `[exitActiveExact]="true"` makes it active on that very
  path only. A template that read `#x="routerLinkActive"` / `x.isActive` reads
  `#x="qitsExit"` / `x.isActive()`; style the active link with `[class.active]="x.isActive()"` or
  `a[aria-current='page']`. `[exitCurrent]` (ticket qits-2064) overrides what `aria-current` the
  link renders: bound to a token (`'step'`, `'true'`, …) the link carries that `aria-current`
  whatever the route, bound to `null` it carries none even while active, and left unbound it keeps
  the path rule above. `isActive()` itself never changes with `[exitCurrent]` — it is always the
  path rule.
- **Trigger marks.** `QitsExit` and `[qitsTriggers]="[…]"` set `data-qits-outcome` to
  `<interaction>:<outcome>` per entry, space-separated in the order given
  (`create-work-item:created create-work-item:refused`). `outcomeMark(...entries)` returns the
  same string, for a component that binds `[attr.data-qits-outcome]` itself. The mark is a plain
  attribute, so it survives into a frozen screenshot page. The interaction span reads it from the
  target or an ancestor: `app.interaction.outcome` is the mark, and without a `data-track-event`
  the first mark's interaction names the span (`interaction create-work-item`) and
  `app.interaction.name`. `data-track-event` wins when both are there.

**The compiler checks the names**, through the `QitsApp` interface an app augments. Unaugmented,
`RoutePath` and `InteractionName` are `string`, and the params are still parsed from the literal
path (`PathParams<'projects/:slug'>` is `{ slug: string | number }`).

- `routePath`: `qits/route-paths` (below) generates `src/app/route-paths.ts` from the route tables,
  with the augmentation in it. `exit()` then refuses a path the router does not serve, and `go()`
  refuses a missing or misspelled param. The file is opt-in: create it (empty is enough) and run
  `eslint --fix src/app/route-paths.ts` to generate it.
- `interaction`: one line next to the app's own list of interactions, so `outcomes()` refuses an
  unknown one:

```ts
// src/app/interactions.ts
export type InteractionSlug = 'create-work-item' | 'open-project';
declare module '@qits/angular' {
  interface QitsApp {
    interaction: InteractionSlug;
  }
}
```

**Recording in browser specs.** Call `recordOutcomes()` from `@qits/angular/testing/browser` once
in the browser specs' setup file. Every `go()`, `reach()` and handled `QitsExit` click is then
recorded with `{ interaction, outcome, kind, to, url? }` (`url` for all but a stay), plus `spec`
(`expect.getState().testPath`), `test` (`currentTestName`) and `route` (the pattern the TestBed's
router had matched when it was reached, `currentRoutePattern()`, or `null`). `outcomeRecords()`
gives the current test's records in order, for assertions. `takeOutcomeRecords()` gives the spec file's records since
the last call and forgets them, as `takeRouteRecords()` does for routes. Records start empty before
every test, and nothing outside a test is recorded. Without `recordOutcomes()` the main entry
records nothing; its seam, `ɵsetOutcomeRecorder`, is internal.

```ts
// src/testing/browser/setup.ts
import { recordOutcomes } from '@qits/angular/testing/browser';
recordOutcomes();

// a page spec
import { outcomeRecords } from '@qits/angular/testing/browser';
await page.getByRole('button', { name: 'Create' }).click();
expect(outcomeRecords().map((r) => r.outcome)).toEqual(['created']);
```

**Checking that every outcome is tested** (ticket qits-2003). After each test, `recordOutcomes()`
sends the test's records through the browser command `qitsOutcomes`, which
`screenshotReferences({ freezes })` registers (without it, nothing is sent), and the run writes
them into the freeze manifest as `outcomes.fired`, beside `outcomes.declared`, read from the
source (see [the manifest](#screenshots-frozen-as-html-freezescreenshots-and-the-freezes-option)).
Each freeze also lists the trigger marks visible in its shot (`triggers`). Then
`qits-angular screenshots --check` names, one line each:

- **an outcome no browser test reaches.** A page's outcome needs a fire on its own route, a
  layout's one in its subtree, an app-wide one anywhere;
- **a stay no screenshot follows.** A stay leaves the page where it is, so the page after it must be
  shown; an exit needs no screenshot of its own;
- **a trigger no screenshot shows.** A page's needs a freeze of its route listing it in `triggers`,
  a layout's one of its subtree, an app-wide one any freeze, `route: null` ones included. This is
  not the same as reaching it: a test may click a button no screenshot shows. Not asked of a
  `triggered: false` interaction;
- **a route no outcome leads to, and that is not an entry point** (ticket qits-2049, below);
- **an `outcomes()` call it cannot read**, by `file:line`: a non-literal interaction, a spread, a
  computed key, an entry that is no `exit()` / `stay()` / `returnTo()` / `external()` call, an exit
  or external without a string literal, options that are not `{ triggered: true | false }`.

```text
create-work-item:refused (projects/:slug/work/create): no browser test reaches it.
create-work-item:refused (projects/:slug/work/create): a stay needs a screenshot after it is reached.
create-work-item:refused: no screenshot of projects/:slug/work/create shows its trigger. Add a screenshot test where it is visible, with another provider state if needed (an open menu, a loaded list).
auth/old: no outcome leads here, and it is not an entry point. Add the exit that should lead here, or declare it an entry point.
src/app/routes/projects/projects.page.ts:12: an outcomes() call that cannot be read statically (a spread).
```

The declarations are read statically, with the app's own `typescript` (resolved from the app root;
an optional peer of `@qits/angular`; when it is missing the check names it as a gap): every `.ts` file
under `src/app` (specs left out) whose `outcomes(...)` call is the `outcomes` import from
`@qits/angular`, renamed or through a namespace import. The scope is the declaring file's
directory under the routes directory (`src/app/routes`, `--routes <dir>`, as the lint rules'
`routes` option): a file there that is not a `*.layout.ts` declares for exactly the route its
directory names (`projects/[slug]` → `projects/:slug`, the directory itself `''`); a `*.layout.ts`
there for its route's whole subtree; a `*.layout.ts` under the `$layout` alias and any file outside
the routes directory for the whole app (`route: null`). Layout and app-wide declarations are
`global: true` and checked once, not per page.

**The library's own outcomes count too** (ticket qits-2044). The sign-in callback page declares
`sign-in` (`succeeded`, a return; `failed`, a stay; both `triggered: false`) and `sign-in-failed`
(`restarted`, its Start again link, an exit to `''`) on `auth/callback`; the session guard declares
`session-guard:signedOut` (an external to `idp`, `triggered: false`) app-wide; and the bearer
interceptor and `QitsBearerFetch`, when a platform call answers 401 and no refresh helps, leave
through `session-expired:signedOut` (the same, app-wide, ticket qits-2052). They ship in the
package (`screenshots/outcomes.json`) and join the app's declarations when the app imports
`qitsAuthCallbackRoute` or `provideQitsBearerSignIn` (the sign-in ones), `qitsSignedInGuard` or
`QitsSession` (the guard's), `qitsBearerInterceptor` or `QitsBearerFetch` (the expiry's) from
`@qits/angular` in a non-spec file under `src/app`. Their `file` is the library's source,
`@qits/angular/src/lib/…`. So an app that signs in this way needs browser tests that reach them,
as it does for its own; a test that reaches an external one stubs `QITS_LEAVE_APP`. Their slugs
(`sign-in`, `sign-in-failed`, `session-guard`, `session-expired`) are the library's: an app does
not declare an interaction of its own under any of them.

**Entry points** (ticket qits-2049). Besides the outcome gaps above, `--check` also holds every
_checked_ route — a row of `manifest.routes` (`describeRoutes()`'s tree, walking `children`) with
no `children` of its own, no `redirectTo`, and a `path` other than `**` — against the declared
exits: a route is reached when some declared `exit()`, in any scope (a page's own, a layout's,
app-wide, or the library's), has a `to` equal to the route's `fullPath`. A route entered from
outside the app rather than by a declared exit — an idp redirect, an old bookmarked address — says
so instead of needing an inbound exit, with `data: QITS_ENTRY` (or the plain
`data: { qitsEntry: true }` the manifest key reads; `QITS_ENTRY` is just the typed way to write it)
on its route, which `describeRoutes()` copies into `routes[].entry`. `qitsAuthCallbackRoute` is
already marked this way, so every app that imports it gets the entry point for free. A route with
no inbound exit and no `entry: true` is its own gap, named by its `fullPath` (`''` as `/`), and is
report-only until `--enforce-outcomes` like the rest:

```ts
import { QITS_ENTRY } from '@qits/angular';
export const routes: Routes = [{ path: '', data: QITS_ENTRY, component: HomePage }];
```

**Forwards and page routes** (ticket qits-2076). A _forward_
is a route that renders a component but leaves as soon as it is entered (a page that only decides
where to send you): it is not `rendersNothing`, has no string `redirectTo` and a `path` other than
`**`; the declared entries whose `route` is exactly its `fullPath` (page or layout scope; an
app-wide `route: null` entry never counts) exist and are all `exit()`s with `triggered: false`; and
every route below it is `rendersNothing` (a route without children qualifies, a layout over real
pages never does). At the end of the run the freeze writer marks each one `forward: true` in
`manifest.routes` — on the forward itself, not on its `rendersNothing` children, though a `''`
child shares its `fullPath`. A manifest written before `rendersNothing` has no flag to read, so a
route with children there is never a forward. `@qits/angular/screenshots` exports both readers:

- `forwardRoutes(manifest, declared)`: the `Set` of the forwards' `fullPath`s, computed from the
  route tree and the declarations.
- `pageRoutes(manifest, declared?)`: the checked routes minus the `rendersNothing` ones and minus
  every route in a forward's subtree (the forward and its `''` child among them). Any rule about
  the states a page shows must iterate this set. It reads the `forward: true` flags of the manifest;
  given `declared`, it computes the forwards with `forwardRoutes()` instead.

Neither changes a gap: the reachability check above still holds every checked route, forwards
included, since a forward still has to be led to.

The rollout is opt-in: the outcome gaps are **report-only** (printed to stderr under a heading
that says so, the exit code untouched) until the app adds `--enforce-outcomes`, which makes any gap
exit 1, as an orphan does. An app without a declaration reports nothing, so it migrates page by
page and adds the flag to its `test:browser` script once its gaps are gone. An update run
(`UPDATE_SNAPSHOT`) lists the gaps and exits 0.

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

**Text answers** (ticket qits-2058). A provider may record a text body (an `.html` or `.txt` file
the index's `file` names), which the app requests with `responseType: 'text'`. `text(state,
operationId)` on the Node-side reader gives that file verbatim (`pactedGoldenMasters` checks it as
it checks `body`), and `fromGoldenMasterTexts(read, source?)` (or `recordedText(text, source?)`)
registers it in the browser. Flush the string as it is: Angular passes a string through to a text
request, where it would JSON-stringify an object. A string has no identity, so it is registered by
**value**: a string equal to a recorded text passes the guard, any other string is refused.

```ts
// vitest-browser.config.ts: READERS maps a provider to its pactedGoldenMasters(…) reader
// … commands: { goldenMasterText: (_ctx, state, operationId, p) => READERS[p].text(state, operationId) }

// src/testing/browser/golden-master.ts
export const goldenMasterText = fromGoldenMasterTexts(
  (state: string, operationId: string, provider: Provider = 'qits-projects') =>
    commands.goldenMasterText(state, operationId, provider),
  (state, operationId, provider = 'qits-projects') => ({
    provider: REPOSITORY[provider],
    state,
    operationId,
  }),
);

// a page spec
req.flush(await goldenMasterText('a project exists', 'getReadme'));
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
  routes only from `routes`. `takeRouteRecords()` returns what the running spec file noted, sorted
  and without duplicates, and forgets it; `clearRouteRecords()` only forgets. Every spec file runs
  in the same page, so each route is stamped with the file that noted it: `guardGoldenMasters()`
  clears them in a `beforeAll`, so a file starts with none, and `takeRouteRecords()` drops, with a
  `console.warn` naming the file and the record, any route noted in another file (or outside one).
  The setup file needs nothing more than the two lines below.
- **The ledger keeps it.** `goldenMasterRoutes(ledgerPath, root?)` (from `@qits/angular/testing`)
  is the Vitest browser command the setup file sends the records to after each spec file, and
  `.plugin` on it is the Vite plugin that adds its reporter to the run: put the command in
  `browser.commands` and the plugin in the config's `plugins`, or nothing is written. A call only
  stages the spec's records; when the run ends, the reporter rewrites the section of every spec
  file that ran completely (it passed, and so did every test in it) and nothing else:
  `{ "<spec path relative to root>": [records] }`, records sorted and without duplicates, keys
  sorted, two-space JSON with a trailing newline, written only when the text changed. A spec file
  that ran completely and sent an empty list loses its section; one that ran completely but never
  sent its records keeps its section as it was, and the reporter warns, naming the spec; a file that failed (in a test or in
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

| Rule                                         | What it enforces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qits/client-only-in-stores`                 | Only `*.store.ts` files, `*.operations.ts` files and specs import a generated client, so every backend call goes through a store or through an operation declared in a `*.operations.ts` file. Type-only imports are fine. Files in `allow` (default `src/app/app.config*.ts`, `src/main*.ts`) may import it to set the client up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `qits/consume-client-calls`                  | In a store, every call to a generated client function is the first argument of `consume(call, paths)`; awaiting it on its own, `.then`, passing the promise or the function elsewhere, and `…Resource` helpers (no promise to wrap) are reported. In a `*.operations.ts` file the client function is never called at all: the only accepted use is `call: getX` in the object literal passed to `qitsOperation({ ... })` — calling it, wrapping it in `consume`, or passing it anywhere else is reported there instead. Option `consume` renames the wrapper, `operation` renames `qitsOperation`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `qits/store-has-pact`                        | A store or operations file that imports a generated client has its pact spec beside it: `<name>.store.pact.spec.ts` for a store, `<name>.operations.pact.spec.ts` for an operations file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `qits/reads-through-resources`               | **Off** in `recommended`: an app turns it on, route by route, as it migrates (see [API reads and writes](#api-reads-and-writes-qitsresource-and-qitsmutation)). Reports three ways round `qitsResource` / `qitsMutation`: using a generated client function directly, called or not (a type-only import is fine); calling `qitsOperation(...)` anywhere but a `*.operations.ts` file, where no pact spec stands beside it; and `inject(X)` of a store whose own file imports a generated client, which means the data still arrives through the store's calls rather than through an operation (a store that imports no client — UI state only — is fine). `X`'s import is followed to a `*.store.ts` file on disk, relative or through a tsconfig path alias (`$core/…`). Specs and the generated clients themselves are not read, and inside an operations file the client function itself is `consume-client-calls`' business, not this rule's. Options `clients` / `operation` (default `qitsOperation`), shared with the other client rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `qits/data-through-fields`                   | **Off** in `recommended`: an app turns it on, route by route, once its templates carry the data marks, with typed linting (see [Holding a page to its marks](#holding-a-page-to-its-marks-qitsdata-through-fields)). In a component's template (inline or `templateUrl`), the API data it renders — read from a `qitsResource` field's `value()` (option `resource`) or from an `input()` / `model()` whose type, a union member, an array element or a type argument of it, is declared under `clients` — sits under a `qitsField` inside a `qitsEntity` / `qitsEntityList`. Interpolations, `[textContent]` / `[innerText]` / `[innerHTML]`, and every input of an element whose tag starts with a `display` prefix (default `['ui-']`) render; class, style, `attr.*`, the marks' own inputs and control-flow conditions do not. Reported: rendered data with no `qitsField` at or above it; a `qitsField` with no entity mark at or above it in the same template; a pipe, call, operator, template literal, ternary or non-alias `computed` under a plain path mark (it needs `{ derived: [...] }`); a literal path naming another field than the plain path shown; a literal `{ derived: [...] }` missing a path the expression reads. A `computed(() => <plain path>)` (or `linkedSignal`) is that path, an `@for` item an entity of its own. Without typed linting it says so once per component class. Options `clients` / `resource` (default `qitsResource`) / `display`.                                  |
| `qits/pact-names`                            | In a `*.pact.spec.ts`, `new PactV4({ consumer, provider })` and `addGoldenInteraction(…, { provider, trigger: { app } })`: the consumer and trigger app equal the nearest `package.json` `name`; the provider is a repository name ending in a role (`-service`, `-frontend`, `-app`, `-daemon`, `-oci`, `-cli`, `-javalib`, `-jslib`). Give names as string literals or consts, or the rule cannot check them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `qits/page-location`                         | A `*.page.ts` or `*.layout.ts` file lives under the routes directory (a `*.layout.ts` also under the `$layout` alias directory, when the project has one), and every component class under the routes directory lives in such a file. Other files there (a resolver, a guard, a `*.routes.ts`) and specs are fine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `qits/page-suffix`                           | The exported component in a `*.page.ts` ends in `Page`, the one in a `*.layout.ts` ends in `Layout`, and a component named `…Page` / `…Layout` lives in such a file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `qits/page-has-screenshots`                  | Every `*.page.ts` and `*.layout.ts` under the routes directory, and every `*.layout.ts` under the `$layout` alias directory, has `<name>.page.browser.spec.ts` / `<name>.layout.browser.spec.ts` beside it, and that spec calls `toMatchScreenshot`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `qits/page-screenshots-through-routes`       | A `*.page.browser.spec.ts` / `*.layout.browser.spec.ts` under the routes directory opens its page through the app's routes: it calls one of `helpers` (default `['openRoute']`) or passes a route table imported from a route-table file to the router (`provideRouter(routes)`). Reported: `TestBed.createComponent(X)` with `X` from a `*.page.ts` / `*.layout.ts`; `provideRouter`, `RouterModule.forRoot` or `RouterTestingModule.withRoutes` given anything else (`[]`, an inline table, a local constant); and a spec doing neither, once, on its first `toMatchScreenshot`. Specs elsewhere (patterns, UI components, a `$layout` layout) are not read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `qits/screenshot-kind`                       | **`warn`** in `recommended`. In a `*.browser.spec.*` file, every `toMatchScreenshot` call passes an options object (after the name, or alone) whose `kind` is a string literal from the enum (`'DATA'`, `'NO_DATA'`, `'PENDING'`, `'ERROR'`); a `viewports` there is an array of enum literals (`'PHONE'`, `'TABLET'`, `'DESKTOP'`), and a `colorSchemes` one of `'LIGHT'`, `'DARK'`, with a non-empty string-literal `reason` beside either. Reported: no options object, no `kind`, a `kind` that is not such a literal, a `viewports` or `colorSchemes` that is not such an array, either without a `reason`. See [What a screenshot shows](#what-a-screenshot-shows-kind-and-the-preset-widths).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `qits/page-screenshot-whole-page`            | **`warn`** in `recommended`. In a `*.page.browser.spec.ts` / `*.layout.browser.spec.ts` under the routes directory, the subject of every `expect.element(<subject>).toMatchScreenshot(...)` (or `expect(<subject>)`) is the whole page: a member named in `wholePage` (default `['frame', 'routeNativeElement']`) that is not chained further (`opened.frame`), `page.elementLocator(<whole page>)`, a `const` / `let` bound to one (awaited or not) or destructured under a `wholePage` key (`const { frame } = await shown()`), or a call to a function of the same file whose every return is one. Reported, on the subject: anything else (`getByRole(...)`, `querySelector` / `closest` results, `opened.page`, other helper calls, parameters). A part of the page goes in its component's own browser spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `qits/route-matches-directory`               | In a route table, every route with `component` or `loadComponent` (and every `loadChildren`) imports from the directory its URL names: the `path`s from the top of the table through `children`, `''` skipped, `:param` as `[param]`, relative to the routes directory. `path: '**'` may render any page; `redirectTo` routes are skipped. A route table under the routes directory is mounted at its own directory. A `*.layout.ts` under the `$layout` alias directory is shared and not checked. Imports through a path alias and non-literal paths are not checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `qits/route-paths`                           | Keeps `src/app/route-paths.ts` (option `file`) generated from the route tables: `export type RoutePath`, every full path of a route with `component`, `loadComponent`, `children` or `loadChildren` (`''` included, `**`, `redirectTo` and non-literal paths left out, a nested `*.routes.ts` prefixed by its directory; sorted, no leading slash), and the `declare module '@qits/angular' { interface QitsApp { routePath: RoutePath } }` augmentation that makes `exit()` refuse other paths. Reports `stale` on that file when it differs; the fix rewrites it, so `eslint --fix src/app/route-paths.ts` is the generator. The file is opt-in: create it (empty is enough) and run that fix; a missing file is not reported. See [Where an interaction leads](#where-an-interaction-leads-outcomes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `qits/navigation-through-outcomes`           | **`warn`**, as are `screenshot-kind` and `page-screenshot-whole-page`. Navigation goes through a declared outcome ([Where an interaction leads](#where-an-interaction-leads-outcomes)): it then reports a `Router.navigate` / `Router.navigateByUrl` call and a raw `routerLink` (plain or `[routerLink]`, on any element or `<ng-template>`) in a component's `template` or `templateUrl`. The `Router` is found without type information: the names it is imported under from `@angular/router`, then `inject(Router)`, a `this.<name>` whose field is `inject(Router)` or typed `Router` (constructor parameter properties too), and a parameter or variable typed `Router` or set to `inject(Router)`. `routerLinkActive`, `createUrlTree` / `parseUrl` (they do not navigate) and clicks that do neither are not reported, nor are specs or `src/testing/`. An empty command list — `navigate([], …)` (never `navigateByUrl`) or `[routerLink]="[]"` — keeps the current route and changes only the query or fragment, a local click under owner decision 4 (epic qits-2000, ticket qits-2038), and is not reported; `navigate([])`'s second argument, if any, must carry no `relativeTo` or one that is a plain identifier or a `this.<name>`/`this.#name` member — anything that could still name another route (`.parent`, a call, a computed member) keeps it reported. An external template's report sits on `templateUrl` and names `<file>.html:<line>:<col>`. Options `include` / `exclude` (see below). |
| `qits/browser-spec-data-from-golden-masters` | In every `*.browser.spec.ts` except the UI components' (option `syntheticAllowed`, default `['src/app/ui/**']`): no `patchState`, no `TestBed.overrideProvider`, no `useValue`/`useFactory`/`useClass`/`useExisting` for a `*Store` token or for any token imported from the app's state tree (`$core/…` or a path with `/core/`, such as `SelectedProject`; option `allowTokens: ['EVENT_SOURCE']` exempts named state-tree tokens that are transport seams only, never data, and never a `*Store`), no import from a `*.store` file except `import type`, no `recorded`/`fromGoldenMasters`/`recordedText`/`fromGoldenMasterTexts` import; the first argument of `flush(…)` traces back to a golden-master call, unless the options give a literal `status` of 400 or more (or 204 with `null`). See [Browser spec data comes from golden masters](#browser-spec-data-comes-from-golden-masters-qitsangulartestingbrowser).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `qits/theme-colors`                          | **Off** in `recommended`: an app turns it on (`'qits/theme-colors': 'error'`) once its theme has semantic tokens. In a dark-mode-capable app, colours come from the theme's semantic tokens, never a palette step or a literal colour. Reported: a colour utility (`bg-`, `text-`, `border-*`, `ring-`, `fill-`, `from-`, `shadow-`, …) naming a palette colour — `white`, `black`, a Tailwind default step (`gray-500`) or a step the theme declares (`charcoal-brown-600`) — whatever its variants, `!`, `-` or opacity; an arbitrary value holding a raw colour (`bg-[#fff]`, `text-[oklch(…)]`) or a palette `var(--color-…)`, and `bg-(--color-<step>)`; in CSS, a hex, a colour function (`rgb()` … `oklch()`, `color()`, `color-mix()`), a named colour or a palette `var(--color-…)`. Allowed: semantic utilities and vars (`bg-surface`, `text-fg-muted/50`, `bg-(--color-surface)`), `current`, `transparent`, `inherit`, `initial`, `unset`, and non-colour suffixes (`text-sm`, `border-2`, `text-[13px]`). Option `theme`; where it reads and the suggestion are below.                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Generated clients are `src/app/api/**` (relative to the nearest `package.json`) unless you pass
`{ clients: ['<glob>', …] }` to `client-only-in-stores`, `consume-client-calls`, `store-has-pact`
and `reads-through-resources`. A path alias such as `@api/**` is matched as written.

**`reads-through-resources` is off in `recommended`** for the same reason `theme-colors` is: an
app migrates one route at a time, so it is turned on with a `files` override naming that route's
files, not for the whole `src/app/**` at once:

```js
// eslint.config.mjs
export default [
  ...yourConfig,
  ...qits.configs.recommended,
  {
    files: ['src/app/routes/projects/[slug]/agents/**/*.ts'],
    rules: { 'qits/reads-through-resources': 'error' },
  },
];
```

`navigation-through-outcomes` reads the files matching `include` (default `['src/app/**']`) and not
`exclude` (default `['src/app/api/**']`), both globs relative to the nearest `package.json`, so
the `ui/components/` primitives are covered too: a primitive that links takes an outcome entry
(`input<ExitEntry>()` bound to `<a [qitsExit]>`) instead of a path. A real exception, such as a
page that only redirects, opts out with
`// eslint-disable-next-line qits/navigation-through-outcomes -- <reason>`. A line comment cannot
sit inside an inline template, so put a
`/* eslint-disable qits/navigation-through-outcomes -- <reason> */` …
`/* eslint-enable qits/navigation-through-outcomes */` pair round the `template:` property.

`theme-colors` reads a component's templates (`template` and `templateUrl`: `class`, `[class.x]`,
the string literals of `[class]` / `[ngClass]`, `style`, and literal `[style.x]`, `[style]` and
`[ngStyle]` values) and styles (`styles`, `styleUrl` / `styleUrls`: declaration values and
`@apply`), and every other string of the file for colour utilities only, so a raw colour in
TypeScript (`'rgba(0, 0, 0, 0)'`, a spec fixture's `'#2563eb'`) is not reported. Interpolated
parts (`${…}`, `{{…}}`, bound expressions) are never read. The tokens come from the theme: option
`theme` (default `src/styles.css`, relative to the nearest `package.json`) and every stylesheet it
`@import`s, relative or from a package (`exports` with the `style`, then `default` condition),
Tailwind itself not followed. A `--color-<name>` in an `@theme` block makes `<name>` a colour: a
palette step when it ends in `-<number>`, a semantic token otherwise. A report suggests the
semantic token whose light value is the fixed colour's (`text-charcoal-brown-600` → `text-fg-muted`
when `--color-fg-muted` resolves to `var(--color-charcoal-brown-600)`; `#fff` →
`var(--color-surface)`): `var()` chains are followed through the theme's custom properties outside
any dark context (`prefers-color-scheme: dark`, a `.dark` / `[data-theme="dark"]` selector,
`@variant dark`, `@custom-variant`), and `light-dark(a, b)` is `a`. The suggestion is offered in
the editor for an inline position; it is never an autofix, and an external template or stylesheet
is reported on its `templateUrl` / `styleUrl` with `<file>:<line>:<col>`. A missing theme still
reports palette colours, saying the theme was not found.

**Routes on the filesystem.** `src/app/routes/` mirrors the URL. A routed component is a page,
`<name>.page.ts` with a class ending in `Page`, in the directory of its route: the route
`projects/:slug/work` renders `src/app/routes/projects/[slug]/work/project-work.page.ts`
(`ProjectWorkPage`). A route with `children` renders a layout, `<name>.layout.ts` with a class
ending in `Layout`, in the directory of its own path (path `''` is `src/app/routes/`). Components
that are not routed stay outside (`ui/components/`, `patterns/`). The route rules take
`{ routes: 'src/app/routes', routeTables: ['src/app/app.routes.ts', 'src/app/**/*.routes.ts'] }`
(the defaults shown), relative to the nearest `package.json`; `page-has-screenshots` reads only
`routes`, `page-screenshots-through-routes` also takes `helpers` (default `['openRoute']`),
`page-screenshot-whole-page` takes `wholePage` (default `['frame', 'routeNativeElement']`), and
`route-paths` also takes `file` (default `src/app/route-paths.ts`). A shared layout
may also live outside `routes/`: point the `$layout/*` path alias in the project's `tsconfig.json`
(next to `package.json`, `extends` followed) at a directory, such as
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

The screenshots show the page where the app shows it: through the app's own route table, so the
layouts above it render around it and each freeze names the real route (ticket qits-1998). A page
or layout spec under the routes directory that mounts the page itself
(`TestBed.createComponent(ProjectsPage)`), hands the router a table of its own
(`provideRouter([{ path: 'projects', component: ProjectsPage }])`, `provideRouter([])`), or never
opens a route fails `page-screenshots-through-routes`. Open it with the app's helper (`openRoute()`
by default; name yours with `{ helpers: ['openPage'] }`) or with `provideRouter(routes)` and
`routes` imported from `app.routes.ts` (or another route-table file). `freezeScreenshots()` checks
the same at run time ([below](#screenshots-frozen-as-html-freezescreenshots-and-the-freezes-option)).
A real exception opts out with a reason, above its first screenshot or for the whole file:

```ts
// eslint-disable-next-line qits/page-screenshots-through-routes -- shows the bare page on purpose
await expect.element(view).toMatchScreenshot('bare');
// or, first in the file:
/* eslint-disable qits/page-screenshots-through-routes -- mounts a stand-in route on purpose */
```

What such a spec screenshots is the whole page, too (ticket qits-2074): a freeze taken there is
listed as a state of its route, so a crop (an action bar, one region) would be shown as "the page
in state X". `page-screenshot-whole-page` (`warn` in `recommended`) reports a screenshot whose
subject is not `opened.frame` (or `page.elementLocator(opened.frame)`, a name bound to it, a
destructured `frame`, or a helper of the same file returning it). Put a part of the page in its
component's own browser spec under `patterns/` or `ui/`, or give the page a provider state that
shows it; a real exception opts out with
`// eslint-disable-next-line qits/page-screenshot-whole-page -- <reason>`.

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

`--check` also reports the outcome gaps (report-only unless `--enforce-outcomes`; see
[Where an interaction leads](#where-an-interaction-leads-outcomes)), reading `manifest.json` from
`--freezes <dir>` (default `src/testing/browser/freezes`) and the declarations' scope from
`--routes <dir>` (default `src/app/routes`).

A reference is an orphan when:

- its spec file is gone (found without a test run, so `--check` is useful in `lint` too);
- or the recorded run ran its spec completely (every test passed, nothing skipped or filtered), the
  spec has not changed since, and no test asked for that reference;
- or, in a spec whose tests that did not pass all skipped themselves (`it.skip`, `it.todo`, a false
  `skipIf`/`runIf`, `ctx.skip()`; nothing failed, nothing filtered or `.only`), unchanged since, the
  run took its shots in colour schemes (`freezeScreenshots({ colorSchemes })`), no test asked for
  that reference, and its name ends in none of the schemes (`-light-<browser>-<platform>.png`,
  `-dark-…`): every shot of such a run, a skipped test's too, is named with its scheme.

A spec that the record does not cover that way is not judged, so a partial run never reports a
false orphan. In a spec with self-skipped tests, a reference no test asked for that does end in a
scheme (or any such reference, in an app without `colorSchemes`) is not judged either: a skipped
test may own it, and `--verbose` says how many (`2 skipped test(s) may own 3 reference(s)`). With `UPDATE_SNAPSHOT` set (an update run, as Vitest reads it), `--check` lists the
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
// with kinds required and the page specs shot at the preset widths (ticket qits-2046, below):
// freezeScreenshots({ routes, requireKind: true, viewportSpecs: DEFAULT_ROUTE_SPECS });
// and every shot in light and dark too (ticket qits-2083, below):
// freezeScreenshots({ routes, viewportSpecs: DEFAULT_ROUTE_SPECS, colorSchemes: ['LIGHT', 'DARK'] });

// vitest-browser.config.ts (Node side)
plugins: [screenshotReferences({ freezes: true })];
// or { freezes: { dir: 'src/testing/browser/freezes', routeSpecs: /\.page\.browser\.spec\.ts$/ } }
// (the browser side takes freezeScreenshots({ routes, routeSpecs }) with the same default)
```

`freezeScreenshots()` overwrites the matcher once (`chai.util.overwriteMethod` on
`chai.Assertion.prototype`, `chai` from `vitest`): Vitest's matcher runs first, and when it passed,
the element `expect.element` resolved is serialized (`freezeShot()`) and sent through the browser
command `qitsFreeze`; the route tree goes through `qitsFreezeRoutes`. Both are registered by the
`freezes` option. A failing shot fails the test and freezes nothing.

A shot in a page or layout spec under the routes directory (option `routeSpecs`, default
`DEFAULT_ROUTE_SPECS`, `/(^|\/)src\/app\/routes\/.*\.(page|layout)\.browser\.spec\.[cm]?[jt]sx?$/`,
matched against the test file) must show the app's routes, or it fails its test after Vitest's
matcher passed and nothing is frozen for it (ticket qits-1998). With `routes` given, the TestBed
must have a router (asked without creating one) whose top matched route is one of `routes`
(`renderedThroughRoutes(router, routes)`: the element itself or the router's copy of it, since the
`Router` copies every route it is given; a stand-in route, a layout with other children or another
component fails). Without `routes`, the router must have matched a route pattern. The error names
the spec (relative to the root), the shot and the test, and says to open the page through the app's
routes (`openRoute()`, or `provideRouter(routes)` with the routes from `app.routes.ts`). The lint
rule `qits/page-screenshots-through-routes` reports the same before a run. `freezeScreenshots()` also clears the guard's
per-test records before every test (`currentTestRecords()`, the recorded answers flushed since the
test started, router or not).

What the run writes, under `dir` (default `src/testing/browser/freezes`, the tree the
`screenshot-baselines` automation commits):

- `<spec path relative to the root>/<name>.html`: one file per screenshot. `<name>` is the
  screenshot's name slugged as Vitest slugs the PNG's (`menu/open` → `menu/open.html`,
  `detail: an epic` → `detail-an-epic.html`); an unnamed shot is Vitest's default `<test name> <n>`,
  `<n>` counting every shot of the test, named or not, as Vitest counts it. A shot taken at the
  preset widths ([below](#what-a-screenshot-shows-kind-and-the-preset-widths)) is one file per width,
  `<name>-phone.html`, `<name>-tablet.html`, `<name>-desktop.html`.
- `assets/<file name>`: the same-origin files a freeze uses (the test fonts), copied once from the
  path the URL names under the root (`/src/testing/browser/fonts/x.woff2` →
  `<root>/src/testing/browser/fonts/x.woff2`), referred to relatively (`../../…/assets/x.woff2`).
  Two different files with the same name fail the run. A copy no freeze uses any more is deleted.
- `manifest.json`: `routes` (the tree as `describeRoutes()` gives it: `{path, fullPath, redirectTo?,
entry?, rendersNothing?, forward?, children?}`; `entry: true` marks a route entered from outside the
  app, `data: QITS_ENTRY` on it, ticket qits-2049; `rendersNothing: true` a route with no
  `component`, `loadComponent`, `loadChildren` or `redirectTo` (string or function), a `path` other
  than `**`, and children that all render nothing too — a layout's `''` child, a `:tab` child that
  only feeds the layout a parameter — and `forward: true` a forward, ticket qits-2076, see
  _Forwards and page routes_ under the outcome check; each is omitted when false), `freezes` (`{file, spec, test, name, kind, viewport, route, records, triggers, dataMarks}`,
  sorted by `file`, which is relative to `dir`), `byRoute` (route pattern → files) and `outcomes`
  (below). `name` is the name the spec gave, without a width suffix. `kind` is the state the shot
  says it shows (`'DATA'`, `'NO_DATA'`, `'PENDING'`, `'ERROR'`), `null` when it gave none.
  `viewport` is the preset width it was taken at (`'PHONE'`, `'TABLET'`, `'DESKTOP'`), `null` for a
  shot at the test's own viewport. Both are optional for a reader: a manifest written before them,
  and the entries a run keeps from specs it did not see completely, have neither, and are written
  back with `null`. `route` is
  the pattern the TestBed's router had matched, and only for specs `routeSpecs` matches (default
  `DEFAULT_ROUTE_SPECS`, the page and layout specs under `src/app/routes/`, which open their page
  through the app's routes): pattern and UI specs, and a `$layout` layout's (the shell), mount
  stand-in routes, so theirs is `null`. `triggers` are the `<interaction>:<outcome>` marks (`data-qits-outcome`)
  visible in the shot, split, deduplicated and sorted. They are measured on the live DOM before the
  shot is serialized, because the HTML keeps a closed menu's marks too: a mark counts when the
  element passes `checkVisibility({ checkVisibilityCSS: true })`, has no `hidden` attribute on itself
  or an ancestor, has a box of non-zero size, and that box meets the shot's element (or the page's
  scroll area for a page shot). `dataMarks` are the visible `data-qits-*` marks (ticket qits-2141),
  under the same visibility rule, written only when non-empty; see
  [What a page shows: data marks](#what-a-page-shows-data-marks) above. Two-space JSON, stable key
  order, trailing newline.
- `outcomes.declared`: `{route, interaction, outcome, kind, to, global, triggered, file}` per entry
  of the app's `outcomes()` calls, and of the library's that the app brings in, read from the source
  at the end of the run (scoped by the `freezes` option's `routes`, default `src/app/routes`),
  sorted by route, interaction and outcome.
  `outcomes.fired`: `{spec, test, route, interaction, outcome, kind, freeze}` per outcome a test
  reached (`recordOutcomes()`), sorted by spec and test, in order within a test. `freeze` is the
  first freeze of the same spec and test whose shot came after it (the payload's `outcomes`, the
  test's record count at shot time, is greater than the record's index), `null` when none did. For
  a shot taken at the preset widths it is that shot's DESKTOP freeze (PHONE is taken first), or the
  shot's first freeze when its opt-out leaves DESKTOP out.
  `route` follows the freezes' rule (`null` outside `routeSpecs`).

Every run writes, update run or not, and replaces only what it saw completely
(`completeForFreezes`): a spec in which nothing failed and every test that did not pass skipped
itself (`it.skip`, `it.todo`, a false `skipIf`/`runIf`) gets exactly the freezes it sent (a shot
no test takes any more loses its file); a spec file that no longer exists loses its freezes; a spec
that failed, did not run, or that the run narrowed (`-t`, tags, line or id filters, `.only` in the
file) keeps the freezes it had. Its fired outcomes follow the same rules: a complete spec replaces
them, a gone spec drops them, any other keeps them. The orphan record keeps its stricter rule (every test ran and
passed), and judges a spec with self-skipped tests only by colour scheme. Never edit a freeze by hand.

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
- Elements that are themselves invisible and refreshed on a timer or on input are frozen without
  their contents (the element and its own attributes stay, its children go):
  `freezeScreenshots({ emptyElements })`, a list of selectors, default `DEFAULT_EMPTIED_ELEMENTS`
  (`.xterm-accessibility-tree`, xterm's screen-reader tree: it rebuilds on a 100 ms debouncer after
  the terminal resizes, which a whole-page shot does by itself; and
  `.xterm-accessibility .live-region`, xterm's other screen-reader element: it gets the text
  written to the terminal appended to it on a debouncer and clears only on key input, so a freeze
  catches it empty in one run and full in the next); giving it replaces the default, and `[]`
  disables it.
- A rule already kept in the same at-rule context is kept once, so a sheet the setup injects again
  for every spec file in the shared page does not repeat in later freezes.
- `blob:` URLs (random per run, dead afterwards): a loaded `<img>` from one is inlined as a PNG
  `data:` URL, any other `blob:` URL (in the HTML or a CSS `url()`) becomes `about:blank`.
- The CSS is the page's own rules, filtered: a style rule stays when its selector, without its
  state pseudo-classes and pseudo-elements (`:hover`, `:focus-visible`, `::before`, `:not(…)`, …),
  matches the element, something in it or a shell. `:is()`, `:where()`, `:matches()`,
  `:-webkit-any()` and `:has()` are kept with their arguments stripped the same way, so Tailwind's
  `:is(.\*\:col-span-full > *)` stays only where that class is; `@media`,
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

### What a screenshot shows: `kind` and the preset widths

A shot says which state it shows (ticket qits-2046), so a reader can open a route on its happy
path. Neither the name nor the recordings can tell: a domain status called `pending` that shows
content is the happy path, and a refused write carries the happy path's recordings (non-2xx
answers are never recorded). The kind is an option of Vitest's own matcher, not a wrapper:

```ts
await expect.element(view).toMatchScreenshot('list', { kind: 'DATA' });
await expect.element(view).toMatchScreenshot({ kind: 'NO_DATA' }); // unnamed: Vitest's default name
```

`ScreenshotKind` and `SCREENSHOT_KINDS` (`@qits/angular/testing/browser`):

| Kind      | The shot shows                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA`    | The happy path: content. A domain status named "pending" or "failed" that shows content (a release request's `pending`) is `DATA`; so is a form with no read (a create form). |
| `NO_DATA` | The read answered with nothing to show: an empty list.                                                                                                                        |
| `PENDING` | Waiting: a read in flight (a real loading state), or a write waiting on a timer.                                                                                              |
| `ERROR`   | A read that failed, and a refused write: it shows a refusal, not the happy path. There is no fifth kind for it.                                                               |

Importing `@qits/angular/testing/browser` augments Vitest's `ScreenshotMatcherOptions` (through
`vitest/browser`) with `kind?: ScreenshotKind`, `viewports?: readonly ScreenshotViewport[]`,
`colorSchemes?: readonly ColorScheme[]` and `reason?: string`. `freezeScreenshots()` takes the four
keys out before it calls Vitest's matcher,
so Vitest never sees them. A kind outside the enum fails the shot. The freeze records `kind`.

**`freezeScreenshots({ requireKind: true })`** refuses a shot without a kind: it fails its test
before Vitest's matcher runs, names the spec, the test and the shot, and nothing is frozen or
compared. Without it (the default) the freeze records `kind: null`, so an app that has not given its
shots kinds yet stays green; it turns `requireKind` on together with `qits/screenshot-kind` at
`error`. The lint rule (`warn` in `recommended`) reports the same before a run: in a
`*.browser.spec.*` file every `toMatchScreenshot` call passes an options object with a string-literal
`kind` from the enum, and a `viewports` there is an array of enum literals with a non-empty
string-literal `reason`.

**The preset widths.** `freezeScreenshots({ viewportSpecs })` names the specs, matched against the
test file's path, whose every shot is taken at each preset width, PHONE, TABLET and DESKTOP in that
order (`ScreenshotViewport`, `SCREENSHOT_VIEWPORTS`), chosen against stock Tailwind v4 breakpoints:

| Width     | Size     | Why                                                                        |
| --------- | -------- | -------------------------------------------------------------------------- |
| `PHONE`   | 390×844  | Below `sm` (640).                                                          |
| `TABLET`  | 1024×768 | Above `md` (768), so a shell shows its side navigation; below `xl` (1280). |
| `DESKTOP` | 1440×900 | Above `xl`.                                                                |

The default is none: every shot is one shot at the test's own viewport, named and frozen as before,
with `viewport: null`. The recommended value is `DEFAULT_ROUTE_SPECS` (the page and layout specs),
widened as the app needs, for example to the shell's spec under `src/app/layout/shell/`. The spec
path decides, not the element: every page shot is an element shot of the shell's frame. For each
width the matcher:

1. calls `page.viewport(width, height)` (`vitest/browser`), `height` the larger of the preset's and
   the test's own, so a test that set a tall viewport (1040×3400) to show a whole page is not
   cropped;
2. lets the layout settle: two animation frames, then the TestBed app's
   `ApplicationRef.whenStable()` when a test module exists (looked up without creating one), waited
   for at most 250 ms, since a `PENDING` shot keeps the app unstable on purpose. Under
   `vi.useFakeTimers()` (which fakes `requestAnimationFrame` too) the frames are the page's own,
   taken when the setup file loaded, and the stability wait is skipped: change detection is
   scheduled on the faked timers, so it runs when the test's clock does; the CSS follows the width
   regardless;
3. runs Vitest's matcher with the name suffixed `-phone`, `-tablet` or `-desktop`: the reference is
   `<name>-<viewport>-<browser>-<platform>.png`;
4. freezes the result as `<name>-<viewport>.html`, with `viewport` on the record.

Afterwards the test's own viewport is restored (and settled), so what the test asserts after the
shot sees what it saw before. A failure at one width fails the assertion and its message starts
with the width (`at PHONE (390x844): …`).

A shot opts out of widths with a reason:

```ts
await expect.element(row).toMatchScreenshot('hover', {
  kind: 'DATA',
  viewports: ['DESKTOP'],
  reason: 'needs a fine pointer',
});
```

`viewports` is a non-empty subset of the three, taken in preset order; `reason` is required with
it and non-empty. A `viewports` without a `reason`, or naming another width, fails the shot. On a
shot outside `viewportSpecs`, `viewports` is ignored. The freeze HTML
keeps every `@media` rule, so the three freezes of one shot differ mostly by the width they were
laid out at; a reader draws each in a frame of its record's `viewport` width.

### Light and dark: `colorSchemes`

`freezeScreenshots({ colorSchemes: ['LIGHT', 'DARK'] })` (ticket qits-2083) takes every shot of
every spec (no spec filter, unlike `viewportSpecs`) once per colour scheme (`ColorScheme`,
`COLOR_SCHEMES`, LIGHT first). The option is a non-empty subset of the two; anything else throws
from `freezeScreenshots()` at setup. The default is none: one shot, today's names, no switching,
nothing new in the manifest. For each width (or the one shot at the test's own viewport), then for
each scheme, the matcher:

1. emulates `prefers-color-scheme` through the browser command `qitsColorScheme`
   (`FREEZE_COLOR_SCHEME_COMMAND`), which calls Playwright's `page.emulateMedia({ colorScheme })` on
   the Node side, so it needs the Playwright provider (any other fails the shot saying so).
   `screenshotReferences({ freezes })` registers it with the other freeze commands;
2. sets the theme attribute on `<html>` to `light` or `dark`: `themeAttribute`, default
   `data-theme`, for a theme switched by attribute rather than by media query;
3. settles as after a resize, runs Vitest's matcher and freezes the result.

The scheme is the last suffix, on the PNG and on the freeze: `<name>[-<viewport>]-light` and
`-dark` (`list-phone-dark` is `list-phone-dark-chromium-linux.png` and `<spec>/list-phone-dark.html`).
Both schemes are suffixed. Afterwards the attribute goes back to what it was (removed when it was
absent) and the emulation is reset, then the page settles again. A failure names the scheme after
the width: `at TABLET (1024x768), DARK: …`, or `at DARK: …` at the test's own viewport.

**Expect twice the references.** Turning the option on renames every reference and doubles them;
regenerate them through the platform's `screenshot-baselines` job for the release request, as for
any reference, never by hand. The old names become orphans that job's `--prune` deletes.

A shot leaves a scheme out with the same `reason` key `viewports` uses; one reason covers both:

```ts
await expect.element(chart).toMatchScreenshot('chart', {
  kind: 'DATA',
  colorSchemes: ['LIGHT'],
  reason: 'the chart has no dark palette yet',
});
```

`colorSchemes` is a non-empty subset of `LIGHT` / `DARK`; without a `reason`, or naming another
scheme, it fails the shot (and `qits/screenshot-kind` reports it). In an app without the option it
is ignored. The freeze records `colorScheme`, and `colorSchemeReason` (the shot's `reason` when it
gave its own `colorSchemes`, else `null`); the manifest records the option as a top-level
`colorSchemes`. Without the option none of these keys is written, so the manifest stays byte for
byte as before; a reader takes a missing one as `null`. A run that froze nothing keeps the previous
manifest's `colorSchemes`. An outcome links to the first scheme its shot took (LIGHT unless left
out), at DESKTOP.

**The check.** With `colorSchemes` in the manifest, `qits-angular screenshots --check` groups the
page and layout freezes (`route` set) by spec, test, name and viewport and fails (exit 1, not behind
`--enforce-outcomes`; an update run only lists them) on each group missing a scheme that none of
its freezes opted out of:

```
src/app/routes/projects/projects.page.browser.spec.ts 'list' [PHONE]: missing DARK
```

A freeze without a scheme in such a manifest (kept from a spec the run skipped) misses every scheme.
The freeze HTML keeps the theme attribute on `<html>`, so an attribute-switched theme shows in it as
it did in the shot; a `prefers-color-scheme` rule shows only when the reader opens it in that scheme.

### Offline shots: `offline`

An app built offline-first (`provideQitsOffline`, above) opts in with
`freezeScreenshots({ offline: true })` (ticket qits-2151); the landing app does not, and without it
nothing below happens and the manifest stays byte for byte as it is. With it:

- **Every test starts online with an empty store.** Before each test the real `navigator.onLine`
  is put back and every `qits-offline:*` IndexedDB database is deleted: in a real browser IndexedDB
  survives from one test to the next, so a stored answer or a queued write would otherwise leak.
- **Every freeze says what the page's offline layer was.** The payload and the manifest's freeze
  carry `connectivity`, read at the shot (never declared by the spec, so it cannot say otherwise
  than the page):

  ```json
  "connectivity": {
    "network": "OFFLINE",
    "outbox": [{ "operation": "qits-notes-service#renameNote", "state": "PENDING" }],
    "cacheResources": ["qits-notes-service#getNote"],
    "queueMutations": ["qits-notes-service#renameNote"]
  }
  ```

  `network` is `ONLINE` or `OFFLINE`, from `navigator.onLine`; `outbox` the outbox's entries, oldest
  first (`PENDING`, `SENDING`, `CONFLICT`, `FAILED`); `cacheResources` and `queueMutations` the live
  `offline: 'cache'` resources and `offline: 'queue'` mutations on the page, as
  `<provider>#<operationId>`. The manifest also gets a top-level `"offline": true` (a run that froze
  nothing keeps the previous value) and `"offlineOptOuts"`. `kind` stays what the page shows: an
  offline page showing stored data is `DATA`, a queued write is not a request in flight, and a
  conflict shows the server's record.

The helpers, all in `@qits/angular/testing/browser`:

| Helper                                | What it does                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goOffline()` / `goOnline()`          | Overrides `navigator.onLine` on the page and dispatches `offline` / `online`, which the offline layer listens to. Not Playwright's `context.setOffline`: that also cuts the Vite module server, so a lazy `loadComponent` would fail. The real value is back after every test.                                                                                      |
| `seedOfflineStore(op, params, body)`  | Stores `body` as the answer of `op` for `params`: what a `cache` resource with those params shows (an open page reads it at once). `body` must be a golden-master recording (refused with the guard's message otherwise), and is named in the test's records, as a flush is. Needs `provideQitsOffline` and a user. Flushing online, then `goOffline()`, works too. |
| `conflictAnswer(request, current)`    | Answers a queued write's `TestRequest` with qits-2148's 412: `urn:qits:problem:stale-version` with `current` and `currentVersion` (`current.version`). `current` must be a recording; the 412 itself is never recorded by a pact.                                                                                                                                   |
| `offlineShotsNotTaken({ reason, … })` | Says, once per spec, why it takes none of the shots below: `network: true` covers the offline shot, `operations: ['<provider>#<operationId>']` those mutations' shots, neither covers all. Sent through the browser command `qitsOfflineOptOut`, which `screenshotReferences({ freezes })` registers.                                                               |

A pending write needs no helper: run the page's own mutation after `goOffline()`. A route spec
taking the three shots:

```ts
// notes.page.browser.spec.ts
import { HttpTestingController } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  conflictAnswer,
  goOffline,
  goOnline,
  seedOfflineStore,
} from '@qits/angular/testing/browser';
import { GET_NOTE } from '../../api/notes';
import { goldenMaster, openRoute } from '../../../testing/browser';

const note = await goldenMaster('a note exists', 'getNote');
const renamed = await goldenMaster('the note was renamed', 'getNote');

/** The page opened offline (provideQitsOffline in its TestBed), the note in the store. */
async function offlineNote() {
  goOffline();
  const page = await openRoute('/notes/n1');
  // The page is open already: the resource showing this entry reads it at once.
  await seedOfflineStore(GET_NOTE, { path: { id: 'n1' } }, note);
  await page.stable();
  return page;
}

it('shows the stored note offline', async () => {
  const page = await offlineNote();
  await expect.element(page.frame).toMatchScreenshot('offline', { kind: 'DATA' });
});

it('holds a rename made offline', async () => {
  const page = await offlineNote();
  await page.rename('shopping'); // the page's own queue mutation
  await expect.element(page.frame).toMatchScreenshot('pending', { kind: 'DATA' });
});

it('shows the conflict when the server moved on', async () => {
  const page = await offlineNote();
  await page.rename('shopping');
  goOnline(); // the cache resource reloads, and the outbox sends
  const http = TestBed.inject(HttpTestingController);
  (await vi.waitFor(() => http.expectOne({ method: 'GET', url: '/api/notes/n1' }))).flush(renamed);
  conflictAnswer(
    await vi.waitFor(() => http.expectOne({ method: 'PATCH', url: '/api/notes/n1' })),
    renamed,
  );
  await page.stable();
  await expect.element(page.frame).toMatchScreenshot('conflict', { kind: 'DATA' });
});
```

(`openRoute`, `page.rename` and `page.stable` stand for the app's own helpers.)

**The check.** With `"offline": true` in the manifest, `qits-angular screenshots --check` holds every
route (a freeze with a `route`) to its offline states (`offlineGaps()`), and fails on each gap like
the colour-scheme gaps (exit 1, not behind `--enforce-outcomes`; an update run only lists them):

```
notes: no offline shot                                    a freeze lists cacheResources, none is OFFLINE
notes: no pending shot of qits-notes-service#renameNote   a queueMutations entry no outbox holds PENDING
notes: no conflict shot of qits-notes-service#renameNote  … and none holds CONFLICT
```

An opt-out from a spec with a freeze on the route silences them as far as it reaches:

```ts
offlineShotsNotTaken({ reason: 'the board is read live', network: true });
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

| Command                                 | What it does                                                                                                                                                                                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                            | `ng build qits-integrations-angular` → APF output in `dist/qits-integrations-angular/`                                                                                                                                                                                           |
| `pnpm test`                             | the lint-rule, screenshot-command and pwa-command tests (`pnpm test:eslint`, `pnpm test:screenshots`, `pnpm test:pwa`, `node --test`), then `ng test qits-integrations-angular` (vitest builder, jsdom)                                                                          |
| `pnpm test:browser`                     | `*.browser.spec.ts` in headless Chromium (style freezing needs a real layout engine), then `screenshotReferences()` in a real Vitest browser run, then `qits-angular pwa --check`'s offline start on a built app shell; needs a one-time `pnpm exec playwright install chromium` |
| `pnpm lint`                             | `ng lint qits-integrations-angular`                                                                                                                                                                                                                                              |
| `pnpm check-exports`                    | verify `dist/qits-integrations-angular` is publishable (run it after `pnpm build`)                                                                                                                                                                                               |
| `qits-angular pwa --write`              | (in an app) write the web manifest from `qits-pwa.json`, its colours from the theme tokens; see [Installable offline shell](#installable-offline-shell-qitsangularpwa)                                                                                                           |
| `qits-angular pwa --check --dist <dir>` | (in an app, after `ng build`) fail a build that does not install or start offline; the offline start needs Chromium                                                                                                                                                              |
