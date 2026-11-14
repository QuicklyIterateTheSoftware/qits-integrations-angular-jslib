/**
 * The outcomes an app declares (ticket qits-2003, epic qits-2000), read from its source, and the
 * gaps between them and what the browser tests reached and showed.
 *
 * `declaredOutcomes()` parses every `.ts` file under `src/app` (specs left out) with the app's own
 * TypeScript compiler, resolved from the app root (`typescript` is an optional peer of
 * `@qits/angular`; every Angular app has it). A call counts when its callee is the `outcomes` import
 * from `@qits/angular`, renamed or not; each key of its object literal is one entry:
 *
 *   { route, interaction, outcome, kind, to, global, triggered, file }
 *
 * `kind` and `to` come from the `exit('path')` / `stay()` / `returnTo()` / `external('name')` call
 * of the same import (`to` is the exit's path, the external's name, `null` otherwise), `triggered`
 * from the call's third argument (`{ triggered: false }` for an interaction no element triggers;
 * default `true`), `file` is relative to the root. The scope comes from the declaring file's
 * directory, under the routes directory (default `src/app/routes`, the lint rules' `routes` option):
 *
 * - a page: any file under it but a `*.layout.ts` declares for exactly the route its directory
 *   names (`[p]` is `:p`, no leading slash, the directory itself is `''`), as `segmentDirs` in
 *   `eslint/project.mjs` makes directories of routes and `currentRoutePattern()` names them;
 * - a layout: a `*.layout.ts` under it declares for its route's whole subtree (`global: true`);
 * - app-wide: a `*.layout.ts` under the `$layout` alias, and any file outside the routes directory,
 *   declares for the whole app (`global: true`, `route: null`).
 *
 * A call the reader cannot read (a non-literal interaction, a spread, a computed key, an entry that
 * is none of the four calls, options that are not `{ triggered: true | false }`) is `unreadable`, by
 * file and line: a gap of its own.
 *
 * The library declares outcomes of its own (the sign-in callback page, the session guard; ticket
 * qits-2044). `scripts/library-outcomes.mjs` reads them with the same reader ({@link readOutcomes})
 * into `outcomes.json` beside this module, which ships in the package; each entry also names the
 * exports that bring it into an app (`provides`). An app that imports one of those from
 * `@qits/angular` (a value import, in any non-spec file under `src/app`) declares those outcomes
 * too, with `file` naming the library's source (`@qits/angular/src/lib/…`).
 *
 * `outcomeGaps()` holds the declarations against `manifest.json` (`freezes.mjs`): an outcome no
 * fired record reaches, a stay no screenshot follows, an outcome whose trigger no screenshot in its
 * scope shows (not asked of a `triggered: false` one), a page route that renders a layout's or
 * app-wide trigger none of its own screenshots shows ({@link routeTriggerGaps}, ticket qits-2225), a
 * checked route no outcome leads to ({@link unreachableRoutes}, ticket qits-2049), and the unreadable
 * calls.
 *
 * Forwards (ticket qits-2076): {@link forwardRoutes} names the routes that render a component but
 * leave at once (only untriggered exits, nothing rendered below them); the freeze writer marks them
 * `forward: true` in the manifest, and {@link pageRoutes} — the checked routes minus those and the
 * `rendersNothing` ones — is the set any rule about the states a page shows iterates.
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

/** The order `declared` comes in: by route (app-wide last), interaction, outcome and file. */
function sortDeclared(declared) {
  return declared.sort(
    (a, b) =>
      compare(a.route === null, b.route === null) ||
      compare(a.route ?? '', b.route ?? '') ||
      compare(a.interaction, b.interaction) ||
      compare(a.outcome, b.outcome) ||
      compare(a.file, b.file),
  );
}

/** An entry with its fields in the order the manifest and `outcomes.json` keep. */
const entryOf = ({ route, interaction, outcome, kind, to, global, triggered, file }) => ({
  route,
  interaction,
  outcome,
  kind,
  to,
  global,
  triggered,
  file,
});

/**
 * Reads the `outcomes()` calls of `files` (`{ file, text, scope }`, `scope` being `{ route, global }`)
 * with the compiler `ts`. A call counts when its callee is the `outcomes` export of a module `from`
 * accepts (`from(specifier, file)`; by default `@qits/angular` only), imported by name, renamed or
 * not, or through a namespace. Returns `{ declared, unreadable }`, both sorted.
 *
 * @param {{ ts: object, files: { file: string, text: string, scope: { route: string | null, global: boolean } }[], from?: (specifier: string, file: string) => boolean }} input
 */
