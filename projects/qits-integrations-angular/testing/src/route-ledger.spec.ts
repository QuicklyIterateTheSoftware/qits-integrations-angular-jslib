/// <reference types="node" />
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  goldenMasterRoutes,
  routeLedger,
  type GoldenMasterRoutes,
  type RouteLedgerTestModule,
  type RouteRecord,
} from './route-ledger';

const LIST = 'src/app/routes/list.page.browser.spec.ts';
const BOARD = 'src/app/routes/board.page.browser.spec.ts';
const LEDGER = 'src/testing/browser/routes.json';

const record = (state: string, route: string, operationId = 'listThings'): RouteRecord => ({
  provider: 'qits-demo-service',
  state,
  operationId,
  route,
});

/** A stand-in for Vitest's `TestModule`: the module's state and its tests' states. */
const testModule = (
  moduleId: string,
  state = 'passed',
  tests: readonly string[] = ['passed'],
  errors: readonly unknown[] = [],
): RouteLedgerTestModule => ({
  moduleId,
  state: () => state,
  errors: () => errors,
  children: { allTests: () => tests.map((s) => ({ result: () => ({ state: s }) })) },
});

describe('the route ledger', () => {
  let root: string;
  let ledger: string;
  let routes: GoldenMasterRoutes;
  const spec = (path: string) => ({ testPath: join(root, path) });
  const passed = (path: string) => testModule(join(root, path));
  const written = () => readFileSync(ledger, 'utf8');
  /** One run: each spec file sends its records, then the run ends with every file passed. */
  const run = (...files: [path: string, records: RouteRecord[]][]) => {
    routes.reporter.onTestRunStart();
    for (const [path, records] of files) routes(spec(path), records);
    routes.reporter.onTestRunEnd(files.map(([path]) => passed(path)));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qits-routes-'));
    mkdirSync(join(root, 'src/app/routes'), { recursive: true });
    for (const file of [LIST, BOARD]) writeFileSync(join(root, file), '');
    ledger = join(root, LEDGER);
    routes = goldenMasterRoutes(LEDGER, root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes a spec’s records sorted, without duplicates, as stable JSON', () => {
    run([
      LIST,
      [
        record('b', 'things'),
        record('a', 'things/:id'),
        record('a', 'things'),
        record('b', 'things'),
      ],
    ]);
    const expected = {
      [LIST]: [record('a', 'things'), record('a', 'things/:id'), record('b', 'things')],
    };
    expect(written()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  it('writes nothing on a call alone', () => {
    routes(spec(LIST), [record('a', 'things')]);
    expect(existsSync(ledger)).toBe(false);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  it('replaces a staged list on a second call for the same spec', () => {
    routes.reporter.onTestRunStart();
    routes(spec(LIST), [record('a', 'things')]);
    routes(spec(LIST), [record('b', 'things')]);
    routes.reporter.onTestRunEnd([passed(LIST)]);
    expect(JSON.parse(written())).toEqual({ [LIST]: [record('b', 'things')] });
  });

  it('replaces only the sections of the specs that ran, keys sorted', () => {
    run([LIST, [record('a', 'things')]], [BOARD, [record('a', 'boards/:id')]]);
    run([LIST, [record('c', 'things')]]);
    const file = JSON.parse(written());
    expect(Object.keys(file)).toEqual([BOARD, LIST]);
    expect(file[BOARD]).toEqual([record('a', 'boards/:id')]);
    expect(file[LIST]).toEqual([record('c', 'things')]);
  });

  it('removes the section of a passing spec that recorded nothing', () => {
    run([LIST, [record('a', 'things')]], [BOARD, [record('a', 'boards/:id')]]);
    run([LIST, []]);
    expect(Object.keys(JSON.parse(written()))).toEqual([BOARD]);
  });

  it('removes the section of a passing spec that staged nothing', () => {
    run([LIST, [record('a', 'things')]], [BOARD, [record('a', 'boards/:id')]]);
    routes.reporter.onTestRunStart();
    routes.reporter.onTestRunEnd([passed(LIST)]);
    expect(Object.keys(JSON.parse(written()))).toEqual([BOARD]);
  });

  it('keeps the section of a spec whose test failed', () => {
    run([LIST, [record('a', 'things')]]);
    routes.reporter.onTestRunStart();
    routes(spec(LIST), []);
    routes.reporter.onTestRunEnd([testModule(join(root, LIST), 'failed', ['passed', 'failed'])]);
    expect(JSON.parse(written())).toEqual({ [LIST]: [record('a', 'things')] });
  });

  it('keeps the section of a spec with a skipped test', () => {
    run([LIST, [record('a', 'things'), record('a', 'things/:id')]]);
    routes.reporter.onTestRunStart();
    routes(spec(LIST), [record('a', 'things')]);
    routes.reporter.onTestRunEnd([testModule(join(root, LIST), 'passed', ['passed', 'skipped'])]);
    expect(JSON.parse(written())).toEqual({
      [LIST]: [record('a', 'things'), record('a', 'things/:id')],
    });
  });

  it('keeps the section of a spec whose beforeAll failed', () => {
    run([LIST, [record('a', 'things')]]);
    routes.reporter.onTestRunStart();
    routes(spec(LIST), []);
    routes.reporter.onTestRunEnd([
      testModule(join(root, LIST), 'failed', ['skipped', 'skipped'], [new Error('beforeAll')]),
    ]);
    expect(JSON.parse(written())).toEqual({ [LIST]: [record('a', 'things')] });
  });

  it('leaves the file byte-identical when every spec failed', () => {
    run(
      [LIST, [record('b', 'things'), record('a', 'things/:id', 'getThing')]],
      [BOARD, [record('a', 'boards/:id'), record('a', 'things')]],
    );
    const before = written();
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(ledger, old, old);
    routes.reporter.onTestRunStart();
    routes(spec(LIST), []);
    routes(spec(BOARD), []);
    routes.reporter.onTestRunEnd([
      testModule(join(root, LIST), 'failed', ['skipped']),
      testModule(join(root, BOARD), 'failed', ['skipped']),
    ]);
    expect(written()).toBe(before);
    expect(statSync(ledger).mtimeMs).toBe(old.getTime());
  });

  it('forgets what was staged when a run starts', () => {
    run([LIST, [record('a', 'things')]], [BOARD, [record('a', 'boards/:id')]]);
    routes(spec(LIST), [record('z', 'stale')]);
    routes.reporter.onTestRunStart();
    routes.reporter.onTestRunEnd([passed(LIST)]);
    expect(Object.keys(JSON.parse(written()))).toEqual([BOARD]);
  });

  it('writes no file for a first spec that recorded nothing', () => {
    run([LIST, []]);
    expect(existsSync(ledger)).toBe(false);
  });

  it('drops the sections of spec files that no longer exist', () => {
    run([BOARD, [record('a', 'boards/:id')]]);
    rmSync(join(root, BOARD));
    run([LIST, [record('a', 'things')]]);
    expect(Object.keys(JSON.parse(written()))).toEqual([LIST]);
  });

  it('leaves the file untouched when nothing changed', () => {
    run([LIST, [record('a', 'things')]]);
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(ledger, old, old);
    run([LIST, [record('a', 'things'), record('a', 'things')]]);
    expect(statSync(ledger).mtimeMs).toBe(old.getTime());
  });

  it('keys a section by the spec’s path relative to the root, with / separators', () => {
    routes.reporter.onTestRunStart();
    routes({ testPath: LIST }, [record('a', 'things')]);
    routes.reporter.onTestRunEnd([passed(LIST)]);
    expect(Object.keys(JSON.parse(written()))).toEqual([LIST]);
  });

  it('refuses a call outside a test file', () => {
    expect(() => routes({ testPath: undefined }, [])).toThrow(/outside a test file/);
  });

  it('adds its reporter to the Vitest run once', () => {
    const reporters: unknown[] = ['default'];
    routes.plugin.configureVitest({ vitest: { config: { reporters } } });
    routes.plugin.configureVitest({ vitest: { config: { reporters } } });
    expect(routes.plugin.name).toBe('qits:route-ledger');
    expect(reporters).toEqual(['default', routes.reporter]);
  });

  it('reads the routes of an interaction across every section', () => {
    run(
      [LIST, [record('a', 'things'), record('a', 'things/:id', 'getThing')]],
      [BOARD, [record('a', 'boards/:id'), record('a', 'things')]],
    );
    const lookup = routeLedger(ledger);
    expect(lookup('qits-demo-service', 'a', 'listThings')).toEqual(['boards/:id', 'things']);
    expect(lookup('qits-demo-service', 'a', 'getThing')).toEqual(['things/:id']);
    expect(lookup('qits-other-service', 'a', 'listThings')).toEqual([]);
    expect(lookup('qits-demo-service', 'b', 'listThings')).toEqual([]);
  });

  it('reads no routes without a ledger', () => {
    expect(routeLedger(join(root, 'nope.json'))('qits-demo-service', 'a', 'listThings')).toEqual(
      [],
    );
  });
});
