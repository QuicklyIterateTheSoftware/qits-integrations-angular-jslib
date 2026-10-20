/// <reference types="node" />
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPactPart } from './pact-part';

const UPDATE = 'QITS_TEST_PART_UPDATE';

/** An interaction as `addGoldenInteraction` writes it, reduced to what the part reads. */
function interaction(
  operationId: string,
  ui: string,
  { name = 'a', version }: { name?: string; version?: string } = {},
) {
  return {
    description: `${ui}: ${operationId}`,
    providerStates: [{ name: 'a thing exists' }],
    comments: {
      references: {
        'qits-call': { app: 'qits-demo-service', operationId },
        'qits-trigger': { kind: 'ui', app: 'qits-demo-app', interaction: ui },
        ...(version
          ? {
              'qits-via': { repository: 'qits-demo-jslib', artifact: '@qits/demo', version },
            }
          : {}),
      },
    },
    response: { body: { name } },
  };
}

const pact = (metadata: string, ...interactions: object[]) => ({
  consumer: { name: 'qits-demo-app' },
  provider: { name: 'qits-demo-service' },
  metadata: { v: metadata },
  interactions,
});

describe('assertPactPart', () => {
  let root: string;
  let generated: string;
  let committed: string;
  const write = (file: string, content: object) => writeFileSync(file, JSON.stringify(content));
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const update = (body: () => void) => {
    process.env[UPDATE] = 'true';
    try {
      body();
    } finally {
      delete process.env[UPDATE];
    }
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qits-part-'));
    generated = join(root, 'generated.json');
    committed = join(root, 'pacts', 'committed.json');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes, then checks, only the operations the spec owns, ignoring metadata and order', () => {
    // Another spec's part is already committed.
    update(() => {
      write(generated, pact('1', interaction('listThings', 'list')));
      assertPactPart(generated, committed, ['listThings'], UPDATE);
      write(generated, pact('1', interaction('getThing', 'open'), interaction('getThing', 'edit')));
      assertPactPart(generated, committed, ['getThing'], UPDATE);
    });
    expect(read(committed).interactions.map((i: { description: string }) => i.description)).toEqual(
      ['edit: getThing', 'list: listThings', 'open: getThing'],
    );
    expect(existsSync(`${committed}.lock`)).toBe(false);

    write(generated, pact('2', interaction('getThing', 'open'), interaction('getThing', 'edit')));
    expect(() => assertPactPart(generated, committed, ['getThing'], UPDATE)).not.toThrow();
    write(generated, pact('1', interaction('getThing', 'open', { name: 'b' })));
    expect(() => assertPactPart(generated, committed, ['getThing'], UPDATE)).toThrow(
      /differs from what this spec generates for getThing/,
    );
  });

  it('owns an operation for the named UI interactions only', () => {
    update(() => {
      write(generated, pact('1', interaction('getThing', 'open'), interaction('getThing', 'edit')));
      assertPactPart(generated, committed, ['getThing'], UPDATE);
    });
    write(generated, pact('1', interaction('getThing', 'open')));
    const owned = [{ operationId: 'getThing', interactions: ['open'] }];
    expect(() => assertPactPart(generated, committed, owned, UPDATE)).not.toThrow();
    // A spec that made an interaction it does not own is refused.
    write(generated, pact('1', interaction('getThing', 'edit')));
    expect(() => assertPactPart(generated, committed, owned, UPDATE)).toThrow(
      /made interactions for operations it does not own/,
    );
  });

  it('fails when nothing is committed', () => {
    write(generated, pact('1', interaction('getThing', 'open')));
    expect(() => assertPactPart(generated, committed, ['getThing'], UPDATE)).toThrow(
      /does not exist/,
    );
  });

  it('rewrites its part on a difference in the qits-via version alone, and says so', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const other = interaction('listThings', 'list', { version: '1' });
    update(() => {
      write(generated, pact('1', other));
      assertPactPart(generated, committed, ['listThings'], UPDATE);
      write(generated, pact('1', interaction('getThing', 'open', { version: '1' })));
      assertPactPart(generated, committed, ['getThing'], UPDATE);
    });

    write(generated, pact('1', interaction('getThing', 'open', { version: '2' })));
    expect(() => assertPactPart(generated, committed, ['getThing'], UPDATE)).not.toThrow();
    expect(info).toHaveBeenCalledWith(`qits-via version refreshed 1 → 2 (${committed})`);
    // Its own part carries the new version; another spec's part is left as it was.
    expect(read(committed).interactions).toEqual([
      other,
      interaction('getThing', 'open', { version: '2' }),
    ]);

    write(generated, pact('1', interaction('getThing', 'open', { version: '3', name: 'b' })));
    expect(() => assertPactPart(generated, committed, ['getThing'], UPDATE)).toThrow(/differs/);
  });
});
