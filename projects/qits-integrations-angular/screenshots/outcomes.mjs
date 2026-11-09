/**
 * The outcomes an app declares (ticket qits-2003, epic qits-2000), read from its source, and the
 * gaps between them and what the browser tests reached and showed.
 *
 * `declaredOutcomes()` parses every `.ts` file under `src/app` (specs left out) with the app's own
 * TypeScript compiler, resolved from the app root (`typescript` is an optional peer of
 * `@qits/angular`; every Angular app has it). A call counts when its callee is the `outcomes` import
 * from `@qits/angular`, renamed or not; each key of its object literal is one entry:
 *
 *   { route, interaction, outcome, kind, to, global, file }
 *
 * `kind` and `to` come from the `exit('path')` / `stay()` call of the same import, `file` is
 * relative to the root. The scope comes from the declaring file's directory, under the routes
 * directory (default `src/app/routes`, the lint rules' `routes` option):
 *
 * - a page: any file under it but a `*.layout.ts` declares for exactly the route its directory
 *   names (`[p]` is `:p`, no leading slash, the directory itself is `''`), as `segmentDirs` in
 *   `eslint/project.mjs` makes directories of routes and `currentRoutePattern()` names them;
 * - a layout: a `*.layout.ts` under it declares for its route's whole subtree (`global: true`);
 * - app-wide: a `*.layout.ts` under the `$layout` alias, and any file outside the routes directory,
 *   declares for the whole app (`global: true`, `route: null`).
 *
 * A call the reader cannot read (a non-literal interaction, a spread, a computed key, an entry that
 * is no `exit()` / `stay()` call) is `unreadable`, by file and line: a gap of its own.
 *
 * `outcomeGaps()` holds the declarations against `manifest.json` (`freezes.mjs`): an outcome no
 * fired record reaches, a stay no screenshot follows, an outcome whose trigger no screenshot in its
 * scope shows, and the unreadable calls.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, posix, relative } from 'node:path';
import { DEFAULT_ROUTES, layoutAliasDir } from '../eslint/project.mjs';
import { toPosix } from './record.mjs';

export { DEFAULT_ROUTES };

/** Where the reader looks for declarations, relative to the root. */
const SOURCES = 'src/app';

const SKIP = new Set(['node_modules', 'dist', 'tmp', 'out-tsc', 'coverage']);

const isSource = (name) => /\.m?ts$/.test(name) && !/\.d\.m?ts$/.test(name);
const isSpec = (name) => /\.(spec|test)\.m?ts$/.test(name);
const isLayout = (file) => /\.layout\.m?ts$/.test(file);

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every source file under `dir`, relative to `root`, with `/` separators. */
function sourcesUnder(root, dir) {
  if (!existsSync(join(root, dir))) return [];
  const found = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourcesUnder(root, path));
    else if (isSource(entry.name) && !isSpec(entry.name)) found.push(path);
  }
  return found.sort(compare);
}

/** The app's `typescript`, resolved from its root; throws naming the package when it has none. */
function loadTypescript(root) {
  try {
    return createRequire(join(root, 'package.json'))('typescript');
  } catch {
    throw new Error(
      `cannot read the outcomes() declarations: the package typescript does not resolve from ${root}. ` +
        'Install it in the app (an optional peer dependency of @qits/angular).',
    );
  }
}

const inside = (dir) => (path) => dir !== undefined && (path === dir || path.startsWith(`${dir}/`));

/** A directory under the routes directory as the route it names: `projects/[slug]` → `projects/:slug`. */
const routeOf = (dir, routes) =>
  dir
    .slice(routes.length)
    .split('/')
    .filter((s) => s)
    .map((s) => s.replace(/^\[(.+)\]$/, ':$1'))
    .join('/');

/**
 * Reads the `outcomes()` declarations of the app at `root`. `routes` is the routes directory,
 * relative to the root. Returns `{ declared, unreadable }`, both sorted.
 *
 * @param {{ root: string, routes?: string }} options
 */