export function readOutcomes({ ts, files, from = (specifier) => specifier === '@qits/angular' }) {
  const declared = [];
  const unreadable = [];

  for (const { file, text, scope } of files) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const unread = (node, why) => unreadable.push({ file, line: line(node), why });

    const { named, namespaces } = importsOf(ts, source, (specifier) => from(specifier, file));
    if (named.size === 0 && namespaces.size === 0) continue;

    /** The export a callee names, or undefined. */
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

    /** `triggered` from the options argument: `true` when absent, undefined when it cannot be read. */
    const triggeredOf = (options) => {
      if (options === undefined) return true;
      if (!ts.isObjectLiteralExpression(options)) return undefined;
      let triggered = true;
      for (const property of options.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ||
          property.name.text !== 'triggered'
        ) {
          return undefined;
        }
        const value = property.initializer.kind;
        if (value === ts.SyntaxKind.TrueKeyword) triggered = true;
        else if (value === ts.SyntaxKind.FalseKeyword) triggered = false;
        else return undefined;
      }
      return triggered;
    };

    const readCall = (call) => {
      const interaction = literal(call.arguments[0]);
      if (interaction === undefined) return unread(call, 'its interaction is not a string literal');
      const object = call.arguments[1];
      if (!object || !ts.isObjectLiteralExpression(object)) {
        return unread(call, 'its outcomes are not an object literal');
      }
      const triggered = triggeredOf(call.arguments[2]);
      if (triggered === undefined) {
        return unread(
          call.arguments[2],
          'its options are not an object literal of triggered: true or false',
        );
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
        if (outcome === undefined || !KINDS.has(kind)) {
          unread(
            property,
            `the entry ${outcome ?? '?'} is not an exit(), stay(), returnTo() or external() call`,
          );
          continue;
        }
        let to = null;
        if (kind === 'exit' || kind === 'external') {
          to = literal(value.arguments[0]) ?? null;
          if (to === null) {
            unread(property, `the ${kind} ${outcome} is not given a string literal`);
            continue;
          }
        }
        declared.push({ ...scope, interaction, outcome, kind, to, triggered, file });
      }
    };

    const visit = (node) => {
      if (ts.isCallExpression(node) && imported(node.expression) === 'outcomes') readCall(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  unreadable.sort((a, b) => compare(a.file, b.file) || a.line - b.line);
  return { declared: sortDeclared(declared).map(entryOf), unreadable };
}

/** The calls an entry of an `outcomes()` declaration can be. */
const KINDS = new Set(['exit', 'stay', 'returnTo', 'external']);

/**
 * The value imports of `source` from the modules `accepts` takes: local name → exported name, and
 * the namespace names.
 */
function importsOf(ts, source, accepts) {
  const named = new Map();
  const namespaces = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!accepts(statement.moduleSpecifier.text)) continue;
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
  return { named, namespaces };
}

/** The `@qits/angular` exports `source` brings in: its named value imports, and `ns.x` of a namespace. */
function exportsUsed(ts, source) {
  const { named, namespaces } = importsOf(ts, source, (specifier) => specifier === '@qits/angular');
  const used = new Set(named.values());
  if (namespaces.size > 0) {
    const visit = (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text)
      ) {
        used.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return used;
}

/**
 * The library's own declarations, as this copy of `@qits/angular` ships them (`outcomes.json`,
 * written by `pnpm outcomes:library`): resolved next to this module, so the version the app has
 * installed is the one counted.
 */
export function libraryOutcomes() {
  return JSON.parse(readFileSync(new URL('./outcomes.json', import.meta.url), 'utf8'));
}

/**
 * Reads the `outcomes()` declarations of the app at `root`. `routes` is the routes directory,
 * relative to the root. The library's own declarations ({@link libraryOutcomes}) join them when the
 * app imports an export that brings them in (`provides`). Returns `{ declared, unreadable }`, both
 * sorted.
 *
 * @param {{ root: string, routes?: string }} options
 */
export function declaredOutcomes({ root, routes = DEFAULT_ROUTES }) {
  const base = routes.replace(/^\.\//, '').replace(/\/+$/, '');
  const candidates = sourcesUnder(root, SOURCES)
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }))
    .filter(({ text }) => text.includes('@qits/angular'));
  if (candidates.length === 0) return { declared: [], unreadable: [] };

  const library = libraryOutcomes();
  const provides = new Set(library.flatMap((entry) => entry.provides));
  const mentions = ({ text }) =>
    text.includes('outcomes') || [...provides].some((name) => text.includes(name));
  if (!candidates.some(mentions)) return { declared: [], unreadable: [] };

  const ts = loadTypescript(root);
  const aliasDir = layoutAliasDir(root);
  const inLayouts = inside(aliasDir && toPosix(relative(root, aliasDir)));
  const underBase = inside(base);
  const scopeOf = (file) => {
    const dir = posix.dirname(file);
    if (isLayout(file) && inLayouts(dir)) return { route: null, global: true };
    if (underBase(dir)) return { route: routeOf(dir, base), global: isLayout(file) };
    return { route: null, global: true };
  };

  const read = readOutcomes({
    ts,
    files: candidates.map(({ file, text }) => ({ file, text, scope: scopeOf(file) })),
  });
  const used = new Set();
  for (const { file, text } of candidates) {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const name of exportsUsed(ts, source)) used.add(name);
  }
  const shipped = library
    .filter((entry) => entry.provides.some((name) => used.has(name)))
    .map(entryOf);
  return { declared: sortDeclared([...read.declared, ...shipped]), unreadable: read.unreadable };
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

