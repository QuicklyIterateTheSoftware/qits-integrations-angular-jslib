/**
 * The Vitest plugin that records, during a browser run, every reference screenshot a
 * `toMatchScreenshot` call resolves, per spec file. The run is the source of truth: a name made in
 * a loop, an `it.each` table or a template string is recorded exactly as Vitest resolves it.
 *
 * It wraps `browser.expect.toMatchScreenshot.resolveScreenshotPath` (Vitest's default, or the
 * app's own), which Vitest calls on the Node side for every comparison, and adds a reporter that
 * writes the record when the run ends.
 *
 * With the `freezes` option it also writes the screenshot freezes (ticket qits-1947,
 * `freezes.mjs`): it registers the browser commands `freezeScreenshots()` sends them to (in its
 * Vite `config` hook, see there), and the
 * same reporter writes them at the end of the run. The outcomes `recordOutcomes()` sends after each
 * test (`qitsOutcomes`, ticket qits-2003) go into the same manifest. `qitsColorScheme` (ticket
 * qits-2083) emulates `prefers-color-scheme` for `freezeScreenshots({ colorSchemes })`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  DEFAULT_RECORD,
  DEFAULT_SCREENSHOT_DIRECTORY,
  RECORD_VERSION,
  fileHash,
  toPosix,
} from './record.mjs';
import {
  FREEZE_COLOR_SCHEME_COMMAND,
  RESET_COLOR_SCHEME,
  FREEZE_COMMAND,
  FREEZE_ROUTES_COMMAND,
  OUTCOMES_COMMAND,
  freezeWriter,
} from './freezes.mjs';

/** Vitest's own default (`@vitest/browser`, `defaultOptions.resolveScreenshotPath`). */
const vitestDefault = ({
  arg,
  ext,
  root,
  screenshotDirectory,
  testFileDirectory,
  testFileName,
  browserName,
}) =>
  resolve(
    root,
    testFileDirectory,
    screenshotDirectory,
    testFileName,
    `${arg}-${browserName}-${platform()}${ext}`,
  );

/**
 * The `qitsColorScheme` command (ticket qits-2083): emulates `prefers-color-scheme` on the page the
 * tests run in, `'light'` or `'dark'`, or resets it with `'reset'` ({@link RESET_COLOR_SCHEME}).
 * Not with `null`: Vitest 5's browser tester reads `"selector" in args[0]` of every command whose
 * first argument is an object, and `typeof null` is `'object'`, so a `null` throws a `TypeError` in
 * the browser before it is sent. Vitest 4 sends it; refusing it here keeps the Vitest 4 runs
 * (`vitest-run.test.mjs`) a guard for Vitest 5. Only the Playwright provider has a `page` with
 * `emulateMedia` (in Vitest 4 and 5 alike); any other fails the shot naming the fix.
 */
export async function emulateColorScheme(context, scheme) {
  if (scheme !== RESET_COLOR_SCHEME && scheme !== 'light' && scheme !== 'dark') {
    throw new Error(
      `screenshot freezes: ${FREEZE_COLOR_SCHEME_COMMAND} takes 'light', 'dark' or ` +
        `'${RESET_COLOR_SCHEME}', not ${JSON.stringify(scheme)}` +
        (scheme === null ? " (Vitest 5's browser tester throws on a null command argument)." : '.'),
    );
  }
  const page = context?.page;
  if (!page || typeof page.emulateMedia !== 'function') {
    throw new Error(
      `screenshot freezes: freezeScreenshots({ colorSchemes }) emulates prefers-color-scheme ` +
        `through Playwright, but the browser provider${context?.provider?.name ? ` '${context.provider.name}'` : ''} ` +
        'has no page to emulate it on. Use the playwright provider (@vitest/browser-playwright), ' +
        'or drop the colorSchemes option.',
    );
  }
  await page.emulateMedia({ colorScheme: scheme === RESET_COLOR_SCHEME ? null : scheme });
  return null;
}

const WRAPPED = Symbol.for('qits.screenshotReferences.wrapped');

