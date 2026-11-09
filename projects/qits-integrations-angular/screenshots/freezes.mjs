/**
 * The Node side of the screenshot freezes (ticket qits-1947): `freezeScreenshots()` in
 * `@qits/angular/testing/browser` sends every passing screenshot as HTML through the `qitsFreeze`
 * browser command, and the app's route tree through `qitsFreezeRoutes`; this keeps them until the
 * run ends and then writes, under the freeze directory (default `src/testing/browser/freezes`):
 *
 *   <spec path relative to the root>/<screenshot name>.html   one file per screenshot
 *   assets/<file name>                                        same-origin files the HTML uses
 *   manifest.json                                             what is where (below)
 *
 *   {
 *     "routes": [{ "path": "projects", "fullPath": "projects", "children": [ … ] }],
 *     "freezes": [{
 *       "file": "src/app/routes/projects/projects.page.browser.spec.ts/list.html",
 *       "spec": "src/app/routes/projects/projects.page.browser.spec.ts",
 *       "test": "projects page > lists the projects",
 *       "name": "list",
 *       "route": "projects",              // null unless a page or layout spec under routes/ (routeSpecs)
 *       "records": [{ "provider": "qits-projects-service", "state": "…", "operationId": "…" }],
 *       "triggers": ["projects:open"]     // the visible outcome marks, `<interaction>:<outcome>`
 *     }],
 *     "byRoute": { "projects": ["src/app/routes/projects/projects.page.browser.spec.ts/list.html"] },
 *     "outcomes": {
 *       "declared": [{ "route": "projects", "interaction": "projects", "outcome": "open",
 *                      "kind": "exit", "to": "projects/:slug", "global": false,
 *                      "file": "src/app/routes/projects/projects.page.ts" }],
 *       "fired": [{ "spec": "…", "test": "…", "route": "projects", "interaction": "projects",
 *                   "outcome": "open", "kind": "exit", "freeze": "…/list.html" }]
 *     }
 *   }
 *
 * `file` is relative to the freeze directory. A run replaces only what it saw completely: a spec
 * whose tests all ran and passed gets exactly the freezes it sent (its other files are deleted), a
 * spec file that no longer exists loses its freezes, and a spec that failed, was filtered or did not
 * run keeps the freezes it had. Every run writes, update run or not.
 *
 * The outcomes (ticket qits-2003): `declared` is read from the app's source at the end of every run
 * (`declaredOutcomes()` in `outcomes.mjs`); `fired` are the records `recordOutcomes()` sends through
 * `qitsOutcomes` after each test, kept per spec by the freezes' rules. A fired record's `freeze` is
 * the first freeze of its test whose shot came after it (the freeze's `outcomes` count, the test's
 * records at shot time, is greater than the record's index in the test), `null` when no shot did.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, posix, relative, resolve } from 'node:path';
import { toPosix } from './record.mjs';
import { DEFAULT_ROUTES, declaredOutcomes } from './outcomes.mjs';

export const DEFAULT_FREEZE_DIRECTORY = 'src/testing/browser/freezes';

/**
 * The specs whose freezes name their route: the page and layout specs under `src/app/routes/`,
 * which open the page through the app's routes (`freezeScreenshots()` checks that, with the same
 * default). Pattern and UI specs, and a `$layout` layout's (the shell), mount stand-in routes.
 */
export const DEFAULT_ROUTE_SPECS =
  /(^|\/)src\/app\/routes\/.*\.(page|layout)\.browser\.spec\.[cm]?[jt]sx?$/;

/** The browser commands, as `@qits/angular/testing/browser` names them. */
export const FREEZE_COMMAND = 'qitsFreeze';
export const FREEZE_ROUTES_COMMAND = 'qitsFreezeRoutes';
export const OUTCOMES_COMMAND = 'qitsOutcomes';

