/**
 * `qits-angular screenshots --check | --prune`: finds the reference screenshots that no screenshot
 * test uses (see `orphans.mjs`).
 *
 * - `--check` lists them and exits 1. In an update run (`UPDATE_SNAPSHOT` set, as Vitest reads it)
 *   it only lists them: that run's job prunes them next.
 * - `--prune` deletes them. Only the platform's screenshot baselines job runs it.
 *
 * `--check` also holds the app's `outcomes()` declarations against the freeze manifest (ticket
 * qits-2003, `outcomes.mjs`), and every checked route against the declared exits (ticket qits-2049):
 * a route no exit leads to, and that is not itself declared an entry point
 * (`data: QITS_ENTRY` / `data: { qitsEntry: true }`, `manifest.routes[].entry`), is named too. Those
 * gaps are report-only unless `--enforce-outcomes` is given, so an app adopts the check page by
 * page; an update run only lists them, as it does the orphans.
 *
 * With a manifest that records `colorSchemes` (ticket qits-2083, `freezeScreenshots({ colorSchemes
 * })`), `--check` also fails on every page or layout shot missing one of them that it did not opt
 * out of (`colorSchemeGaps()` in `freezes.mjs`). That is not an outcome gap: it fails without
 * `--enforce-outcomes`, and only an update run lists it instead.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_RECORD } from './record.mjs';
import { findOrphans, pruneOrphans } from './orphans.mjs';
import { DEFAULT_FREEZE_DIRECTORY, MANIFEST, colorSchemeGaps } from './freezes.mjs';
import { checkedRoutes, DEFAULT_ROUTES, declaredOutcomes, outcomeGaps } from './outcomes.mjs';

export const USAGE = `Usage: qits-angular screenshots --check | --prune [options]

Finds reference screenshots (__screenshots__/) that no screenshot test uses.
A reference whose spec file is gone is found without a test run. A reference
whose spec exists is judged by the record of the last browser run, written by
screenshotReferences() from @qits/angular/screenshots: only a spec in which
every test ran and passed, and that has not changed since, is judged.

--check also reads the outcomes() declarations from the source and the
freeze manifest, and names each declared outcome no browser test reaches,
each stay no screenshot follows, each outcome whose trigger no screenshot
shows, each outcomes() call it cannot read, and each route (manifest.routes,
a page or layout with no children, no redirectTo, path other than '**') that
no declared exit leads to and that is not itself declared an entry point
(route data: QITS_ENTRY). These gaps are report-only unless --enforce-outcomes
is given.

When the manifest records colorSchemes (freezeScreenshots({ colorSchemes })),
--check also fails on each page or layout shot (spec, test, name, viewport)
missing one of those schemes, unless it opted out with its own colorSchemes
and a reason.

  --check              List the orphans; exit 1 if there are any.
  --prune              Delete the orphans (the screenshot baselines job does this).
  --root <dir>         The project root (default: the current directory).
  --record <file>      The record (default: ${DEFAULT_RECORD}).
  --freezes <dir>      The freeze directory holding manifest.json
                       (default: ${DEFAULT_FREEZE_DIRECTORY}).
  --routes <dir>       The routes directory the outcomes are scoped by
                       (default: ${DEFAULT_ROUTES}).
  --enforce-outcomes   Exit 1 on an outcome gap too.
  --verbose            Also list the specs that were not judged, and why.
`;

const REASON = {
  'spec-gone': (orphan) => `its spec ${orphan.spec} is gone`,
  'no-spec': () => 'it is in no spec directory',
  unused: (orphan) => `${orphan.spec} takes no screenshot with this name`,
};

/** An update run, as Vitest sees it: `UPDATE_SNAPSHOT` set to anything but `none`. */
const isUpdateRun = (env) => !!env.UPDATE_SNAPSHOT && env.UPDATE_SNAPSHOT !== 'none';

/**
 * Runs the command. `args` are the arguments after `screenshots`. Returns the exit code.
 *
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string | undefined>,
 *   out?: (line: string) => void, err?: (line: string) => void }} [io]
 */
export function screenshots(args, io = {}) {
  const out = io.out ?? ((line) => console.log(line));
  const err = io.err ?? ((line) => console.error(line));
  const env = io.env ?? process.env;
  let mode;
  let root = io.cwd ?? process.cwd();
  let record = DEFAULT_RECORD;
  let freezes = DEFAULT_FREEZE_DIRECTORY;
  let routes = DEFAULT_ROUTES;
  let enforceOutcomes = false;
  let verbose = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--check' || arg === '--prune') {
      if (mode && mode !== arg) {
        err('qits-angular screenshots: give --check or --prune, not both');
        return 2;
      }
      mode = arg;
    } else if (arg === '--root' && i + 1 < args.length) root = resolve(root, args[++i]);
    else if (arg === '--record' && i + 1 < args.length) record = args[++i];
    else if (arg === '--freezes' && i + 1 < args.length) freezes = args[++i];
    else if (arg === '--routes' && i + 1 < args.length) routes = args[++i];
    else if (arg === '--enforce-outcomes') enforceOutcomes = true;
    else if (arg === '--verbose') verbose = true;
    else if (arg === '--help' || arg === '-h') {
      out(USAGE);
      return 0;
    } else {
      err(`qits-angular screenshots: unknown argument ${arg}\n\n${USAGE}`);
      return 2;
    }
  }
  if (!mode) {
    err(USAGE);
    return 2;
  }

  const orphanCode = checkOrphans({ mode, root, record, verbose, env, out, err });
  if (mode === '--prune') return orphanCode;
  const outcomeCode = checkOutcomes({ root, freezes, routes, enforceOutcomes, env, out, err });
  const schemeCode = checkColorSchemes({ root, freezes, env, out, err });
  return Math.max(orphanCode, outcomeCode, schemeCode);
}

