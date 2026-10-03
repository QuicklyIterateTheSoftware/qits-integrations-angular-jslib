// node --test: the screenshot record, the orphan finder and the CLI, on throwaway app trees under
// <repo>/tmp (git-ignored). The plugin is driven with stand-ins for Vitest's objects here; the
// real Vitest run is in vitest-run.test.mjs (pnpm test:browser, needs Chromium).
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { screenshots } from '../cli.mjs';
import { findOrphans, pruneOrphans, screenshotReferences } from '../index.mjs';
import { DEFAULT_RECORD, fileHash } from '../record.mjs';

mkdirSync('tmp', { recursive: true });
const base = mkdtempSync(join(process.cwd(), 'tmp', 'screenshots-'));
after(() => rmSync(base, { recursive: true, force: true }));

let apps = 0;
/** A fresh app tree with `files` (path → content). */
function app(files) {
  const root = join(base, `app-${++apps}`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const SPEC = 'src/app/card/card.browser.spec.ts';
const shot = (spec, name) => {
  const slash = spec.lastIndexOf('/');
  return `${spec.slice(0, slash)}/__screenshots__/${spec.slice(slash + 1)}/${name}-chromium-linux.png`;
};

/** Writes the record a run would write: `specs` maps a spec to its references (or options). */
function writeRecord(root, specs, path = DEFAULT_RECORD) {
  const record = { version: 1, screenshotDirectory: '__screenshots__', specs: {} };
  for (const [spec, entry] of Object.entries(specs)) {
    const {
      references,
      complete = true,
      sha256 = fileHash(join(root, spec)),
    } = Array.isArray(entry) ? { references: entry } : entry;
    record.specs[spec] = { sha256, complete, references };
  }
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(record));
}

describe('findOrphans', () => {
  it('finds the references of a deleted spec without a record', () => {
    const root = app({
      [SPEC]: 'spec',
      [shot(SPEC, 'card')]: 'png',
      [shot('src/app/gone/gone.browser.spec.ts', 'a')]: 'png',
      [shot('src/app/gone/gone.browser.spec.ts', 'b')]: 'png',
    });
    const { orphans, unchecked, recordProblem } = findOrphans({ root, record: DEFAULT_RECORD });
    assert.deepEqual(
      orphans.map((o) => [o.path, o.reason, o.spec]),
      [
        [
          shot('src/app/gone/gone.browser.spec.ts', 'a'),
          'spec-gone',
          'src/app/gone/gone.browser.spec.ts',
        ],
        [
          shot('src/app/gone/gone.browser.spec.ts', 'b'),
          'spec-gone',
          'src/app/gone/gone.browser.spec.ts',
        ],
      ],
    );
    assert.deepEqual(unchecked, [{ spec: SPEC, why: 'no recorded browser run' }]);
    assert.equal(recordProblem, 'no recorded browser run');
  });

  it('finds a reference the recorded run did not ask for, and keeps the ones it did', () => {
    const root = app({
      [SPEC]: 'spec',
      [shot(SPEC, 'card')]: 'png',
      [shot(SPEC, 'card-old-name')]: 'png',
      [shot(SPEC, 'menu/open')]: 'png',
    });
    writeRecord(root, { [SPEC]: [shot(SPEC, 'card'), shot(SPEC, 'menu/open')] });
    const { orphans, unchecked } = findOrphans({ root, record: DEFAULT_RECORD });
    assert.deepEqual(orphans, [
      {
        path: shot(SPEC, 'card-old-name'),
        directory: 'src/app/card/__screenshots__',
        spec: SPEC,
        reason: 'unused',
      },
    ]);
    assert.deepEqual(unchecked, []);
  });

  it('does not judge a spec that did not pass completely, changed, or did not run', () => {
    const other = 'src/app/list/list.browser.spec.ts';
    const third = 'src/app/tree/tree.browser.spec.ts';
    const root = app({
      [SPEC]: 'spec',
      [other]: 'spec',
      [third]: 'spec',
      [shot(SPEC, 'old')]: 'png',
      [shot(other, 'old')]: 'png',
      [shot(third, 'old')]: 'png',
    });
    writeRecord(root, {
      [SPEC]: { references: [], complete: false },
      [other]: { references: [], sha256: 'a different file' },
    });
    const { orphans, unchecked } = findOrphans({ root, record: DEFAULT_RECORD });
    assert.deepEqual(orphans, []);
    assert.deepEqual(unchecked, [
      { spec: SPEC, why: 'not every test in it passed in the recorded browser run' },
      { spec: other, why: 'it changed since the recorded browser run' },
      { spec: third, why: 'the recorded browser run did not run it' },
    ]);
  });

  it('finds a file that lies directly in a screenshot directory', () => {
    const root = app({ 'src/app/__screenshots__/stray.png': 'png' });
    const { orphans } = findOrphans({ root, record: DEFAULT_RECORD });
    assert.deepEqual(
      orphans.map((o) => [o.path, o.reason]),
      [['src/app/__screenshots__/stray.png', 'no-spec']],
    );
  });

  it('does not search node_modules, dist or dot-directories', () => {
    const root = app({
      [shot('node_modules/x/x.browser.spec.ts', 'a')]: 'png',
      [shot('dist/x/x.browser.spec.ts', 'a')]: 'png',
      [shot('.angular/x/x.browser.spec.ts', 'a')]: 'png',
    });
    assert.deepEqual(findOrphans({ root, record: DEFAULT_RECORD }).orphans, []);
  });

  it('reads a record from another path, and says when it is not JSON or of another version', () => {
    const root = app({ [SPEC]: 'spec', [shot(SPEC, 'old')]: 'png', 'bad.json': '{' });
    writeRecord(root, { [SPEC]: [] }, 'out/record.json');
    assert.equal(findOrphans({ root, record: 'out/record.json' }).orphans.length, 1);
    assert.match(findOrphans({ root, record: 'bad.json' }).recordProblem, /not JSON/);
    writeFileSync(join(root, 'v2.json'), JSON.stringify({ version: 2, specs: {} }));
    assert.match(findOrphans({ root, record: 'v2.json' }).recordProblem, /another version/);
  });
});

describe('pruneOrphans', () => {
  it('deletes the orphans and the directories they leave empty, and nothing else', () => {
    const gone = 'src/app/gone/gone.browser.spec.ts';
    const root = app({
      [SPEC]: 'spec',
      [shot(SPEC, 'card')]: 'png',
      [shot(SPEC, 'old/nested')]: 'png',
      [shot(gone, 'a')]: 'png',
      'src/app/gone/README.md': 'kept',
    });
    writeRecord(root, { [SPEC]: [shot(SPEC, 'card')] });
    pruneOrphans(root, findOrphans({ root, record: DEFAULT_RECORD }).orphans);
    assert.ok(existsSync(join(root, shot(SPEC, 'card'))));
    assert.ok(!existsSync(join(root, 'src/app/card/__screenshots__/card.browser.spec.ts/old')));
    assert.ok(!existsSync(join(root, 'src/app/gone/__screenshots__')));
    assert.ok(existsSync(join(root, 'src/app/gone/README.md')));
    assert.deepEqual(findOrphans({ root, record: DEFAULT_RECORD }).orphans, []);
  });
});

describe('qits-angular screenshots', () => {
  const run = (root, args, env = {}) => {
    const out = [];
    const err = [];
    const code = screenshots(args, {
      cwd: root,
      env,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('--check fails on an orphan, names it and tells the fix', () => {
    const root = app({ [shot('src/app/gone/gone.browser.spec.ts', 'a')]: 'png' });
    const { code, err, out } = run(root, ['--check']);
    assert.equal(code, 1);
    assert.match(err, /1 reference screenshot\(s\) belong to no screenshot test/);
    assert.match(err, /gone\.browser\.spec\.ts\/a-chromium-linux\.png/);
    assert.match(err, /its spec src\/app\/gone\/gone\.browser\.spec\.ts is gone/);
    assert.match(err, /Do not delete them by hand/);
    assert.match(err, /screenshot-baselines --request/);
    assert.match(out, /only references of deleted specs are checked/);
    assert.ok(existsSync(join(root, shot('src/app/gone/gone.browser.spec.ts', 'a'))));
  });

  it('--check passes when every reference is used', () => {
    const root = app({ [SPEC]: 'spec', [shot(SPEC, 'card')]: 'png' });
    writeRecord(root, { [SPEC]: [shot(SPEC, 'card')] });
    const { code, out } = run(root, ['--check']);
    assert.equal(code, 0);
    assert.match(out, /every reference screenshot belongs to a screenshot test/);
  });

  it('--check only lists the orphans in an update run', () => {
    const root = app({ [shot('src/app/gone/gone.browser.spec.ts', 'a')]: 'png' });
    assert.equal(run(root, ['--check'], { UPDATE_SNAPSHOT: 'all' }).code, 0);
    assert.equal(run(root, ['--check'], { UPDATE_SNAPSHOT: 'none' }).code, 1);
  });

  it('--prune deletes the orphans', () => {
    const root = app({ [SPEC]: 'spec', [shot(SPEC, 'card')]: 'png', [shot(SPEC, 'old')]: 'png' });
    writeRecord(root, { [SPEC]: [shot(SPEC, 'card')] });
    const { code, out } = run(root, ['--prune']);
    assert.equal(code, 0);
    assert.match(out, /deleted 1 reference\(s\)/);
    assert.ok(!existsSync(join(root, shot(SPEC, 'old'))));
    assert.ok(existsSync(join(root, shot(SPEC, 'card'))));
  });

  it('--verbose lists the specs it did not judge', () => {
    const root = app({ [SPEC]: 'spec', [shot(SPEC, 'card')]: 'png' });
    writeRecord(root, {});
    const { out } = run(root, ['--check', '--verbose']);
    assert.match(out, /card\.browser\.spec\.ts: the recorded browser run did not run it/);
  });

  it('refuses a missing mode, both modes, and an unknown argument', () => {
    const root = app({});
    assert.equal(run(root, []).code, 2);
    assert.equal(run(root, ['--check', '--prune']).code, 2);
    assert.equal(run(root, ['--check', '--nope']).code, 2);
  });
});

describe('screenshotReferences', () => {
  /** Stand-ins for what Vitest hands the plugin and the reporter. */
  function vitestLike(root, browser = { enabled: true }) {
    const vitest = { config: { reporters: [] } };
    const project = { config: { root, browser } };
    return { vitest, project };
  }
  const data = (root, spec, arg) => ({
    arg,
    ext: '.png',
    root,
    platform: 'linux',
    screenshotDirectory: '__screenshots__',
    testFileDirectory: dirname(spec),
    testFileName: spec.slice(spec.lastIndexOf('/') + 1),
    browserName: 'chromium',
  });
  const module = (root, spec, states, moduleState = 'passed') => ({
    moduleId: join(root, spec),
    state: () => moduleState,
    errors: () => [],
    children: { allTests: () => states.map((state) => ({ result: () => ({ state }) })) },
  });

  it('records every resolved reference per spec and writes the record at the end of the run', () => {
    const other = 'src/app/list/list.browser.spec.ts';
    const root = app({ [SPEC]: 'spec', [other]: 'spec' });
    const { vitest, project } = vitestLike(root);
    const plugin = screenshotReferences();
    plugin.configureVitest({ vitest, project });
    plugin.configureVitest({ vitest, project }); // a second project: wrapped and added once

    assert.equal(vitest.config.reporters.length, 1);
    const [reporter] = vitest.config.reporters;
    const resolvePath = project.config.browser.expect.toMatchScreenshot.resolveScreenshotPath;

    reporter.onTestRunStart();
    assert.equal(resolvePath(data(root, SPEC, 'b')), join(root, shot(SPEC, 'b')));
    resolvePath(data(root, SPEC, 'a'));
    resolvePath(data(root, SPEC, 'a'));
    resolvePath(data(root, other, 'x'));
    reporter.onTestRunEnd([
      module(root, SPEC, ['passed', 'passed']),
      module(root, other, ['passed', 'skipped']),
    ]);

    const record = JSON.parse(readFileSync(join(root, DEFAULT_RECORD), 'utf8'));
    assert.deepEqual(record, {
      version: 1,
      screenshotDirectory: '__screenshots__',
      specs: {
        [SPEC]: {
          sha256: fileHash(join(root, SPEC)),
          complete: true,
          references: [shot(SPEC, 'a'), shot(SPEC, 'b')],
        },
        [other]: {
          sha256: fileHash(join(root, other)),
          complete: false,
          references: [shot(other, 'x')],
        },
      },
    });
  });

  it('starts every run afresh and marks a failed module incomplete', () => {
    const root = app({ [SPEC]: 'spec' });
    const { vitest, project } = vitestLike(root);
    screenshotReferences({ record: 'out/r.json' }).configureVitest({ vitest, project });
    const [reporter] = vitest.config.reporters;
    const resolvePath = project.config.browser.expect.toMatchScreenshot.resolveScreenshotPath;
    resolvePath(data(root, SPEC, 'stale'));
    reporter.onTestRunStart();
    reporter.onTestRunEnd([module(root, SPEC, ['passed'], 'failed')]);
    const record = JSON.parse(readFileSync(join(root, 'out/r.json'), 'utf8'));
    assert.deepEqual(record.specs[SPEC].references, []);
    assert.equal(record.specs[SPEC].complete, false);
  });

  it("wraps the app's own resolver, and keeps its screenshot directory", () => {
    const root = app({});
    const own = ({ root: r, testFileName, arg }) => join(r, 'shots', testFileName, `${arg}.png`);
    const { vitest, project } = vitestLike(root, {
      enabled: true,
      screenshotDirectory: 'shots',
      expect: { toMatchScreenshot: { resolveScreenshotPath: own } },
    });
    screenshotReferences().configureVitest({ vitest, project });
    const [reporter] = vitest.config.reporters;
    reporter.onTestRunStart();
    const resolvePath = project.config.browser.expect.toMatchScreenshot.resolveScreenshotPath;
    assert.equal(
      resolvePath(data(root, SPEC, 'a')),
      join(root, 'shots/card.browser.spec.ts/a.png'),
    );
    reporter.onTestRunEnd([module(root, SPEC, ['passed'])]);
    const record = JSON.parse(readFileSync(join(root, DEFAULT_RECORD), 'utf8'));
    assert.equal(record.screenshotDirectory, 'shots');
    assert.deepEqual(record.specs[SPEC].references, ['shots/card.browser.spec.ts/a.png']);
  });

  it('leaves a project without browser mode alone', () => {
    const root = app({});
    const { vitest, project } = vitestLike(root, { enabled: false });
    screenshotReferences().configureVitest({ vitest, project });
    assert.equal(vitest.config.reporters.length, 0);
    assert.equal(project.config.browser.expect, undefined);
  });
});
