import { CLIENTS_SCHEMA, clientMatcher, isOperations, isStore } from '../project.mjs';

/**
 * In a store, every call to a generated client goes straight into `consume(call, paths)`: the
 * call is its first argument, nothing in between. `consume` narrows the answer to the paths the
 * store reads, and the store's pact spec binds the same paths, so what the store reads and what the
 * pact binds cannot drift. Any other use of a client function — awaited on its own, `.then`,
 * passed elsewhere, or a `…Resource` helper, which is no promise to wrap — is reported.
 *
 * In a `*.operations.ts` file a client function is never called at all: it is handed over as the
 * `call` of `qitsOperation({ provider, operationId, method, call, consumes })`, and the library calls
 * it with the operation's `consumes` paths, which the file's pact spec binds. So there the only
 * accepted use is `call: getX` (or `call: api.getX`) in the object literal that is the first
 * argument of `qitsOperation(...)`; calling it, wrapping it in `consume`, or passing it anywhere else
 * is reported.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'In a store, every generated client call is the first argument of consume(call, paths); in an operations file, every client function is the call of qitsOperation({ call }).',
    },
    schema: [
      {
        ...CLIENTS_SCHEMA,
        properties: {
          ...CLIENTS_SCHEMA.properties,
          consume: { type: 'string' },
          operation: { type: 'string' },
        },
      },
    ],
    messages: {
      unwrapped:
        "'{{name}}' is a generated client function: call it as the first argument of {{consume}}(call, paths), so the store reads only what it lists.",
      notOperationCall:
        "'{{name}}' is a generated client function: in an operations file, pass it as the call of {{operation}}({ call: {{name}}, … }) and let the operation call it, not here.",
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    const operations = isOperations(file);
    if (!isStore(file) && !operations) return {};
    const clients = clientMatcher(context);
    if (clients.inClients) return {};
    const wrapper = context.options[0]?.consume ?? 'consume';
    const operation = context.options[0]?.operation ?? 'qitsOperation';
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

    /** Whether `target` is the value of `call:` in the object literal that is `qitsOperation`'s first argument. */
    const operationCall = (target) => {
      const prop = target.parent;
      if (prop?.type !== 'Property' || prop.value !== target || prop.computed) return false;
      if (prop.key.type !== 'Identifier' ? prop.key.value !== 'call' : prop.key.name !== 'call')
        return false;
      const object = prop.parent;
      const call = object?.parent;
      return (
        object.type === 'ObjectExpression' &&
        call?.type === 'CallExpression' &&
        call.arguments[0] === object &&
        call.callee.type === 'Identifier' &&
        call.callee.name === operation
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
        const name = namespace ? source.getText(target) : id.name;
        if (operations) {
          if (operationCall(target)) continue;
          context.report({
            node: target,
            messageId: 'notOperationCall',
            data: { name, operation },
          });
          continue;
        }
        if (wrappedTarget(target)) continue;
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
