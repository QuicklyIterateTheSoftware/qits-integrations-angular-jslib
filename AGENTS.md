# CLAUDE.md — `@qits/angular`

The integration library for Angular apps managed by [qits](https://github.com/wohlben/qits):
config.json-gated browser OTEL telemetry (traces + logs, route/interaction/caller enrichment,
error shipping), feature capture (`withFeatureCapture()` — a floaty button that style-freezes
the page, POSTs it to qits' capture ingest, and navigates the top window to the created
workspace), and state snapshots (`withQitsSnapshot('name')` on an `@ngrx/signals` store, or
`registerCaptureState()` for anything else — registered state rides the capture payload's
`state` field into the workspace goal). See `README.md` for the consumer contract.

## Shape of the integration (traps are load-bearing — don't "clean them up")

Public API (all of `public-api.ts`): `initQitsIntegration(options?)` (pre-bootstrap, fetches the
`api/config.json` identity relay, stays dark on `telemetry: null`, otherwise wires the OTEL web
SDKs; independently stashes the `capture` section), `provideQitsIntegration(...features)` (DI:
`TelemetryErrorHandler` + route telemetry; `QitsIntegrationFeature.providers` is the tree-shakable
seam for features), `withFeatureCapture(options?)`, `captureNow()`, `freezeDocument()` (the
freeze core, exported so the qits webui's element picker can eventually consume it instead of its
own copy), and `consume(call, paths)` / `Consumed<T, Paths>` (`consume.ts`: a store states the body
paths it reads; the compiler then refuses any other field, and the pact spec binds the same list;
type-level only, the run-time function returns the answer unchanged), `outcomes()` (below), and the
bearer sign-in (`provideQitsBearerSignIn`, below). The two-phase shape is not incidental: Angular's `FetchBackend` captures `window.fetch`
on first use, so `initQitsIntegration()` must complete **before** `bootstrapApplication`.

Ported verbatim from the qits fixture (`testing-repo-quarkus-angular`), each encoding a trap
(details in qits' `docs/features/2026-07-06_spa-observability.md` and
`2026-07-11_spa-telemetry-meta-enrichment.md`):

- `init-qits-integration.ts` + `telemetry-sdk.ts` — the SDK lives in `telemetry-sdk.ts` and is
  reached **only** through the dynamic `import()` in `init-qits-integration.ts`, so ng-packagr
  emits it as its own FESM chunk and the consumer's bundler keeps it out of the initial bundle.
  A static import of that module, or of any SDK package (anything but `@opentelemetry/api` and
  type-only imports) from the eager files, pulls it all back in. Exporter URLs are used **verbatim** by the proto exporters
  (resolve per-signal URLs from `document.baseURI`); `ignoreUrls` excludes the `api/otel/v1/`
  passthrough (else exports instrument themselves recursively); 1 s flush (iframe removal fires
  no pagehide — the default 5 s buffer silently loses spans).
- `route-context.ts` — module-level current-route state; stamping processors put
  `app.route.path`/`app.route.url` on every span/log record.
- `route-telemetry.ts` — `Navigation` spans + route tracking as an app initializer (router
  wiring needs the injector, so it can't live in the pre-bootstrap init).
- `interaction-telemetry.ts` — enrichment via the instrumentation's
  `shouldPreventSpanCreation` hook (despite the name); `data-track-event` is read from
  `closest()`, because a submit's target is the form. The outcome mark (`data-qits-outcome`) is
  read the same way: `app.interaction.outcome`, and the span's name from its first mark's
  interaction when no `data-track-event` names it (that one wins).
- `fetch-caller-attribution.ts` — `window.fetch` wrapper installed **before**
  FetchInstrumentation registers so it runs inside the fetch span's context;
  `Error.stackTraceLimit` lifted around capture (plumbing alone is ~50 frames).
- `telemetry-error-handler.ts` — zoneless Angular funnels all errors through `ErrorHandler`,
  never `window` listeners; apps keep `provideBrowserGlobalErrorListeners()`.

Feature capture (qits' `docs/features/2026-07-14_spa-feature-capture.md`), same trap-encoding
style:

- `capture-config.ts` — module-level relay/options state (the relay arrives pre-bootstrap,
  before DI exists); `isCaptureActive()` is the gate for the button, `captureNow()`, and the
  widened route-telemetry initializer (route _tracking_ is needed even when telemetry is dark —
  the Navigation spans are global no-ops without a tracer provider).
- `document-freeze.ts` — subtree style-freeze, sibling of the qits webui's element-scoped
  `style-freeze.ts` (same algorithm: stylesheet-free **off-screen, never display:none** baseline
  iframe, per-tag UA-default snapshot, inline only diffs). Adds: baseline iframe inside the
  captured document itself (marked `data-qits-pick-overlay` so the walk drops it), scroll/form
  state reflected into attributes, canvas → data-URL `<img>`, and a depth-first byte-budget
  truncation. Two entry points over one core: `freezeDocument()` freezes the page's **`<body>`
  only** (head/stylesheets/scripts dropped — styles are already inlined), `freezeElement()`
  freezes a single subtree (the picked component). Needs a real layout engine → tested in
  `*.browser.spec.ts` (headless Chromium), never jsdom.
- `element-picker.ts` / `app-component.ts` / `element-selector.ts` — the pick gesture the button
  now opens (see below). `pickElement(document)` is the in-app, same-realm analogue of the qits
  webui's cross-iframe `DomPicker`: overlay + hint (both `data-qits-pick-overlay`), capture-phase
  listeners so the pick click never reaches the app, single-shot resolve, Escape/right-click →
  `undefined`. `nearestAppComponent()` climbs to the closest ancestor-or-self whose tag starts
  with `app-` — the subtree `captureNow(target)` freezes as the payload's `selection` (the pick
  and everything around it, trimmed to the component boundary; falls back to the picked element).
  `selectorFor()` (ported from the webui picker) records the pick's provenance.
- `capture-transport.ts` — POSTs to the relayed `ingestUrl` verbatim
  (container-reachable ≠ browser-reachable is the consumer's problem then). Gzip is buffered,
  not streamed — streaming fetch bodies need `duplex`. `captureApiAvailable()` probes the same
  target with a bare `OPTIONS` before the button mounts: 204 (qits' CORS route) ⇒ show, 404 or
  unreachable ⇒ stay hidden — the relay proves intent, the probe proves the POST would land.
- `capture-navigation.ts` — `window.top.location.assign` behind a seam (unstubable in browser
  specs); **top** window so a capture from inside the qits web view lands the qits tab on the
  new workspace.
- `with-feature-capture.ts` / `capture-button.component.ts` — the button mounts via
  `APP_BOOTSTRAP_LISTENER` (an app initializer cannot inject the still-under-construction
  `ApplicationRef`), `createComponent` + `appRef.attachView` + append to `document.body`. The
  button host carries `data-qits-pick-overlay`: excluded from its own freeze, from its own picker,
  _and_ from qits' element picker. The press is a two-step gesture: `idle → picking` (arms
  `pickElement`) → on pick `busy` (`captureNow(target)` → navigate), on Escape/right-click back to
  `idle`. `captureNow(target?)` stays public and target-optional — a `renderButton: false` trigger
  can capture with no pick (whole-body snapshot, no `selection`).

State snapshots (qits' `docs/features/2026-07-14_capture-state-snapshot.md`):

- `capture-state.ts` — module-level `Map` of named suppliers (registration can predate DI and
  any capture); suppliers run lazily at capture time only. Duplicate name: warn + last-wins.
  The unregister fn is **identity-guarded** — it deletes only if the map still holds _its own_
  supplier, so a stale destroy after a hot-reload re-registration can't tear down the live one.
  Per-entry try/catch (covering the sanitizer walk — object getters can throw mid-enumeration)
  → `{$error}`; per-entry 64 kB cap → wholesale `{$truncated, bytes}` replacement.
- `capture-state-sanitize.ts` — JSON-safe sanitizer: depth 8, ancestor-path (not visited-set)
  cycle detection so shared DAG references still serialize, `Map`/`Set`/`Date` converted,
  everything non-plain → `"$unserializable(<type>)"`. **BigInt → string is load-bearing**: it is
  the one value `JSON.stringify` _throws_ on, and the payload-level stringify in
  capture-transport must never throw.
- `with-qits-snapshot.ts` — `signalStoreFeature` registering `() => getState(store)`.
  Registration happens in `onInit`, **not** the `withHooks` factory body (the factory runs
  mid-store-construction); `onDestroy` unregisters. The supplier is injection-context-free
  (`getState` is a pure signal read). `@ngrx/signals` is a required peer — the FESM imports it
  statically, so every consumer must resolve it even without using the feature.

Bearer sign-in (`src/lib/sign-in/`, epic qits-543; moved from qits-landing-app's `ng serve`
sign-in, `core/auth/dev-*.ts`, with the `dev` naming dropped):

- `provide-qits-bearer-sign-in.ts` — `provideQitsBearerSignIn(options)` (`clientId`,
  `platformDomain?`, `idpOrigin?`, `callbackRoute?`) wires `QITS_SIGN_IN` (resolved settings),
  `QitsTokens`, `QitsSession`, `QitsBearerFetch`, `QITS_EVENT_SOURCE`, `QITS_WEB_SOCKET`, and an environment
  initializer that `resetConfig`s `auth/callback` to the **front** of the router config (an
  appended route would sit behind an app's `**`). `qitsBearerInterceptor` is not wired: functional
  interceptors only enter through `provideHttpClient(withInterceptors([...]))`.
- `qits-tokens.ts` — PKCE flow, `sessionStorage` store keyed by client id, refresh ahead of
  expiry, **one refresh in flight** (the idp rotates refresh tokens and revokes the family on
  reuse), one sign-in redirect per page.
- `sign-in-settings.ts` — `platformDomainOf()` (first label `qits` = apex) and `isPlatformUrl()`
  (same origin, or `https` at/under the platform domain): the only hosts that see the bearer.
- `bearer-web-socket.ts` / `fetch-event-source.ts` — the `qits.bearer` subprotocol offer and the
  `fetch`-based SSE reader; neither reconnects by itself.

Outcomes (`src/lib/outcomes/`, ticket qits-2001, epic qits-2000): where an interaction leads,
declared once and checked by the compiler.

- `outcomes.ts` — `outcomes(interaction, { key: exit('path/:p') | stay() | returnTo() | external('name') }, { triggered? })`
  gives one frozen entry per key (`interaction`, `outcome`, `kind`, `to`). It `inject`s the `Router` and `QITS_LEAVE_APP`, so it runs in an injection context
  (a field initializer). An exit's `url(params)` is **absolute** (`/` + the
  pattern with each `:param` `encodeURIComponent`ed; a missing one throws), so a `routerLink` built
  from it never resolves against the current route; `go(params, options?)` records, then returns
  `navigateByUrl`'s Promise. `options` is `ExitGoOptions` (ticket qits-2038): the router's
  behaviour plus `queryParams` / `fragment`; with either, it navigates to `exitUrlTree()`'s tree
  (the rest of the options as behaviour) and records `serializeUrl` of it, without them it calls
  `navigateByUrl(url, options)` as before. `exitUrlTree()` (internal, `QitsExit`'s `href` too) feeds
  the parsed path's **segments** to `createUrlTree`, never the URL string: a string command is split
  on `/` but not decoded, so an encoded param would be encoded twice. A stay's `reach()` only records. A return's `go(url, behaviour?)`
  (ticket qits-2044) follows only an app URL (one leading `/`, tabs and line breaks dropped first as
  a browser does; else `/`); an external's `leave(href)` records, then calls `QITS_LEAVE_APP` (root token, default `DOCUMENT.location.assign`; a routed browser test provides a spy, since overriding the `DOCUMENT` breaks rendering). The third
  argument does nothing at run time: the screenshot reader reads `triggered: false` (an interaction
  no element triggers) from the source. Typing seam: the empty `QitsApp`
  interface, which an app augments with `routePath` (the generated `route-paths.ts`, see
  `qits/route-paths`) and `interaction`; `RoutePath` / `InteractionName` fall back to `string`.
  `PathParams<P>` is a template-literal parse in the `consume.ts` manner. A path without params
  takes `Readonly<Record<string, never>>`, **not** `PathParams`'s empty type: the compiler checks
  no excess field against an empty type, so `go({ slug })` on such a path would pass.
- `outcome-recorder.ts` — module-level recorder, `null` by default (production pays one null
  check); `ɵsetOutcomeRecorder` is exported for `@qits/angular/testing/browser` only.
- `qits-exit.directive.ts` / `qits-triggers.directive.ts` / `outcome-mark.ts` — `a[qitsExit]`
  renders `href` as `RouterLink` does (`LocationStrategy.prepareExternalUrl` of the serialized
  URL, so a base href is honoured) and takes only a plain primary click without `target` (or
  `_self`); anything else is the browser's and records nothing. `[exitQueryParams]` /
  `[exitFragment]` (ticket qits-2038) go into both the `href` and the click's `go()` options (only
  the keys that are set). `exportAs: 'qitsExit'` and the `isActive()` signal replace
  `routerLinkActive` + `ariaCurrentWhenActive="page"` (`[attr.aria-current]`): Angular's
  standalone `isActive()` function (`Router.isActive` is deprecated since 21.1) on the path-only
  tree, `paths: 'subset'` (`'exact'` with `[exitActiveExact]`) and query, matrix params and fragment
  ignored; it follows `router.lastSuccessfulNavigation`, set just before each `NavigationEnd`, so no
  `router.events` subscription. `QitsExit` and `[qitsTriggers]`
  set `data-qits-outcome` through `outcomeMark()`. The attribute name is spelled out in the
  directives and in `interaction-telemetry.ts`: that file is reached from the lazy
  `telemetry-sdk.ts`, so importing a shared constant split `outcome-mark.ts` into its own chunk.
- Type tests: `outcomes.spec.ts` augments `QitsApp` (`declare module '@qits/angular'`) and uses
  `@ts-expect-error`; the vitest builder type-checks, so an unused directive fails the run. The
  augmentation is global to the spec program; specs are excluded from the library build, so it
  never ships. The other outcomes specs keep to its names, and so do the library's own declarations
  (`sign-in`, `sign-in-failed`, `session-guard`, `session-expired` are in its `interaction`
  union), because the sign-in sources are compiled into the same spec program.
- The library declares its own outcomes (ticket qits-2044): `QitsAuthCallbackPage` (`sign-in`:
  `succeeded` returnTo, `failed` stay, `triggered: false`; `sign-in-failed:restarted`, the Start
  again `QitsExit` to `''`) and `QitsSession` (`session-guard:signedOut`, external `idp`,
  `triggered: false`; `ensure()` takes `QitsTokens.authorizeUrl()`, the first half of `login()`, and
  leaves through it); and `QitsSessionExpiry` (ticket qits-2052, not exported, provided by
  `provideQitsBearerSignIn`: `session-expired:signedOut`, external `idp`, `triggered: false`),
  which `qitsBearerInterceptor` (resolved lazily through its `Injector`, because `outcomes()`
  injects the `Router` only that path needs) and `QitsBearerFetch` call on a 401 that no refresh
  helps, in place of `login()`; its `provides` are `qitsBearerInterceptor` and `QitsBearerFetch`.
  Their specs provide `provideRouter([])`, `QitsSessionExpiry` and a `QITS_LEAVE_APP` spy, as any
  test reaching an external does. These slugs are the library's; an app must not reuse them.
  `scripts/library-outcomes.mjs` (`pnpm outcomes:library`) reads them with the screenshot reader's
  `readOutcomes()` into `screenshots/outcomes.json`, which ships (the screenshots assets glob takes
  `json`; `check-exports` checks it); its `SCOPES` table gives each declaring file's `route` /
  `global` and `provides` (the exports whose import brings the entries into an app), and a
  declaring file missing there fails the run. A screenshots test fails when the committed file is
  stale.
- Entry points (ticket qits-2049): a route entered from outside the app — an idp redirect, an old
  bookmarked address — rather than by an exit this app declares, says so with plain route data,
  `data: { qitsEntry: true }` (the manifest key is fixed); `QITS_ENTRY` (`src/lib/outcomes/entry.ts`,
  exported from the public entry point) is the typed way to write it. `describeRoutes()`
  (`@qits/angular/testing/browser`) copies it as `entry: true` on the manifest's `routes[]`, next to
  `redirectTo`, never into `outcomes.declared` (an entry is a property of a route, not an outcome).
  `qitsAuthCallbackRoute` carries it, so every app that imports it gets the entry point for free.
  `outcomeGaps()`'s `unreachableRoutes()` (`screenshots/outcomes.mjs`) walks `manifest.routes`
  (`children` recursed) and holds every checked row — no `children` of its own, no `redirectTo`, a
  `path` other than `**` — against the declared `exit()`s (any scope: page, layout, app-wide,
  library): a route no exit's `to` reaches, and that is not itself `entry: true`, is its own gap,
  report-only until `--enforce-outcomes` like the rest.
- Forwards (ticket qits-2076): `describeRoutes()` writes `rendersNothing: true` on a route with no
  `component` / `loadComponent` / `loadChildren` / `redirectTo` (string or function), a `path`
  other than `**`, and children that all render nothing too. `forwardRoutes(manifest, declared)`
  (`screenshots/outcomes.mjs`) names the routes that render a component, whose own declared entries
  (`route === fullPath`; `route: null` never counts) are all untriggered `exit()`s, and below which
  everything is `rendersNothing`; `freezeWriter().end()` writes `forward: true` on those nodes
  (`markForwards()`, re-judging a kept tree; never on the `''` child that shares the path).
  `pageRoutes(manifest, declared?)` is `checkedRoutes()` minus `rendersNothing` rows and forward
  subtrees, read from the flags (computed when `declared` is given): the set any rule about a
  page's states iterates. `outcomeGaps()` and the reachability rule do not use it.

The library is **zoneless-first**: no `zone.js`, no `@opentelemetry/context-zone` — the default
stack context manager is correct. The `instrumentation-user-interaction` `zone.js` peer is
marked optional via a pnpm `packageExtensions` entry here and in every consumer.

## Commands

- `pnpm build` — `ng build qits-integrations-angular` → APF output in `dist/qits-integrations-angular/`
- `pnpm test` — `pnpm test:eslint` (the lint rules) and `pnpm test:screenshots` (the screenshot command), both `node --test`, then `ng test qits-integrations-angular` (vitest builder, jsdom; excludes `*.browser.spec.ts`)
- `pnpm test:browser` — `*.browser.spec.ts` in headless Chromium (`ng run
qits-integrations-angular:test-browser`), then the real Vitest run of `screenshotReferences()`; one-time `pnpm exec playwright install chromium`
- `pnpm lint` — `ng lint qits-integrations-angular`
- `pnpm check-exports` — verify `dist/qits-integrations-angular` is publishable (after `pnpm build`)

## Workspace layout & what gets published

Standard `ng new` workspace (`--create-application=false`) plus one library project under
`projects/qits-integrations-angular/`. Nothing about the layout is non-standard any more.

**The package is `dist/qits-integrations-angular`** — the ng-packagr output, published to qits'
own npm registry (hosted by qits-artifacts, under the `@qits` scope) by
`.config/qits/ci-event-release.yml`. `projects/qits-integrations-angular/package.json` is the single
source of truth for name, version, description, license, peers and runtime deps; ng-packagr copies
it into the manifest inside `dist/`, and that manifest is what `npm publish` uploads. A field that
must reach the registry is added _there_.

There are two READMEs and they are not redundant: the root one is the consumer contract, and
`projects/qits-integrations-angular/README.md` is the _package_ README — ng-packagr copies it into
the tarball, so it is the page the registry shows. ng-packagr refuses assets from outside the
project directory, so the root file cannot be the shipped one; keep the short version pointing at
the long one.

The root `package.json` is the **workspace harness**: the devDependencies that build and test the
library, and the runtime deps its sources resolve against while doing so. It used to _be_ the
package — git-only distribution installed the repo root and built it consumer-side — and that whole
shape (a duplicated `name`/`version`, `files`/`exports` pointing into `dist/`, `prepare` as the
distribution mechanism) is gone. A registry tarball ships prebuilt, so the consumer-side rebuild and
the `pnpm.onlyBuiltDependencies` allowlist it needed have nothing left to do.

### Packaging invariants (don't break)

- **`dist/qits-integrations-angular` is the package** — never the repo root, never a hand-edited
  manifest. `npm publish` is pointed at that directory.
- **`projects/qits-integrations-angular/package.json` is the source of truth** for everything the
  published manifest carries.
- **The root keeps `private: true`** — it blocks registry publishing of the _root_, which is
  exactly right: the harness is not the package, and `dist/` publishes independently of it. The
  root also carries no `files`, no `exports`, no `prepare`; `check-exports` fails if any come back.
  (Do not verify that guard with `npm publish --dry-run`: the `EPRIVATE` check lives in
  `libnpmpublish`, which a dry run never reaches, so it happily prints a tarball listing for a
  private manifest. Only a real publish refuses.)
- **Root `dependencies` mirror the published manifest's** — the workspace resolves against its own
  `node_modules` while a consumer resolves what the manifest declares; either drift ships a package
  whose imports resolve for nobody but us.
- **`pnpm check-exports` guards all of it** against `dist/` after a build, and both CI pipelines
  run it. Never hand-edit `dist/`.
- **`dist/` is never committed on `main`** — CI rebuilds it before it publishes.
- **One pipeline publishes, and it is not a push.** `.config/qits/ci-event-release.yml` reacts to
  `SCMRelease`, checks the release tag out and publishes that version with no `--tag`, so `latest`
  moves once per release, then points `main` at the same version. The tag name is the version.
  Beside it,
  `.config/qits/ci-event-release-request.yml` is the QA pipeline: it builds the `release/<id>` fold
  of a release request and publishes nothing, and its green verdict is what lets Auto Release stamp
  the version. Releasing is `POST /projects/api/repositories/<repoId>/release-requests`, never a
  version-bump commit.
- **A change to the release recipe takes effect on the release that merges it**, not on the one
  after. qits-ci reads `.config/qits/ci-event-release.yml` at `main`, and Auto Release merges the
  fold before it publishes the `SCMRelease` the recipe triggers on — so by the time the run is
  selected, `main` already carries the edit. Measured 2026-09-05: the release that added the
  `npm dist-tag add` line moved `main` to its own version. Do not plan a recipe change around a
  one-release delay that does not exist.
- **The `main` dist-tag names the latest released main**, and the release pipeline points it there
  with `npm dist-tag add` right after its publish. It used to name the retired push pipeline's
  **prerelease**, `<version>-main.g<sha7>`, cut on every push to `main`; when that leg went, nothing
  was left writing the tag and it sat on `2026.830.133217-main.g55effb5` through five releases.
  `main` only advances at a release now, so the tag follows releases — which is what `@main` was
  always taken to mean. The move is a separate call because `npm publish` claims exactly one
  dist-tag and a version is immutable: no single publish can be under both `latest` and `main`. (If
  you ever restore a prerelease leg, it needs an explicit `--tag`: a bare `npm publish` means
  `--tag latest`, and the registry refuses a publish that would move `latest` to a lower-sorting
  version — a missing flag is a 403 and a red build, not a silent regression.)
- **The publish is publish-if-absent** — a re-run finds its version in the registry and succeeds
  without touching it. Published versions are immutable; never try to re-publish one.

## The other entry points

- **`@qits/angular/testing`** (`projects/qits-integrations-angular/testing/`, an ng-packagr
  secondary entry): the golden-master reader and pact helper (epic qits-546), moved from
  qits-landing-app. It imports `node:fs`, so it is Node-only and must never be imported by the main
  entry. Its spec runs under `ng test` (the `../testing/**` include in `angular.json`, because the
  builder's globs are relative to `src/`) and starts a real pact-js mock server. A pact binds only
  the body paths an interaction lists in `consumes` (required); the golden master keeps the whole
  answer. `via` adds `qits-via` (a library's call, ticket qits-1284), `response` pacts an answer
  that is not JSON, and `assertPactPart` (`pact-part.ts`, promoted from qits-landing-app) checks one
  spec's part of a shared pact file. `pact-compare.ts` is internal: both comparisons mask
  `qits-via.version` and rewrite the file on a version-only difference instead of failing.
- **`@qits/angular/testing/browser`** (`testing/browser/`, a nested ng-packagr entry): the
  golden-master guard (epic qits-112) for browser specs: every browser spec takes its backend data
  from golden masters, except the UI components' (`syntheticAllowed`, default `['src/app/ui/**']`,
  the same option in the guard and the lint rule). Only UI components may use synthetic data. It must stay browser-safe, so it never
  imports `@qits/angular/testing` (Node-only). `recorded()` deep-freezes a body and puts it and
  everything in it in a `WeakSet`; a text body (`responseType: 'text'`, ticket qits-2058) is
  registered by `recordedText()` / `fromGoldenMasterTexts()` by **value** in a `Map` (a string has no
  identity, so an equal string passes; `''` stays an empty answer), and read Node-side with
  `goldenMasters(…).text()`, which `pactedGoldenMasters()` checks as it checks `body()`;
  `guardGoldenMasters()` patches `TestRequest.prototype.flush`
  and `event`. Identity is made in the browser: a Vitest command sends JSON, so wrap the command,
  not the Node reader. The lint rule `browser-spec-data-from-golden-masters` is only a heuristic;
  the guard is the guarantee. `pactedGoldenMasters()` (in `@qits/angular/testing`, Node-side) refuses
  a body no interaction in the committed pact uses. Every error ends in the same fix: a new provider
  state plus a pact interaction for it. The guard also notes the route each recording is shown on
  (ticket qits-1946; `takeRouteRecords()`), stamped with the spec file that noted it (the files
  share one page: `guardGoldenMasters()` registers a `beforeAll` that clears them, and
  `takeRouteRecords()` drops, with a `console.warn`, any noted in another file, qits-2056), and `route-ledger.ts` in `@qits/angular/testing` keeps
  those in a committed ledger (`goldenMasterRoutes`, a browser command that only stages; the
  reporter its `.plugin` adds writes the sections of files that ran completely at `onTestRunEnd`,
  qits-1966, the same `complete()` rule as the freezes; a complete file that never sent keeps its
  section with a warning, one that sent `[]` loses it, qits-2056) that `addGoldenInteraction`
  reads through `useRouteLookup(routeLedger(...))` into `qits-trigger.route`. The route pattern is
  `matchedRoutePath` from the main entry, imported by package name (`tsconfig.spec.json` maps
  `@qits/angular` to `src/public-api.ts` for the specs; ng-packagr resolves it to the built entry).
  `recordOutcomes()` (`record-outcomes.ts`, ticket qits-2001) reaches the main entry's outcome
  recorder the same way, which is what makes it one module instance: `beforeEach` installs it and
  clears the test's records, `afterEach` sends them through the `qitsOutcomes` browser command
  (ticket qits-2003; skipped when no plugin registered it) and only then uninstalls it, and each
  record is stamped with `spec` and `test` from `expect.getState()` and `route` from the guard's
  `currentRoutePattern()` at fire time. `outcomeRecords()` is the current test's,
  `takeOutcomeRecords()` drains the file's, in order.
- **`@qits/angular/eslint`** (`projects/qits-integrations-angular/eslint/`): plain ESM, no build.
  ng-packagr copies the `.mjs` files as assets (minus `test/`), and the source `package.json`'s
  `exports["./eslint"]` points at them; ng-packagr merges that with the exports it generates.
  Rule tests run with `node --test` and ESLint's `RuleTester`, on a throwaway app tree under
  `tmp/` (git-ignored). The roles `pact-names` accepts are the wrapper's repository roles; keep
  them in step. `route-paths` (ticket qits-2001) is a generator run as a rule: it lints the
  generated file (option `file`, default `src/app/route-paths.ts`, plus the shared `routes` /
  `routeTables`), builds its text from the route tables (`export type RoutePath` and the
  `declare module '@qits/angular' { interface QitsApp { routePath: RoutePath } }` augmentation),
  reports `stale` when it differs, and its fix rewrites the whole file, so
  `eslint --fix src/app/route-paths.ts` regenerates it. The file is opt-in: a missing one is not
  reported anywhere (qits-2010) — see the rule below.
  It shares the route walk with `route-matches-directory` (`project.mjs`).
  `navigation-through-outcomes` (ticket qits-2002, epic qits-2000) reports `Router.navigate` /
  `navigateByUrl` calls and raw `routerLink`s in templates under `include` (default `src/app/**`)
  minus `exclude` (default `src/app/api/**`); specs are skipped. The library holds itself to it
  (ticket qits-2044): its own `eslint.config.js` `require()`s `./eslint/index.mjs` (ESM without
  top-level await) and sets the rule with `include: ['src/lib/**']`,
  `exclude: ['src/lib/outcomes/**']` — only the outcome API, whose `QitsExit` and `go()` navigate by design, is
  left out. An empty command list — `router.navigate([], …)` (never `navigateByUrl`) or
  `[routerLink]="[]"` — keeps the current route and changes only the query or fragment, a local
  click under owner decision 4 (epic qits-2000, ticket qits-2038), and is not reported; a
  `navigate([])` second argument stays innocent only with no `relativeTo`, or one that is a plain
  identifier or a `this.<name>`/`this.#name` member (anything that could still name another route,
  such as `.parent` or a computed member, keeps it reported). No type information: the `Router` is
  resolved syntactically from its `@angular/router` import (`inject(R)`, `this.<field>` set to
  `inject(R)` or typed `R`, parameter properties, typed or `inject(R)` locals). Templates are parsed
  with `parseTemplate` from `@angular/compiler`, a **required peer** for that (every Angular app
  has it; the root devDepends on it, which `check-exports` demands). Inline reports land on the
  attribute (literal start + `sourceSpan` offset), or on the `template` property when the literal
  has escapes; an external one on `templateUrl`, naming `<file>.html:line:col`. It is the first
  rule `recommended` set to **`warn`**, because it reports what every unmigrated app has and no fix
  clears (the qits-2010 rule below): it stays `warn` here until qits-2005 turns it to `error` in
  the app once the app navigates through outcomes.
  `screenshot-kind` (ticket qits-2046) is the second `warn` rule, for the same reason: in every
  `*.browser.spec.*` each `toMatchScreenshot(...)` names its `kind` (`DATA`, `NO_DATA`, `PENDING`,
  `ERROR`) as a literal, and an opt-out `viewports` (`PHONE`, `TABLET`, `DESKTOP`) or
  `colorSchemes` (`LIGHT`, `DARK`, ticket qits-2083) a literal `reason` (one covers both); the enums
  are spelled in the rule and in `screenshot-options.ts` (and `freezes.mjs`), keep them in step.
  qits-2047 turns it to `error` in landing. The runtime half is `freezeScreenshots({ requireKind,
viewportSpecs, colorSchemes })`, all off by default so a bump changes nothing until the app opts in.
  `page-screenshots-through-routes` (ticket qits-1998) reads only `*.page.browser.spec.ts` /
  `*.layout.browser.spec.ts` under the routes directory: a `TestBed.createComponent` of an import
  from a `*.page.ts` / `*.layout.ts`, a router provider given anything but an identifier imported
  from a route-table file, and (only when neither was reported) a spec calling none of `helpers`
  (default `openRoute`, landing's own helper). The runtime half is in `freezeScreenshots()`.
  `page-screenshot-whole-page` (ticket qits-2074) is the third `warn` rule, in the same scope
  (`PAGE_SPEC` and `routeLayout().under()`, the same `routes` options; `unwrap` / `memberName` are
  shared in `project.mjs`): the subject of each `expect.element(<subject>).toMatchScreenshot(...)`
  (or `expect(<subject>)`, `.not` / `.soft` between) is the whole page — a member named in
  `wholePage` (default `frame`, `routeNativeElement`) not chained further, `x.elementLocator(<that>)`,
  a `const` / `let` bound to one (awaited too) or destructured under a `wholePage` key (trusted by
  name), or a call to a function of the same file whose every return is one (arguments not read).
  Anything else is reported once, on the subject. It stays `warn` until qits-landing-app fixes its
  crops, in its own ticket, and turns it to `error` there.
  **A rule added to `configs.recommended` must pass on a consumer that has not adopted it yet**: it
  is `error` on every consumer's whole codebase the moment the library bumps, so it may only report
  on something a consumer opts into by a file existing (as `route-paths` now does) or something
  `eslint --fix` can clear by itself — never on a bare absence with no fix, which turns every
  unadopted consumer red with an error no automation can clear (qits-2010).

- **`@qits/angular/screenshots`** and the **`qits-angular`** command
  (`projects/qits-integrations-angular/screenshots/`, `bin/`; epic qits-112): plain ESM, no build,
  copied as assets like the lint rules; `exports["./screenshots"]` and `bin` in the source
  `package.json`. `screenshotReferences()` is a Vitest plugin: in `configureVitest` it wraps
  `browser.expect.toMatchScreenshot.resolveScreenshotPath` (Vitest calls it on the Node side for
  every comparison, with the real spec path even under the Angular builder) and pushes a reporter
  onto `vitest.config.reporters` (Vitest builds its reporters from that array after the hooks).
  The reporter writes the record at `onTestRunEnd`: per spec, the resolved references, whether
  every test passed, and the spec's sha256. `qits-angular screenshots --check | --prune` judges a
  reference by place (spec gone: no run needed) or by that record (spec ran completely and is
  unchanged); anything else is not judged, so a partial run never reports a false orphan. Not an
  ESLint rule: ESLint visits source files, and an orphan's spec may not exist. Unit tests
  (`pnpm test:screenshots`) drive the plugin with stand-ins; `vitest-run.test.mjs` (in
  `pnpm test:browser`, needs Chromium) proves it in a real Vitest run. If a Vitest upgrade moves
  either hook, that test fails; the command then finds no record and judges by place only.
  With `screenshotReferences({ freezes })` it also registers the browser commands `qitsFreeze` /
  `qitsFreezeRoutes` (`browser.commands`, in the same hook) and writes the screenshot freezes
  (`freezes.mjs`, ticket qits-1947) from the same reporter: `<dir>/<spec>/<name>.html`, `assets/`,
  `manifest.json`, replacing only specs that ran completely (`complete()`, shared with the record).
  The browser half is `freezeScreenshots()` in `@qits/angular/testing/browser`: it overwrites
  `toMatchScreenshot` on `chai.Assertion.prototype` (chai's `overwriteMethod`; Vitest's
  `expect.extend` put it there) and freezes the `object` flag after the matcher passed;
  `freeze-shot.ts` is the serializer (filtered CSS **rules**, never computed styles, so it is
  renderer-independent — unlike `document-freeze.ts`). `vitest/browser` is imported dynamically
  there, so importing the entry (the guard) never needs a browser run. A shot in a spec
  `routeSpecs` matches (default `DEFAULT_ROUTE_SPECS`, page and layout specs under
  `src/app/routes/`, the same default as the Node side's) fails unless the TestBed's router shows
  one of `options.routes` (`renderedThroughRoutes`, qits-1998). **Not by identity**: the `Router`
  constructor runs `resetConfig`, whose `standardizeConfig` copies every route (children too), so
  `routerState…routeConfig` is never an element of the array `provideRouter` got; a copy is
  recognised by every non-`children`, non-`_` key holding the same value, children recursively. The command names are
  spelled in both halves; keep them in step. `freeze-shot.browser.spec.ts` runs under
  `test-browser` (the `../testing/**/*.browser.spec.ts` include; `ng test` excludes it).
  Outcomes (ticket qits-2003): each freeze payload also carries `outcomes` (the test's record count
  at shot time) and `triggers` (`visible-triggers.ts`: the `data-qits-outcome` marks visible in the
  shot — `checkVisibility` with CSS, no `hidden` on an ancestor, a non-zero box meeting the target's
  box or the page's scroll area — measured on the **live DOM** before `freezeShot`, because the
  HTML keeps a closed menu's marks too). The third command, `qitsOutcomes`, takes each test's
  records. `end()` writes `triggers` per freeze and `outcomes: { declared, fired }`: `fired` follow
  the freezes' per-spec rules (complete replaces, gone drops, otherwise kept), each linked to the
  first freeze of its spec and test whose `outcomes` exceeds the record's index (`freeze`, or
  `null`), its `route` nulled outside `routeSpecs` like a freeze's; `declared` is read afresh.
  `outcomes.mjs` is the reader: the app's own `typescript` (an **optional peer**, resolved with
  `createRequire` from the app root, loaded only when a file under `src/app` mentions
  `@qits/angular` and `outcomes` or a `provides` name; specs skipped), a call counts when its callee
  is the `outcomes` import from `@qits/angular` (renamed, or via a namespace), each key one
  `{route, interaction, outcome, kind, to, global, triggered, file}`;
  `readOutcomes({ ts, files, from })` is that reading over any file list. The library's shipped `outcomes.json` (resolved next
  to `outcomes.mjs`, so the installed version counts) joins when a non-spec file under `src/app`
  value-imports one of an entry's `provides` from `@qits/angular` (by name or `ns.x`), without
  `provides`. Scope by the file's directory under the
  routes directory (`routes`, as the lint rules'; `--routes` on the command): a non-layout file is
  the route its directory names (inverse of `segmentDirs`), a `*.layout.ts` its subtree
  (`global`), a `$layout` layout or any file outside the routes directory app-wide (`route: null`,
  `global`); anything it cannot read is an `unreadable` gap by file:line. `--check` names the gaps
  (`outcomeGaps()`): unreached, a reached stay with no `freeze`, no freeze in scope listing the
  trigger (not for `triggered: false`), unreadable. They are **report-only** (stderr, exit unchanged) unless
  `--enforce-outcomes`; an app with no declaration prints nothing; an update run only lists them.
  `--freezes <dir>` names the manifest's directory. The root page's route `''` also takes `null`,
  since `currentRoutePattern()` reports the empty route as `null`.
  Colour schemes (ticket qits-2083): `freezeScreenshots({ colorSchemes, themeAttribute })` takes
  every shot of every spec (no spec filter) at each width once per scheme, LIGHT then DARK: the
  fourth command, `qitsColorScheme` (`FREEZE_COLOR_SCHEME_COMMAND` in both halves), calls
  `context.page.emulateMedia({ colorScheme })` (Playwright only; `null` resets), the harness sets
  `themeAttribute` (default `data-theme`) on `<html>` to `light` / `dark`, then `settle()` and the
  shot, named `<name>[-<viewport>]-light` / `-dark` (PNG and freeze; `viewportName()`,
  `freezeFile(spec, name, viewport, colorScheme)`). A `finally` puts the attribute back (removed
  when absent) and the emulation to `null`. A shot opts out with `colorSchemes` and the `reason`
  `viewports` uses (an `OWN_KEYS` entry, stripped for Vitest); without the app option it is ignored.
  The payload carries `colorScheme`, `colorSchemes` (the option) and `colorSchemeReason`. **Without
  the option the manifest is byte-identical to before**: the top-level `colorSchemes` and each
  freeze's `colorScheme` / `colorSchemeReason` are written only when the run's payloads carried the
  option (a run that froze nothing keeps the old manifest's value; a run that carried `null` drops
  it). With it, `--check` fails (exit 1, not behind `--enforce-outcomes`, listed only in an update
  run) on each page or layout freeze group (spec, test, name, viewport) missing a scheme none of its
  freezes opted out of (`colorSchemeGaps()`). Turning the option on doubles and renames every
  reference: they are regenerated through the screenshot-baselines job.

## Conventions (inherited from the qits webui)

- **Every export of the main entry goes through `projects/qits-integrations-angular/src/public-api.ts`.**
- Standalone components only; `ChangeDetectionStrategy.OnPush`.
- `input()` / `output()` / `computed()` functions — never the decorator forms.
- `inject()` over constructor injection.
- Native control flow (`@if` / `@for` / `@switch`), not `*ngIf` / `*ngFor`.
- No `any`.
- Component selector prefix `qits` (kebab-case); directive prefix `qits` (camelCase).
