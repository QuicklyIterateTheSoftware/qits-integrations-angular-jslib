import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve, sep } from 'node:path';
import { isSpec, literalText, memberName, nearestPackage, property, unwrap } from '../project.mjs';

const require = createRequire(import.meta.url);

/** The policies that need an offline-capable operation, by the call that declares them. */
const POLICIES = new Map([
  ['qitsResource', { index: 2, policy: 'cache' }],
  ['qitsMutation', { index: 1, policy: 'queue' }],
]);

/** The mark a provider puts on an offline-capable operation, and the values that set it. */
const MARK = 'x-qits-offline';
const marked = (value) => value === true || value === 'true';

/** Parsed contracts by absolute path: `{ mtime, index }` or `{ mtime, error }`. */
const documents = new Map();

/**
 * One OpenAPI document as an index from `<METHOD> <operationId>` to its operation object, read
 * again only when the file changes (its mtime), the way project.mjs remembers packages. `.json` is
 * parsed natively; `.yml` / `.yaml` takes the optional `yaml` package, loaded only then.
 * `{ error: 'noYaml' | 'unreadable' }` when it cannot be read.
 */
function contract(path) {
  const mtime = statSync(path).mtimeMs;
  const known = documents.get(path);
  if (known && known.mtime === mtime) return known;
  let found;
  try {
    const text = readFileSync(path, 'utf8');
    let doc;
    if (/\.ya?ml$/i.test(path)) {
      let yaml;
      try {
        yaml = require('yaml');
      } catch {
        yaml = undefined;
      }
      if (!yaml) found = { mtime, error: 'noYaml' };
      else doc = yaml.parse(text);
    } else doc = JSON.parse(text);
    if (!found) {
      const index = new Map();
      for (const item of Object.values(doc?.paths ?? {})) {
        if (!item || typeof item !== 'object') continue;
        for (const [method, operation] of Object.entries(item)) {
          if (typeof operation?.operationId === 'string')
            index.set(`${method.toUpperCase()} ${operation.operationId}`, operation);
        }
      }
      found = { mtime, index };
    }
  } catch {
    found = { mtime, error: 'unreadable' };
  }
  documents.set(path, found);
  return found;
}

