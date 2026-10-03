/**
 * `qits-angular screenshots --check | --prune`: finds the reference screenshots that no screenshot
 * test uses (see `orphans.mjs`).
 *
 * - `--check` lists them and exits 1. In an update run (`UPDATE_SNAPSHOT` set, as Vitest reads it)
 *   it only lists them: that run's job prunes them next.
 * - `--prune` deletes them. Only the platform's screenshot baselines job runs it.
 */
import { resolve } from 'node:path';
import { DEFAULT_RECORD } from './record.mjs';
import { findOrphans, pruneOrphans } from './orphans.mjs';

export const USAGE = `Usage: qits-angular screenshots --check | --prune [options]

Finds reference screenshots (__screenshots__/) that no screenshot test uses.
A reference whose spec file is gone is found without a test run. A reference
whose spec exists is judged by the record of the last browser run, written by
screenshotReferences() from @qits/angular/screenshots: only a spec in which
every test ran and passed, and that has not changed since, is judged.

  --check          List the orphans; exit 1 if there are any.
  --prune          Delete the orphans (the screenshot baselines job does this).
  --root <dir>     The project root (default: the current directory).
  --record <file>  The record (default: ${DEFAULT_RECORD}).
  --verbose        Also list the specs that were not judged, and why.
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
