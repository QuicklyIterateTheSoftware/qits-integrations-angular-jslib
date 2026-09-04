# Bootstrap this repository: the `@qits/angular` walking skeleton

> **How to use this document:** it lives as plan 0 in the qits repo
> (`docs/feature-ideas/angular-lib-repo-bootstrap-0.md`) and is written to be **copied into the
> `wohlben/qits-angular-integration` repository** (as `BOOTSTRAP.md`) **and executed by a coding agent
> there**. Everything the agent needs — context, locked decisions, scaffold commands, the exact
> manual edits on top of the scaffold, version pins, traps, acceptance criteria — is in this
> file. Agent: work through the steps in order; where a step says *verify*, actually run the
> command and read the output.

> **Historical record — names and the distribution model below are stale.** This document describes
> the bootstrap as it was executed, and is kept verbatim. Since then the repo moved to
> `QuicklyIterateTheSoftware/qits-integrations-angular-jslib` (a submodule of `qits-qits` at
> `components/qits-integrations/qits-integrations-angular-jslib`) and the Angular project was renamed
> `qits-angular-integration` → `qits-integrations-angular`.
>
> More importantly, **the root-manifest takeover this document's Step 2 builds has been undone.**
> qits has its own npm registry now, so the published artifact is `dist/qits-integrations-angular`
> — the ng-packagr output, published by `.config/qits/ci-event-release.yml` off a release tag — and
> `projects/qits-integrations-angular/package.json` is the single source of truth for the published
> manifest. The root's duplicated `name`/`version`, its `files`/`exports` into `dist/`, and the
> `prepare` build hook are gone with the git-install path they served; a registry tarball ships
> prebuilt, so no consumer builds anything and none needs the `pnpm.onlyBuiltDependencies`
> allowlist. `private: true` still stays on the root, for the reason locked decision 1 gives — it
> blocks publishing the **root** — and that is now a statement about the workspace harness only,
> since `dist/` publishes on its own. For the current layout and commands read `AGENTS.md` and
> `README.md`, not this file.

## Context (what this repo is)

This repository will hold **`@qits/angular`**, the integration library for Angular apps managed
by **qits** — a tool that runs each git branch as a containerized workspace with dev-server
daemons, telemetry, a web view, and a coding agent. Today an app integrates by copy-pasting
files from a fixture repo; this library replaces the copy with a dependency:

```ts
// main.ts
await initQitsIntegration();
// app.config.ts
providers: [provideQitsIntegration()]
```

Later plans (in the qits repo, `docs/feature-ideas/*-{1..4}.md`) fill the library with the real
integration: OTEL telemetry wiring, an always-on feature-capture button, a signalStore state
snapshot. **This bootstrap deliberately contains none of that.** It delivers an
empty-but-installable walking skeleton whose only purpose is to prove the distribution
mechanics, because the decided distribution is unusual:

**Git-only distribution, no npm publishing (prototype phase).** Consumers run
`pnpm add "git+https://github.com/wohlben/qits-angular-integration.git#<rev>"`. pnpm clones the repo,
installs its devDependencies, runs the `prepare` script (which builds `dist/`), then packs using
the `files` field. Every decision below serves that pipeline.

## Locked decisions — do not revisit during bootstrap

