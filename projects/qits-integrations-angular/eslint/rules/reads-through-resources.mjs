import {
  CLIENTS_SCHEMA,
  DEFAULT_CLIENTS,
  clientMatcher,
  isOperations,
  isSpec,
  resolveStore,
  storeImportsClient,
} from '../project.mjs';

/**
 * A component reads API data through `qitsResource(OP, () => params)` and writes through
 * `qitsMutation(OP)`, where `OP` is a `qitsOperation(...)` declared in a `*.operations.ts` file.
 * The operation names the paths it consumes and its pact spec binds them, so a page that goes
 * through operations cannot read a field no pact covers. Three ways round that are reported:
 *
 * - using a generated client function directly, called or not (a type from a client is fine);
 * - declaring a `qitsOperation(...)` anywhere but a `*.operations.ts` file, where no pact spec
 *   stands beside it;
 * - `inject(X)` of a store that itself imports a generated client: the data then arrives through
 *   the store's calls rather than an operation. A store that imports no client (UI state only)
 *   is fine. `X`'s import is followed, relative or through a tsconfig path alias (`$core/…`), to a
 *   `*.store.ts` file on disk.
 *
 * An app moves to operations one route at a time, so this rule is not in `recommended`: the app
 * turns it on with a `files` glob for each route that has moved. Specs and the generated clients
 * themselves are never covered, and in an operations file the client functions are
 * consume-client-calls' business.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reads go through qitsResource and writes through qitsMutation, with an operation from a *.operations.ts file; no generated client and no client-calling store.',
    },
    schema: [
      {
        ...CLIENTS_SCHEMA,
        properties: { ...CLIENTS_SCHEMA.properties, operation: { type: 'string' } },
      },
    ],
    messages: {
      clientCall:
        "'{{name}}' is a generated client function: read through qitsResource and write through qitsMutation, with an operation from a *.operations.ts file.",
      operationHere:
        '{{operation}}(...) declares an operation: declare it in a *.operations.ts file, beside its pact spec, and import it from there.',
      storeRead:
        "'{{name}}' is a store that calls a generated client: read API data through qitsResource, not a store.",
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    if (isSpec(file)) return {};
    const clients = clientMatcher(context);
    if (clients.inClients) return {};
    const globs = context.options[0]?.clients ?? DEFAULT_CLIENTS;
    const operation = context.options[0]?.operation ?? 'qitsOperation';
    const operations = isOperations(file);
    const source = context.sourceCode;

    /** `typeof getX` in a type calls nothing. */
    const inTypeQuery = (id) => {
      for (let node = id.parent; node?.type.startsWith('TS'); node = node.parent) {
        if (node.type === 'TSTypeQuery') return true;
      }
      return false;
    };

    /** Every value use of a binding imported from a client; `api.getX` on a namespace as a whole. */
    const reportUses = (variable, namespace) => {
      for (const ref of variable.references) {
        const id = ref.identifier;
        if (ref.isValueReference === false || inTypeQuery(id)) continue;
        if (id.parent?.type === 'ImportSpecifier' || id.parent?.type === 'ImportNamespaceSpecifier')
          continue;
        const member = id.parent;
        const target =
          namespace && member?.type === 'MemberExpression' && member.object === id ? member : id;
        const name = target === id ? id.name : source.getText(target);
        context.report({ node: target, messageId: 'clientCall', data: { name } });
      }
    };

    /** The value import an identifier resolves to, as its declaration, or undefined. */
    const valueImport = (id) => {
      const ref = source.getScope(id).references.find((r) => r.identifier === id);
      const def = ref?.resolved?.defs[0];
      if (def?.type !== 'ImportBinding') return undefined;
      if (def.parent.importKind === 'type' || def.node.importKind === 'type') return undefined;
      return def.parent;
    };

    return {
      ImportDeclaration(node) {
        if (operations || node.importKind === 'type') return;
        if (typeof node.source.value !== 'string' || !clients.isClient(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.importKind === 'type') continue;
          for (const variable of source.getDeclaredVariables(specifier)) {
            reportUses(variable, specifier.type === 'ImportNamespaceSpecifier');
          }
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return;
        if (node.callee.name === operation && !operations) {
          context.report({ node, messageId: 'operationHere', data: { operation } });
          return;
        }
        const [arg] = node.arguments;
        if (node.callee.name !== 'inject' || arg?.type !== 'Identifier') return;
        const declaration = valueImport(arg);
        if (typeof declaration?.source.value !== 'string') return;
        const store = resolveStore(file, declaration.source.value);
        if (store && storeImportsClient(store, globs, context.cwd)) {
          context.report({ node: arg, messageId: 'storeRead', data: { name: arg.name } });
        }
      },
    };
  },
};