/**
 * A queued write or a cached read is safe only on an operation the provider built for it (ticket
 * qits-2150): qits-2148's `@OfflineCapable` operations take `If-Match` on updates and deletes,
 * replay an `Idempotency-Key`, and answer collections as `ChangesPage`. On any other operation a
 * replay after a lost answer can apply twice, and an update cannot conflict, which is
 * last-write-wins. The provider marks each such operation `x-qits-offline` in its OpenAPI document
 * (`true`, or the string `"true"` that MicroProfile's `@Extension` renders).
 *
 * For `qitsResource(OP, …, { offline: 'cache' })` and `qitsMutation(OP, { offline: 'queue' })`,
 * `OP` is followed with the type checker (through imports, so a `*.operations.ts` file is read) to
 * its declaration, which must be `const OP = qitsOperation({ provider, operationId, method, … })`
 * with those three as string literals; anything else is not reported. The operation is looked up in
 * the provider's document, named by the required option `contracts` (`{ "<provider>": "<path>" }`,
 * paths relative to the nearest `package.json`, `.json`, `.yml` or `.yaml`): the
 * `paths.*.<method>` whose `operationId` matches. Reported: a provider with no document, or whose
 * file is missing or does not parse (`noContract`); an operation the document does not have
 * (`unknownOperation`); one it has without the mark (`notOfflineCapable`); and a YAML document
 * without the optional `yaml` package installed (`noYaml`, once per document and file).
 *
 * It needs the app's contracts, so it is in no preset; the documents are the providers'
 * `docs/openapi.yml` the clients are generated from, committed in the app. It needs typed linting;
 * without it the rule says so once per file instead of passing. Specs are not read.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A cache resource and a queue mutation go through an operation its provider's OpenAPI document marks x-qits-offline.",
    },
    schema: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: [
        {
          type: 'object',
          properties: {
            contracts: {
              type: 'object',
              minProperties: 1,
              additionalProperties: { type: 'string', minLength: 1 },
            },
          },
          required: ['contracts'],
          additionalProperties: false,
        },
      ],
    },
    messages: {
      noContract:
        "{{provider}} {{operationId}} is used with offline: '{{policy}}', but {{why}}: commit the provider's docs/openapi.yml and name it in contracts.",
      unknownOperation:
        "{{provider}}'s contract {{path}} has no {{method}} operation '{{operationId}}': the operation is renamed or gone, or the committed document is stale.",
      notOfflineCapable:
        "{{provider}} {{operationId}} is not offline-capable (its contract does not mark it x-qits-offline), so offline: '{{policy}}' can replay a write twice or overwrite a change: make the operation @OfflineCapable in the provider, or use offline: 'online-only'.",
      noYaml: 'install yaml to read {{path}}, or give a .json document',
      typedLinting:
        'offline-capable-operations needs typed linting: set languageOptions.parserOptions.projectService',
    },
  },
  create(context) {
    const absolute = context.physicalFilename ?? context.filename;
    if (isSpec(absolute)) return {};
    const contracts = context.options[0]?.contracts ?? {};
    const root = nearestPackage(absolute)?.dir ?? context.cwd;
    const services = context.sourceCode.parserServices;
    const checker = services?.program?.getTypeChecker();
    const toTs = services?.esTreeNodeToTSNodeMap;
    let ts;
    let refused = false;
    const noYamlReported = new Set();

    /** The literal text of a TypeScript expression, by its type: `'x'`, or a `const` holding it. */
    const stringOf = (node) => {
      const type = node && checker.getTypeAtLocation(node);
      return type?.isStringLiteral() ? type.value : undefined;
    };

    /** `(x)`, `x as T`, `x satisfies T`, `x!`: the expression inside. */
    const bare = (node) => {
      while (
        node &&
        (ts.isParenthesizedExpression(node) ||
          ts.isAsExpression(node) ||
          ts.isSatisfiesExpression(node) ||
          ts.isNonNullExpression(node))
      )
        node = node.expression;
      return node;
    };

    /** `OP`'s `qitsOperation({...})` identity: `{ provider, operationId, method }`, or undefined. */
    const identity = (esNode) => {
      const node = toTs.get(esNode);
      let symbol = node && checker.getSymbolAtLocation(node);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.declarations?.find(ts.isVariableDeclaration);
      const init = bare(declaration?.initializer);
      if (!init || !ts.isCallExpression(init)) return undefined;
      const callee = init.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      const spec = bare(init.arguments[0]);
      if (name !== 'qitsOperation' || !spec || !ts.isObjectLiteralExpression(spec))
        return undefined;
      const found = {};
      for (const key of ['provider', 'operationId', 'method']) {
        const assignment = spec.properties.find(
          (p) => ts.isPropertyAssignment(p) && p.name.text === key,
        );
        found[key] = stringOf(assignment?.initializer);
        if (found[key] === undefined) return undefined;
      }
      return found;
    };

    /** A call's callee as a plain name: `qitsResource(...)` or `ns.qitsResource(...)`. */
    const calleeName = (node) => {
      const callee = unwrap(node.callee);
      if (callee?.type === 'Identifier') return callee.name;
      if (callee?.type === 'MemberExpression') return memberName(callee);
      return undefined;
    };

    return {
      CallExpression(node) {
        const kind = POLICIES.get(calleeName(node));
        if (!kind) return;
        const options = unwrap(node.arguments[kind.index]);
        const offline = options?.type === 'ObjectExpression' && property(options, 'offline');
        const policy = offline ? literalText(offline.value) : undefined;
        const op = node.arguments[0];
        if (policy !== kind.policy || !op || op.type === 'SpreadElement') return;
        if (!checker || !toTs) {
          if (!refused) context.report({ node, messageId: 'typedLinting' });
          refused = true;
          return;
        }
        ts ??= require('typescript');
        const id = identity(op);
        if (!id) return;
        const data = { ...id, policy };
        const configured = contracts[id.provider];
        const path = configured && resolve(root, configured);
        const shown = path && relative(root, path).split(sep).join('/');
        if (!path || !existsSync(path)) {
          const why = configured
            ? `its contract ${shown} does not exist`
            : `contracts names no document for ${id.provider}`;
          context.report({ node: op, messageId: 'noContract', data: { ...data, why } });
          return;
        }
        const doc = contract(path);
        if (doc.error === 'noYaml') {
          if (!noYamlReported.has(path))
            context.report({ node: op, messageId: 'noYaml', data: { path: shown } });
          noYamlReported.add(path);
          return;
        }
        if (doc.error) {
          const why = `its contract ${shown} is not a JSON or YAML document`;
          context.report({ node: op, messageId: 'noContract', data: { ...data, why } });
          return;
        }
        const operation = doc.index.get(`${id.method.toUpperCase()} ${id.operationId}`);
        if (!operation) {
          context.report({
            node: op,
            messageId: 'unknownOperation',
            data: { ...data, path: shown },
          });
          return;
        }
        if (!marked(operation[MARK]))
          context.report({ node: op, messageId: 'notOfflineCapable', data });
      },
    };
  },
};
