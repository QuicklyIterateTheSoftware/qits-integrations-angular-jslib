// node --test: the screenshot record, the orphan finder and the CLI, on throwaway app trees under
// <repo>/tmp (git-ignored). The plugin is driven with stand-ins for Vitest's objects here; the
// real Vitest run is in vitest-run.test.mjs (pnpm test:browser, needs Chromium).
import { after, describe, it } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { screenshots } from '../cli.mjs';
import {
  COLOR_SCHEMES,
  FREEZE_COLOR_SCHEME_COMMAND,
  RESET_COLOR_SCHEME,
  colorSchemeGaps,
  completeForFreezes,
  declaredOutcomes,
  findOrphans,
  freezeFile,
  freezeSlug,
  pruneOrphans,
  screenshotReferences,
} from '../index.mjs';
import { DEFAULT_RECORD, fileHash } from '../record.mjs';
import { emulateColorScheme } from '../plugin.mjs';
import {
  checkedRoutes,
  forwardRoutes,
  libraryOutcomes,
  outcomeGaps,
  pageRoutes,
  readOutcomes,
} from '../outcomes.mjs';
import {
  LIBRARY_OUTCOMES,
  REGENERATE,
  libraryOutcomesText,
} from '../../../../scripts/library-outcomes.mjs';

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

