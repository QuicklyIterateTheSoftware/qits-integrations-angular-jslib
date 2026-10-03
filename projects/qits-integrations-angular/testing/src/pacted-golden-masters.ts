/// <reference types="node" />
/**
 * Golden masters a screenshot may show only when the provider verifies them (epic qits-112): a body
 * is given out only when an interaction in the consumer's committed pact uses its provider state
 * and operation. Node-side: call it where the browser command reads the golden masters
 * (`vitest-browser.config.ts`), as the browser cannot read files.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { GoldenMasters } from './golden-master-pact';

interface PactFile {
  provider?: { name?: string };
  interactions?: {
    providerStates?: { name: string }[];
    comments?: { references?: { 'qits-call'?: { operationId?: string } } };
  }[];
}

/**
 * `masters`, with `body(state, operationId)` refusing an answer that no interaction in `pactFile`
 * (the committed `pacts/<consumer>_<provider>.json`) uses: same provider state, same
 * `qits-call` operationId. So every body a screenshot shows is one the provider verifies. The pact
 * is read on every call, so a regenerated one counts at once.
 */
export function pactedGoldenMasters(masters: GoldenMasters, pactFile: string): GoldenMasters {
  return {
    operation: (state, operationId) => masters.operation(state, operationId),
    body: (state, operationId) => {
      if (!existsSync(pactFile)) {
        throw new Error(
          `no pact at ${pactFile}, so no golden master from it is verified. Add the consumer's ` +
            `pact spec next to the store with an interaction for provider state '${state}', ` +
            `operationId '${operationId}', and generate and commit the pact (QITS_GOLDEN_UPDATE=true).`,
        );
      }
      const pact = JSON.parse(readFileSync(pactFile, 'utf8')) as PactFile;
      const provider = pact.provider?.name ?? '<provider repository>';
      const used = (pact.interactions ?? []).some(
        (i) =>
          i.comments?.references?.['qits-call']?.operationId === operationId &&
          (i.providerStates ?? []).some((s) => s.name === state),
      );
      if (!used) {
        throw new Error(
          `golden master '${state}' / ${operationId} is in no interaction of ${pactFile}, so ` +
            `${provider} does not verify it. Add a pact interaction for it in the consumer’s pact ` +
            `spec next to the store (provider state '${state}', operationId '${operationId}'), ` +
            'regenerate the pact (QITS_GOLDEN_UPDATE=true) and commit it. If no recorded state ' +
            `fits this case, add a provider state to ${provider} (ProviderStates + golden-master ` +
            'recorder), record it, and add a pact interaction for it in the same way, so the ' +
            `provider verifies it. Then answer with goldenMaster('<new state>', '${operationId}').`,
        );
      }
      return masters.body(state, operationId);
    },
  };
}
