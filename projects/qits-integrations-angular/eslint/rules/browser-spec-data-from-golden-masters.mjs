import { relative, sep } from 'node:path';
import { globRegex, nearestPackage } from '../project.mjs';

/** A browser spec; other specs are not checked. */
export const BROWSER_SPECS = /\.browser\.spec\.[cm]?[jt]sx?$/;

/** Browser specs that may use synthetic data, relative to the project root: the UI components. */
export const DEFAULT_SYNTHETIC_ALLOWED = ['src/app/ui/**'];

/** A call that reads a golden master: `goldenMaster(…)`, `commands.goldenMaster(…)`, `githostGoldenMaster(…)`. */
const DEFAULT_GOLDEN_MASTER = '[gG]olden_?[mM]aster';

/** An import of a store file: `./projects.store`, `$core/projects/projects.store.ts`. */
const STORE_FILE = /(^|\/)[^/]+\.store(\.[cm]?[jt]s)?$/;

/** An import from the app's state tree: `$core/…`, `../../core/…`, `src/app/core/…`. */
const STATE_TREE = /^\$core\/|(^|\/)core\//;

/** What `@qits/angular/testing/browser` registers recordings with; a spec that has it can fake one. */
const RECORDERS = new Set(['recorded', 'fromGoldenMasters']);
const BROWSER_TESTING = '@qits/angular/testing/browser';

/** Array methods that give an element of the array, so of a recording when the array is one. */
const ELEMENT_OF = new Set(['at', 'find', 'findLast']);

/** The fix when no recorded state holds the data a case needs. */
const NEW_STATE =
  "If no recorded state fits this case, add a provider state to the provider repository that serves this call (ProviderStates + golden-master recorder), record it, and add a pact interaction for it in the consumer's pact spec next to the store (provider state '<new state>', operationId '<operationId>'), so the provider verifies it. Then answer with goldenMaster('<new state>', '<operationId>').";

/** The fix for data put in by hand: feed it through HTTP from a golden master. */
const VIA_HTTP = `Feed the data through HTTP from a golden master instead: let the real store request it, and answer with http.expectOne(…).flush(await goldenMaster('<state>', '<operationId>')). ${NEW_STATE}`;

const PROVIDER_KEYS = new Set(['useValue', 'useFactory', 'useClass', 'useExisting']);

/**
 * A browser spec gets its backend data from golden masters and from nothing else (epic qits-112).
 * Only the specs of UI components may use synthetic data: option `syntheticAllowed` (globs relative
 * to the project root, default `['src/app/ui/**']`) names the browser specs the rule skips. It may not set a store's state (`patchState`), replace a provider
 * (`TestBed.overrideProvider`, a `*Store` token or any token imported from the app's state tree,
 * `$core/…` or a path with `/core/`, with `useValue`/`useFactory`/`useClass`/
 * `useExisting`; option `allowTokens` exempts state-tree tokens that are transport seams only,
 * never data, such as an event source), import a store file except for its types, or register its own recordings. The
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
        'A browser spec gets its backend data from golden masters only, unless it tests a UI component.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          goldenMaster: { type: 'string' },
          allowTokens: { type: 'array', items: { type: 'string' }, uniqueItems: true },
          syntheticAllowed: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      patchState: `A browser spec does not set state with patchState. ${VIA_HTTP}`,
      overrideProvider: `A browser spec does not replace providers. ${VIA_HTTP}`,
      stateProvider: `A browser spec does not replace '{{token}}', which holds app state. ${VIA_HTTP}`,
      storeImport: `A browser spec imports '{{source}}' for its types only: write \`import type\`. ${VIA_HTTP}`,
      recorder:
        "A browser spec does not register recordings itself. Import '{{name}}' in a testing helper (such as src/testing/browser/golden-master.ts), wrap the goldenMaster command there, and take bodies from that helper's goldenMaster(…).",
      notGolden: `flush(…) answers with data that does not come from a golden master. Flush a body goldenMaster(…) gave, or a part of it, as it is: never a literal, a copy, a spread or a slice. ${NEW_STATE} For an error answer, give a literal status of 400 or more; for 204 No Content, flush(null, { status: 204, statusText: 'No Content' }).`,
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    if (!BROWSER_SPECS.test(file)) return {};
    const root = nearestPackage(file)?.dir ?? context.cwd;
    const projectPath = relative(root, file).split(sep).join('/');
    const synthetic = (context.options[0]?.syntheticAllowed ?? DEFAULT_SYNTHETIC_ALLOWED).map(
      globRegex,
    );
    if (synthetic.some((glob) => glob.test(projectPath))) return {};
    const golden = new RegExp(context.options[0]?.goldenMaster ?? DEFAULT_GOLDEN_MASTER);
    // Transport seams only, never data: a token that only cuts the network off (an event source).
    const allowTokens = new Set(context.options[0]?.allowTokens ?? []);
    const source = context.sourceCode ?? context.getSourceCode();
    const patchStates = new Set(['patchState']);
    /** Local names a value import from the state tree binds, minus the allowed seams. */
    const stateTokens = new Set();

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
      Program(program) {
        for (const node of program.body) {
          if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue;
          if (!STATE_TREE.test(String(node.source.value))) continue;
          for (const specifier of node.specifiers) {
            if (specifier.importKind === 'type') continue;
            const imported = specifier.imported?.name ?? specifier.imported?.value;
            if (allowTokens.has(imported) || allowTokens.has(specifier.local.name)) continue;
            stateTokens.add(specifier.local.name);
          }
        }
      },
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
          if (key === 'provide') {
            const value = property.value;
            // `ns.Token` from a namespace import of the state tree is that namespace's token.
            token =
              value.type === 'MemberExpression' && stateTokens.has(nameOf(value.object))
                ? nameOf(value.object)
                : nameOf(value);
          } else if (PROVIDER_KEYS.has(key)) replaces = true;
        }
        if (replaces && token && (/Store$/.test(token) || stateTokens.has(token))) {
          context.report({ node, messageId: 'stateProvider', data: { token } });
        }
      },
    };
  },
};