describe('screenshot freezes', () => {
  const PAGE = 'src/app/routes/projects/projects.page.browser.spec.ts';
  const CARD = 'src/app/ui/card/card.browser.spec.ts';
  const DIR = 'src/testing/browser/freezes';
  /** A module stand-in: `state` for the module, `tests` the states of its tests. */
  const module = (root, spec, state = 'passed', tests = [state]) => ({
    moduleId: join(root, spec),
    state: () => state,
    errors: () => [],
    children: { allTests: () => tests.map((t) => ({ result: () => ({ state: t }) })) },
  });
  /** A run: `shots` maps a spec to the freezes it sends (name → html), `modules` its outcomes. */
  function run(
    root,
    { shots = {}, modules, routes, options = { freezes: true }, config = {}, specifications = [] },
  ) {
    const vitest = { config: { reporters: [], ...config } };
    const project = { config: { root, browser: { enabled: true } } };
    screenshotReferences(options).configureVitest({ vitest, project });
    const [reporter] = vitest.config.reporters;
    const { qitsFreeze, qitsFreezeRoutes } = project.config.browser.commands;
    reporter.onTestRunStart(specifications);
    if (routes) qitsFreezeRoutes({}, routes);
    for (const [spec, freezes] of Object.entries(shots)) {
      for (const [name, html] of Object.entries(freezes)) {
        const records = [{ provider: 'qits-projects-service', state: 's', operationId: 'op' }];
        qitsFreeze(
          { testPath: join(root, spec) },
          {
            name,
            test: `t ${name}`,
            html,
            route: 'projects',
            records,
            assets: [],
          },
        );
      }
    }
    reporter.onTestRunEnd(modules ?? Object.keys(shots).map((spec) => module(root, spec)));
    return project;
  }
  const manifest = (root, dir = DIR) =>
    JSON.parse(readFileSync(join(root, dir, 'manifest.json'), 'utf8'));
  const read = (root, path) => readFileSync(join(root, DIR, path), 'utf8');

  it('slugs a name as Vitest slugs a screenshot name', () => {
    assert.equal(freezeSlug('loading'), 'loading');
    assert.equal(freezeSlug('menu/open'), 'menu/open');
    assert.equal(freezeSlug('detail: an epic (2)'), 'detail-an-epic-2');
    assert.equal(freezeSlug('page > lists them 1'), 'page-lists-them-1');
    assert.equal(freezeSlug('../up/x.png'), 'x');
    assert.equal(freezeSlug('/abs/x.jpg'), 'abs/xjpg');
  });

  it("registers the commands in the config hook, beside the app's own", () => {
    const plugin = screenshotReferences({ freezes: true });
    const contributed = plugin.config({ test: { browser: { commands: { own: () => 1 } } } });
    assert.deepEqual(Object.keys(contributed.test.browser.commands), [
      'qitsFreeze',
      'qitsFreezeRoutes',
      'qitsOutcomes',
      'qitsColorScheme',
    ]);
    assert.equal(screenshotReferences().config({}), undefined);
    // configureVitest keeps what the config hook registered.
    const root = app({});
    const vitest = { config: { reporters: [] } };
    const commands = { ...contributed.test.browser.commands, own: () => 1 };
    const project = { config: { root, browser: { enabled: true, commands } } };
    plugin.configureVitest({ vitest, project });
    assert.equal(
      project.config.browser.commands.qitsFreeze,
      contributed.test.browser.commands.qitsFreeze,
    );
    assert.equal(typeof project.config.browser.commands.own, 'function');
  });

  it('registers the commands only with the freezes option', () => {
    const root = app({});
    const vitest = { config: { reporters: [] } };
    const project = { config: { root, browser: { enabled: true } } };
    screenshotReferences().configureVitest({ vitest, project });
    assert.equal(project.config.browser.commands, undefined);
  });

  it('writes each freeze, copies its assets and writes the manifest', () => {
    const root = app({ [PAGE]: 'spec', [CARD]: 'spec', 'src/fonts/inter.woff2': 'font' });
    const font =
      '<style>@font-face { src: url("qits-freeze-asset:/src/fonts/inter.woff2"); }</style>';
    const routes = [{ path: 'projects', fullPath: 'projects' }];
    run(root, {
      routes,
      shots: {
        [PAGE]: { list: `${font}<p>list</p>`, 'menu/open': '<p>menu</p>' },
        [CARD]: { card: '<img src="qits-freeze-asset:/missing.png">' },
      },
    });
    assert.equal(
      read(root, `${PAGE}/list.html`),
      '<style>@font-face { src: url("../../../../../assets/inter.woff2"); }</style><p>list</p>',
    );
    assert.equal(read(root, 'assets/inter.woff2'), 'font');
    // A same-origin URL that is no file under the root keeps its URL.
    assert.equal(read(root, `${CARD}/card.html`), '<img src="/missing.png">');
    const records = [{ provider: 'qits-projects-service', state: 's', operationId: 'op' }];
    const text = read(root, 'manifest.json');
    assert.ok(text.endsWith('}\n'));
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`);
    assert.deepEqual(JSON.parse(text), {
      routes,
      freezes: [
        {
          file: `${PAGE}/list.html`,
          spec: PAGE,
          test: 't list',
          name: 'list',
          kind: null,
          viewport: null,
          route: 'projects',
          records,
          triggers: [],
        },
        {
          file: `${PAGE}/menu/open.html`,
          spec: PAGE,
          test: 't menu/open',
          name: 'menu/open',
          kind: null,
          viewport: null,
          route: 'projects',
          records,
          triggers: [],
        },
        // Not a page spec: no route.
        {
          file: `${CARD}/card.html`,
          spec: CARD,
          test: 't card',
          name: 'card',
          kind: null,
          viewport: null,
          route: null,
          records,
          triggers: [],
        },
      ],
      byRoute: { projects: [`${PAGE}/list.html`, `${PAGE}/menu/open.html`] },
      outcomes: { declared: [], fired: [] },
    });
    assert.deepEqual(Object.keys(JSON.parse(text).freezes[0]), [
      'file',
      'spec',
      'test',
      'name',
      'kind',
      'viewport',
      'route',
      'records',
      'triggers',
    ]);
  });

  it('names the route of the page and layout specs under the routes directory only', () => {
    const LAYOUT = 'src/app/routes/projects/[slug]/work/work.layout.browser.spec.ts';
    const PATTERN = 'src/app/patterns/list/list.page.browser.spec.ts';
    const SHELL = 'src/app/layout/shell/shell.layout.browser.spec.ts';
    const specs = [PAGE, LAYOUT, PATTERN, SHELL];
    const root = app(Object.fromEntries(specs.map((spec) => [spec, 'spec'])));
    run(root, { shots: Object.fromEntries(specs.map((spec) => [spec, { shot: '<p>x</p>' }])) });
    const routes = Object.fromEntries(manifest(root).freezes.map((f) => [f.spec, f.route]));
    assert.deepEqual(routes, {
      [PAGE]: 'projects',
      // A routed layout opens its page through the app's routes (qits-1998).
      [LAYOUT]: 'projects',
      // A pattern spec and the shell's mount stand-in routes.
      [PATTERN]: null,
      [SHELL]: null,
    });
    assert.deepEqual(manifest(root).byRoute, {
      projects: [`${LAYOUT}/shot.html`, `${PAGE}/shot.html`],
    });
  });

  it('replaces only what a run saw completely', () => {
    const gone = 'src/app/gone/gone.browser.spec.ts';
    const root = app({ [PAGE]: 'spec', [CARD]: 'spec', [gone]: 'spec', 'src/a.png': 'png' });
    run(root, {
      routes: [{ path: 'projects', fullPath: 'projects' }],
      shots: {
        [PAGE]: { list: '<p>1</p>', old: '<img src="qits-freeze-asset:/src/a.png">' },
        [CARD]: { card: '<p>1</p>' },
        [gone]: { g: '<p>1</p>' },
      },
    });
    rmSync(join(root, gone));
    // PAGE ran completely without "old"; CARD failed after a changed shot; no routes were sent.
    run(root, {
      shots: { [PAGE]: { list: '<p>2</p>' }, [CARD]: { card: '<p>2</p>' } },
      modules: [module(root, PAGE), module(root, CARD, 'failed')],
    });
    assert.equal(read(root, `${PAGE}/list.html`), '<p>2</p>');
    assert.ok(!existsSync(join(root, DIR, PAGE, 'old.html')));
    assert.equal(read(root, `${CARD}/card.html`), '<p>1</p>');
    assert.ok(!existsSync(join(root, DIR, 'src/app/gone')));
    assert.ok(!existsSync(join(root, DIR, 'assets')), 'an asset no freeze uses is deleted');
    assert.deepEqual(
      manifest(root).freezes.map((f) => f.file),
      [`${PAGE}/list.html`, `${CARD}/card.html`],
    );
    assert.deepEqual(manifest(root).routes, [{ path: 'projects', fullPath: 'projects' }]);
  });

  it('replaces the freezes of a spec whose other tests skip themselves', () => {
    const root = app({ [CARD]: "it.skip('held', () => {});" });
    run(root, { shots: { [CARD]: { a: '<p>1</p>', old: '<p>1</p>' } } });
    run(root, {
      shots: { [CARD]: { a: '<p>2</p>' } },
      modules: [module(root, CARD, 'passed', ['passed', 'skipped'])],
    });
    assert.equal(read(root, `${CARD}/a.html`), '<p>2</p>');
    assert.ok(!existsSync(join(root, DIR, CARD, 'old.html')));
    // A module whose only test is skipped is complete too, and has no shots.
    assert.equal(completeForFreezes(module(root, CARD, 'skipped', ['skipped'])), true);
  });

  it('keeps the freezes of a spec the run narrowed, or that failed or did not finish', () => {
    const narrowedRuns = [
      { config: { testNamePattern: /a/ } },
      { config: { tagsFilter: ['slow'] } },
      { specifications: (root) => [{ moduleId: join(root, CARD), testLines: [3] }] },
      { specifications: (root) => [{ moduleId: join(root, CARD), testIds: ['x'] }] },
      { specifications: (root) => [{ moduleId: join(root, CARD), testNamePattern: /a/ }] },
    ];
    for (const narrowed of narrowedRuns) {
      const root = app({ [CARD]: 'spec' });
      run(root, { shots: { [CARD]: { a: '<p>1</p>', b: '<p>1</p>' } } });
      run(root, {
        ...narrowed,
        specifications: narrowed.specifications?.(root) ?? [],
        shots: { [CARD]: { a: '<p>2</p>' } },
        modules: [module(root, CARD, 'passed', ['passed', 'skipped'])],
      });
      assert.equal(read(root, `${CARD}/a.html`), '<p>1</p>', JSON.stringify(narrowed));
      assert.ok(existsSync(join(root, DIR, CARD, 'b.html')));
    }
    const root = app({ [CARD]: "it.only('a', () => {});", [PAGE]: 'spec' });
    assert.equal(completeForFreezes(module(root, CARD, 'passed', ['passed', 'skipped'])), false);
    assert.equal(completeForFreezes(module(root, PAGE, 'failed', ['passed', 'failed'])), false);
    assert.equal(completeForFreezes(module(root, PAGE, 'passed', ['passed', 'pending'])), false);
    assert.equal(
      completeForFreezes({ ...module(root, PAGE), task: { containsOnly: true } }),
      false,
      "Vitest 5's containsOnly",
    );
    assert.equal(
      completeForFreezes({ ...module(root, CARD), task: { containsOnly: false } }),
      true,
      'containsOnly wins over the source',
    );
    assert.equal(completeForFreezes(module(root, PAGE), { filtered: true }), false);
  });

  // Ticket qits-2046: what each shot says it shows, and the preset width it was taken at.
  /** Sends `payloads` (beside name and test: kind, viewport) for CARD and ends the run. */
  function send(root, payloads, modules) {
    const vitest = { config: { reporters: [] } };
    const project = { config: { root, browser: { enabled: true } } };
    screenshotReferences({ freezes: true }).configureVitest({ vitest, project });
    const [reporter] = vitest.config.reporters;
    reporter.onTestRunStart([]);
    for (const payload of payloads) {
      project.config.browser.commands.qitsFreeze(
        { testPath: join(root, CARD) },
        { test: 't', html: `<p>${payload.name}</p>`, route: null, records: [], ...payload },
      );
    }
    reporter.onTestRunEnd(modules ?? [module(root, CARD)]);
  }

  it('records the kind each shot gave, and null for none or one outside the enum', () => {
    const root = app({ [CARD]: 'spec' });
    send(root, [
      { name: 'data', kind: 'DATA' },
      { name: 'empty', kind: 'NO_DATA' },
      { name: 'waiting', kind: 'PENDING' },
      { name: 'refused', kind: 'ERROR' },
      { name: 'unsaid' },
      { name: 'odd', kind: 'data' },
    ]);
    assert.deepEqual(
      manifest(root).freezes.map((f) => [f.name, f.kind, f.viewport]),
      [
        ['data', 'DATA', null],
        ['empty', 'NO_DATA', null],
        ['odd', null, null],
        ['refused', 'ERROR', null],
        ['unsaid', null, null],
        ['waiting', 'PENDING', null],
      ],
    );
  });

  it('names the freeze of a shot at a preset width <name>-<viewport>.html, the name unchanged', () => {
    const root = app({ [CARD]: 'spec' });
    send(root, [
      ...['PHONE', 'TABLET', 'DESKTOP'].map((viewport) => ({
        name: 'menu/open',
        kind: 'DATA',
        viewport,
      })),
      { name: 'hover', kind: 'DATA', viewport: 'DESKTOP' },
      // A width outside the enum is a shot at the test's own viewport.
      { name: 'own', kind: 'DATA', viewport: 'WATCH' },
    ]);
    assert.deepEqual(
      manifest(root).freezes.map((f) => [f.file, f.name, f.viewport]),
      [
        [`${CARD}/hover-desktop.html`, 'hover', 'DESKTOP'],
        [`${CARD}/menu/open-desktop.html`, 'menu/open', 'DESKTOP'],
        [`${CARD}/menu/open-phone.html`, 'menu/open', 'PHONE'],
        [`${CARD}/menu/open-tablet.html`, 'menu/open', 'TABLET'],
        [`${CARD}/own.html`, 'own', null],
      ],
    );
    assert.equal(read(root, `${CARD}/menu/open-tablet.html`), '<p>menu/open</p>');
    assert.equal(freezeFile(CARD, 'detail: an epic', 'PHONE'), `${CARD}/detail-an-epic-phone.html`);
    assert.equal(freezeFile(CARD, 'detail: an epic'), `${CARD}/detail-an-epic.html`);
  });

  // Ticket qits-2083: the colour scheme each shot was taken in, with freezeScreenshots({ colorSchemes }).
  const BOTH = ['LIGHT', 'DARK'];

  it('names the freeze of a shot in a colour scheme with the scheme last, and records the option', () => {
    const root = app({ [CARD]: 'spec' });
    send(root, [
      ...['PHONE', 'DESKTOP'].flatMap((viewport) =>
        BOTH.map((colorScheme) => ({
          name: 'list',
          kind: 'DATA',
          viewport,
          colorScheme,
          colorSchemes: BOTH,
          colorSchemeReason: null,
        })),
      ),
      // An opt-out: one scheme, its reason recorded; a shot at the test's own viewport.
      {
        name: 'chart',
        kind: 'DATA',
        viewport: null,
        colorScheme: 'LIGHT',
        colorSchemes: BOTH,
        colorSchemeReason: 'no dark palette yet',
      },
      // A scheme outside the enum is no scheme; an empty reason is none.
      {
        name: 'odd',
        kind: 'DATA',
        colorScheme: 'DUSK',
        colorSchemes: BOTH,
        colorSchemeReason: ' ',
      },
    ]);
    const written = manifest(root);
    assert.deepEqual(written.colorSchemes, BOTH);
    assert.deepEqual(Object.keys(written), [
      'routes',
      'colorSchemes',
      'freezes',
      'byRoute',
      'outcomes',
    ]);
    assert.deepEqual(
      written.freezes.map((f) => [f.file, f.name, f.viewport, f.colorScheme, f.colorSchemeReason]),
      [
        [`${CARD}/chart-light.html`, 'chart', null, 'LIGHT', 'no dark palette yet'],
        [`${CARD}/list-desktop-dark.html`, 'list', 'DESKTOP', 'DARK', null],
        [`${CARD}/list-desktop-light.html`, 'list', 'DESKTOP', 'LIGHT', null],
        [`${CARD}/list-phone-dark.html`, 'list', 'PHONE', 'DARK', null],
        [`${CARD}/list-phone-light.html`, 'list', 'PHONE', 'LIGHT', null],
        [`${CARD}/odd.html`, 'odd', null, null, null],
      ],
    );
    assert.deepEqual(Object.keys(written.freezes[0]), [
      'file',
      'spec',
      'test',
      'name',
      'kind',
      'viewport',
      'colorScheme',
      'colorSchemeReason',
      'route',
      'records',
      'triggers',
    ]);
    assert.equal(read(root, `${CARD}/list-phone-dark.html`), '<p>list</p>');
    assert.equal(freezeFile(CARD, 'list', 'PHONE', 'DARK'), `${CARD}/list-phone-dark.html`);
    assert.equal(freezeFile(CARD, 'list', null, 'LIGHT'), `${CARD}/list-light.html`);
    assert.deepEqual(COLOR_SCHEMES, BOTH);
    assert.equal(FREEZE_COLOR_SCHEME_COMMAND, 'qitsColorScheme');
    assert.equal(RESET_COLOR_SCHEME, 'reset');
  });

  it('keeps the colour-scheme option across a run that froze nothing, and drops it with the option', () => {
    const root = app({ [CARD]: 'spec' });
    const shot = { name: 'list', kind: 'DATA', colorSchemes: BOTH, colorSchemeReason: null };
    send(
      root,
      BOTH.map((colorScheme) => ({ ...shot, colorScheme })),
    );
    // A run in which CARD did not run: nothing carried the option, the old manifest's stays.
    send(root, [], []);
    assert.deepEqual(manifest(root).colorSchemes, BOTH);
    assert.deepEqual(
      manifest(root).freezes.map((f) => f.colorScheme),
      ['DARK', 'LIGHT'],
    );
    // A run whose payloads carry no option (the app dropped it): the keys go, as before it.
    send(root, [{ name: 'list', kind: 'DATA', colorScheme: null, colorSchemes: null }]);
    const written = manifest(root);
    assert.equal('colorSchemes' in written, false);
    assert.deepEqual(
      written.freezes.map((f) => [f.file, 'colorScheme' in f]),
      [[`${CARD}/list.html`, false]],
    );
  });

  it('emulates prefers-color-scheme on the Playwright page, and refuses without one', async () => {
    const calls = [];
    const page = { emulateMedia: async (options) => calls.push(options) };
    assert.equal(await emulateColorScheme({ page }, 'dark'), null);
    await emulateColorScheme({ page }, 'reset');
    assert.deepEqual(calls, [{ colorScheme: 'dark' }, { colorScheme: null }]);
    await assert.rejects(
      emulateColorScheme({ provider: { name: 'webdriverio' } }, 'dark'),
      /provider 'webdriverio' has no page to emulate it on\. Use the playwright provider/,
    );
    await assert.rejects(emulateColorScheme({ page }, 'DARK'), /takes 'light', 'dark' or 'reset'/);
    // Vitest 5's tester throws on a null first argument before the command is sent (qits-2083):
    // refused here too, so the browser half's Vitest 4 runs fail the same way if it sends one.
    await assert.rejects(
      emulateColorScheme({ page }, null),
      /not null \(Vitest 5's browser tester throws on a null command argument\)/,
    );
    assert.equal(calls.length, 2);
  });

  it('reads a manifest written before kind and viewport, and writes its kept entries back with null', () => {
    const root = app({ [PAGE]: 'spec', [CARD]: 'spec' });
    const old = {
      file: `${PAGE}/list.html`,
      spec: PAGE,
      test: 't list',
      name: 'list',
      route: 'projects',
      records: [],
      triggers: ['projects:open'],
    };
    mkdirSync(join(root, DIR, PAGE), { recursive: true });
    writeFileSync(join(root, DIR, PAGE, 'list.html'), '<p>old</p>');
    writeFileSync(
      join(root, DIR, 'manifest.json'),
      `${JSON.stringify({ routes: [], freezes: [old], byRoute: { projects: [old.file] } })}\n`,
    );
    // PAGE did not run: its entry is kept as it was, and reads with the new fields as null.
    send(root, [{ name: 'card', kind: 'DATA' }]);
    assert.deepEqual(manifest(root).freezes, [
      { ...old, kind: null, viewport: null },
      {
        file: `${CARD}/card.html`,
        spec: CARD,
        test: 't',
        name: 'card',
        kind: 'DATA',
        viewport: null,
        route: null,
        records: [],
        triggers: [],
      },
    ]);
    assert.equal(read(root, `${PAGE}/list.html`), '<p>old</p>');
    assert.deepEqual(manifest(root).byRoute, { projects: [old.file] });
  });

  it('takes another directory and other route specs', () => {
    const root = app({ [CARD]: 'spec' });
    run(root, {
      options: { freezes: { dir: 'out/freezes', routeSpecs: /card\.browser\.spec\.ts$/ } },
      shots: { [CARD]: { card: '<p>1</p>' } },
    });
    assert.deepEqual(manifest(root, 'out/freezes').byRoute, {
      projects: [`${CARD}/card.html`],
    });
    assert.deepEqual(manifest(root, 'out/freezes').routes, []);
  });
});

// The outcomes (ticket qits-2003): what the source declares, what the tests reached and showed.
const WORK_CREATE = 'src/app/routes/projects/[slug]/work/create/work-create.page.ts';
const PROJECTS_LAYOUT = 'src/app/routes/projects/projects.layout.ts';
const SHELL = 'src/app/layout/shell.layout.ts';
const MENU = 'src/app/ui/menu/menu.component.ts';
const ROOT_PAGE = 'src/app/routes/home.page.ts';
const BROKEN = 'src/app/routes/broken/broken.page.ts';
const DECLARATIONS = {
  'tsconfig.json': '{ "compilerOptions": { "paths": { "$layout/*": ["src/app/layout/*"] } } }',
  [WORK_CREATE]: `import { Component } from '@angular/core';
import { exit, outcomes, stay } from '@qits/angular';

@Component({ template: '' })
export class WorkCreatePage {
  readonly create = outcomes('create-work-item', {
    refused: stay(),
    created: exit('projects/:slug/work/detail/:id'),
  });
}
`,
  // A renamed import.
  [PROJECTS_LAYOUT]: `import { exit as leave, outcomes as declare } from '@qits/angular';

export class ProjectsLayout {
  readonly nav = declare('project-nav', { home: leave(\`projects\`) });
}
`,
  // A layout under the $layout alias, through a namespace import.
  [SHELL]: `import * as qits from '@qits/angular';

export class ShellLayout {
  readonly session = qits.outcomes('session', { 'signed-out': qits.stay() });
}
`,
  // Outside the routes directory.
  [MENU]: `import { outcomes, stay } from '@qits/angular';

export class Menu {
  readonly menu = outcomes('menu', { open: stay() });
}
`,
  // The routes directory itself is the empty route.
  [ROOT_PAGE]: `import { outcomes, stay } from '@qits/angular';

export class HomePage {
  readonly home = outcomes('home', { greeted: stay() });
}
`,
  [BROKEN]: `import { exit, outcomes, stay } from '@qits/angular';

const name = 'broken';
const path = 'projects';
const key = 'k';
const rest = {};
const other = () => stay();
export class BrokenPage {
  readonly a = outcomes(name, { a: stay() });
  readonly b = outcomes('b', {
    ...rest,
    [key]: stay(),
    c: other(),
    d: exit(path),
    ok: stay(),
  });
}
`,
  // Not counted: a spec, another package's outcomes(), and a file outside src/app.
  'src/app/routes/projects/projects.page.spec.ts': `import { outcomes, stay } from '@qits/angular';
outcomes('spec-only', { x: stay() });
`,
  'src/app/routes/projects/local.ts': `import { outcomes, stay } from './elsewhere';
// @qits/angular
outcomes('not-ours', { x: stay() });
`,
  'src/main.ts': `import { outcomes, stay } from '@qits/angular';
outcomes('main', { x: stay() });
`,
};

describe('declaredOutcomes', () => {
  it('reads page, layout, $layout, outside and renamed declarations, and the unreadable calls', () => {
    const root = app(DECLARATIONS);
    const { declared, unreadable } = declaredOutcomes({ root });
    assert.deepEqual(declared, [
      {
        route: '',
        interaction: 'home',
        outcome: 'greeted',
        kind: 'stay',
        to: null,
        global: false,
        triggered: true,
        file: ROOT_PAGE,
      },
      {
        route: 'broken',
        interaction: 'b',
        outcome: 'ok',
        kind: 'stay',
        to: null,
        global: false,
        triggered: true,
        file: BROKEN,
      },
      {
        route: 'projects',
        interaction: 'project-nav',
        outcome: 'home',
        kind: 'exit',
        to: 'projects',
        global: true,
        triggered: true,
        file: PROJECTS_LAYOUT,
      },
      {
        route: 'projects/:slug/work/create',
        interaction: 'create-work-item',
        outcome: 'created',
        kind: 'exit',
        to: 'projects/:slug/work/detail/:id',
        global: false,
        triggered: true,
        file: WORK_CREATE,
      },
      {
        route: 'projects/:slug/work/create',
        interaction: 'create-work-item',
        outcome: 'refused',
        kind: 'stay',
        to: null,
        global: false,
        triggered: true,
        file: WORK_CREATE,
      },
      {
        route: null,
        interaction: 'menu',
        outcome: 'open',
        kind: 'stay',
        to: null,
        global: true,
        triggered: true,
        file: MENU,
      },
      {
        route: null,
        interaction: 'session',
        outcome: 'signed-out',
        kind: 'stay',
        to: null,
        global: true,
        triggered: true,
        file: SHELL,
      },
    ]);
    assert.deepEqual(unreadable, [
      { file: BROKEN, line: 9, why: 'its interaction is not a string literal' },
      { file: BROKEN, line: 11, why: 'a spread' },
      { file: BROKEN, line: 12, why: 'a computed key' },
      {
        file: BROKEN,
        line: 13,
        why: 'the entry c is not an exit(), stay(), returnTo() or external() call',
      },
      { file: BROKEN, line: 14, why: 'the exit d is not given a string literal' },
    ]);
  });

  it('takes another routes directory', () => {
    const root = app({
      'src/app/pages/projects/[slug]/detail.page.ts': DECLARATIONS[MENU],
    });
    assert.deepEqual(
      declaredOutcomes({ root, routes: 'src/app/pages' }).declared.map((d) => [d.route, d.global]),
      [['projects/:slug', false]],
    );
    assert.deepEqual(
      declaredOutcomes({ root }).declared.map((d) => [d.route, d.global]),
      [[null, true]],
    );
  });

  it('needs no typescript without a declaration, and names it when one needs it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'qits-outcomes-'));
    after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(outside, 'src/app'), { recursive: true });
    writeFileSync(join(outside, 'src/app/plain.ts'), 'export const x = 1;\n');
    assert.deepEqual(declaredOutcomes({ root: outside }), { declared: [], unreadable: [] });
    writeFileSync(join(outside, 'src/app/menu.ts'), DECLARATIONS[MENU]);
    assert.throws(
      () => declaredOutcomes({ root: outside }),
      /the package typescript does not resolve/,
    );
  });
});

describe('declaredOutcomes, the other kinds and the triggered option', () => {
  const KINDS_PAGE = 'src/app/routes/sign-in/sign-in.page.ts';

  it('reads returnTo(), external() and { triggered }, and names what it cannot read', () => {
    const root = app({
      [KINDS_PAGE]: `import { exit, external, outcomes, returnTo, stay } from '@qits/angular';

const site = 'idp';
const options = { triggered: false };
export class SignInPage {
  readonly back = outcomes('back', { home: returnTo(), idp: external('idp') }, { triggered: false });
  readonly link = outcomes('link', { open: exit('') }, { triggered: true });
  readonly empty = outcomes('empty', { open: stay() }, {});
  readonly a = outcomes('a', { x: stay() }, options);
  readonly b = outcomes('b', { x: stay() }, { ...options });
  readonly c = outcomes('c', { x: stay() }, { triggered: 0 });
  readonly d = outcomes('d', { x: stay() }, { other: false });
  readonly e = outcomes('e', { x: external(site) });
}
`,
    });
    const { declared, unreadable } = declaredOutcomes({ root });
    const page = (interaction, outcome, kind, to, triggered) => ({
      route: 'sign-in',
      interaction,
      outcome,
      kind,
      to,
      global: false,
      triggered,
      file: KINDS_PAGE,
    });
    assert.deepEqual(declared, [
      page('back', 'home', 'returnTo', null, false),
      page('back', 'idp', 'external', 'idp', false),
      page('empty', 'open', 'stay', null, true),
      page('link', 'open', 'exit', '', true),
    ]);
    const why = 'its options are not an object literal of triggered: true or false';
    assert.deepEqual(unreadable, [
      { file: KINDS_PAGE, line: 9, why },
      { file: KINDS_PAGE, line: 10, why },
      { file: KINDS_PAGE, line: 11, why },
      { file: KINDS_PAGE, line: 12, why },
      { file: KINDS_PAGE, line: 13, why: 'the external x is not given a string literal' },
    ]);
  });

  it('runs over any file list, with another module for the API', () => {
    const ts = createRequire(import.meta.url)('typescript');
    const read = readOutcomes({
      ts,
      files: [
        {
          file: 'src/lib/x.ts',
          text: "import { outcomes, stay } from './api';\noutcomes('x', { y: stay() });\n",
          scope: { route: 'x', global: false },
        },
        {
          file: 'src/lib/z.ts',
          text: "import { outcomes, stay } from '@qits/angular';\noutcomes('z', { y: stay() });\n",
          scope: { route: null, global: true },
        },
      ],
      from: (specifier) => specifier === './api',
    });
    assert.deepEqual(read, {
      declared: [
        {
          route: 'x',
          interaction: 'x',
          outcome: 'y',
          kind: 'stay',
          to: null,
          global: false,
          triggered: true,
          file: 'src/lib/x.ts',
        },
      ],
      unreadable: [],
    });
  });
});

describe('the library’s own outcomes', () => {
  const shipped = libraryOutcomes();
  const strip = ({ provides: _provides, ...entry }) => entry;
  const byInteraction = (...names) =>
    shipped.filter((entry) => names.includes(entry.interaction)).map(strip);

  it(`ships ${LIBRARY_OUTCOMES} as the library's source declares it now (else: ${REGENERATE})`, async () => {
    const committed = readFileSync(new URL(`../../${LIBRARY_OUTCOMES}`, import.meta.url), 'utf8');
    assert.equal(
      committed,
      await libraryOutcomesText(),
      `${LIBRARY_OUTCOMES} is stale: run ${REGENERATE} and commit the file.`,
    );
  });

  it('declares the sign-in callback page, the session expiry and the session guard', () => {
    assert.deepEqual(
      shipped.map((e) => [
        `${e.interaction}:${e.outcome}`,
        e.kind,
        e.to,
        e.triggered,
        e.route,
        e.global,
      ]),
      [
        ['sign-in:failed', 'stay', null, false, 'auth/callback', false],
        ['sign-in:succeeded', 'returnTo', null, false, 'auth/callback', false],
        ['sign-in-failed:restarted', 'exit', '', true, 'auth/callback', false],
        ['session-expired:signedOut', 'external', 'idp', false, null, true],
        ['session-guard:signedOut', 'external', 'idp', false, null, true],
      ],
    );
  });

  it('joins the session expiry to an app that sends platform calls with the bearer', () => {
    const intercepted = app({
      'src/app/app.config.ts': `import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { qitsBearerInterceptor } from '@qits/angular';
export const config = { providers: [provideHttpClient(withInterceptors([qitsBearerInterceptor]))] };
`,
    });
    assert.deepEqual(
      declaredOutcomes({ root: intercepted }).declared,
      byInteraction('session-expired'),
    );
    const fetching = app({
      'src/app/ui/asset.ts': `import { inject } from '@angular/core';
import { QitsBearerFetch } from '@qits/angular';
export class Asset {
  private readonly fetcher = inject(QitsBearerFetch);
}
`,
    });
    assert.deepEqual(
      declaredOutcomes({ root: fetching }).declared,
      byInteraction('session-expired'),
    );
    const neither = app({
      'src/app/app.config.ts': `import { qitsSignedInGuard } from '@qits/angular';
export const guard = qitsSignedInGuard;
`,
    });
    assert.deepEqual(declaredOutcomes({ root: neither }).declared, byInteraction('session-guard'));
  });

  it('joins an app that imports what brings them in, by name or through a namespace', () => {
    const root = app({
      'src/app/app.routes.ts': `import { qitsAuthCallbackRoute, qitsSignedInGuard as signedIn } from '@qits/angular';
export const routes = [qitsAuthCallbackRoute, { path: '', canActivate: [signedIn], children: [] }];
`,
    });
    assert.deepEqual(
      declaredOutcomes({ root }).declared,
      byInteraction('sign-in', 'sign-in-failed', 'session-guard'),
    );
    const namespaced = app({
      'src/app/app.config.ts': `import * as qits from '@qits/angular';
export const config = { providers: [qits.provideQitsBearerSignIn({ clientId: 'x' })] };
`,
    });
    assert.deepEqual(
      declaredOutcomes({ root: namespaced }).declared,
      byInteraction('sign-in', 'sign-in-failed'),
    );
  });

  it('stays out of an app that imports none of it, or only its types, or only in a spec', () => {
    const root = app({
      'src/app/app.config.ts': `import { provideQitsIntegration } from '@qits/angular';
import type { QitsSession } from '@qits/angular';
import { type qitsSignedInGuard } from '@qits/angular';
export const config = { providers: [provideQitsIntegration()] };
`,
      'src/app/app.spec.ts': "import { qitsAuthCallbackRoute } from '@qits/angular';\n",
    });
    assert.deepEqual(declaredOutcomes({ root }), { declared: [], unreadable: [] });
  });

  it('sorts them among the app’s own', () => {
    const root = app({
      [MENU]: DECLARATIONS[MENU],
      [ROOT_PAGE]: `import { outcomes, qitsSignedInGuard, stay } from '@qits/angular';
export const guard = qitsSignedInGuard;
export class HomePage {
  readonly home = outcomes('home', { greeted: stay() });
}
`,
    });
    assert.deepEqual(
      declaredOutcomes({ root }).declared.map((e) => `${e.route}|${e.interaction}:${e.outcome}`),
      ['|home:greeted', 'null|menu:open', 'null|session-guard:signedOut'],
    );
  });

  it('are gaps when no test reaches them, and ask no screenshot of an untriggered one', () => {
    const declared = byInteraction('sign-in', 'sign-in-failed', 'session-guard');
    assert.deepEqual(outcomeGaps({ declared, unreadable: [], manifest: undefined }), [
      'sign-in:failed (auth/callback): no browser test reaches it.',
      'sign-in:succeeded (auth/callback): no browser test reaches it.',
      'sign-in-failed:restarted (auth/callback): no browser test reaches it.',
      'sign-in-failed:restarted: no screenshot of auth/callback shows its trigger. Add a screenshot test where it is visible, with another provider state if needed (an open menu, a loaded list).',
      'session-guard:signedOut (app-wide): no browser test reaches it.',
    ]);
    const fired = (interaction, outcome, kind, freeze = null) => ({
      spec: 'src/app/routes/auth.page.browser.spec.ts',
      test: 't',
      route: interaction === 'session-guard' ? 'projects' : 'auth/callback',
      interaction,
      outcome,
      kind,
      freeze,
    });
    const manifest = {
      freezes: [
        {
          file: 'f.html',
          route: 'auth/callback',
          triggers: ['sign-in-failed:restarted'],
        },
      ],
      outcomes: {
        fired: [
          fired('sign-in', 'succeeded', 'returnTo'),
          fired('sign-in', 'failed', 'stay', 'f.html'),
          fired('sign-in-failed', 'restarted', 'exit'),
          fired('session-guard', 'signedOut', 'external'),
        ],
      },
    };
    assert.deepEqual(outcomeGaps({ declared, unreadable: [], manifest }), []);
    // A stay still needs its screenshot, untriggered or not.
    manifest.outcomes.fired[1] = fired('sign-in', 'failed', 'stay');
    assert.deepEqual(outcomeGaps({ declared, unreadable: [], manifest }), [
      'sign-in:failed (auth/callback): a stay needs a screenshot after it is reached.',
    ]);
  });
});

describe('outcomes in the freeze manifest', () => {
  const PAGE = 'src/app/routes/projects/[slug]/work/create/work-create.page.browser.spec.ts';
  const CARD = 'src/app/ui/card/card.browser.spec.ts';
  const DIR = 'src/testing/browser/freezes';
  const module = (root, spec, state = 'passed') => ({
    moduleId: join(root, spec),
    state: () => state,
    errors: () => [],
    children: { allTests: () => [{ result: () => ({ state }) }] },
  });
  const fire = (test, outcome, route = 'projects/:slug/work/create') => ({
    interaction: 'create-work-item',
    outcome,
    kind: outcome === 'created' ? 'exit' : 'stay',
    to: null,
    spec: 'ignored: the command context names the spec',
    test,
    route,
  });
  /**
   * A run: `steps` per spec, in order, each
   * `['shot', test, name, outcomes, triggers, viewport?, colorScheme?]` or
   * `['fired', test, ...outcome names]`; `modules` the outcome of each spec (default passed).
   */
  function run(root, steps, modules) {
    const vitest = { config: { reporters: [] } };
    const project = { config: { root, browser: { enabled: true } } };
    screenshotReferences({ freezes: true }).configureVitest({ vitest, project });
    const [reporter] = vitest.config.reporters;
    const { qitsFreeze, qitsOutcomes } = project.config.browser.commands;
    reporter.onTestRunStart([]);
    for (const [spec, list] of Object.entries(steps)) {
      const context = { testPath: join(root, spec) };
      for (const [what, test, ...rest] of list) {
        if (what === 'fired') {
          qitsOutcomes(
            context,
            rest.map((outcome) => fire(test, outcome)),
          );
        } else {
          const [name, outcomes, triggers, viewport, colorScheme] = rest;
          qitsFreeze(context, {
            name,
            test,
            html: '<p></p>',
            route: 'projects/:slug/work/create',
            records: [],
            assets: [],
            outcomes,
            triggers,
            kind: 'DATA',
            viewport,
            colorScheme,
            colorSchemes: colorScheme ? ['LIGHT', 'DARK'] : null,
          });
        }
      }
    }
    reporter.onTestRunEnd(modules ?? Object.keys(steps).map((spec) => module(root, spec)));
  }
  const manifest = (root) => JSON.parse(readFileSync(join(root, DIR, 'manifest.json'), 'utf8'));

  it('lists the declared and fired outcomes, links each fire to the first shot after it, and the triggers', () => {
    const root = app({ [PAGE]: 'spec', [CARD]: 'spec', [WORK_CREATE]: DECLARATIONS[WORK_CREATE] });
    run(root, {
      [PAGE]: [
        ['shot', 'creates', 'empty', 0, ['create-work-item:refused', 'create-work-item:created']],
        ['shot', 'refuses', 'before', 0, []],
        ['shot', 'refuses', 'refused', 1, ['create-work-item:created', 'create-work-item:created']],
        ['shot', 'refuses', 'later', 2, []],
        // Sent after the test, as recordOutcomes() does: refused before the "refused" shot, then
        // refused again before "later"; "creates" reached created after its only shot.
        ['fired', 'refuses', 'refused', 'refused', 'refused'],
        ['fired', 'creates', 'created'],
      ],
      [CARD]: [['fired', 'opens', 'refused']],
    });
    const { freezes, outcomes } = manifest(root);
    assert.deepEqual(
      freezes.map((f) => [f.name, f.triggers]),
      [
        ['before', []],
        ['empty', ['create-work-item:created', 'create-work-item:refused']],
        ['later', []],
        ['refused', ['create-work-item:created']],
      ],
    );
    assert.deepEqual(outcomes.declared, declaredOutcomes({ root }).declared);
    assert.equal(outcomes.declared.length, 2);
    const file = (name) => `${PAGE}/${name}.html`;
    assert.deepEqual(outcomes.fired, [
      {
        spec: PAGE,
        test: 'creates',
        route: 'projects/:slug/work/create',
        interaction: 'create-work-item',
        outcome: 'created',
        kind: 'exit',
        freeze: null,
      },
      ...[file('refused'), file('later'), null].map((freeze) => ({
        spec: PAGE,
        test: 'refuses',
        route: 'projects/:slug/work/create',
        interaction: 'create-work-item',
        outcome: 'refused',
        kind: 'stay',
        freeze,
      })),
      // Not a page spec: no route, as for its freezes.
      {
        spec: CARD,
        test: 'opens',
        route: null,
        interaction: 'create-work-item',
        outcome: 'refused',
        kind: 'stay',
        freeze: null,
      },
    ]);
  });

  it('keeps the fired outcomes of a spec a partial run skipped or failed, and drops a gone spec’s', () => {
    const other = 'src/app/routes/projects/projects.page.browser.spec.ts';
    const gone = 'src/app/routes/gone/gone.page.browser.spec.ts';
    const root = app({ [PAGE]: 'spec', [CARD]: 'spec', [other]: 'spec', [gone]: 'spec' });
    run(root, {
      [PAGE]: [['fired', 'refuses', 'refused']],
      [CARD]: [['fired', 'opens', 'refused']],
      [other]: [['fired', 'lists', 'refused']],
      [gone]: [['fired', 'goes', 'refused']],
    });
    rmSync(join(root, gone));
    // PAGE ran completely and reached nothing now; CARD failed; `other` did not run.
    run(root, { [PAGE]: [], [CARD]: [['fired', 'opens', 'created']] }, [
      module(root, PAGE),
      module(root, CARD, 'failed'),
    ]);
    assert.deepEqual(
      manifest(root).outcomes.fired.map((f) => [f.spec, f.test, f.outcome]),
      [
        [other, 'lists', 'refused'],
        [CARD, 'opens', 'refused'],
      ],
    );
  });

  // Ticket qits-2046: a shot at the preset widths is three freezes, PHONE first; the link a
  // reader follows is the DESKTOP one, and the first freeze when the shot has no DESKTOP.
  it("links a fire to the DESKTOP freeze of the first shot after it, else to that shot's first", () => {
    const root = app({ [PAGE]: 'spec' });
    const widths = (test, name, outcomes, viewports = ['PHONE', 'TABLET', 'DESKTOP']) =>
      viewports.map((viewport) => ['shot', test, name, outcomes, [], viewport]);
    run(root, {
      [PAGE]: [
        ...widths('refuses', 'before', 0),
        ...widths('refuses', 'refused', 1),
        ...widths('refuses', 'later', 2, ['PHONE', 'TABLET']),
        ['fired', 'refuses', 'refused', 'refused'],
      ],
    });
    assert.deepEqual(
      manifest(root).outcomes.fired.map((f) => f.freeze),
      [`${PAGE}/refused-desktop.html`, `${PAGE}/later-phone.html`],
    );
  });

  // Ticket qits-2083: of a shot's schemes, the link is the first it took (LIGHT unless left out).
  it('links a fire to the first colour scheme of the DESKTOP freeze of the shot after it', () => {
    const root = app({ [PAGE]: 'spec' });
    const shots = (test, name, outcomes, schemes) =>
      ['PHONE', 'DESKTOP'].flatMap((viewport) =>
        schemes.map((scheme) => ['shot', test, name, outcomes, [], viewport, scheme]),
      );
    run(root, {
      [PAGE]: [
        ...shots('refuses', 'before', 0, ['LIGHT', 'DARK']),
        ...shots('refuses', 'refused', 1, ['LIGHT', 'DARK']),
        ...shots('refuses', 'later', 2, ['DARK']),
        ['fired', 'refuses', 'refused', 'refused'],
      ],
    });
    assert.deepEqual(
      manifest(root).outcomes.fired.map((f) => f.freeze),
      [`${PAGE}/refused-desktop-light.html`, `${PAGE}/later-desktop-dark.html`],
    );
  });

  it('replaces what a retried test sent before', () => {
    const root = app({ [PAGE]: 'spec' });
    run(root, {
      [PAGE]: [
        ['fired', 'refuses', 'refused', 'refused'],
        ['fired', 'refuses', 'created'],
      ],
    });
    assert.deepEqual(
      manifest(root).outcomes.fired.map((f) => f.outcome),
      ['created'],
    );
  });
});

describe('qits-angular screenshots --check, the outcome gaps', () => {
  const PAGE = 'src/app/routes/projects/[slug]/work/create/work-create.page.browser.spec.ts';
  const DIR = 'src/testing/browser/freezes';
  const check = (root, args = [], env = {}) => {
    const out = [];
    const err = [];
    const code = screenshots(['--check', ...args], {
      cwd: root,
      env,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const withManifest = (files, manifest, dir = DIR) =>
    app({ ...files, [`${dir}/manifest.json`]: JSON.stringify(manifest) });
  const freeze = (route, triggers, name = 'x') => ({
    file: `${PAGE}/${name}.html`,
    spec: PAGE,
    test: 't',
    name,
    route,
    records: [],
    triggers,
  });
  const fired = (interaction, outcome, route, freezeFile = null) => ({
    spec: PAGE,
    test: 't',
    route,
    interaction,
    outcome,
    kind: 'stay',
    freeze: freezeFile,
  });
  const CREATE = 'projects/:slug/work/create';
  const declarations = {
    'tsconfig.json': DECLARATIONS['tsconfig.json'],
    [WORK_CREATE]: DECLARATIONS[WORK_CREATE],
    [PROJECTS_LAYOUT]: DECLARATIONS[PROJECTS_LAYOUT],
    [MENU]: DECLARATIONS[MENU],
  };

  it('names an unreached outcome, a stay without a freeze, a trigger no screenshot shows, and an unreadable call', () => {
    const root = withManifest(
      { ...declarations, [BROKEN]: DECLARATIONS[BROKEN] },
      {
        freezes: [
          // On another route: does not show the page's trigger, but the layout's subtree has it.
          freeze('projects/:slug', ['create-work-item:created', 'project-nav:home']),
          freeze(null, ['menu:open'], 'menu'),
        ],
        outcomes: {
          fired: [
            // On its page, but no shot after it.
            fired('create-work-item', 'refused', CREATE),
            // In the layout's subtree, anywhere for the app-wide menu.
            fired('project-nav', 'home', 'projects/:slug'),
            fired('menu', 'open', null, `${PAGE}/menu.html`),
            // On another page: does not reach the page's created.
            fired('create-work-item', 'created', 'projects/:slug'),
          ],
        },
      },
    );
    const { code, err } = check(root);
    assert.equal(code, 0, 'report-only');
    const gaps = err.split('\n');
    assert.match(
      gaps[0],
      /: 11 outcome gap\(s\), report-only \(they fail the check with --enforce-outcomes\):$/,
    );
    assert.deepEqual(gaps.slice(1), [
      '  b:ok (broken): no browser test reaches it.',
      '  b:ok: no screenshot of broken shows its trigger. Add a screenshot test where it is visible, with another provider state if needed (an open menu, a loaded list).',
      '  create-work-item:created (projects/:slug/work/create): no browser test reaches it.',
      '  create-work-item:created: no screenshot of projects/:slug/work/create shows its trigger. Add a screenshot test where it is visible, with another provider state if needed (an open menu, a loaded list).',
      '  create-work-item:refused (projects/:slug/work/create): a stay needs a screenshot after it is reached.',
      '  create-work-item:refused: no screenshot of projects/:slug/work/create shows its trigger. Add a screenshot test where it is visible, with another provider state if needed (an open menu, a loaded list).',
      `  ${BROKEN}:9: an outcomes() call that cannot be read statically (its interaction is not a string literal).`,
      `  ${BROKEN}:11: an outcomes() call that cannot be read statically (a spread).`,
      `  ${BROKEN}:12: an outcomes() call that cannot be read statically (a computed key).`,
      `  ${BROKEN}:13: an outcomes() call that cannot be read statically (the entry c is not an exit(), stay(), returnTo() or external() call).`,
      `  ${BROKEN}:14: an outcomes() call that cannot be read statically (the exit d is not given a string literal).`,
    ]);
  });

  it('checks a layout once for its subtree and an app-wide outcome anywhere', () => {
    const root = withManifest(declarations, {
      freezes: [freeze('projects', ['project-nav:home']), freeze(null, ['menu:open'], 'menu')],
      outcomes: {
        fired: [fired('project-nav', 'home', 'projects'), fired('menu', 'open', null, 'm.html')],
      },
    });
    const { err } = check(root);
    assert.doesNotMatch(err, /project-nav|menu:open/);
    // Outside the layout's subtree, neither fire nor shot counts for it.
    const elsewhere = withManifest(declarations, {
      freezes: [freeze('teams', ['project-nav:home'])],
      outcomes: { fired: [fired('project-nav', 'home', 'teams')] },
    });
    const gaps = check(elsewhere).err;
    assert.match(gaps, /project-nav:home \(projects and below\): no browser test reaches it\./);
    assert.match(
      gaps,
      /project-nav:home: no screenshot of projects or a route below it shows its trigger\./,
    );
    assert.match(gaps, /menu:open \(app-wide\): no browser test reaches it\./);
    assert.match(gaps, /menu:open: no screenshot shows its trigger\./);
    // Checked once, not once per page.
    assert.equal(gaps.match(/project-nav:home \(/g).length, 1);
  });

  it('exits 1 on an outcome gap with --enforce-outcomes, and 0 when there is none', () => {
    const root = withManifest(
      { [MENU]: DECLARATIONS[MENU] },
      { freezes: [], outcomes: { fired: [] } },
    );
    const enforced = check(root, ['--enforce-outcomes']);
    assert.equal(enforced.code, 1);
    assert.match(
      enforced.err,
      /: 2 outcome gap\(s\):\n  menu:open \(app-wide\): no browser test reaches it\./,
    );
    assert.doesNotMatch(enforced.err, /report-only/);
    // An update run lists them and passes.
    const update = check(root, ['--enforce-outcomes'], { UPDATE_SNAPSHOT: 'all' });
    assert.equal(update.code, 0);
    assert.match(update.out, /2 outcome gap\(s\):[\s\S]*This is an update run/);

    const covered = withManifest(
      { [MENU]: DECLARATIONS[MENU] },
      {
        freezes: [freeze(null, ['menu:open'])],
        outcomes: { fired: [fired('menu', 'open', null, `${PAGE}/x.html`)] },
      },
    );
    const passed = check(covered, ['--enforce-outcomes']);
    assert.equal(passed.code, 0);
    assert.equal(passed.err, '');
    assert.match(passed.out, /every declared outcome \(1\) is reached by a test/);
  });

  it('reports nothing for an app without declarations, and says when the manifest is missing', () => {
    const none = app({ 'src/app/app.ts': 'export const x = 1;\n' });
    const quiet = check(none, ['--enforce-outcomes']);
    assert.equal(quiet.code, 0);
    assert.equal(quiet.err, '');
    assert.doesNotMatch(quiet.out, /outcome/);

    const missing = app({ [MENU]: DECLARATIONS[MENU] });
    const { code, err } = check(missing, ['--enforce-outcomes']);
    assert.equal(code, 1);
    assert.match(err, /no freeze manifest at src\/testing\/browser\/freezes\/manifest\.json/);
  });

  it('takes --freezes and --routes', () => {
    const root = withManifest(
      { 'src/app/pages/projects/projects.page.ts': DECLARATIONS[MENU] },
      {
        freezes: [freeze('projects', ['menu:open'])],
        outcomes: { fired: [fired('menu', 'open', 'projects', 'x.html')] },
      },
      'out/freezes',
    );
    assert.equal(
      check(root, ['--enforce-outcomes', '--freezes', 'out/freezes', '--routes', 'src/app/pages'])
        .code,
      0,
    );
    // Without --routes the file is app-wide, which these fires also satisfy; without --freezes no manifest.
    assert.equal(check(root, ['--enforce-outcomes', '--freezes', 'out/freezes']).code, 0);
    assert.equal(check(root, ['--enforce-outcomes']).code, 1);
  });
});

// Ticket qits-2049: a checked route (manifest.routes, walking children) that no declared exit
// leads to, and that is not itself an entry point, is its own gap.
describe('qits-angular screenshots --check, unreachable routes and entry points (qits-2049)', () => {
  const PAGE = 'src/app/routes/projects/[slug]/work/create/work-create.page.browser.spec.ts';
  const DIR = 'src/testing/browser/freezes';
  const check = (root, args = [], env = {}) => {
    const out = [];
    const err = [];
    const code = screenshots(['--check', ...args], {
      cwd: root,
      env,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const withManifest = (files, manifest) =>
    app({ ...files, [`${DIR}/manifest.json`]: JSON.stringify(manifest) });
  const freeze = (route, triggers, name = 'x') => ({
    file: `${PAGE}/${name}.html`,
    spec: PAGE,
    test: 't',
    name,
    route,
    records: [],
    triggers,
  });
  const fired = (interaction, outcome, route, freezeFile = null) => ({
    spec: PAGE,
    test: 't',
    route,
    interaction,
    outcome,
    kind: 'stay',
    freeze: freezeFile,
  });
  // The menu's `menu:open` (app-wide) stays fully covered, so the only gap left is the route check.
  const coveredManifest = (routes) => ({
    routes,
    freezes: [freeze(null, ['menu:open'])],
    outcomes: { fired: [fired('menu', 'open', null, `${PAGE}/x.html`)] },
  });

  it('names a route no outcome leads to, and it is not an entry point, with the exact message', () => {
    const root = withManifest(
      { [MENU]: DECLARATIONS[MENU] },
      coveredManifest([{ path: 'create', fullPath: 'create' }]),
    );
    const { code, err } = check(root);
    assert.equal(code, 0, 'report-only');
    assert.match(
      err,
      /\n {2}create: no outcome leads here, and it is not an entry point\. Add the exit that should lead here, or declare it an entry point\.\n?$/,
    );
  });

  it("shows the root route ('') as / in the gap message", () => {
    const root = withManifest(
      { [MENU]: DECLARATIONS[MENU] },
      coveredManifest([{ path: '', fullPath: '' }]),
    );
    const { err } = check(root);
    assert.match(err, /\n {2}\/: no outcome leads here, and it is not an entry point\./);
  });

  it('passes a route reached only by a layout exit, or only by an app-wide exit', () => {
    const NAV = 'src/app/ui/nav/nav.component.ts';
    const navDeclaration = `import { exit, outcomes } from '@qits/angular';

export class Nav {
  readonly go = outcomes('nav-exit', { home: exit('home') });
}
`;
    const root = withManifest(
      { [PROJECTS_LAYOUT]: DECLARATIONS[PROJECTS_LAYOUT], [NAV]: navDeclaration },
      {
        routes: [
          { path: 'projects', fullPath: 'projects' },
          { path: 'home', fullPath: 'home' },
        ],
        freezes: [freeze('projects', ['project-nav:home']), freeze(null, ['nav-exit:home'])],
        outcomes: {
          fired: [fired('project-nav', 'home', 'projects'), fired('nav-exit', 'home', null)],
        },
      },
    );
    const { err } = check(root);
    assert.doesNotMatch(err, /no outcome leads here/);
  });

  it('passes a route declared an entry point even with no inbound exit', () => {
    const root = withManifest(
      { [MENU]: DECLARATIONS[MENU] },
      coveredManifest([{ path: 'auth/callback', fullPath: 'auth/callback', entry: true }]),
    );
    const { err } = check(root);
    assert.doesNotMatch(err, /no outcome leads here/);
  });

  it('does not check a redirect, a wildcard route, or a parent that has children', () => {
    const root = withManifest(
      { [MENU]: DECLARATIONS[MENU] },
      coveredManifest([
        { path: '', fullPath: '', redirectTo: 'projects' },
        { path: '**', fullPath: '**' },
        {
          path: 'projects',
          fullPath: 'projects',
          children: [{ path: ':slug', fullPath: 'projects/:slug' }],
        },
      ]),
    );
    const { err } = check(root);
    // 'projects' is a parent (skipped); its child is checked and unreachable.
    assert.doesNotMatch(err, /\n {2}projects: no outcome leads here/);
    assert.doesNotMatch(err, /\n {2}\/: no outcome leads here/);
    assert.doesNotMatch(err, /\n {2}\*\*: no outcome leads here/);
    assert.match(err, /\n {2}projects\/:slug: no outcome leads here/);
  });

  it('a returnTo or an external outcome adds no inbound edge', () => {
    const RETURN = 'src/app/ui/sign-in/sign-in.component.ts';
    const EXTERNAL = 'src/app/ui/leave/leave.component.ts';
    const root = withManifest(
      {
        [MENU]: DECLARATIONS[MENU],
        [RETURN]: `import { outcomes, returnTo } from '@qits/angular';

export class SignIn {
  readonly back = outcomes('sign-in-again', { done: returnTo() }, { triggered: false });
}
`,
        [EXTERNAL]: `import { external, outcomes } from '@qits/angular';

export class Leave {
  readonly go = outcomes('leave', { idp: external('idp') }, { triggered: false });
}
`,
      },
      coveredManifest([{ path: 'projects', fullPath: 'projects' }]),
    );
    const { err } = check(root);
    assert.match(err, /\n {2}projects: no outcome leads here/);
  });

  it('--enforce-outcomes exits 1 on an unreachable route alone, 0 without it, report-only on stderr', () => {
    const root = withManifest(
      { [MENU]: DECLARATIONS[MENU] },
      coveredManifest([{ path: 'create', fullPath: 'create' }]),
    );
    const plain = check(root);
    assert.equal(plain.code, 0);
    assert.match(plain.err, /report-only/);
    assert.match(plain.err, /create: no outcome leads here/);
    const enforced = check(root, ['--enforce-outcomes']);
    assert.equal(enforced.code, 1);
    assert.match(enforced.err, /create: no outcome leads here/);
    assert.doesNotMatch(enforced.err, /report-only/);
  });

  it('the success line also counts the checked routes', () => {
    const root = withManifest(
      { [MENU]: DECLARATIONS[MENU] },
      coveredManifest([
        { path: '', fullPath: '', redirectTo: 'projects' },
        { path: 'auth/callback', fullPath: 'auth/callback', entry: true },
      ]),
    );
    const { out, err } = check(root, ['--enforce-outcomes']);
    assert.equal(err, '');
    assert.match(
      out,
      /every declared outcome \(1\) is reached by a test and its trigger is shown, and every route \(1\) is led to or an entry point\./,
    );
  });
});

describe('forwards and page routes (qits-2076)', () => {
  const exitEntry = (
    route,
    outcome,
    to,
    { global = false, triggered = false, kind = 'exit' } = {},
  ) => ({
    route,
    interaction: 'forward',
    outcome,
    kind,
    to: kind === 'exit' ? to : null,
    global,
    triggered,
    file: 'src/app/routes/x.ts',
  });
  // A layout whose '' and :tab children only feed it, and which leaves at once (a guard, a redirect
  // computed at run time): both exits are untriggered and declared on the layout's own route.
  const forwardLayout = {
    path: 'go',
    fullPath: 'go',
    children: [
      { path: '', fullPath: 'go', rendersNothing: true },
      { path: ':tab', fullPath: 'go/:tab', entry: true, rendersNothing: true },
    ],
  };
  const layoutOverPage = {
    path: 'settings',
    fullPath: 'settings',
    children: [
      { path: '', fullPath: 'settings', rendersNothing: true },
      { path: 'profile', fullPath: 'settings/profile' },
    ],
  };
  const forwardDeclared = [
    exitEntry('go', 'home', 'projects', { global: true }),
    exitEntry('go', 'tab', 'projects/:slug', { global: true }),
  ];

  it('names a layout over rendersNothing children with only untriggered exits a forward', () => {
    const manifest = { routes: [forwardLayout] };
    assert.deepEqual([...forwardRoutes(manifest, forwardDeclared)], ['go']);
    // A route without children qualifies trivially.
    const leaf = { routes: [{ path: 'leaf', fullPath: 'leaf' }] };
    assert.deepEqual([...forwardRoutes(leaf, [exitEntry('leaf', 'away', 'x')])], ['leaf']);
  });

  it('does not name a layout with a real page child', () => {
    const declared = [exitEntry('settings', 'away', 'projects', { global: true })];
    assert.deepEqual([...forwardRoutes({ routes: [layoutOverPage] }, declared)], []);
  });

  it('does not name a route whose exits come with a triggered outcome, or a stay', () => {
    const manifest = { routes: [forwardLayout] };
    const triggered = [...forwardDeclared, exitEntry('go', 'click', 'x', { triggered: true })];
    assert.deepEqual([...forwardRoutes(manifest, triggered)], []);
    const stay = [...forwardDeclared, exitEntry('go', 'wait', null, { kind: 'stay' })];
    assert.deepEqual([...forwardRoutes(manifest, stay)], []);
    for (const kind of ['returnTo', 'external']) {
      const other = [...forwardDeclared, exitEntry('go', 'other', null, { kind })];
      assert.deepEqual([...forwardRoutes(manifest, other)], [], kind);
    }
  });

  it('ignores route: null declarations, and needs a declaration on the route itself', () => {
    const manifest = { routes: [forwardLayout] };
    const appWide = [exitEntry(null, 'away', 'x', { global: true })];
    assert.deepEqual([...forwardRoutes(manifest, appWide)], []);
    // An untriggered app-wide exit does not disqualify a forward either.
    assert.deepEqual([...forwardRoutes(manifest, [...forwardDeclared, ...appWide])], ['go']);
    // Neither does a stay declared on another route.
    const elsewhere = [...forwardDeclared, exitEntry('settings', 'wait', null, { kind: 'stay' })];
    assert.deepEqual([...forwardRoutes(manifest, elsewhere)], ['go']);
  });

  it('never names a rendersNothing route, a redirect or a wildcard, and reads no flag as absent', () => {
    const routes = [
      { path: 'blank', fullPath: 'blank', rendersNothing: true },
      { path: 'old', fullPath: 'old', redirectTo: 'go' },
      { path: '**', fullPath: '**' },
      // A manifest written before rendersNothing: the children render, as far as it says.
      { path: 'legacy', fullPath: 'legacy', children: [{ path: ':tab', fullPath: 'legacy/:tab' }] },
    ];
    const declared = ['blank', 'old', '**', 'legacy'].map((r) => exitEntry(r, 'away', 'x'));
    assert.deepEqual([...forwardRoutes({ routes }, declared)], []);
    assert.deepEqual([...forwardRoutes(undefined, declared)], []);
  });

  it('pageRoutes drops the rendersNothing rows and a forward’s subtree, from flags or from declared', () => {
    // `leaf` is a forward without children: it is a checked row itself, and no page.
    const leaf = { path: 'leaf', fullPath: 'leaf' };
    const routes = [
      forwardLayout,
      layoutOverPage,
      leaf,
      { path: 'projects', fullPath: 'projects' },
      { path: 'blank', fullPath: 'blank', rendersNothing: true },
    ];
    const declared = [...forwardDeclared, exitEntry('leaf', 'away', 'projects')];
    const paths = (rows) => rows.map((route) => route.fullPath);
    assert.deepEqual(paths(checkedRoutes({ routes })), [
      'go',
      'go/:tab',
      'settings',
      'settings/profile',
      'leaf',
      'projects',
      'blank',
    ]);
    assert.deepEqual([...forwardRoutes({ routes }, declared)], ['go', 'leaf']);
    assert.deepEqual(paths(pageRoutes({ routes }, declared)), ['settings/profile', 'projects']);
    // Without declared, the forward: true flags the writer puts in the manifest decide.
    const flagged = routes.map((route) =>
      route === forwardLayout || route === leaf ? { ...route, forward: true } : route,
    );
    assert.deepEqual(paths(pageRoutes({ routes: flagged })), ['settings/profile', 'projects']);
    // No flags and no declared: no forwards, only the rendersNothing rows go.
    assert.deepEqual(paths(pageRoutes({ routes })), ['settings/profile', 'leaf', 'projects']);
    assert.deepEqual(pageRoutes(undefined), []);
  });

  it('the freeze writer writes forward: true on the forward only, in manifest.json', () => {
    const DIR = 'src/testing/browser/freezes';
    const root = app({
      'src/app/routes/go/go.layout.ts': `import { exit, outcomes } from '@qits/angular';

export class GoLayout {
  readonly forward = outcomes(
    'forward',
    { home: exit('projects'), tab: exit('projects/:slug') },
    { triggered: false },
  );
}
`,
      'src/app/routes/settings/settings.layout.ts': `import { exit, outcomes } from '@qits/angular';

export class SettingsLayout {
  readonly away = outcomes('away', { home: exit('projects') }, { triggered: false });
}
`,
    });
    const vitest = { config: { reporters: [] } };
    const project = { config: { root, browser: { enabled: true } } };
    screenshotReferences({ freezes: true }).configureVitest({ vitest, project });
    const [reporter] = vitest.config.reporters;
    reporter.onTestRunStart([]);
    // A forward flag a stale tree carries is judged again.
    project.config.browser.commands.qitsFreezeRoutes({}, [
      forwardLayout,
      { ...layoutOverPage, forward: true },
    ]);
    reporter.onTestRunEnd([]);
    const manifest = JSON.parse(readFileSync(join(root, DIR, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.routes, [{ ...forwardLayout, forward: true }, layoutOverPage]);
    assert.deepEqual(
      manifest.outcomes.declared.filter((entry) => entry.route === 'go').map((e) => e.triggered),
      [false, false],
    );
    assert.deepEqual(
      pageRoutes(manifest).map((route) => route.fullPath),
      ['settings/profile'],
    );
  });
});

describe('qits-angular screenshots --check, the colour schemes (qits-2083)', () => {
  const PAGE = 'src/app/routes/projects/projects.page.browser.spec.ts';
  const CARD = 'src/app/ui/card/card.browser.spec.ts';
  const DIR = 'src/testing/browser/freezes';
  /** A page freeze (`route` set) of `name` at `viewport` in `colorScheme`. */
  const freeze = (name, viewport, colorScheme, extra = {}) => ({
    file: `${PAGE}/${name}.html`,
    spec: PAGE,
    test: `t ${name}`,
    name,
    kind: 'DATA',
    viewport,
    colorScheme,
    colorSchemeReason: null,
    route: 'projects',
    records: [],
    triggers: [],
    ...extra,
  });
  /** An app whose manifest holds `freezes`, and `colorSchemes` when given. */
  const withManifest = (freezes, colorSchemes) => {
    const root = app({ [PAGE]: 'spec' });
    const manifest = {
      routes: [],
      ...(colorSchemes ? { colorSchemes } : {}),
      freezes,
      byRoute: {},
      outcomes: { declared: [], fired: [] },
    };
    mkdirSync(join(root, DIR), { recursive: true });
    writeFileSync(join(root, DIR, 'manifest.json'), JSON.stringify(manifest));
    return root;
  };
  const check = (root, env = {}) => {
    const out = [];
    const err = [];
    const code = screenshots(['--check'], {
      cwd: root,
      env,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const BOTH = ['LIGHT', 'DARK'];

  it('fails on a page shot missing a scheme, per viewport, and on one taken in none', () => {
    const root = withManifest(
      [
        freeze('list', 'PHONE', 'LIGHT'),
        freeze('list', 'PHONE', 'DARK'),
        freeze('list', 'DESKTOP', 'LIGHT'),
        freeze('menu', null, null),
        // Not a page or layout shot: never held to the schemes.
        { ...freeze('card', null, 'LIGHT'), spec: CARD, route: null },
      ],
      BOTH,
    );
    const { code, err } = check(root);
    assert.equal(code, 1);
    assert.match(err, /2 page or layout shot\(s\) miss a colour scheme:/);
    assert.match(err, new RegExp(`  ${PAGE} 'list' \\[DESKTOP\\]: missing DARK\\n`));
    assert.match(err, new RegExp(`  ${PAGE} 'menu': missing LIGHT, DARK\\n`));
    assert.doesNotMatch(err, /card/);
    assert.match(err, /\{ colorSchemes: \['LIGHT'\], reason: '…' \}/);
    // An update run only lists them.
    const update = check(root, { UPDATE_SNAPSHOT: 'all' });
    assert.equal(update.code, 0);
    assert.match(update.out, /missing DARK[\s\S]*the gaps are listed only/);
  });

  it('passes a shot that opted out of a scheme with a reason, and one taken in every scheme', () => {
    const root = withManifest(
      [
        freeze('list', 'DESKTOP', 'LIGHT'),
        freeze('list', 'DESKTOP', 'DARK'),
        freeze('chart', 'DESKTOP', 'LIGHT', { colorSchemeReason: 'no dark palette yet' }),
      ],
      BOTH,
    );
    const { code, out, err } = check(root);
    assert.equal(code, 0, err);
    assert.match(out, /every page and layout shot is taken in each colour scheme \(LIGHT, DARK\)/);
  });

  it('checks nothing without colorSchemes in the manifest, or without a manifest', () => {
    const root = withManifest([freeze('list', 'DESKTOP', null)]);
    const { code, out, err } = check(root);
    assert.equal(code, 0, err);
    assert.doesNotMatch(`${out}${err}`, /colour scheme/);
    assert.equal(check(app({ [PAGE]: 'spec' })).code, 0);
  });

  it('groups by spec, test, name and viewport, reading missing keys as null', () => {
    assert.deepEqual(colorSchemeGaps(undefined), []);
    assert.deepEqual(colorSchemeGaps({ freezes: [freeze('list', null, null)] }), []);
    assert.deepEqual(
      colorSchemeGaps({
        colorSchemes: ['DARK'],
        freezes: [
          freeze('list', null, 'DARK'),
          // Another test of the same name is its own group; a freeze without the keys has none.
          { ...freeze('list', null, 'LIGHT'), test: 'other' },
          { file: 'x', spec: PAGE, test: 't', name: 'old', route: 'projects' },
        ],
      }),
      [`${PAGE} 'list': missing DARK`, `${PAGE} 'old': missing DARK`],
    );
  });
});
