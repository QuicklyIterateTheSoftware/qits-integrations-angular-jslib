import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { CLIENTS_SCHEMA, clientMatcher, importVisitors, isStore } from '../project.mjs';

/**
 * A store that imports a generated client has its pact spec beside it: `x.store.ts` needs
 * `x.store.pact.spec.ts`. The pact spec is where the store's calls are recorded against the
 * provider's golden masters.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'A store that imports a generated client has a sibling <name>.pact.spec.ts.',
    },
    schema: [CLIENTS_SCHEMA],
    messages: {
      noPact: "This store calls '{{specifier}}' but has no pact spec: add {{pact}} beside it.",
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    if (!isStore(file)) return {};
    const clients = clientMatcher(context);
    const pact = file.replace(/\.([mc]?[jt]s)$/, '.pact.spec.$1');
    let reported = false;
    return importVisitors((node, specifier) => {
      if (reported || !clients.isClient(specifier) || existsSync(pact)) return;
      reported = true;
      context.report({ node, messageId: 'noPact', data: { specifier, pact: basename(pact) } });
    });
  },
};
