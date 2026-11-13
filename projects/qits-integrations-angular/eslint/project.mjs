// Shared by the rules: where the app's project root is, and which imports are a generated client.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Where the generated clients live, relative to the project root, unless a rule is told otherwise. */
export const DEFAULT_CLIENTS = ['src/app/api/**'];

/** The `clients` option every client-aware rule takes. */
export const CLIENTS_SCHEMA = {
  type: 'object',
  properties: { clients: { type: 'array', items: { type: 'string' }, minItems: 1 } },
  additionalProperties: false,
};

const packages = new Map();

/** The nearest package.json at or above `file`'s directory: `{ dir, name }`, or undefined. */
export function nearestPackage(file) {
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    if (packages.has(dir)) return packages.get(dir);
    const manifest = `${dir}${sep}package.json`;
    if (existsSync(manifest)) {
      let name;
      try {
        name = JSON.parse(readFileSync(manifest, 'utf8')).name;
      } catch {
        name = undefined;
      }
      const found = { dir, name };
      packages.set(dir, found);
      return found;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** A glob (`**`, `*`, `?`) as an anchored regex over `/`-separated paths. */
export function globRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * A matcher for one file's imports: `isClient(specifier)` says whether an import names a generated
 * client. A relative specifier is resolved against the importing file and taken relative to the
 * project root; a bare one (a path alias) is matched as written. `inClients` says whether the
 * importing file is itself part of a client (a generated client imports itself freely).
 */
export function clientMatcher(context) {
  return clientMatcherFor(
    context.physicalFilename ?? context.filename,
    context.options[0]?.clients,
    context.cwd,
  );
}

/**
 * The same matcher for any file on disk, not only the one being linted: a rule that follows an
 * import into another file asks with that file's own path, so its relative imports resolve from it.
 */
export function clientMatcherFor(file, clients = DEFAULT_CLIENTS, cwd = process.cwd()) {
  const globs = clients.map(globRegex);
  const root = nearestPackage(file)?.dir ?? cwd;
  const asProjectPath = (path) => relative(root, path).split(sep).join('/');
  const matches = (path) =>
    globs.some((g) => g.test(path) || g.test(path.replace(/\.[mc]?[jt]sx?$/, '')));
  return {
    /** The importing file, relative to the project root. */
    file: asProjectPath(file),
    inClients: matches(asProjectPath(file)),
    isClient(specifier) {
      if (specifier.startsWith('.') || isAbsolute(specifier)) {
        const path = asProjectPath(resolve(dirname(file), specifier));
        return !path.startsWith('..') && (matches(path) || matches(`${path}/index`));
      }
      return matches(specifier);
    },
  };
}

/** An `import type` / `export type`, or one whose every name is `type`: it calls nothing. */
function typeOnly(node) {
  if (node.importKind === 'type' || node.exportKind === 'type') return true;
  const names = node.specifiers ?? [];
  return names.length > 0 && names.every((s) => s.importKind === 'type' || s.exportKind === 'type');
}

/**
 * Every static import / re-export / literal dynamic import in a file, as `(node, specifier)`.
 * Type-only ones are skipped: a type from a client calls nothing.
 */
export function importVisitors(onImport) {
  const literal = (node, source) => {
    if (typeOnly(node)) return;
    if (source?.type === 'Literal' && typeof source.value === 'string')
      onImport(node, source.value);
  };
  return {
    ImportDeclaration: (node) => literal(node, node.source),
    ExportNamedDeclaration: (node) => literal(node, node.source),
    ExportAllDeclaration: (node) => literal(node, node.source),
    ImportExpression: (node) => literal(node, node.source),
  };
}

export const isStore = (file) => /\.store\.[mc]?[jt]s$/.test(file);
export const isOperations = (file) => /\.operations\.[mc]?[jt]s$/.test(file);
export const isSpec = (file) => /\.(spec|test)\.[mc]?[jt]sx?$/.test(file);

/**
 * The specifiers a source file on disk imports, read with a regex rather than a parser: a store
 * named by `inject(X)` is a different file from the one being linted, and parsing it would tie the
 * rule to whichever parser the app configured. Comments are stripped first; type-only imports and
 * re-exports (`import type`, or braces holding nothing but `type` names) are left out, as
 * importVisitors leaves them out. A string that merely looks like an import can still be read as
 * one, which errs towards reporting.
 */
export function importedSpecifiers(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const found = [];
  // The clause may not run on into a later import/export: `export class X {}` followed by an
  // `import type` would otherwise read as one value import.
  const statement =
    /\b(?:import|export)\s+(type\s+)?((?:(?!\b(?:import|export)\b)[^'";])*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const [, type, clause, specifier] of code.matchAll(statement)) {
    const names = /^\{([^}]*)\}$/
      .exec(clause.trim())?.[1]
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n);
    if (type || (names?.length && names.every((n) => /^type\s/.test(n)))) continue;
    found.push(specifier);
  }
  for (const [, specifier] of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push(specifier);
  }
  for (const [, specifier] of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) found.push(specifier);
  return found;
}

/**
 * The `*.store.ts` file a specifier names, as an absolute path, or undefined when it names none.
 * A relative specifier resolves against the importing file, a bare one through the tsconfig path
 * aliases (aliasTargets); `x.store`, `x.store.ts` and the ESM-style `x.store.js` all find
 * `x.store.ts`.
 */
export function resolveStore(fromFile, specifier) {
  const bases = specifier.startsWith('.')
    ? [resolve(dirname(fromFile), specifier)]
    : aliasTargets(fromFile, specifier);
  for (const base of bases) {
    const stem = base.replace(/\.[mc]?[jt]s$/, '');
    const candidates = [base, `${stem}.ts`, `${stem}.mts`, `${base}.ts`, `${base}.mts`];
    const store = candidates.find(
      (path) => isStore(path) && existsSync(path) && statSync(path).isFile(),
    );
    if (store) return store;
  }
  return undefined;
}

const storeClients = new Map();

/**
 * Whether a store file on disk imports a generated client, by the same globs the linting rule was
 * given. A bare specifier counts when it matches the globs as written (as clientMatcher has it) or
 * when one of its tsconfig alias targets lies in them, so `$api/agents` finds `src/app/api/agents`. Remembered per path for as long as the file is unchanged (its mtime), so a lint run reads
 * each store once and an editor's long-lived ESLint still sees an edit.
 */
export function storeImportsClient(store, clients = DEFAULT_CLIENTS, cwd = process.cwd()) {
  const mtime = statSync(store).mtimeMs;
  const key = JSON.stringify(clients);
  const known = storeClients.get(store);
  if (known && known.mtime === mtime && known.key === key) return known.result;
  const matcher = clientMatcherFor(store, clients, cwd);
  const result = importedSpecifiers(readFileSync(store, 'utf8')).some(
    (s) =>
      matcher.isClient(s) ||
      (!s.startsWith('.') && aliasTargets(store, s).some((path) => matcher.isClient(path))),
  );
  storeClients.set(store, { mtime, key, result });
  return result;
}

/** Where the routed components live, relative to the project root, unless a rule is told otherwise. */
export const DEFAULT_ROUTES = 'src/app/routes';

/** The files that declare routes, unless a rule is told otherwise. */
export const DEFAULT_ROUTE_TABLES = ['src/app/app.routes.ts', 'src/app/**/*.routes.ts'];

/** The `routes` / `routeTables` options every route-aware rule takes. */
export const ROUTES_SCHEMA = {
  type: 'object',
  properties: {
    routes: { type: 'string', minLength: 1 },
    routeTables: { type: 'array', items: { type: 'string' }, minItems: 1 },
  },
  additionalProperties: false,
};

/** The path alias whose directory may also hold routed layouts. */
export const LAYOUT_ALIAS = '$layout';

/** JSON with comments and trailing commas (a tsconfig) as a value; undefined when it is not. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}

const layoutDirs = new Map();

/**
 * Where the `$layout/*` path alias points, as an absolute directory, from `<root>/tsconfig.json`
 * (following a relative `extends`); undefined when the project has no such alias.
 */
export function layoutAliasDir(root) {
  if (layoutDirs.has(root)) return layoutDirs.get(root);
  const { paths, base } = compilerPaths(resolve(root, 'tsconfig.json'));
  const target = paths?.[`${LAYOUT_ALIAS}/*`]?.[0];
  const dir =
    typeof target === 'string' && target.endsWith('/*')
      ? resolve(base, target.slice(0, -2))
      : undefined;
  layoutDirs.set(root, dir);
  return dir;
}

/**
 * A tsconfig's `compilerOptions.paths` and the directory its targets are relative to (`baseUrl`
 * when set, otherwise the config that holds `paths`), following relative `extends`: the nearest
 * config that sets a value wins. `files` lists every config read, for a cache to watch.
 */
function compilerPaths(start) {
  let paths;
  let pathsBase;
  let baseUrl;
  const seen = new Set();
  for (let config = start; config && !seen.has(config);) {
    seen.add(config);
    const json = existsSync(config) ? parseJsonc(readFileSync(config, 'utf8')) : undefined;
    if (!json) break;
    const options = json.compilerOptions ?? {};
    // A relative path is relative to the config that sets it.
    if (paths === undefined && options.paths) [paths, pathsBase] = [options.paths, dirname(config)];
    if (baseUrl === undefined && typeof options.baseUrl === 'string')
      baseUrl = resolve(dirname(config), options.baseUrl);
    const parent = typeof json.extends === 'string' ? json.extends : undefined;
    if (!parent?.startsWith('.')) break;
    config = resolve(dirname(config), parent.endsWith('.json') ? parent : `${parent}.json`);
  }
  return { paths, base: baseUrl ?? pathsBase, files: [...seen] };
}

const aliasConfigs = new Map();

/** The nearest tsconfig.json at or above `file`'s directory, not looking past its package root. */
function nearestTsconfig(file) {
  const stop = nearestPackage(file)?.dir;
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    const config = `${dir}${sep}tsconfig.json`;
    if (existsSync(config)) return config;
    if (dir === stop || dirname(dir) === dir) return undefined;
  }
}

const mtimeOf = (path) => (existsSync(path) ? statSync(path).mtimeMs : -1);

/**
 * The absolute paths a path-alias specifier may stand for, by the `paths` of the tsconfig nearest
 * to `fromFile`: `$core/x/y.store` under `"$core/*": ["./src/app/core/*"]` is
 * `<config dir>/src/app/core/x/y.store`, an exact pattern maps as written, and every target of a
 * matching pattern is a candidate. Empty when no pattern matches or there is no tsconfig. The
 * config is read again only when it, or one it extends, changes.
 */
export function aliasTargets(fromFile, specifier) {
  const config = nearestTsconfig(fromFile);
  if (!config) return [];
  let known = aliasConfigs.get(config);
  if (!known || known.files.some(([path, mtime]) => mtimeOf(path) !== mtime)) {
    const { paths, base, files } = compilerPaths(config);
    known = { paths: paths ?? {}, base, files: files.map((path) => [path, mtimeOf(path)]) };
    aliasConfigs.set(config, known);
  }
  const found = [];
  for (const [pattern, targets] of Object.entries(known.paths)) {
    if (!Array.isArray(targets)) continue;
    const star = pattern.indexOf('*');
    let rest;
    if (star < 0) {
      if (pattern !== specifier) continue;
      rest = '';
    } else {
      const [prefix, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      if (specifier.length < prefix.length + suffix.length) continue;
      rest = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const target of targets) {
      if (typeof target === 'string') found.push(resolve(known.base, target.replace('*', rest)));
    }
  }
  return found;
}

const inside = (dir) => (path) => dir !== undefined && (path === dir || path.startsWith(`${dir}/`));

/**
 * One file's place in the route layout. `file` is the linted file relative to the project root,
 * `routes` the routes directory, `under(path)` says whether a project path is in it, `layouts` the
 * directory of the `$layout` alias (undefined without one), `inLayouts(path)` whether a project
 * path is in that, `toProject` turns an absolute path into a project path, and `isRouteTable`
 * whether the linted file is one.
 */
export function routeLayout(context) {
  const options = context.options[0] ?? {};
  const routes = (options.routes ?? DEFAULT_ROUTES).replace(/^\.\//, '').replace(/\/+$/, '');
  const tables = (options.routeTables ?? DEFAULT_ROUTE_TABLES).map(globRegex);
  const absolute = context.physicalFilename ?? context.filename;
  const root = nearestPackage(absolute)?.dir ?? context.cwd;
  const toProject = (path) => relative(root, path).split(sep).join('/');
  const file = toProject(absolute);
  const aliasDir = layoutAliasDir(root);
  const layouts = aliasDir && toProject(aliasDir);
  return {
    absolute,
    file,
    routes,
    layouts,
    toProject,
    under: inside(routes),
    inLayouts: inside(layouts),
    isRouteTable: tables.some((g) => g.test(file)),
  };
}

/** `x.page.ts` is a page, `x.layout.ts` a layout; anything else is neither. */
export function pageKind(file) {
  const m = /\.(page|layout)\.[mc]?tsx?$/.exec(file);
  if (!m) return undefined;
  return m[1] === 'page' ? 'Page' : 'Layout';
}

/** Whether a class carries Angular's `@Component(...)` (or `@ng.Component(...)`). */
export function isComponentClass(node) {
  return (node.decorators ?? []).some((d) => {
    const callee = d.expression?.type === 'CallExpression' ? d.expression.callee : d.expression;
    if (callee?.type === 'Identifier') return callee.name === 'Component';
    return callee?.type === 'MemberExpression' && callee.property.name === 'Component';
  });
}

/** A property of an object literal by its plain key, or undefined. */
export function property(object, key) {
  return object.properties.find(
    (p) =>
      p.type === 'Property' &&
      !p.computed &&
      ((p.key.type === 'Identifier' && p.key.name === key) || p.key.value === key),
  );
}

/** A string literal or a template without expressions, as its text; otherwise undefined. */
export function literalText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0].value.cooked;
  return undefined;
}

/** `x!`, `x as T`, `x satisfies T`: the expression inside. */
export function unwrap(node) {
  while (
    node &&
    ['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression'].includes(node.type)
  ) {
    node = node.expression;
  }
  return node;
}

/** A member's name when it is plain (`.x`, `['x']`); otherwise undefined. */
export function memberName(node) {
  if (!node.computed) return node.property.name;
  return literalText(node.property);
}

/** `x as Routes`, `x satisfies Routes`, `x!`: the expression inside. */
function unwrapParent(node) {
  let parent = node.parent;
  while (
    parent &&
    ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(parent.type)
  ) {
    parent = parent.parent;
  }
  return parent;
}

/** The route object a route sits in as one of its `children`, or undefined at the top. */
export function parentRoute(route) {
  const array = route.parent;
  if (array?.type !== 'ArrayExpression') return undefined;
  const prop = unwrapParent(array);
  if (prop?.type !== 'Property' || prop.key.name !== 'children') return undefined;
  return prop.parent?.type === 'ObjectExpression' ? prop.parent : undefined;
}

/**
 * A route's URL segments from the top of its table (the literal `path`s joined down through
 * `children`), or undefined when one of them is not a literal. Needs `parent` links on the AST.
 */
export function routeSegments(route) {
  const own = [];
  for (let r = route; r; r = parentRoute(r)) {
    const path = property(r, 'path');
    if (!path) continue;
    const value = literalText(path.value);
    if (value === undefined) return undefined;
    own.unshift(...value.split('/').filter((s) => s));
  }
  return own;
}

/** URL segments as directories: a `:param` is a `[param]` directory. */
export const segmentDirs = (segments) =>
  segments.map((s) => (s.startsWith(':') ? `[${s.slice(1)}]` : s));

/**
 * Where a route table is mounted, as URL segments: a table under the routes directory is mounted
 * at its own directory there, any other at the top.
 */
export function tableBase(layout, file) {
  const fileDir = dirname(file);
  return layout.under(fileDir)
    ? fileDir
        .slice(layout.routes.length)
        .split('/')
        .filter((s) => s)
    : [];
}
