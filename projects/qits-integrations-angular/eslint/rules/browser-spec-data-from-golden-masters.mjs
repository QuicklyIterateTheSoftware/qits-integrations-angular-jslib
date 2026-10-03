/** The screenshot specs of a page or a layout; other specs are not checked. */
export const PAGE_AND_LAYOUT_SPECS = /\.(page|layout)\.browser\.spec\.[cm]?[jt]sx?$/;

/** A call that reads a golden master: `goldenMaster(…)`, `commands.goldenMaster(…)`, `githostGoldenMaster(…)`. */
const DEFAULT_GOLDEN_MASTER = '[gG]olden_?[mM]aster';

/** An import of a store file: `./projects.store`, `$core/projects/projects.store.ts`. */
const STORE_FILE = /(^|\/)[^/]+\.store(\.[cm]?[jt]s)?$/;

/** What `@qits/angular/testing/browser` registers recordings with; a spec that has it can fake one. */
const RECORDERS = new Set(['recorded', 'fromGoldenMasters']);
const BROWSER_TESTING = '@qits/angular/testing/browser';

/** Array methods that give an element of the array, so of a recording when the array is one. */
const ELEMENT_OF = new Set(['at', 'find', 'findLast']);

const PROVIDER_KEYS = new Set(['useValue', 'useFactory', 'useClass', 'useExisting']);

