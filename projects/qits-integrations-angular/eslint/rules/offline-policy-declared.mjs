import { isSpec, memberName, property, unwrap } from '../project.mjs';

/**
 * In an offline-first app every resource and mutation says how it behaves without a network
 * (ticket qits-2150). `qitsResource`'s and `qitsMutation`'s `offline` option defaults to
 * `'online-only'`, so a forgotten option compiles, passes every test that runs online, and fails
 * only for a person without a network: the page blanks, or the write throws
 * `QitsOfflineError('offline')`. Reported: a call to `qitsResource(...)` (option `resource`) whose
 * third argument, or to `qitsMutation(...)` (option `mutation`) whose second argument, is not an
 * object literal with its own `offline` property. A spread does not count, since the rule cannot
 * see what it holds. The value itself is not checked: `offline: 'online-only'` written out is a
 * decision, and that is all the rule asks for.
 *
 * An app opts in with `configs.offline`, so it is not in `recommended`. Specs are not read.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every qitsResource and qitsMutation declares its offline policy: an options object literal with an offline property.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          resource: { type: 'string', minLength: 1 },
          mutation: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      undeclared:
        "{{callee}}(...) declares no offline policy: pass {{example}} as its {{position}} argument (an object literal with its own offline property), or it is 'online-only' without anyone having decided so.",
    },
  },
  create(context) {
    if (isSpec(context.physicalFilename ?? context.filename)) return {};
    const options = context.options[0] ?? {};
    const kinds = new Map([
      [
        options.resource ?? 'qitsResource',
        { index: 2, position: 'third', example: "{ offline: 'cache' | 'online-only' }" },
      ],
      [
        options.mutation ?? 'qitsMutation',
        { index: 1, position: 'second', example: "{ offline: 'queue' | 'online-only' }" },
      ],
    ]);

    /** A call's callee as a plain name: `qitsResource(...)` or `ns.qitsResource(...)`. */
    const calleeName = (node) => {
      const callee = unwrap(node.callee);
      if (callee?.type === 'Identifier') return callee.name;
      if (callee?.type === 'MemberExpression') return memberName(callee);
      return undefined;
    };

    return {
      CallExpression(node) {
        const callee = calleeName(node);
        const kind = callee && kinds.get(callee);
        if (!kind) return;
        const arg = unwrap(node.arguments[kind.index]);
        if (arg?.type === 'ObjectExpression' && property(arg, 'offline')) return;
        context.report({
          node: arg ?? node,
          messageId: 'undeclared',
          data: { callee, position: kind.position, example: kind.example },
        });
      },
    };
  },
};
