// Shared by the rules: where the app's project root is, and which imports are a generated client.
import { existsSync, readFileSync } from 'node:fs';
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
  const globs = (context.options[0]?.clients ?? DEFAULT_CLIENTS).map(globRegex);
  const file = context.physicalFilename ?? context.filename;
  const root = nearestPackage(file)?.dir ?? context.cwd;
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
export const isSpec = (file) => /\.(spec|test)\.[mc]?[jt]sx?$/.test(file);

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
  let paths;
  let pathsBase;
  let baseUrl;
  const seen = new Set();
  for (let config = resolve(root, 'tsconfig.json'); config && !seen.has(config);) {
    seen.add(config);
    const json = existsSync(config) ? parseJsonc(readFileSync(config, 'utf8')) : undefined;
    if (!json) break;
    const options = json.compilerOptions ?? {};
    // The nearest config that sets a value wins; a relative path is relative to that config.
    if (paths === undefined && options.paths) [paths, pathsBase] = [options.paths, dirname(config)];
    if (baseUrl === undefined && typeof options.baseUrl === 'string')
      baseUrl = resolve(dirname(config), options.baseUrl);
    const parent = typeof json.extends === 'string' ? json.extends : undefined;
    if (!parent?.startsWith('.')) break;
    config = resolve(dirname(config), parent.endsWith('.json') ? parent : `${parent}.json`);
  }
  const target = paths?.[`${LAYOUT_ALIAS}/*`]?.[0];
  const dir =
    typeof target === 'string' && target.endsWith('/*')
      ? resolve(baseUrl ?? pathsBase, target.slice(0, -2))
      : undefined;
  layoutDirs.set(root, dir);
  return dir;
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