/** `/` for the root route (`''`), the full path otherwise, as a gap message shows it. */
const shownRoute = (fullPath) => (fullPath === '' ? '/' : fullPath);

/**
 * The routes the reachability check holds against the declared exits (ticket qits-2049):
 * `manifest.routes` (`describeRoutes()`'s tree), walked through `children`, keeping only the rows
 * a route actually shows — no `children` of its own (a parent's `''` child stands for it), no
 * `redirectTo`, and a `path` other than `**`. `[]` when `manifest` or `manifest.routes` is absent
 * or not an array.
 */
export function checkedRoutes(manifest) {
  const routes = Array.isArray(manifest?.routes) ? manifest.routes : [];
  const rows = [];
  const walk = (list) => {
    for (const route of list) {
      const children = Array.isArray(route.children) ? route.children : [];
      if (children.length > 0) {
        walk(children);
        continue;
      }
      if (typeof route.redirectTo === 'string' || route.path === '**') continue;
      rows.push(route);
    }
  };
  walk(routes);
  return rows;
}

/**
 * The checked routes ({@link checkedRoutes}) that no declared outcome leads to and that are not
 * themselves declared an entry point (ticket qits-2049): a route is reached when some declared
 * entry is an `exit()` (`kind === 'exit'`) whose `to` equals the route's `fullPath`, from any
 * scope — a page's own declaration, a layout's, app-wide, or the library's (`outcomes.json`'s).
 * A row with `entry: true` (`route.data: QITS_ENTRY`, copied by `describeRoutes()`) is entered
 * from outside the app on purpose, so it is skipped rather than asked for an inbound exit.
 *
 * @param {{ declared: object[], manifest?: object }} input
 */
export function unreachableRoutes({ declared, manifest }) {
  const exits = new Set(declared.filter((entry) => entry.kind === 'exit').map((entry) => entry.to));
  return checkedRoutes(manifest).filter(
    (route) => route.entry !== true && !exits.has(route.fullPath),
  );
}

/** A route's `children`, or `[]`. */
const childrenOf = (route) => (Array.isArray(route.children) ? route.children : []);

/** Every route of `manifest.routes`, depth first, parents before their children. */
function allRoutes(manifest) {
  const all = [];
  const walk = (list) => {
    for (const route of list) {
      all.push(route);
      walk(childrenOf(route));
    }
  };
  walk(Array.isArray(manifest?.routes) ? manifest.routes : []);
  return all;
}

/**
 * Whether `route` is a forward (ticket qits-2076): a route that shows a component, yet leaves at
 * once — its outcomes are exits no element triggers, and nothing below it renders. `byRoute` maps a
 * full path to the declared entries whose `route` is exactly it.
 */
function isForward(route, byRoute) {
  if (route.rendersNothing === true) return false;
  if (typeof route.redirectTo === 'string' || route.path === '**') return false;
  const entries = byRoute.get(route.fullPath) ?? [];
  if (entries.length === 0) return false;
  if (!entries.every((entry) => entry.kind === 'exit' && entry.triggered === false)) return false;
  const rendersNothing = (child) =>
    child.rendersNothing === true && childrenOf(child).every(rendersNothing);
  return childrenOf(route).every(rendersNothing);
}

