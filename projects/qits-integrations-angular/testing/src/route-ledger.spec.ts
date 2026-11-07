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
import { goldenMasterRoutes, routeLedger, type RouteRecord } from './route-ledger';

const LIST = 'src/app/routes/list.page.browser.spec.ts';
const BOARD = 'src/app/routes/board.page.browser.spec.ts';

const record = (state: string, route: string, operationId = 'listThings'): RouteRecord => ({
  provider: 'qits-demo-service',
  state,
  operationId,
  route,
});

describe('the route ledger', () => {
  let root: string;
  let ledger: string;
  const spec = (path: string) => ({ testPath: join(root, path) });
  const written = () => readFileSync(ledger, 'utf8');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qits-routes-'));
    mkdirSync(join(root, 'src/app/routes'), { recursive: true });
    for (const file of [LIST, BOARD]) writeFileSync(join(root, file), '');
    ledger = join(root, 'src/testing/browser/routes.json');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes a spec’s records sorted, without duplicates, as stable JSON', () => {
    const write = goldenMasterRoutes('src/testing/browser/routes.json', root);
    write(spec(LIST), [
      record('b', 'things'),
      record('a', 'things/:id'),
      record('a', 'things'),
      record('b', 'things'),
    ]);
    const expected = {
      [LIST]: [record('a', 'things'), record('a', 'things/:id'), record('b', 'things')],
    };
    expect(written()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  it('replaces only the calling spec’s section, keys sorted', () => {
    const write = goldenMasterRoutes('src/testing/browser/routes.json', root);
    write(spec(LIST), [record('a', 'things')]);
    write(spec(BOARD), [record('a', 'boards/:id')]);
    write(spec(LIST), [record('c', 'things')]);
    const file = JSON.parse(written());
    expect(Object.keys(file)).toEqual([BOARD, LIST]);
    expect(file[BOARD]).toEqual([record('a', 'boards/:id')]);
    expect(file[LIST]).toEqual([record('c', 'things')]);
  });

  it('removes the section of a spec that recorded nothing', () => {
    const write = goldenMasterRoutes('src/testing/browser/routes.json', root);
    write(spec(LIST), [record('a', 'things')]);
    write(spec(BOARD), [record('a', 'boards/:id')]);
    write(spec(LIST), []);
    expect(Object.keys(JSON.parse(written()))).toEqual([BOARD]);
  });

  it('writes no file for a first spec that recorded nothing', () => {
    goldenMasterRoutes('src/testing/browser/routes.json', root)(spec(LIST), []);
    expect(existsSync(ledger)).toBe(false);
  });

  it('drops the sections of spec files that no longer exist', () => {
    const write = goldenMasterRoutes('src/testing/browser/routes.json', root);
    write(spec(BOARD), [record('a', 'boards/:id')]);
    rmSync(join(root, BOARD));
    write(spec(LIST), [record('a', 'things')]);
    expect(Object.keys(JSON.parse(written()))).toEqual([LIST]);
  });

  it('leaves the file untouched when nothing changed', () => {
    const write = goldenMasterRoutes('src/testing/browser/routes.json', root);
    write(spec(LIST), [record('a', 'things')]);
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(ledger, old, old);
    write(spec(LIST), [record('a', 'things'), record('a', 'things')]);
    expect(statSync(ledger).mtimeMs).toBe(old.getTime());
  });

  it('keys a section by the spec’s path relative to the root, with / separators', () => {
    goldenMasterRoutes('src/testing/browser/routes.json', root)({ testPath: LIST }, [
      record('a', 'things'),
    ]);
    expect(Object.keys(JSON.parse(written()))).toEqual([LIST]);
  });

  it('refuses a call outside a test file', () => {
    expect(() =>
      goldenMasterRoutes('src/testing/browser/routes.json', root)({ testPath: undefined }, []),
    ).toThrow(/outside a test file/);
  });

  it('reads the routes of an interaction across every section', () => {
    const write = goldenMasterRoutes('src/testing/browser/routes.json', root);
    write(spec(LIST), [record('a', 'things'), record('a', 'things/:id', 'getThing')]);
    write(spec(BOARD), [record('a', 'boards/:id'), record('a', 'things')]);
    const routes = routeLedger(ledger);
    expect(routes('qits-demo-service', 'a', 'listThings')).toEqual(['boards/:id', 'things']);
    expect(routes('qits-demo-service', 'a', 'getThing')).toEqual(['things/:id']);
    expect(routes('qits-other-service', 'a', 'listThings')).toEqual([]);
    expect(routes('qits-demo-service', 'b', 'listThings')).toEqual([]);
  });

  it('reads no routes without a ledger', () => {
    expect(routeLedger(join(root, 'nope.json'))('qits-demo-service', 'a', 'listThings')).toEqual(
      [],
    );
  });
});