/**
 * The page and layout shots missing a colour scheme the manifest records (ticket qits-2083), on
 * stderr with exit 1; nothing at all for a manifest without `colorSchemes` (or none). An update run
 * only lists them: its job writes the freezes that close them.
 */
function checkColorSchemes({ root, freezes, env, out, err }) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(resolve(root, freezes), MANIFEST), 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(manifest?.colorSchemes)) return 0;
  const gaps = colorSchemeGaps(manifest);
  if (gaps.length === 0) {
    out(
      'qits-angular screenshots: every page and layout shot is taken in each colour scheme ' +
        `(${manifest.colorSchemes.join(', ')}) or says why not.`,
    );
    return 0;
  }
  const report = [
    `qits-angular screenshots: ${gaps.length} page or layout shot(s) miss a colour scheme:`,
    ...gaps.map((gap) => `  ${gap}`),
  ];
  if (isUpdateRun(env)) {
    out(
      [...report, 'This is an update run (UPDATE_SNAPSHOT): the gaps are listed only.'].join('\n'),
    );
    return 0;
  }
  err(
    [
      ...report,
      'Run the spec with freezeScreenshots({ colorSchemes }) so each shot is frozen in every',
      "scheme, or leave a scheme out on the shot with { colorSchemes: ['LIGHT'], reason: '…' }.",
    ].join('\n'),
  );
  return 1;
}

function checkOrphans({ mode, root, record, verbose, env, out, err }) {
  const { orphans, unchecked, recordProblem } = findOrphans({ root, record });

  if (recordProblem) {
    out(
      `qits-angular screenshots: ${recordProblem}, so only references of deleted specs are checked.`,
    );
  } else if (unchecked.length > 0) {
    out(
      `qits-angular screenshots: ${unchecked.length} spec(s) not judged by screenshot name` +
        (verbose ? ':' : ' (--verbose lists them).'),
    );
  }
  if (verbose) for (const { spec, why } of unchecked) out(`  ${spec}: ${why}`);

  if (orphans.length === 0) {
    out('qits-angular screenshots: every reference screenshot belongs to a screenshot test.');
    return 0;
  }

  if (mode === '--prune') {
    pruneOrphans(root, orphans);
    out(`qits-angular screenshots: deleted ${orphans.length} reference(s) no test uses:`);
    for (const orphan of orphans) out(`  ${orphan.path} (${REASON[orphan.reason](orphan)})`);
    return 0;
  }

  const report = [
    `qits-angular screenshots: ${orphans.length} reference screenshot(s) belong to no screenshot test:`,
    ...orphans.map((orphan) => `  ${orphan.path}\n    ${REASON[orphan.reason](orphan)}`),
  ];
  if (isUpdateRun(env)) {
    out(
      [...report, 'This is an update run (UPDATE_SNAPSHOT): its job deletes them (--prune).'].join(
        '\n',
      ),
    );
    return 0;
  }
  err(
    [
      ...report,
      'Do not delete them by hand: only the platform writes __screenshots__/. Run the screenshot',
      'baselines job for your release request; its commit deletes them:',
      '  qits maintenance --project <project> --repository <repository> screenshot-baselines --request <id>',
    ].join('\n'),
  );
  return 1;
}

/**
 * The outcome gaps (`outcomes.mjs`), on stderr; nothing at all for an app that declares no
 * outcome. Exit 1 only with `--enforce-outcomes`, and never in an update run.
 */
function checkOutcomes({ root, freezes, routes, enforceOutcomes, env, out, err }) {
  let gaps;
  let declared;
  let manifest;
  try {
    const read = declaredOutcomes({ root, routes });
    declared = read.declared;
    if (read.declared.length === 0 && read.unreadable.length === 0) return 0;
    const manifestPath = join(resolve(root, freezes), MANIFEST);
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      manifest = undefined;
    }
    gaps = outcomeGaps({ ...read, manifest });
    if (manifest === undefined && read.declared.length > 0) {
      gaps.unshift(
        `no freeze manifest at ${freezes}/${MANIFEST}: run the browser tests with ` +
          'screenshotReferences({ freezes: true }) and recordOutcomes().',
      );
    }
  } catch (error) {
    gaps = [error.message];
    declared = [];
  }

  if (gaps.length === 0) {
    out(
      `qits-angular screenshots: every declared outcome (${declared.length}) is reached by a test ` +
        `and its trigger is shown, and every route (${checkedRoutes(manifest).length}) is led to ` +
        'or an entry point.',
    );
    return 0;
  }
  const lines = gaps.map((gap) => `  ${gap}`);
  if (isUpdateRun(env)) {
    out(
      [
        `qits-angular screenshots: ${gaps.length} outcome gap(s):`,
        ...lines,
        'This is an update run (UPDATE_SNAPSHOT): the gaps are listed only.',
      ].join('\n'),
    );
    return 0;
  }
  if (!enforceOutcomes) {
    err(
      [
        `qits-angular screenshots: ${gaps.length} outcome gap(s), report-only (they fail the check ` +
          'with --enforce-outcomes):',
        ...lines,
      ].join('\n'),
    );
    return 0;
  }
  err([`qits-angular screenshots: ${gaps.length} outcome gap(s):`, ...lines].join('\n'));
  return 1;
}
