import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  CLIENTS_SCHEMA,
  clientMatcher,
  importVisitors,
  isOperations,
  isStore,
} from '../project.mjs';

/**
 * A store or operations file that imports a generated client has its pact spec beside it:
 * `x.store.ts` needs `x.store.pact.spec.ts`, `x.operations.ts` needs `x.operations.pact.spec.ts`.
 * The pact spec is where the file's calls are recorded against the provider's golden masters.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A store or operations file that imports a generated client has a sibling <name>.pact.spec.ts.',
    },
    schema: [CLIENTS_SCHEMA],
    messages: {
      noPact: "This {{kind}} calls '{{specifier}}' but has no pact spec: add {{pact}} beside it.",
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    const kind = isStore(file) ? 'store' : isOperations(file) ? 'operations file' : undefined;
    if (!kind) return {};
    const clients = clientMatcher(context);
    const pact = file.replace(/\.([mc]?[jt]s)$/, '.pact.spec.$1');
    let reported = false;
    return importVisitors((node, specifier) => {
      if (reported || !clients.isClient(specifier) || existsSync(pact)) return;
      reported = true;
      context.report({
        node,
        messageId: 'noPact',
        data: { kind, specifier, pact: basename(pact) },
      });
    });
  },
};
