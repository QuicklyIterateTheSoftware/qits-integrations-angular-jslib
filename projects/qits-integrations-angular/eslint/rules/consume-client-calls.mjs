import { CLIENTS_SCHEMA, clientMatcher, isStore } from '../project.mjs';

/**
 * In a store, every call to a generated client goes straight into `consume(call, paths)`: the
 * call is its first argument, nothing in between. `consume` narrows the answer to the paths the
 * store reads, and the store's pact spec binds the same paths, so what the store reads and what the
 * pact binds cannot drift. Any other use of a client function — awaited on its own, `.then`,
 * passed elsewhere, or a `…Resource` helper, which is no promise to wrap — is reported.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'In a store, every generated client call is the first argument of consume(call, paths).',
    },
    schema: [
      {
        ...CLIENTS_SCHEMA,
        properties: { ...CLIENTS_SCHEMA.properties, consume: { type: 'string' } },
      },
    ],
    messages: {
      unwrapped:
        "'{{name}}' is a generated client function: call it as the first argument of {{consume}}(call, paths), so the store reads only what it lists.",
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    if (!isStore(file)) return {};
    const clients = clientMatcher(context);
    if (clients.inClients) return {};
    const wrapper = context.options[0]?.consume ?? 'consume';
    const source = context.sourceCode;

    /** For `api.getX()` on a namespace import: the member expression stands where the id would. */
    const viaNamespace = (id) => {
      const member = id.parent;
      if (member?.type !== 'MemberExpression' || member.object !== id) return undefined;
      return member;
    };

    /** Whether `target` is called, and that call is the first argument of `consume(...)`. */
    const wrappedTarget = (target) => {
      const call = target.parent;
      if (call?.type !== 'CallExpression' || call.callee !== target) return false;
      const outer = call.parent;
      return (
        outer?.type === 'CallExpression' &&
        outer.arguments[0] === call &&
        outer.callee.type === 'Identifier' &&
        outer.callee.name === wrapper
      );
    };

    /** `typeof getX` in a type calls nothing. */
    const inTypeQuery = (id) => {
      for (let node = id.parent; node?.type.startsWith('TS'); node = node.parent) {
        if (node.type === 'TSTypeQuery') return true;
      }
      return false;
    };

    const check = (variable, namespace) => {
      for (const ref of variable.references) {
        const id = ref.identifier;
        if (ref.isValueReference === false || inTypeQuery(id)) continue;
        if (id.parent?.type === 'ImportSpecifier' || id.parent?.type === 'ImportNamespaceSpecifier')
          continue;
        let target = id;
        if (namespace) {
          const member = viaNamespace(id);
          if (!member) continue;
          target = member;
        }
        if (wrappedTarget(target)) continue;
        const name = namespace ? source.getText(target) : id.name;
        context.report({ node: target, messageId: 'unwrapped', data: { name, consume: wrapper } });
      }
    };

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        if (typeof node.source.value !== 'string' || !clients.isClient(node.source.value)) return;
        for (const specifier of node.specifiers) {
          if (specifier.importKind === 'type') continue;
          for (const variable of source.getDeclaredVariables(specifier)) {
            check(variable, specifier.type === 'ImportNamespaceSpecifier');
          }
        }
      },
    };
  },
};
