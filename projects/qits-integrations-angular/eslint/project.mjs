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
