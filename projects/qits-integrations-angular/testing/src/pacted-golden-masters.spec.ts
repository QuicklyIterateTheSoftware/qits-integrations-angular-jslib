/// <reference types="node" />
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoldenMasters } from './golden-master-pact';
import { pactedGoldenMasters } from './pacted-golden-masters';

describe('pactedGoldenMasters', () => {
  let dir: string;
  let pact: string;
  const masters = {
    operation: () => {
      throw new Error('not used');
    },
    body: (state: string, operationId: string) => ({ state, operationId }),
  } as unknown as GoldenMasters;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qits-pacted-'));
    pact = join(dir, 'qits-demo-app_qits-demo-service.json');
    writeFileSync(
      pact,
      JSON.stringify({
        consumer: { name: 'qits-demo-app' },
        provider: { name: 'qits-demo-service' },
        interactions: [
          {
            providerStates: [{ name: 'a thing exists' }],
            comments: { references: { 'qits-call': { operationId: 'getThing' } } },
          },
        ],
      }),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('gives a body the pact uses', () => {
    expect(pactedGoldenMasters(masters, pact).body('a thing exists', 'getThing')).toEqual({
      state: 'a thing exists',
      operationId: 'getThing',
    });
  });

  it('refuses a state or an operation no interaction uses, and says how to fix it', () => {
    const pacted = pactedGoldenMasters(masters, pact);
    expect(() => pacted.body('no thing exists', 'getThing')).toThrow(
      /'no thing exists' \/ getThing is in no interaction of .*, so qits-demo-service does not verify it\. Add a pact interaction/,
    );
    expect(() => pacted.body('a thing exists', 'listThings')).toThrow(
      /add a provider state to qits-demo-service \(ProviderStates \+ golden-master recorder\)/,
    );
  });

  it('refuses everything without a committed pact', () => {
    expect(() =>
      pactedGoldenMasters(masters, join(dir, 'missing.json')).body('a thing exists', 'getThing'),
    ).toThrow(/no pact at .*missing\.json/);
  });
});