/** The routes of `manifest.routes` that are forwards ({@link forwardRoutes}), as route objects. */
function forwardNodes(manifest, declared) {
  const byRoute = new Map();
  for (const entry of Array.isArray(declared) ? declared : []) {
    if (typeof entry.route !== 'string') continue;
    byRoute.set(entry.route, [...(byRoute.get(entry.route) ?? []), entry]);
  }
  return allRoutes(manifest).filter((route) => isForward(route, byRoute));
}

/**
 * The full paths of the forwards in `manifest.routes` (ticket qits-2076). A forward is a route that
 * renders a component (it is not `rendersNothing`, has no string `redirectTo`, and its `path` is not
 * `**`), whose declared entries for exactly its full path (any `global`; a `route: null` entry never
 * counts) are there and all `exit()`s with `triggered: false`, and every descendant of which is
 * `rendersNothing` (a route without children qualifies; a layout over real pages never does). It
 * shows nothing a page shows: it leaves as soon as it is entered. A manifest written before
 * `rendersNothing` has none, so a route with children there is never a forward.
 *
 * @param {object | undefined} manifest
 * @param {object[]} declared
 * @returns {Set<string>}
 */
export function forwardRoutes(manifest, declared) {
  return new Set(forwardNodes(manifest, declared).map((route) => route.fullPath));
}

/**
 * `routes` (`describeRoutes()`'s tree) with `forward: true` on each forward ({@link forwardRoutes})
 * and on nothing else — not on its `rendersNothing` descendants, though a `''` child shares its full
 * path. A `forward` the tree already carries is dropped first, so a kept tree is judged again.
 */
export function markForwards(routes, declared) {
  if (!Array.isArray(routes)) return routes;
  const strip = (list) =>
    list.map(({ forward, ...route }) =>
      Array.isArray(route.children) ? { ...route, children: strip(route.children) } : route,
    );
  const stripped = strip(routes);
  const forwards = new Set(forwardNodes({ routes: stripped }, declared));
  const mark = (list) =>
    list.map((route) => {
      const marked = forwards.has(route) ? { ...route, forward: true } : route;
      return Array.isArray(route.children) ? { ...marked, children: mark(route.children) } : marked;
    });
  return mark(stripped);
}

/**
 * The page routes (ticket qits-2076): the rows of {@link checkedRoutes} that show a page of their
 * own — minus the `rendersNothing` rows, and minus every row in a forward's subtree (the forward
 * itself and its `''` child among them). Any rule about the states a page shows (its kinds, its
 * screenshots) must iterate this set, not `checkedRoutes()`: a forward and a route that renders
 * nothing have no states to show. The reachability check (`unreachableRoutes()`) stays over
 * `checkedRoutes()`, since a forward still has to be led to.
 *
 * The forwards are read from the `forward: true` flags the freeze writer puts on `manifest.routes`,
 * so the manifest alone answers; with `declared` they are computed with {@link forwardRoutes}
 * instead (and the flags are ignored), for a manifest written before them.
 *
 * @param {object | undefined} manifest
 * @param {object[]} [declared]
 */
export function pageRoutes(manifest, declared) {
  const forwards =
    declared === undefined
      ? allRoutes(manifest).filter((route) => route.forward === true)
      : forwardNodes(manifest, declared);
  const excluded = new Set();
  const exclude = (route) => {
    excluded.add(route);
    childrenOf(route).forEach(exclude);
  };
  forwards.forEach(exclude);
  return checkedRoutes(manifest).filter(
    (route) => route.rendersNothing !== true && !excluded.has(route),
  );
}

/** The root route is `''` in `manifest.routes` and `null` on a freeze (`currentRoutePattern()`). */
const sameRoute = (freezeRoute, fullPath) => (freezeRoute ?? '') === fullPath;

/** What `outerHTML` escapes in an attribute value, and the numeric references, decoded. */
const ENTITIES = { amp: '&', quot: '"', lt: '<', gt: '>', nbsp: '\u00a0' };
const decode = (value) =>
  value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (whole, hex, dec, name) =>
    hex
      ? String.fromCodePoint(parseInt(hex, 16))
      : dec
        ? String.fromCodePoint(Number(dec))
        : (ENTITIES[name] ?? whole),
  );

/**
 * The `<interaction>:<outcome>` marks of every `data-qits-outcome` attribute in a frozen document
 * (ticket qits-2225), hidden ones included. The freeze is `outerHTML` (`freezeShot()`): attribute
 * values in double quotes with `"` as `&quot;`, `<` in text as `&lt;`; the only raw text left is
 * a `<style>` element's CSS, whose `[data-qits-outcome="…"]` selectors are not marks, so it is
 * dropped before the tags are read.
 */
