/// <reference types="node" />
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PactV4 } from '@pact-foundation/pact';
import {
  addGoldenInteraction,
  assertPactFile,
  examplePath,
  goldenMasters,
} from './golden-master-pact';

const PACKAGE = '@qits/demo-golden-masters';
const ID = '00000000-0000-4000-8000-000000000001';

/** A throwaway project holding a golden-master package in its node_modules. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'qits-golden-'));
  const tree = join(root, 'node_modules', PACKAGE, 'golden-masters');
  mkdirSync(tree, { recursive: true });
  const index = {
    formatVersion: 1,
    provider: 'qits-demo',
    states: [
      {
        name: 'a thing exists',
        params: { thingId: ID },
        operations: [
          {
            operationId: 'getThing',
            method: 'GET',
            path: '/things/{thingId}',
            status: 200,
            file: 'get-thing.json',
            frozen: { ids: ['$.id'], instants: ['$.created'] },
          },
          {
            operationId: 'listThings',
            method: 'GET',
            path: '/things',
            status: 200,
            file: 'list-things.json',
            frozen: { ids: ['$.entries[*].id'], listFilteredTo: '$.entries' },
          },
        ],
      },
    ],
  };
  writeFileSync(join(tree, 'index.json'), JSON.stringify(index));
  writeFileSync(
    join(tree, 'get-thing.json'),
    JSON.stringify({ id: ID, name: 'a', created: '2026-01-01T00:00:00Z', backup: null }),
  );
  writeFileSync(join(tree, 'list-things.json'), JSON.stringify({ entries: [{ id: ID, size: 3 }] }));
  return root;
}

describe('golden-master-pact', () => {
  let root: string;
  beforeEach(() => (root = project()));
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads a recorded answer, a fresh copy every call', () => {
    const masters = goldenMasters(PACKAGE, 'qits-demo', join(root, 'src'));
    const body = masters.body('a thing exists', 'getThing');
    body.name = 'changed';
    expect(masters.body('a thing exists', 'getThing').name).toBe('a');
    expect(examplePath(masters.operation('a thing exists', 'getThing'))).toBe(`/things/${ID}`);
  });

  it('refuses another provider, and an unknown operation', () => {
    expect(() =>
      goldenMasters(PACKAGE, 'qits-other', root).body('a thing exists', 'getThing'),
    ).toThrow(/qits-demo's golden masters, not qits-other's/);
    expect(() =>
      goldenMasters(PACKAGE, 'qits-demo', root).operation('a thing exists', 'nope'),
    ).toThrow(/record no 'nope'/);
  });

  it('writes interactions with references, provider states and matchers from the frozen lists', async () => {
    const masters = goldenMasters(PACKAGE, 'qits-demo', root);
    const dir = join(root, 'pacts');
    const pact = new PactV4({
      consumer: 'qits-demo-app',
      provider: 'qits-demo-service',
      dir,
      logLevel: 'warn',
    });
    const trigger = { kind: 'ui', app: 'qits-demo-app', interaction: 'open-thing' } as const;
    const common = { provider: 'qits-demo-service', state: 'a thing exists', trigger };
    await addGoldenInteraction(pact, masters, { ...common, operationId: 'getThing' }).executeTest(
      async (server) => expect((await fetch(`${server.url}/things/${ID}`)).status).toBe(200),
    );
    await addGoldenInteraction(pact, masters, { ...common, operationId: 'listThings' }).executeTest(
      async (server) => expect((await fetch(`${server.url}/things`)).status).toBe(200),
    );

    const written = JSON.parse(
      readFileSync(join(dir, 'qits-demo-app-qits-demo-service.json'), 'utf8'),
    );
    const get = written.interactions.find(
      (i: { description: string }) => i.description === 'open-thing: getThing',
    );
    const list = written.interactions.find(
      (i: { description: string }) => i.description === 'open-thing: listThings',
    );
    expect(get.comments.references).toEqual({
      'qits-call': { app: 'qits-demo-service', operationId: 'getThing' },
      'qits-trigger': { kind: 'ui', app: 'qits-demo-app', interaction: 'open-thing' },
    });
    expect(get.providerStates).toEqual([{ name: 'a thing exists', params: { thingId: ID } }]);
    expect(get.request.generators.path.expression).toBe('/things/${thingId}');
    expect(list.request.generators).toBeUndefined();
    const rules = get.response.matchingRules.body;
    expect(rules['$.id'].matchers[0].match).toBe('regex');
    expect(rules['$.created'].matchers[0].match).toBe('regex');
    expect(rules['$.name'].matchers[0].match).toBe('type');
    expect(rules['$.backup']).toBeUndefined();
    expect(list.response.matchingRules.body['$.entries'].matchers[0]).toMatchObject({ min: 1 });
  });

  it('compares the written pact with the committed one, ignoring metadata and order', () => {
    const generated = join(root, 'generated.json');
    const committed = join(root, 'pacts', 'committed.json');
    const pact = (metadata: string, ...descriptions: string[]) =>
      JSON.stringify({
        metadata: { v: metadata },
        interactions: descriptions.map((description) => ({ description })),
      });
    writeFileSync(generated, pact('1', 'a', 'b'));

    expect(() => assertPactFile(generated, committed, 'QITS_TEST_UPDATE')).toThrow(
      /does not exist/,
    );
    process.env['QITS_TEST_UPDATE'] = 'true';
    try {
      assertPactFile(generated, committed, 'QITS_TEST_UPDATE');
    } finally {
      delete process.env['QITS_TEST_UPDATE'];
    }
    writeFileSync(committed, pact('2', 'b', 'a'));
    expect(() => assertPactFile(generated, committed, 'QITS_TEST_UPDATE')).not.toThrow();
    writeFileSync(committed, pact('1', 'a'));
    expect(() => assertPactFile(generated, committed, 'QITS_TEST_UPDATE')).toThrow(/differs/);
  });
});
