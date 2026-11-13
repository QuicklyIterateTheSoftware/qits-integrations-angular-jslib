/**
 * The Node side of the screenshot freezes (ticket qits-1947): `freezeScreenshots()` in
 * `@qits/angular/testing/browser` sends every passing screenshot as HTML through the `qitsFreeze`
 * browser command, and the app's route tree through `qitsFreezeRoutes`; this keeps them until the
 * run ends and then writes, under the freeze directory (default `src/testing/browser/freezes`):
 *
 *   <spec path relative to the root>/<screenshot name>.html   one file per screenshot
 *   <spec path relative to the root>/<name>-<viewport>.html   one per preset width (viewportSpecs)
 *   <spec path relative to the root>/<name>[-<viewport>]-<scheme>.html   one per colour scheme
 *   assets/<file name>                                        same-origin files the HTML uses
 *   manifest.json                                             what is where (below)
 *
 *   {
 *     "routes": [
 *       { "path": "projects", "fullPath": "projects", "entry": true, "children": [ … ] },
 *       { "path": "go", "fullPath": "go", "forward": true,
 *         "children": [{ "path": "", "fullPath": "go", "rendersNothing": true }] }
 *     ],
 *     "freezes": [{
 *       "file": "src/app/routes/projects/projects.page.browser.spec.ts/list.html",
 *       "spec": "src/app/routes/projects/projects.page.browser.spec.ts",
 *       "test": "projects page > lists the projects",
 *       "name": "list",
 *       "kind": "DATA",                   // DATA | NO_DATA | PENDING | ERROR, null when the shot gave none
 *       "viewport": null,                 // PHONE | TABLET | DESKTOP for a shot at a preset width
 *       "route": "projects",              // null unless a page or layout spec under routes/ (routeSpecs)
 *       "records": [{ "provider": "qits-projects-service", "state": "…", "operationId": "…" }],
 *       "triggers": ["projects:open"],    // the visible outcome marks, `<interaction>:<outcome>`
 *       "dataMarks": [{ "source": "qits-projects-service#listProjects", "item": "id=1",
 *                       "field": "name", "derived": [] }]
 *     }],
 *     "byRoute": { "projects": ["src/app/routes/projects/projects.page.browser.spec.ts/list.html"] },
 *     "outcomes": {
 *       "declared": [{ "route": "projects", "interaction": "projects", "outcome": "open",
 *                      "kind": "exit", "to": "projects/:slug", "global": false,
 *                      "triggered": true, "file": "src/app/routes/projects/projects.page.ts" }],
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
 *
 * Kinds and preset widths (ticket qits-2046): `kind` is the state the shot says it shows
 * (`toMatchScreenshot(name, { kind })`), `null` when it gave none. A shot in a spec the browser
 * side's `viewportSpecs` matches is taken once per preset width, PHONE, TABLET and DESKTOP in that
 * order: each is its own freeze, `<name>-phone.html` and so on, with the record's `name` the name
 * the spec gave and `viewport` the width; a shot at the test's own viewport has `viewport: null` and
 * keeps `<name>.html`. A fired record's `freeze` prefers the DESKTOP freeze of the first shot after
 * it, and falls back to that shot's first freeze. Both fields are optional for a reader: a manifest
 * written before them (and entries kept from specs a run skipped) reads as `null`, and is written
 * back with `null`.
 *
 * Colour schemes (ticket qits-2083): in an app that gives `freezeScreenshots({ colorSchemes })`,
 * every shot is taken once per scheme, LIGHT then DARK, at each width: `<name>[-<viewport>]-light`
 * and `-dark` (the scheme is the last suffix, as on the PNG). The manifest then carries the option
 * as a top-level `"colorSchemes": ["LIGHT", "DARK"]`, and each freeze `"colorScheme"` (the scheme,
 * `null` for one taken without it) and `"colorSchemeReason"` (the shot's `reason` when it named its
 * own `colorSchemes`, else `null`). Without the option none of the three keys is written, so the
 * manifest stays as it was; a reader takes a missing key as `null`. The top-level value is the one
 * the run's payloads carried; a run that froze nothing keeps the previous manifest's. An outcome
 * links to the first scheme its shot took (LIGHT unless it opted out of it), at DESKTOP as above.
 * `colorSchemeGaps()` is what `qits-angular screenshots --check` holds the manifest to.
 *
 * Entry points (ticket qits-2049): a route's `entry` is `true` when `describeRoutes()` sees
 * `route.data.qitsEntry === true` (`QITS_ENTRY`), and is omitted otherwise. It marks a route that is
 * entered from outside the app — an idp redirect, an old bookmarked address — rather than by an
 * exit this app declares, so `outcomeGaps()` (`outcomes.mjs`) does not ask it for an inbound exit.
 *
 * Forwards (ticket qits-2076): `describeRoutes()` writes `rendersNothing: true` on a route with no
 * component, lazy load or redirect of its own whose children render nothing too (a layout's `''`
 * child, a `:tab` child that only feeds it a parameter). At the end of the run, with `declared`
 * known, this writes `forward: true` on each route `forwardRoutes()` (`outcomes.mjs`) names: one
 * that renders a component, whose own declared entries are all `exit()`s with `triggered: false`,
 * and below which nothing renders. The flag sits on that route only, never on its `rendersNothing`
 * descendants; a route tree kept from an earlier run is judged again. Both are omitted when false.
 *
 * Data marks (ticket qits-2141): pages carry the data directives' marks as attributes
 * (`data-qits-source`, `data-qits-item`, `data-qits-field`, `data-qits-derived`). Each freeze's
 * `dataMarks` is the browser side's `visibleDataMarks()`, normalised to its four fields (`derived`
 * coerced to a string array), deduplicated and sorted the same way as there. It is written only
 * when the freeze shows at least one mark, right after `triggers`; a freeze without one has no
 * `dataMarks` key at all, so a manifest from an app that carries no marks yet stays byte-for-byte
 * identical to before. An entry kept from a spec a run skipped keeps whatever `dataMarks` (or lack
 * of one) it already had.
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
import { DEFAULT_ROUTES, declaredOutcomes, markForwards } from './outcomes.mjs';

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
export const FREEZE_COLOR_SCHEME_COMMAND = 'qitsColorScheme';

/**
 * What the browser sends `qitsColorScheme` to reset the emulation (`RESET_COLOR_SCHEME` there): a
 * string, because Vitest 5's browser tester throws on a `null` first argument of any command.
 */