/** A file passed when every test in it ran and passed: a skip or a failure leaves names unseen. */
function complete(testModule) {
  if (testModule.state() !== 'passed') return false;
  if ((testModule.errors?.() ?? []).length > 0) return false;
  for (const test of testModule.children.allTests()) {
    if (test.result().state !== 'passed') return false;
  }
  return true;
}

/** The number of tests in a module whose result is `skipped`. */
function skippedTests(testModule) {
  let skipped = 0;
  for (const test of testModule.children.allTests()) {
    if (test.result().state === 'skipped') skipped++;
  }
  return skipped;
}

/** `.only` in a module's source: it marks the module's other tests skipped, like a filter. */
function declaresOnly(testModule) {
  const flag = testModule.task?.containsOnly; // Vitest 5 rolls it up on the file
  if (typeof flag === 'boolean') return flag;
  try {
    return /\b(?:it|test|describe|suite)(?:\.\w+)*\.only\b/.test(
      readFileSync(testModule.moduleId, 'utf8'),
    );
  } catch {
    return true;
  }
}

/** Whether a run narrowed the tests inside files: `-t`, `--tags-filter`. */
function filteredByConfig(config) {
  if (!config) return false;
  return (
    !!config.testNamePattern || (Array.isArray(config.tagsFilter) && config.tagsFilter.length > 0)
  );
}

/**
 * Whether a module's freezes may be replaced by this run (ticket qits-1947): nothing failed, and
 * every test that did not pass was skipped by its own declaration. The run must not have narrowed
 * the tests inside the module (`-t`, tags, lines, ids, `.only`), because that marks the other tests
 * skipped too, and their freezes would be deleted. Unlike {@link complete}, a spec with a
 * permanent `it.skip` still freezes its passing shots.
 */
export function completeForFreezes(testModule, { filtered = false } = {}) {
  if (filtered) return false;
  const state = testModule.state();
  if (state !== 'passed' && state !== 'skipped') return false;
  if ((testModule.errors?.() ?? []).length > 0) return false;
  if (filteredByConfig(testModule.project?.config)) return false;
  if (declaresOnly(testModule)) return false;
  for (const test of testModule.children.allTests()) {
    const result = test.result();
    if (result.state === 'passed') continue;
    // With every filter ruled out, a skipped test skipped itself: `it.skip`, `it.todo`, a false
    // `skipIf`/`runIf`, `ctx.skip()`. Failed or pending (never ran) is not complete.
    if (result.state !== 'skipped') return false;
  }
  return true;
}

/**
 * @param {{ record?: string,
 *   freezes?: boolean | { dir?: string, routeSpecs?: RegExp, routes?: string } }} [options]
 *   `record`: the file to write, relative to the project root (default
 *   `node_modules/.cache/@qits/angular/screenshot-references.json`). `freezes`: write the screenshot
 *   freezes too, to `dir` (default `src/testing/browser/freezes`), naming the route for the specs
 *   `routeSpecs` matches (default the page and layout specs under `src/app/routes/`,
 *   `DEFAULT_ROUTE_SPECS`); `routes` is the routes directory the manifest's declared outcomes are
 *   scoped by (default `src/app/routes`).
 */