/**
 * A page's or layout's screenshot spec gets its backend data from golden masters and from nothing
 * else (epic qits-112). It may not set a store's state (`patchState`), replace a provider
 * (`TestBed.overrideProvider`, a `*Store` token with `useValue`/`useFactory`/`useClass`/
 * `useExisting`), import a store file except for its types, or register its own recordings. The
 * first argument of `flush(…)` must trace back to a golden-master call, unless the answer is an
 * error (a literal `status` of 400 or more) or a literal 204 with no body.
 *
 * The trace is a heuristic: a call whose name matches `goldenMaster`, a field or element of one, or
 * a `const` whose value is one. A function parameter cannot be traced and passes; so does a
 * `flush` whose options are not an object literal with a literal `status`. The run-time guard
 * (`guardGoldenMasters()` from `@qits/angular/testing/browser`) is the real guarantee; this rule
 * reports the mistake where it is written.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A page's or layout's screenshot spec gets its backend data from golden masters only.",
    },
    schema: [
      {
        type: 'object',
        properties: { goldenMaster: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      patchState:
        'A screenshot spec does not set state with patchState: answer the store’s request with a golden master.',
      overrideProvider:
        'A screenshot spec does not replace providers: answer the requests with golden masters.',
      storeProvider:
        "A screenshot spec does not replace '{{token}}': let the real store ask, and answer it with a golden master.",
      storeImport:
        "A screenshot spec imports '{{source}}' for its types only (import type): the store gets its data from a golden master.",
      recorder:
        "A screenshot spec does not register recordings itself: import '{{name}}' in a testing helper, and take bodies from that helper.",
      notGolden:
        'flush(…) answers with data that does not come from a golden master. Flush a golden-master body or a part of it; for an error, give a literal status of 400 or more.',
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    if (!PAGE_AND_LAYOUT_SPECS.test(file)) return {};
    const golden = new RegExp(context.options[0]?.goldenMaster ?? DEFAULT_GOLDEN_MASTER);
    const source = context.sourceCode ?? context.getSourceCode();
    const patchStates = new Set(['patchState']);

    const nameOf = (node) =>
      node?.type === 'Identifier'
        ? node.name
        : node?.type === 'MemberExpression' && !node.computed
          ? node.property.name
          : undefined;

    const findVariable = (scope, name) => {
      for (let s = scope; s; s = s.upper) {
        const variable = s.set.get(name);
        if (variable) return variable;
      }
      return undefined;
    };

    const unwrap = (node) => {
      while (
        node &&
        [
          'AwaitExpression',
          'TSAsExpression',
          'TSNonNullExpression',
          'TSSatisfiesExpression',
          'TSTypeAssertion',
          'ChainExpression',
        ].includes(node.type)
      ) {
        node = node.type === 'AwaitExpression' ? node.argument : node.expression;
      }
      return node;
    };

    /** Whether `node` traces back to a golden-master call (or cannot be traced: a parameter). */
    const traced = (node, seen = new Set()) => {
      node = unwrap(node);
      if (!node || seen.has(node)) return false;
      seen.add(node);
      switch (node.type) {
        case 'CallExpression': {
          const name = nameOf(node.callee);
          if (name && golden.test(name)) return true;
          return (
            node.callee.type === 'MemberExpression' &&
            ELEMENT_OF.has(name) &&
            traced(node.callee.object, seen)
          );
        }
        case 'MemberExpression':
          return traced(node.object, seen);
        case 'ConditionalExpression':
          return traced(node.consequent, seen) && traced(node.alternate, seen);
        case 'LogicalExpression':
          return traced(node.left, seen) && traced(node.right, seen);
        case 'Identifier': {
          const variable = findVariable(source.getScope(node), node.name);
          if (!variable || variable.defs.length !== 1) return false;
          const [def] = variable.defs;
          if (def.type === 'Parameter') return true;
          if (def.type !== 'Variable') return false;
          if (variable.references.some((r) => r.isWrite() && !r.init)) return false;
          if (def.node.init) return traced(def.node.init, seen);
          const loop = def.parent?.parent;
          return loop?.type === 'ForOfStatement' && traced(loop.right, seen);
        }
        default:
          return false;
      }
    };

    /** The literal `status` of `flush`'s options: a number, `null` when not given, `undefined` when unknown. */
    const statusOf = (options) => {
      if (!options) return null;
      if (options.type !== 'ObjectExpression') return undefined;
      let status = null;
      for (const property of options.properties) {
        if (property.type !== 'Property') return undefined;
        const key = property.computed ? undefined : (property.key.name ?? property.key.value);
        if (key !== 'status') continue;
        const value = property.value;
        status =
          value.type === 'Literal' && typeof value.value === 'number' ? value.value : undefined;
      }
      return status;
    };

    const isEmpty = (node) =>
      (node.type === 'Literal' && node.value === null) ||
      (node.type === 'Identifier' && node.name === 'undefined');

    return {
      ImportDeclaration(node) {
        const from = node.source.value;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue;
          const imported = specifier.imported.name ?? specifier.imported.value;
          if (imported === 'patchState') patchStates.add(specifier.local.name);
          if (from === BROWSER_TESTING && RECORDERS.has(imported)) {
            context.report({ node: specifier, messageId: 'recorder', data: { name: imported } });
          }
        }
        if (typeof from === 'string' && STORE_FILE.test(from)) {
          const typesOnly =
            node.importKind === 'type' ||
            (node.specifiers.length > 0 &&
              node.specifiers.every(
                (s) => s.type === 'ImportSpecifier' && s.importKind === 'type',
              ));
          if (!typesOnly) {
            context.report({ node, messageId: 'storeImport', data: { source: from } });
          }
        }
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && STORE_FILE.test(String(node.source.value))) {
          context.report({ node, messageId: 'storeImport', data: { source: node.source.value } });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const name = nameOf(callee);
        if (
          (callee.type === 'Identifier' && patchStates.has(name)) ||
          (callee.type === 'MemberExpression' && name === 'patchState')
        ) {
          context.report({ node, messageId: 'patchState' });
        } else if (callee.type === 'MemberExpression' && name === 'overrideProvider') {
          context.report({ node, messageId: 'overrideProvider' });
        } else if (
          callee.type === 'MemberExpression' &&
          name === 'flush' &&
          node.arguments.length > 0
        ) {
          const [body, options] = node.arguments;
          const status = statusOf(options);
          if (status === undefined || status >= 400) return;
          if (status === 204 && isEmpty(body)) return;
          if (body.type === 'SpreadElement' || !traced(body)) {
            context.report({ node: body, messageId: 'notGolden' });
          }
        }
      },
      ObjectExpression(node) {
        let token;
        let replaces = false;
        for (const property of node.properties) {
          if (property.type !== 'Property' || property.computed) continue;
          const key = property.key.name ?? property.key.value;
          if (key === 'provide') token = nameOf(property.value);
          else if (PROVIDER_KEYS.has(key)) replaces = true;
        }
        if (replaces && token && /Store$/.test(token)) {
          context.report({ node, messageId: 'storeProvider', data: { token } });
        }
      },
    };
  },
};