export const RESET_COLOR_SCHEME = 'reset';

/** What a same-origin URL is in the HTML the browser sends (`FREEZE_ASSET_PREFIX` there). */
const ASSET = /qits-freeze-asset:(\/[^"'\s),?#]*)/g;

export const MANIFEST = 'manifest.json';

/** The kinds a shot may say it shows (`ScreenshotKind` in `@qits/angular/testing/browser`). */
export const SCREENSHOT_KINDS = Object.freeze(['DATA', 'NO_DATA', 'PENDING', 'ERROR']);

/** The preset widths, in the order a shot is taken at them (`ScreenshotViewport` there). */
export const SCREENSHOT_VIEWPORTS = Object.freeze(['PHONE', 'TABLET', 'DESKTOP']);

/** The colour schemes, in the order a shot is taken in them (`ColorScheme` there). */
export const COLOR_SCHEMES = Object.freeze(['LIGHT', 'DARK']);

/** The width an outcome links to first: the one a reader shows by default. */
const LINKED_VIEWPORT = 'DESKTOP';

const oneOf = (values, value) => (values.includes(value) ? value : null);

/** A reason as the manifest keeps it: a non-empty string, else `null`. */
const reasonOf = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);

/**
 * A colour-scheme option as the manifest keeps it: the schemes in {@link COLOR_SCHEMES} order, or
 * `null` when it is not a non-empty list of them.
 */
function schemesOf(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((scheme) => COLOR_SCHEMES.includes(scheme))) return null;
  return COLOR_SCHEMES.filter((scheme) => value.includes(scheme));
}