export function frozenMarks(html) {
  const marks = new Set();
  const markup = html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  for (const [, attributes] of markup.matchAll(
    /<[a-zA-Z][^\s/>]*((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g,
  )) {
    for (const [, name, double, single, bare] of attributes.matchAll(
      /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
    )) {
      if (name.toLowerCase() !== 'data-qits-outcome') continue;
      for (const mark of decode(double ?? single ?? bare ?? '').split(/\s+/)) {
        if (mark) marks.add(mark);
      }
    }
  }
  return marks;
}

/**
 * The per-route trigger gaps (ticket qits-2225, owner ruling: coverage is judged per route). A
 * layout's or app-wide trigger is not covered by one screenshot anywhere in its scope: each page
 * route ({@link pageRoutes}) that renders it must show it in one of its own screenshots. For each
 * page route, its freezes are those whose `route` is its `fullPath` (`null` as the root `''`). What
 * it offers are the marks in their frozen HTML ({@link frozenMarks}, read from `freezesDir`; a
 * missing or unreadable file offers nothing, a stale one is named elsewhere), kept to the names
 * of declared `global` entries that are triggered and in scope for the route (a page's own entry is
 * already judged on its route alone). What it shows is the union of their `triggers`. Each name
 * offered and not shown is one gap, routes in `pageRoutes()` order, names sorted. Without
 * `freezesDir` nothing is offered.
 *
 * @param {{ declared: object[], manifest?: object, freezesDir?: string }} input
 */
export function routeTriggerGaps({ declared, manifest, freezesDir }) {
  if (freezesDir === undefined) return [];
  const freezes = Array.isArray(manifest?.freezes) ? manifest.freezes : [];
  const read = new Map();
  const marksOf = (file) => {
    if (!read.has(file)) {
      let marks;
      try {
        marks = frozenMarks(readFileSync(join(freezesDir, file), 'utf8'));
      } catch {
        marks = new Set();
      }
      read.set(file, marks);
    }
    return read.get(file);
  };
  const gaps = [];
  for (const { fullPath } of pageRoutes(manifest)) {
    const own = freezes.filter(
      (freeze) => sameRoute(freeze.route, fullPath) && typeof freeze.file === 'string',
    );
    if (own.length === 0) continue;
    const covered = new Set(
      declared
        .filter((entry) => entry.global && entry.triggered !== false && inScope(entry, fullPath))
        .map((entry) => `${entry.interaction}:${entry.outcome}`),
    );
    const offered = new Set(own.flatMap((freeze) => [...marksOf(freeze.file)]));
    const shown = new Set(
      own.flatMap((freeze) => (Array.isArray(freeze.triggers) ? freeze.triggers : [])),
    );
    const route = shownRoute(fullPath);
    for (const name of [...offered].filter((n) => covered.has(n) && !shown.has(n)).sort(compare)) {
      gaps.push(
        `${name} (${route}): ${route} renders its trigger, but none of its own screenshots shows ` +
          `it. Add a screenshot of ${route} where it is visible (an open menu, an expanded section).`,
      );
    }
  }
  return gaps;
}

/**
 * The outcome gaps, one message each, in the order of the declarations, then one per page route
 * that renders a layout's or app-wide trigger none of its own screenshots shows
 * ({@link routeTriggerGaps}, ticket qits-2225; only with `freezesDir`, the directory holding the
 * manifest and the frozen HTML), then one per unreachable route ({@link unreachableRoutes}, ticket
 * qits-2049), then the unreadable calls. `manifest` is `manifest.json` as read (or `undefined` when
 * there is none).
 *
 * @param {{ declared: object[], unreadable: object[], manifest?: object, freezesDir?: string }} input
 */
export function outcomeGaps({ declared, unreadable, manifest, freezesDir }) {
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
    // No element triggers it (a guard, a callback page): there is no trigger to show.
    if (entry.triggered === false) continue;
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
  gaps.push(...routeTriggerGaps({ declared, manifest, freezesDir }));
  for (const route of unreachableRoutes({ declared, manifest })) {
    gaps.push(
      `${shownRoute(route.fullPath)}: no outcome leads here, and it is not an entry point. Add ` +
        'the exit that should lead here, or declare it an entry point.',
    );
  }
  for (const { file, line, why } of unreadable) {
    gaps.push(`${file}:${line}: an outcomes() call that cannot be read statically (${why}).`);
  }
  return [...new Set(gaps)];
}