export function declaredOutcomes({ root, routes = DEFAULT_ROUTES }) {
  const base = routes.replace(/^\.\//, '').replace(/\/+$/, '');
  const candidates = sourcesUnder(root, SOURCES)
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))
    .filter(({ text }) => text.includes('@qits/angular') && text.includes('outcomes'));
  if (candidates.length === 0) return { declared: [], unreadable: [] };

  const ts = loadTypescript(root);
  const aliasDir = layoutAliasDir(root);
  const inLayouts = inside(aliasDir && toPosix(relative(root, aliasDir)));
  const underBase = inside(base);
  const declared = [];
  const unreadable = [];

  for (const { file, text } of candidates) {
    const dir = posix.dirname(file);
    let scope;
    if (isLayout(file) && inLayouts(dir)) scope = { route: null, global: true };
    else if (underBase(dir)) scope = { route: routeOf(dir, base), global: isLayout(file) };
    else scope = { route: null, global: true };

    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const unread = (node, why) => unreadable.push({ file, line: line(node), why });

    /** Local name → imported name, of `@qits/angular`'s named imports; and its namespace imports. */
    const named = new Map();
    const namespaces = new Set();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (statement.moduleSpecifier.text !== '@qits/angular') continue;
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      else if (bindings) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          named.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    }
    if (named.size === 0 && namespaces.size === 0) continue;

    /** The `@qits/angular` export a callee names, or undefined. */
    const imported = (callee) => {
      if (ts.isIdentifier(callee)) return named.get(callee.text);
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text)
      ) {
        return callee.name.text;
      }
      return undefined;
    };
    const literal = (node) =>
      node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        ? node.text
        : undefined;

    const readCall = (call) => {
      const interaction = literal(call.arguments[0]);
      if (interaction === undefined) return unread(call, 'its interaction is not a string literal');
      const object = call.arguments[1];
      if (!object || !ts.isObjectLiteralExpression(object)) {
        return unread(call, 'its outcomes are not an object literal');
      }
      for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
          unread(property, 'a spread');
          continue;
        }
        if (property.name && ts.isComputedPropertyName(property.name)) {
          unread(property, 'a computed key');
          continue;
        }
        const outcome =
          property.name &&
          (ts.isIdentifier(property.name) ||
            ts.isStringLiteral(property.name) ||
            ts.isNumericLiteral(property.name))
            ? property.name.text
            : undefined;
        const value = ts.isPropertyAssignment(property) ? property.initializer : undefined;
        const kind = value && ts.isCallExpression(value) ? imported(value.expression) : undefined;
        if (outcome === undefined || (kind !== 'exit' && kind !== 'stay')) {
          unread(property, `the entry ${outcome ?? '?'} is not an exit() or stay() call`);
          continue;
        }
        let to = null;
        if (kind === 'exit') {
          to = literal(value.arguments[0]) ?? null;
          if (to === null) {
            unread(property, `the exit ${outcome} is not given a string literal`);
            continue;
          }
        }
        declared.push({ ...scope, interaction, outcome, kind, to, file });
      }
    };

    const visit = (node) => {
      if (ts.isCallExpression(node) && imported(node.expression) === 'outcomes') readCall(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  declared.sort(
    (a, b) =>
      compare(a.route === null, b.route === null) ||
      compare(a.route ?? '', b.route ?? '') ||
      compare(a.interaction, b.interaction) ||
      compare(a.outcome, b.outcome) ||
      compare(a.file, b.file),
  );
  unreadable.sort((a, b) => compare(a.file, b.file) || a.line - b.line);
  return {
    declared: declared.map(({ route, interaction, outcome, kind, to, global, file }) => ({
      route,
      interaction,
      outcome,
      kind,
      to,
      global,
      file,
    })),
    unreadable,
  };
}

/**
 * Whether a route (a fired record's, a freeze's) is in a declaration's scope: the page's own route,
 * its layout's subtree, or anywhere for an app-wide one. The root page also takes `null`, because
 * `currentRoutePattern()` names the empty route `null`.
 */
function inScope(entry, route) {
  if (entry.route === null) return true;
  if (!entry.global) return route === entry.route || (entry.route === '' && route === null);
  if (route === null) return entry.route === '';
  return entry.route === '' || route === entry.route || route.startsWith(`${entry.route}/`);
}

/** The route a gap names, in parentheses after the outcome. */
function where(entry) {
  if (entry.route === null) return 'app-wide';
  const route = entry.route === '' ? '/' : entry.route;
  return entry.global ? `${route} and below` : route;
}

/** The screenshots a trigger gap asks for. */
function shownOn(entry) {
  if (entry.route === null) return 'no screenshot';
  const route = entry.route === '' ? '/' : entry.route;
  return entry.global
    ? `no screenshot of ${route} or a route below it`
    : `no screenshot of ${route}`;
}

/**
 * The outcome gaps, one message each, in the order of the declarations, then the unreadable calls.
 * `manifest` is `manifest.json` as read (or `undefined` when there is none).
 *
 * @param {{ declared: object[], unreadable: object[], manifest?: object }} input
 */
export function outcomeGaps({ declared, unreadable, manifest }) {
  const fired = Array.isArray(manifest?.outcomes?.fired) ? manifest.outcomes.fired : [];
  const freezes = Array.isArray(manifest?.freezes) ? manifest.freezes : [];
  const gaps = [];
  for (const entry of declared) {
    const name = `${entry.interaction}:${entry.outcome}`;
    const reached = fired.filter(
      (record) =>
        record.interaction === entry.interaction &&
        record.outcome === entry.outcome &&
        inScope(entry, record.route ?? null),
    );
    if (reached.length === 0) {
      gaps.push(`${name} (${where(entry)}): no browser test reaches it.`);
    } else if (entry.kind === 'stay' && !reached.some((record) => record.freeze)) {
      gaps.push(`${name} (${where(entry)}): a stay needs a screenshot after it is reached.`);
    }
    const shown = freezes.some(
      (freeze) =>
        Array.isArray(freeze.triggers) &&
        freeze.triggers.includes(name) &&
        inScope(entry, freeze.route ?? null),
    );
    if (!shown) {
      gaps.push(
        `${name}: ${shownOn(entry)} shows its trigger. Add a screenshot test where it is visible, ` +
          'with another provider state if needed (an open menu, a loaded list).',
      );
    }
  }
  for (const { file, line, why } of unreadable) {
    gaps.push(`${file}:${line}: an outcomes() call that cannot be read statically (${why}).`);
  }
  return [...new Set(gaps)];
}