/**
 * The freeze file of a shot, relative to the freeze directory: `<spec>/<slug>.html`, or
 * `<spec>/<slug>-<viewport>.html` for a shot at a preset width, as Vitest names its PNG
 * `<name>-<viewport>-<browser>-<platform>.png` (the browser side suffixes the name it compares). A
 * shot in a colour scheme (ticket qits-2083) takes the scheme as the last suffix:
 * `<spec>/<slug>[-<viewport>]-light.html`, `-dark`.
 */
export function freezeFile(spec, name, viewport = null, colorScheme = null) {
  const width = viewport ? `-${viewport.toLowerCase()}` : '';
  const scheme = colorScheme ? `-${colorScheme.toLowerCase()}` : '';
  return `${spec}/${freezeSlug(name)}${width}${scheme}.html`;
}

/**
 * The page and layout shots (`route` not `null`) that lack a scheme of the manifest's
 * `colorSchemes` (ticket qits-2083), one message each: `<spec> '<name>' [<viewport>]: missing DARK`.
 * The freezes are grouped by spec, test, name and viewport; a group misses each scheme of
 * `colorSchemes` none of its freezes was taken in, unless one of them opted out (its
 * `colorSchemeReason` is set). A freeze without a scheme counts as none taken. Empty without
 * `colorSchemes` in the manifest.
 */
export function colorSchemeGaps(manifest) {
  const wanted = schemesOf(manifest?.colorSchemes);
  if (!wanted) return [];
  const groups = new Map();
  for (const freeze of Array.isArray(manifest.freezes) ? manifest.freezes : []) {
    if (freeze?.route === null || freeze?.route === undefined) continue;
    const viewport = oneOf(SCREENSHOT_VIEWPORTS, freeze.viewport);
    const key = JSON.stringify([freeze.spec, freeze.test, freeze.name, viewport]);
    const group = groups.get(key) ?? { freeze, viewport, taken: new Set(), optedOut: false };
    const scheme = oneOf(COLOR_SCHEMES, freeze.colorScheme);
    if (scheme) group.taken.add(scheme);
    if (reasonOf(freeze.colorSchemeReason)) group.optedOut = true;
    groups.set(key, group);
  }
  const gaps = [];
  for (const { freeze, viewport, taken, optedOut } of groups.values()) {
    if (optedOut) continue;
    const missing = wanted.filter((scheme) => !taken.has(scheme));
    if (missing.length === 0) continue;
    gaps.push(
      `${freeze.spec} '${freeze.name}'${viewport ? ` [${viewport}]` : ''}: missing ${missing.join(', ')}`,
    );
  }
  return gaps.sort(compare);
}
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

/** `a` and `b`, with `null` first; otherwise the usual string order (ticket qits-2141). */
const compareNullable = (a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : compare(a, b));

