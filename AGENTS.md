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
seam for features), `withFeatureCapture(options?)`, `captureNow()`, and `freezeDocument()` (the
freeze core, exported so the qits webui's element picker can eventually consume it instead of its
own copy). The two-phase shape is not incidental: Angular's `FetchBackend` captures `window.fetch`
on first use, so `initQitsIntegration()` must complete **before** `bootstrapApplication`.

Ported verbatim from the qits fixture (`testing-repo-quarkus-angular`), each encoding a trap
(details in qits' `docs/features/2026-07-06_spa-observability.md` and
`2026-07-11_spa-telemetry-meta-enrichment.md`):

- `init-qits-integration.ts` — exporter URLs are used **verbatim** by the proto exporters
  (resolve per-signal URLs from `document.baseURI`); `ignoreUrls` excludes the `api/otel/v1/`
  passthrough (else exports instrument themselves recursively); 1 s flush (iframe removal fires
  no pagehide — the default 5 s buffer silently loses spans).
- `route-context.ts` — module-level current-route state; stamping processors put
  `app.route.path`/`app.route.url` on every span/log record.
- `route-telemetry.ts` — `Navigation` spans + route tracking as an app initializer (router
  wiring needs the injector, so it can't live in the pre-bootstrap init).
- `interaction-telemetry.ts` — enrichment via the instrumentation's
  `shouldPreventSpanCreation` hook (despite the name); `data-track-event` is read from
  `closest()`, because a submit's target is the form.
- `fetch-caller-attribution.ts` — `window.fetch` wrapper installed **before**
  FetchInstrumentation registers so it runs inside the fetch span's context;
  `Error.stackTraceLimit` lifted around capture (plumbing alone is ~50 frames).
- `telemetry-error-handler.ts` — zoneless Angular funnels all errors through `ErrorHandler`,
  never `window` listeners; apps keep `provideBrowserGlobalErrorListeners()`.

Feature capture (qits' `docs/features/2026-07-14_spa-feature-capture.md`), same trap-encoding
style:

- `capture-config.ts` — module-level relay/options state (the relay arrives pre-bootstrap,
  before DI exists); `isCaptureActive()` is the gate for the button, `captureNow()`, and the
  widened route-telemetry initializer (route *tracking* is needed even when telemetry is dark —
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
- `capture-transport.ts` — framed under the service proxy (`/workspaces/service/{ws}/{svc}/` base) the frame
  origin IS qits, so POST same-origin `/workspaces/api/capture` (the ingest is `qits-workspaces`
  and the gateway routes `/<segment>/*` verbatim by prefix — the segment is the address, not a
  rewrite); else the relayed `ingestUrl` verbatim
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
  *and* from qits' element picker. The press is a two-step gesture: `idle → picking` (arms
  `pickElement`) → on pick `busy` (`captureNow(target)` → navigate), on Escape/right-click back to
  `idle`. `captureNow(target?)` stays public and target-optional — a `renderButton: false` trigger
  can capture with no pick (whole-body snapshot, no `selection`).

State snapshots (qits' `docs/features/2026-07-14_capture-state-snapshot.md`):

- `capture-state.ts` — module-level `Map` of named suppliers (registration can predate DI and
  any capture); suppliers run lazily at capture time only. Duplicate name: warn + last-wins.
  The unregister fn is **identity-guarded** — it deletes only if the map still holds *its own*
  supplier, so a stale destroy after a hot-reload re-registration can't tear down the live one.
  Per-entry try/catch (covering the sanitizer walk — object getters can throw mid-enumeration)
  → `{$error}`; per-entry 64 kB cap → wholesale `{$truncated, bytes}` replacement.
- `capture-state-sanitize.ts` — JSON-safe sanitizer: depth 8, ancestor-path (not visited-set)
  cycle detection so shared DAG references still serialize, `Map`/`Set`/`Date` converted,
  everything non-plain → `"$unserializable(<type>)"`. **BigInt → string is load-bearing**: it is
  the one value `JSON.stringify` *throws* on, and the payload-level stringify in
  capture-transport must never throw.
- `with-qits-snapshot.ts` — `signalStoreFeature` registering `() => getState(store)`.
  Registration happens in `onInit`, **not** the `withHooks` factory body (the factory runs
  mid-store-construction); `onDestroy` unregisters. The supplier is injection-context-free
  (`getState` is a pure signal read). `@ngrx/signals` is a required peer — the FESM imports it
  statically, so every consumer must resolve it even without using the feature.

The library is **zoneless-first**: no `zone.js`, no `@opentelemetry/context-zone` — the default
stack context manager is correct. The `instrumentation-user-interaction` `zone.js` peer is
marked optional via a pnpm `packageExtensions` entry here and in every consumer.

## Commands

- `pnpm build` — `ng build qits-integrations-angular` → APF output in `dist/qits-integrations-angular/`
- `pnpm test` — `ng test qits-integrations-angular` (vitest builder, jsdom; excludes `*.browser.spec.ts`)
- `pnpm test:browser` — `*.browser.spec.ts` in headless Chromium (`ng run
  qits-integrations-angular:test-browser`); one-time `pnpm exec playwright install chromium`
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
must reach the registry is added *there*.

There are two READMEs and they are not redundant: the root one is the consumer contract, and
`projects/qits-integrations-angular/README.md` is the *package* README — ng-packagr copies it into
the tarball, so it is the page the registry shows. ng-packagr refuses assets from outside the
project directory, so the root file cannot be the shipped one; keep the short version pointing at
the long one.

The root `package.json` is the **workspace harness**: the devDependencies that build and test the
library, and the runtime deps its sources resolve against while doing so. It used to *be* the
package — git-only distribution installed the repo root and built it consumer-side — and that whole
shape (a duplicated `name`/`version`, `files`/`exports` pointing into `dist/`, `prepare` as the
distribution mechanism) is gone. A registry tarball ships prebuilt, so the consumer-side rebuild and
the `pnpm.onlyBuiltDependencies` allowlist it needed have nothing left to do.

### Packaging invariants (don't break)

- **`dist/qits-integrations-angular` is the package** — never the repo root, never a hand-edited
  manifest. `npm publish` is pointed at that directory.
- **`projects/qits-integrations-angular/package.json` is the source of truth** for everything the
  published manifest carries.
- **The root keeps `private: true`** — it blocks registry publishing of the *root*, which is
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

## Conventions (inherited from the qits webui)

- **Every export goes through `projects/qits-integrations-angular/src/public-api.ts`.**
- Standalone components only; `ChangeDetectionStrategy.OnPush`.
- `input()` / `output()` / `computed()` functions — never the decorator forms.
- `inject()` over constructor injection.
- Native control flow (`@if` / `@for` / `@switch`), not `*ngIf` / `*ngFor`.
- No `any`.
- Component selector prefix `qits` (kebab-case); directive prefix `qits` (camelCase).