export function screenshotReferences(options = {}) {
  const recordOption = options.record ?? DEFAULT_RECORD;
  const freezeOptions =
    options.freezes === true ? {} : options.freezes ? options.freezes : undefined;
  let freezes;
  /** spec path (relative, posix) → Set of reference paths (relative, posix) */
  const seen = new Map();
  let root;
  let screenshotDirectory = DEFAULT_SCREENSHOT_DIRECTORY;
  let reporterAdded = false;
  let vitestInstance;
  /** Module ids the run narrowed itself (a spec with lines, ids, a name pattern or tags). */
  let narrowed = new Set();

  /** The writer, made with the root configureVitest saw (or, failing that, the command's project's). */
  const writerFor = (context) =>
    (freezes ??= freezeWriter({ root: root ?? context.project.config.root, ...freezeOptions }));
  const freezeCommands = freezeOptions && {
    [FREEZE_COMMAND]: (context, payload) => {
      writerFor(context).add(context.testPath, payload);
      return null;
    },
    [FREEZE_ROUTES_COMMAND]: (context, routes) => {
      writerFor(context).setRoutes(routes);
      return null;
    },
    [OUTCOMES_COMMAND]: (context, records) => {
      writerFor(context).addOutcomes(context.testPath, records);
      return null;
    },
    [FREEZE_COLOR_SCHEME_COMMAND]: emulateColorScheme,
  };

  const reporter = {
    onTestRunStart(specifications = []) {
      seen.clear();
      freezes?.start();
      narrowed = new Set();
      for (const spec of specifications) {
        if (
          spec.testLines?.length ||
          spec.testIds?.length ||
          spec.testNamePattern ||
          spec.testTagsFilter
        ) {
          narrowed.add(spec.moduleId);
        }
      }
    },
    onTestRunEnd(testModules) {
      if (root === undefined) return;
      const runFiltered =
        filteredByConfig(vitestInstance?.config) ||
        filteredByConfig(vitestInstance?.configOverride);
      const forFreezes = (testModule) =>
        completeForFreezes(testModule, {
          filtered: runFiltered || narrowed.has(testModule.moduleId),
        });
      const specs = {};
      for (const testModule of testModules) {
        const spec = toPosix(relative(root, testModule.moduleId));
        const passed = complete(testModule);
        specs[spec] = {
          sha256: fileHash(testModule.moduleId),
          complete: passed,
          // Every test that did not pass skipped itself (ticket qits-2107): the orphan check judges
          // the references those tests cannot own, and leaves the rest to them.
          ...(!passed && forFreezes(testModule) ? { skipped: skippedTests(testModule) } : {}),
          references: [...(seen.get(spec) ?? [])].sort(),
        };
      }
      // The colour schemes this run's freeze payloads carried, read before the freezes are written.
      const runSchemes = freezes?.colorSchemes();
      const colorSchemes =
        runSchemes === undefined
          ? {}
          : { colorSchemes: runSchemes && runSchemes.map((scheme) => scheme.toLowerCase()) };
      const file = isAbsolute(recordOption) ? recordOption : join(root, recordOption);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify({ version: RECORD_VERSION, screenshotDirectory, ...colorSchemes, specs }, null, 2)}\n`,
      );
      freezes?.end(testModules, forFreezes);
    },
  };

  return {
    name: 'qits:screenshot-references',
    // The freeze commands are registered in the config, before any server starts: Vitest 5 copies
    // `browser.commands` once, when it makes the browser server, and that happens before the
    // configureVitest hooks run (Vitest 4 read them later). Vite merges this into the user's
    // `test.browser.commands`, so the app's own commands stay. With the Angular builder, the
    // runnerConfig's plugins become the test project's plugins, so this runs for that project.
    config() {
      if (!freezeCommands) return undefined;
      return { test: { browser: { commands: { ...freezeCommands } } } };
    },
    configureVitest({ vitest, project }) {
      const browser = project.config.browser;
      if (!browser?.enabled) return;
      root ??= project.config.root;
      vitestInstance ??= vitest;
      screenshotDirectory = browser.screenshotDirectory ?? DEFAULT_SCREENSHOT_DIRECTORY;

      browser.expect ??= {};
      const matcher = (browser.expect.toMatchScreenshot ??= {});
      const inner = matcher.resolveScreenshotPath ?? vitestDefault;
      if (!inner[WRAPPED]) {
        const wrapped = (data) => {
          const path = inner(data);
          const spec = toPosix(join(data.testFileDirectory, data.testFileName));
          const references = seen.get(spec) ?? new Set();
          references.add(toPosix(relative(data.root, path)));
          seen.set(spec, references);
          return path;
        };
        wrapped[WRAPPED] = true;
        matcher.resolveScreenshotPath = wrapped;
      }

      if (freezeCommands) {
        freezes ??= freezeWriter({ root, ...freezeOptions });
        // Already there from config(), unless the plugin was added past the config hooks.
        browser.commands ??= {};
        for (const [name, command] of Object.entries(freezeCommands)) {
          browser.commands[name] ??= command;
        }
      }

      // Vitest builds its reporters from the resolved config after every configureVitest hook.
      if (!reporterAdded) {
        reporterAdded = true;
        vitest.config.reporters.push(reporter);
      }
    },
  };
}