/** `a` and `b` element-wise, then by length (a shorter list first when it is a prefix). */
function compareDerived(a, b) {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const c = compareNullable(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

const compareDataMark = (a, b) =>
  compareNullable(a.source, b.source) ||
  compareNullable(a.item, b.item) ||
  compareNullable(a.field, b.field) ||
  compareDerived(a.derived, b.derived);

/** One data mark as the manifest keeps it: only its four fields, `derived` a string array. */
function dataMarkOf(mark) {
  return {
    source: typeof mark?.source === 'string' ? mark.source : null,
    item: typeof mark?.item === 'string' ? mark.item : null,
    field: typeof mark?.field === 'string' ? mark.field : null,
    derived: Array.isArray(mark?.derived) ? mark.derived.map(String) : [],
  };
}

/**
 * The data marks a shot sent (ticket qits-2141), as the manifest keeps them: only the four
 * fields, deduplicated and sorted as the browser side's `visibleDataMarks()` sorts them.
 */
function dataMarksOf(marks) {
  const seen = new Map();
  for (const raw of Array.isArray(marks) ? marks : []) {
    const mark = dataMarkOf(raw);
    seen.set(JSON.stringify([mark.source, mark.item, mark.field, mark.derived]), mark);
  }
  return [...seen.values()].sort(compareDataMark);
}

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
  /** The `colorSchemes` option this run's payloads carried (`null`: off), `undefined` before one. */
  let runColorSchemes;

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
      runColorSchemes = undefined;
    },

    /**
     * The `colorSchemes` option this run's payloads carried, in {@link COLOR_SCHEMES} order (`null`:
     * they carried none), or `undefined` when the run sent no freeze payload yet.
     */
    colorSchemes() {
      return runColorSchemes;
    },

    /** The `qitsFreezeRoutes` command: the app's route tree, as `describeRoutes()` gives it. */
    setRoutes(tree) {
      routes = tree;
    },

    /** The `qitsFreeze` command, for the spec at `testPath`. */
    add(
      testPath,
      {
        name,
        test,
        html,
        route,
        records,
        outcomes,
        triggers,
        dataMarks,
        kind,
        viewport,
        colorScheme,
        colorSchemes,
        colorSchemeReason,
      },
    ) {
      const spec = toPosix(relative(root, testPath));
      const width = oneOf(SCREENSHOT_VIEWPORTS, viewport);
      const scheme = oneOf(COLOR_SCHEMES, colorScheme);
      runColorSchemes = schemesOf(colorSchemes);
      const file = freezeFile(spec, name, width, scheme);
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
        kind: oneOf(SCREENSHOT_KINDS, kind),
        viewport: width,
        colorScheme: scheme,
        colorSchemeReason: reasonOf(colorSchemeReason),
        route: routeSpecs.test(spec) ? (route ?? null) : null,
        records: (records ?? []).map(({ provider, state, operationId }) => ({
          provider,
          state,
          operationId,
        })),
        triggers: [...new Set(triggers ?? [])].sort(compare),
        dataMarks: dataMarksOf(dataMarks),
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
            // The widths and schemes of one shot share its test, name and outcome count; DESKTOP
            // first, and of its schemes the first taken (LIGHT unless the shot left it out).
            const linked =
              after &&
              (shotsInOrder.find(
                (shot) =>
                  shot.entry.test === test &&
                  shot.entry.name === after.entry.name &&
                  shot.outcomes === after.outcomes &&
                  shot.entry.viewport === LINKED_VIEWPORT,
              ) ??
                after);
            fired.push({ ...record, freeze: linked?.entry.file ?? null });
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
      // The option as this run's payloads carried it; a run that froze nothing keeps the old one.
      const colorSchemes = runColorSchemes === undefined ? old.colorSchemes : runColorSchemes;
      const manifest = {
        routes: markForwards(routes ?? old.routes, declared),
        // Written only with the option, so a manifest without it stays byte for byte as before.
        ...(colorSchemes ? { colorSchemes } : {}),
        freezes: freezes.map(
          ({
            file,
            spec,
            test,
            name,
            kind,
            viewport,
            colorScheme,
            colorSchemeReason,
            route,
            records,
            triggers,
            dataMarks,
          }) => ({
            file,
            spec,
            test,
            name,
            kind: oneOf(SCREENSHOT_KINDS, kind),
            viewport: oneOf(SCREENSHOT_VIEWPORTS, viewport),
            ...(colorSchemes
              ? {
                  colorScheme: oneOf(COLOR_SCHEMES, colorScheme),
                  colorSchemeReason: reasonOf(colorSchemeReason),
                }
              : {}),
            route,
            records,
            triggers: triggers ?? [],
            // Written only when the freeze shows a mark, so a manifest without any stays
            // byte-for-byte as before (ticket qits-2141).
            ...(dataMarks && dataMarks.length > 0 ? { dataMarks } : {}),
          }),
        ),
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
      colorSchemes: schemesOf(manifest.colorSchemes),
      freezes: Array.isArray(manifest.freezes) ? manifest.freezes : [],
      fired: Array.isArray(manifest.outcomes?.fired) ? manifest.outcomes.fired : [],
    };
  } catch {
    return { routes: [], colorSchemes: null, freezes: [], fired: [] };
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