1. **Standard `ng new` workspace scaffold + a root-manifest takeover.** The scaffold
   (`ng new --create-application=false` + `ng generate library`) provides all the build/test
   wiring generator-maintained. The one thing it cannot provide: a git dependency installs the
   **repo root** as the package, and the generated root `package.json` is a workspace shell —
   wrong name, no `exports`, no `files`, no `prepare`, no peers. So after scaffolding, the root
   manifest is rewritten to *be* the installable package — name `@qits/angular`,
   `files`/`exports` pointing into the built `dist/qits-angular-integration/`, `prepare` as the
   consumer-side build hook, real `peerDependencies`. Step 2 specifies every field.
   (`private: true` **stays** — it blocks only registry publishing, which is exactly the
   decision, and does not affect git installs: verified, pnpm packs and installs private
   packages from git fine.)
   *(Superseded: the takeover is undone, but `private: true` outlived the reason given here —
   see the note at the top. It now blocks publishing the workspace **harness**, while the real
   package, `dist/qits-integrations-angular`, publishes to qits' registry.)*
2. **Generated wiring is accepted as-is.** Whatever builders/tsconfig shapes
   `@angular/cli@21` scaffolds for the library (build via ng-packagr, unit tests via the vitest
   builder) are kept — no hand-tuning of `angular.json` beyond what Step 2 lists. If the
   generator output differs from an example in this doc, **the generator wins** (except the root
   manifest, where this doc wins).
3. **Toolchain pins mirror the qits webui** (so library, qits UI, and fixture never straddle
   majors): Node 22, `pnpm@10.33.0` (via `packageManager`), Angular `^21.2.0`, TypeScript
   `~5.9.2`, eslint `^10` + `typescript-eslint` `^8` + `@angular-eslint` `^21.3.1`.
4. **Version `0.0.1`, git SHAs are the versions.** No tags, no changelog, no publish scripts.
5. **MIT license, public repo.**

## Step 0 — starting state: a bare repository

The repository is **empty** — no scaffold, no README, possibly not even an initial commit.
Everything gets created here.

```bash
git clone https://github.com/wohlben/qits-angular-integration.git && cd qits-angular-integration  # or start in the empty checkout
git symbolic-ref HEAD refs/heads/main 2>/dev/null || true   # default branch main if no commit exists yet
node --version   # must be 22.x
corepack enable && corepack prepare pnpm@10.33.0 --activate
```

## Step 1 — scaffold

```bash
# Workspace without an application, generated INTO the existing checkout.
# --directory . tolerates the existing .git and BOOTSTRAP.md; add --force only if it refuses.
pnpm dlx @angular/cli@21 new qits-angular-integration --create-application=false --directory . \
  --skip-git --package-manager pnpm --defaults

# The library project. Project name stays unscoped (qits-angular-integration) — the *package* name is set
# to @qits/angular in the manifests in Step 2; ng-packagr flattens it to fesm2022/qits-angular-integration.mjs.
pnpm ng generate library qits-angular-integration
```

Then clean the example code the generator ships: delete the generated service/component files
under `projects/qits-angular-integration/src/lib/`, and empty the export list in
`projects/qits-angular-integration/src/public-api.ts` (Step 3 refills it).

## Step 2 — the root-manifest takeover (the load-bearing step)

Rewrite the **root `package.json`** (keep the generator's `devDependencies` — including
`ng-packagr` and the test tooling `ng generate library` added — and merge these fields over the
rest):

```jsonc
{
  "name": "@qits/angular",              // was "qits-angular-integration"; consumers import by this name
  "version": "0.0.1",
  "private": true,                      // KEEP: blocks accidental registry publish (the git-only
                                        // decision, enforced); verified harmless to git installs
  "description": "qits integration for Angular apps: telemetry, feature capture, state snapshots (walking skeleton).",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/wohlben/qits-angular-integration.git" },
  "packageManager": "pnpm@10.33.0",
  "scripts": {
    "ng": "ng",
    "build": "ng build qits-angular-integration",
    "test": "ng test qits-angular-integration",
    "lint": "ng lint qits-angular-integration",
    "check-exports": "node scripts/check-exports.mjs",
    "prepare": "ng build qits-angular-integration && node scripts/check-exports.mjs"
  },
  "files": ["dist/qits-angular-integration"],
  "exports": {
    ".": {
      "types": "./dist/qits-angular-integration/index.d.ts",
      "default": "./dist/qits-angular-integration/fesm2022/qits-angular-integration.mjs"
    }
  },
  "sideEffects": false,
  "peerDependencies": { "@angular/core": "^21.2.0" },
  "dependencies": { "tslib": "^2.3.0" }
}
```

Why each unusual field exists (leave these comments out of the actual JSON):

- **`files: ["dist/qits-angular-integration"]`** — pnpm *packs* git dependencies after building them;
  anything outside `files` is dropped from what the consumer receives. Without this, the built
  output never reaches the consumer. (`README.md`, `LICENSE`, `package.json` are always packed.)
- **`prepare`** — runs after `pnpm install` in this repo (harmless local build) **and on the
  consumer side when pnpm builds the git dep** — that second run is the entire distribution
  mechanism. It also runs the exports drift check so a broken mirror fails the install loudly.
- **`exports`** must mirror what ng-packagr writes into `dist/qits-angular-integration/package.json` — the
  authoritative manifest that a *published* package would ship, unreachable here because the
  consumer installs the repo root. The exact FESM filename comes from the package name
  (`@qits/angular` flattens to `qits-angular-integration`); don't hand-guess it — build once and read
  `dist/qits-angular-integration/package.json`, and let `check-exports` guard it thereafter.
- **`peerDependencies`/`dependencies` live in BOTH manifests** — the consumer's package manager
  reads the *root* manifest (so peers must be here), while ng-packagr validates/emits from
  `projects/qits-angular-integration/package.json` (so they're there too). `check-exports` verifies the two
  stay in sync.

And two sibling edits:

- **`projects/qits-angular-integration/package.json`**: set `"name": "@qits/angular"`, `"version": "0.0.1"`,
  peers `@angular/core: ^21.2.0` (drop `@angular/common` unless generated code needs it),
  `dependencies: { "tslib": "^2.3.0" }`.
- **`.gitignore`** (the generated one): ensure `dist/` and `*.tgz` are ignored. `dist/` is
  **never committed on `main`** — it is rebuilt by `prepare`. (A committed-dist `release` branch
  is the designed fallback, built only if consumer-side building fails; see Traps.)

### `scripts/check-exports.mjs`

```js
import { readFileSync } from 'node:fs';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const dist = JSON.parse(readFileSync('dist/qits-angular-integration/package.json', 'utf8'));

let failed = false;
const rootEntry = root.exports['.'];
const distEntry = dist.exports['.'];
for (const key of ['types', 'default']) {
  const expected = './dist/qits-angular-integration/' + distEntry[key].replace(/^\.\//, '');
  if (rootEntry[key] !== expected) {
    console.error(`exports drift: root exports['.'].${key} is ${rootEntry[key]}, dist says ${expected}`);
    failed = true;
  }
}
for (const [pkg, range] of Object.entries(dist.peerDependencies ?? {})) {
  if (root.peerDependencies?.[pkg] !== range) {
    console.error(`peer drift: dist declares ${pkg}@${range}, root has ${root.peerDependencies?.[pkg]}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log('manifests in sync: root mirrors dist (exports + peers)');
```

## Step 3 — the walking-skeleton code

`projects/qits-angular-integration/src/lib/provide-qits-integration.ts`:

```ts
import { EnvironmentProviders, makeEnvironmentProviders } from '@angular/core';

/**
 * Walking skeleton. Plan 1 (qits repo, docs/feature-ideas/qits-angular-integration-library-1.md)
 * replaces these no-ops with the real integration: config.json-gated OTEL telemetry, error
 * handler, route telemetry — then plans 3 and 4 add feature capture and state snapshots.
 */
export function provideQitsIntegration(): EnvironmentProviders {
  return makeEnvironmentProviders([]);
}

/** Pre-bootstrap hook. Must be awaited before bootstrapApplication once plan 1 lands. */
export async function initQitsIntegration(): Promise<void> {}
```

`projects/qits-angular-integration/src/lib/provide-qits-integration.spec.ts` — the assertion is trivial; the
spec exists to prove the generated test toolchain end-to-end:

```ts
import { TestBed } from '@angular/core/testing';
import { provideQitsIntegration } from './provide-qits-integration';

describe('provideQitsIntegration', () => {
  it('bootstraps an injector with the providers', () => {
    TestBed.configureTestingModule({ providers: [provideQitsIntegration()] });
    expect(TestBed.inject(Object, null, { optional: true })).toBeDefined();
  });
});
```

`projects/qits-angular-integration/src/public-api.ts`:

```ts
export { provideQitsIntegration, initQitsIntegration } from './lib/provide-qits-integration';
```

Rule going forward (also for CLAUDE.md): **every export goes through `public-api.ts`**.

## Step 4 — lint

`ng new` does not ship eslint; add the qits-family setup:

```bash
pnpm ng add @angular-eslint/schematics --skip-confirmation
```

Accept the generated flat config, then align two rules with the qits webui conventions
(component selector prefix `qits`/kebab-case, directive prefix `qits`/camelCase) and add
`'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]`. If the schematic
fights the workspace shape, a hand-written `eslint.config.mjs` with
`typescript-eslint` recommended + `@angular-eslint` recommended rules and an
`@angular-eslint/builder:lint` target in `angular.json` is an acceptable fallback.

## Step 5 — docs for humans and agents

- **`README.md`** — the consumer contract. Must cover, briefly: what the library is (one
  paragraph, link to the qits repo); install
  (`pnpm add "git+https://github.com/wohlben/qits-angular-integration.git#<sha>"`); usage (the two lines);
  the dev loop — **iterating against a consumer uses a local `file:../qits-angular-integration` override or
  `pnpm link`, never git-ref churn; commit a `#<sha>` pin only when cutting a consumable
  state**; and the packaging invariants (root manifest is the package, `files` carries dist,
  `prepare` builds on consumer install, root exports/peers mirror dist — one line each, so
  future changes don't innocently break them) including the smoke loop from Step 6 as the
  regression check.
- **`CLAUDE.md`** — for agents working here later: commands (`pnpm build|test|lint|check-exports`);
  the workspace layout + root-manifest takeover and *why* (git-installability); conventions
  inherited from the qits webui (standalone components only, `ChangeDetectionStrategy.OnPush`,
  `input()`/`output()`/`computed()` functions never decorators, `inject()` over constructors,
  native control flow, no `any`); the `public-api.ts` rule; and the packaging invariants list.
- **`LICENSE`** — standard MIT text, copyright 2026 wohlben.

## Step 6 — build, test, commit+push, smoke-test the git install

```bash
pnpm install          # also runs prepare → first build + manifest sync check
pnpm build && pnpm check-exports
pnpm test             # the one spec, green
pnpm lint             # clean
```

**Commit and push first**: git dependencies install from *commits on the remote*, not working
trees — commit everything (including `pnpm-lock.yaml`) as the initial commit on `main` and push.

Then, from a sibling directory (Node 22 + pnpm; inside the `qits/workspace` container image if
available, since that is the environment qits consumers actually run):

```bash
pnpm dlx @angular/cli@21 new smoke --minimal --skip-git --defaults && cd smoke

# Criterion: local git URL — proves clone → devDeps install → prepare build → pack → files
pnpm add "git+file://$(realpath ../qits-angular-integration)#main"

# Wire it in: app.config.ts → providers: [provideQitsIntegration()]
#             main.ts       → await initQitsIntegration() before bootstrapApplication
pnpm ng build             # must compile against the installed dist types

# Criterion: the real remote, SHA-pinned — the exact form consumers will commit
pnpm remove @qits/angular
pnpm add "git+https://github.com/wohlben/qits-angular-integration.git#<current sha>"
pnpm ng build
```

Delete the smoke app afterwards; it is an instrument, not an artifact.

## Traps — read before debugging

- **pnpm 10 build-script gating.** pnpm 10 refuses dependency lifecycle scripts unless
  allowlisted. Git-dep `prepare` *should* be exempt (it's the documented build path for git
  deps), but if the consumer install skips the build, the fix is in the **consumer's**
  `package.json`: `"pnpm": { "onlyBuiltDependencies": ["@qits/angular"] }` — verify which is
  needed during Step 6 and document the answer in the README.
- **Manifest drift** — never hand-edit the root `exports`/peers on a hunch; run
  `pnpm build && pnpm check-exports` and copy what `dist/qits-angular-integration/package.json` actually
  says.
- **`prepare` fallback (`release` branch)** — if consumer-side building proves flaky in a way an
  hour of debugging doesn't fix: create a `release` branch that commits `dist/` and has no
  `prepare` script, point consumers at `#release`, keep `main` clean. Designed, not built —
  reach for it only on real failure.
- **`prepare` before install completes** — if the in-repo `pnpm install` fails because `ng`
  isn't on PATH during the prepare hook, wrap it (`node scripts/prepare.mjs` that no-ops when
  `node_modules/.bin/ng` is absent) — but only if actually observed; the straightforward form is
  preferred.

## Acceptance criteria (all five, in order)

1. `pnpm build` produces APF output under `dist/qits-angular-integration/`: `fesm2022/qits-angular-integration.mjs`,
   `index.d.ts`, and a generated `package.json`; the FESM contains `ɵɵngDeclare`
   partial-compilation calls (the library tsconfig's `compilationMode: partial` — scaffolded by
   the generator — applied), not full `ɵɵdefine*` output.
2. `pnpm test` and `pnpm lint` green.
3. The smoke app installs via **local** `git+file://` URL and its `ng build` compiles the
   imported `provideQitsIntegration()`.
4. Same via the **remote GitHub URL with a SHA pin**.
5. `pnpm check-exports` passes (exports + peers mirrored), and is wired into `prepare` so it
   always will.

## Out of scope (do not build these now)

Real integration code (plan 1), CI, npm publishing, tags/versioning beyond `0.0.1`, registering
this repo in qits, the `release` fallback branch (unless triggered per Traps).
