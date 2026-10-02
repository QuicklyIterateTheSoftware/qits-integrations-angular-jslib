import {
  CLIENTS_SCHEMA,
  clientMatcher,
  globRegex,
  importVisitors,
  isSpec,
  isStore,
} from '../project.mjs';

/** Files that wire a client up (base URL, interceptors) without calling it. */
export const DEFAULT_ALLOW = ['src/app/app.config*.ts', 'src/main*.ts'];

/**
 * Only stores (and specs) import a generated client. Every other call to a backend goes through a
 * store, so the store's pact spec covers every call the app makes. Type-only imports are fine, and
 * so are the files in `allow`, which set the client up.
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Only *.store.ts files and specs may import a generated client.' },
    schema: [
      {
        ...CLIENTS_SCHEMA,
        properties: {
          ...CLIENTS_SCHEMA.properties,
          allow: { type: 'array', items: { type: 'string' } },
        },
      },
    ],
    messages: {
      notAStore:
        "'{{specifier}}' is a generated client. Only a *.store.ts file may call it: move the call into a store.",
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    if (isStore(file) || isSpec(file)) return {};
    const clients = clientMatcher(context);
    const allow = (context.options[0]?.allow ?? DEFAULT_ALLOW).map(globRegex);
    if (clients.inClients || allow.some((g) => g.test(clients.file))) return {};
    return importVisitors((node, specifier) => {
      if (clients.isClient(specifier)) {
        context.report({ node, messageId: 'notAStore', data: { specifier } });
      }
    });
  },
};