/** What a same-origin URL is in the HTML the browser sends (`FREEZE_ASSET_PREFIX` there). */
const ASSET = /qits-freeze-asset:(\/[^"'\s),?#]*)/g;

export const MANIFEST = 'manifest.json';
const ASSETS = 'assets';

/**
 * The file name a screenshot's name gives, without the extension, as Vitest's
 * `resolveScreenshotPath` gets it as `arg` (`@vitest/browser`, `resolveOptions` and `sanitizeArg`):
 * a `.png` extension is dropped (with the directories before it, as `basename` does there), and each
 * path segment keeps only word characters and single hyphens.
 */
export function freezeSlug(name) {
  const extension = extname(name);
  const arg = extension === '.png' ? basename(name, extension) : name;
  const sanitize = (segment) =>
    segment
      .replace(/\s+/g, '-')
      .replace(/[^\w-]+/g, '')
      .replace(/-{2,}/g, '-');
  return posix.relative('/', posix.join('/', arg)).split('/').map(sanitize).join('/');
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Collects the freezes of one run and writes them at its end.
 *
 * @param {{ root: string, dir?: string, routeSpecs?: RegExp, routes?: string }} options
 *   `routes`: the routes directory the declarations are scoped by (default `src/app/routes`).
 */
export function freezeWriter({
  root,
  dir = DEFAULT_FREEZE_DIRECTORY,
  routeSpecs = DEFAULT_ROUTE_SPECS,
  routes: routesDir = DEFAULT_ROUTES,
}) {
  const base = resolve(root, dir);
  /** spec → Map(file → { entry, html, assets: Map(name → source), outcomes, shot }) */
  let pending = new Map();
  /** spec → Map(test → the test's fired records, in order) */
  let pendingOutcomes = new Map();
  /** Orders the shots of a run, so a record links to the first shot after it. */
  let shots = 0;
  /** asset name → the request path it was copied from, this run */
  let assetSources = new Map();
  let routes;

  /** The copy's name for a same-origin `path`, and the file it is copied from (or `null`). */
  function assetFor(path) {
    const decoded = decodeURIComponent(path);
    const candidates = decoded.startsWith('/@fs/')
      ? [decoded.slice('/@fs'.length)]
      : [join(root, decoded), join(root, 'public', decoded)];
    const source = candidates.find((candidate) => existsSync(candidate)) ?? null;
    if (source === null) return { name: null, source };
    const name = basename(source);
    const before = assetSources.get(name);
    if (before !== undefined && before !== path) {
      throw new Error(
        `screenshot freezes: ${before} and ${path} would both be copied to ${dir}/${ASSETS}/${name}; ` +
          'give one of them another file name.',
      );
    }
    assetSources.set(name, path);
    return { name, source };
  }

  return {
    start() {
      pending = new Map();
      pendingOutcomes = new Map();
      shots = 0;
      assetSources = new Map();
      routes = undefined;
    },

    /** The `qitsFreezeRoutes` command: the app's route tree, as `describeRoutes()` gives it. */
    setRoutes(tree) {
      routes = tree;
    },

    /** The `qitsFreeze` command, for the spec at `testPath`. */
    add(testPath, { name, test, html, route, records, outcomes, triggers }) {
      const spec = toPosix(relative(root, testPath));
      const file = `${spec}/${freezeSlug(name)}.html`;
      const toAssets = toPosix(relative(dirname(join(base, file)), join(base, ASSETS)));
      const assets = new Map();
      const rewritten = html.replace(ASSET, (_, path) => {
        const { name: copy, source } = assetFor(path);
        if (copy === null) {
          console.warn(
            `screenshot freezes: ${path} (in ${file}) is not a file under ${root}; the freeze keeps its URL`,
          );
          return path;
        }
        assets.set(copy, source);
        return `${toAssets}/${copy}`;
      });
      const entry = {
        file,
        spec,
        test,
        name,
        route: routeSpecs.test(spec) ? (route ?? null) : null,
        records: (records ?? []).map(({ provider, state, operationId }) => ({
          provider,
          state,
          operationId,
        })),
        triggers: [...new Set(triggers ?? [])].sort(compare),
      };
      const freezes = pending.get(spec) ?? new Map();
      freezes.set(file, { entry, html: rewritten, assets, outcomes: outcomes ?? 0, shot: ++shots });
      pending.set(spec, freezes);
    },

    /**
     * The `qitsOutcomes` command, for the spec at `testPath`: the records one test reached, in
     * order. A test that sends again (a retry) replaces what it sent before.
     */
    addOutcomes(testPath, records) {
      const spec = toPosix(relative(root, testPath));
      const byTest = pendingOutcomes.get(spec) ?? new Map();
      const sent = new Map();
      for (const { test, route, interaction, outcome, kind } of records ?? []) {
        const list = sent.get(test) ?? [];
        list.push({
          spec,
          test,
          route: routeSpecs.test(spec) ? (route ?? null) : null,
          interaction,
          outcome,
          kind,
        });
        sent.set(test, list);
      }
      for (const [test, list] of sent) byTest.set(test, list);
      pendingOutcomes.set(spec, byTest);
    },

    /**
     * Writes what the run froze. `testModules` are the run's modules, `complete(module)` whether
     * every test in one ran and passed.
     */
    end(testModules, complete) {
      const manifestPath = join(base, MANIFEST);
      const old = readManifest(manifestPath);
      const entries = new Map(old.freezes.map((entry) => [entry.file, entry]));
      let fired = old.fired;
      const drop = (spec) => {
        for (const [file, entry] of entries) if (entry.spec === spec) entries.delete(file);
        fired = fired.filter((record) => record.spec !== spec);
      };

      for (const spec of new Set([...old.freezes, ...old.fired].map((entry) => entry.spec))) {
        if (existsSync(join(root, spec))) continue;
        drop(spec);
        rmSync(join(base, spec), { recursive: true, force: true });
        pruneEmpty(dirname(join(base, spec)), base);
      }

      for (const testModule of testModules) {
        if (!complete(testModule)) continue;
        const spec = toPosix(relative(root, testModule.moduleId));
        drop(spec);
        const freezes = pending.get(spec) ?? new Map();
        for (const [file, { entry, html, assets }] of freezes) {
          writeIfChanged(join(base, file), html);
          for (const [name, source] of assets) copyIfChanged(source, join(base, ASSETS, name));
          entries.set(file, entry);
        }
        const shotsInOrder = [...freezes.values()].sort((a, b) => a.shot - b.shot);
        for (const [test, records] of pendingOutcomes.get(spec) ?? []) {
          records.forEach((record, index) => {
            const after = shotsInOrder.find(
              (shot) => shot.entry.test === test && shot.outcomes > index,
            );
            fired.push({ ...record, freeze: after?.entry.file ?? null });
          });
        }
        const directory = join(base, spec);
        for (const path of filesUnder(directory)) {
          if (!freezes.has(toPosix(relative(base, path)))) rmSync(path, { force: true });
        }
        pruneEmpty(directory, base);
      }

      pruneAssets(base, [...entries.keys()]);

      const freezes = [...entries.values()].sort((a, b) => compare(a.file, b.file));
      const byRoute = {};
      for (const route of [...new Set(freezes.map((f) => f.route).filter((r) => r !== null))].sort(
        compare,
      )) {
        byRoute[route] = freezes.filter((f) => f.route === route).map((f) => f.file);
      }
      let declared = [];
      try {
        declared = declaredOutcomes({ root, routes: routesDir }).declared;
      } catch (error) {
        console.warn(`screenshot freezes: ${error.message} The manifest declares no outcomes.`);
      }
      // Stable: a test's records keep the order they were reached in.
      fired.sort((a, b) => compare(a.spec, b.spec) || compare(a.test, b.test));
      const manifest = {
        routes: routes ?? old.routes,
        freezes: freezes.map(({ file, spec, test, name, route, records, triggers }) => ({
          file,
          spec,
          test,
          name,
          route,
          records,
          triggers: triggers ?? [],
        })),
        byRoute,
        outcomes: {
          declared,
          fired: fired.map(({ spec, test, route, interaction, outcome, kind, freeze }) => ({
            spec,
            test,
            route,
            interaction,
            outcome,
            kind,
            freeze,
          })),
        },
      };
      writeIfChanged(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}

function readManifest(path) {
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    return {
      routes: Array.isArray(manifest.routes) ? manifest.routes : [],
      freezes: Array.isArray(manifest.freezes) ? manifest.freezes : [],
      fired: Array.isArray(manifest.outcomes?.fired) ? manifest.outcomes.fired : [],
    };
  } catch {
    return { routes: [], freezes: [], fired: [] };
  }
}

function writeIfChanged(path, content) {
  try {
    if (readFileSync(path, 'utf8') === content) return;
  } catch {
    // not there yet
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function copyIfChanged(source, target) {
  try {
    if (readFileSync(source).equals(readFileSync(target))) return;
  } catch {
    // not there yet
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Removes `directory` and its parents up to (not including) `stop` while they are empty. */
function pruneEmpty(directory, stop) {
  for (const path of directoriesUnder(directory)) {
    try {
      rmdirSync(path);
    } catch {
      // not empty
    }
  }
  for (let at = directory; at.startsWith(stop) && at !== stop; at = dirname(at)) {
    try {
      rmdirSync(at);
    } catch {
      return;
    }
  }
}

function directoriesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((a, b) => b.length - a.length);
}

/** Deletes the copied assets no freeze refers to any more. */
function pruneAssets(base, files) {
  const used = new Set();
  for (const file of files) {
    let html;
    try {
      html = readFileSync(join(base, file), 'utf8');
    } catch {
      continue;
    }
    for (const [, name] of html.matchAll(/(?:\.\.\/)*assets\/([^"'\s),?#/]+)/g)) used.add(name);
  }
  const directory = join(base, ASSETS);
  for (const path of filesUnder(directory)) {
    if (!used.has(basename(path))) rmSync(path, { force: true });
  }
  pruneEmpty(directory, base);
}
