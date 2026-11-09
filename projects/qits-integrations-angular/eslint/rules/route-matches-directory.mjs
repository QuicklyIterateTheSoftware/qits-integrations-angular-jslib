import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  ROUTES_SCHEMA,
  literalText as text,
  pageKind,
  property,
  routeLayout,
  routeSegments as segments,
  segmentDirs,
  tableBase,
} from '../project.mjs';

/** The first `import('…')` with a literal specifier inside `node`. */
function dynamicImport(node, keys) {
  if (!node || typeof node.type !== 'string') return undefined;
  if (node.type === 'ImportExpression') return text(node.source);
  for (const key of keys[node.type] ?? []) {
    const children = Array.isArray(node[key]) ? node[key] : [node[key]];
    for (const child of children) {
      const found = dynamicImport(child, keys);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * In a route table, every route that renders a component sits where its URL says: the route's
 * full path (the `path`s from the top of the table down through `children`, `:param` as
 * `[param]`) is the directory of the component's file, relative to the routes directory. A
 * `loadChildren` route points at the route table of that directory. A route table under the
 * routes directory is mounted at its own directory. `path: '**'` may render any page;
 * `redirectTo` routes render nothing and are skipped. A `*.layout.ts` under the `$layout` alias
 * directory is shared, not tied to one URL, so it is not checked.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: "A route's component lives in the directory that mirrors the route's URL.",
    },
    schema: [ROUTES_SCHEMA],
    messages: {
      misplaced:
        "Route '{{route}}' renders {{what}} from '{{actual}}/', but its URL puts it in '{{expected}}/'. Move the file there, or change the route.",
    },
  },
  create(context) {
    const layout = routeLayout(context);
    if (!layout.isRouteTable) return {};
    const source = context.sourceCode;
    const base = tableBase(layout, layout.file);

    /** The project path a specifier imports, or undefined for a bare one (an alias, a package). */
    const imported = (specifier) => {
      if (!specifier.startsWith('.') && !isAbsolute(specifier)) return undefined;
      return resolve(dirname(layout.absolute), specifier);
    };

    /** The directory of what a specifier imports; a specifier naming a directory is its index. */
    const directoryOf = (absolute) => {
      try {
        if (existsSync(absolute) && statSync(absolute).isDirectory())
          return layout.toProject(absolute);
      } catch {
        // fall through to the file's directory
      }
      return layout.toProject(dirname(absolute));
    };

    /** Whether an import names a `*.layout.ts` (written with or without its extension). */
    const isLayoutFile = (absolute) =>
      pageKind(absolute) === 'Layout' || /\.layout$/.test(absolute);

    /** Where the component of `component: X` was imported from. */
    const staticImport = (id) => {
      let scope = source.getScope(id);
      for (; scope; scope = scope.upper) {
        const variable = scope.set.get(id.name);
        if (!variable) continue;
        const def = variable.defs[0];
        if (def?.type !== 'ImportBinding') return undefined;
        return text(def.parent.source);
      }
      return undefined;
    };

    const check = (route, valueNode, what) => {
      const segs = segments(route);
      if (!segs || segs.includes('**')) return;
      let specifier;
      if (what === 'its component' && valueNode.type === 'Identifier') {
        specifier = staticImport(valueNode);
      } else {
        specifier = dynamicImport(valueNode, source.visitorKeys);
      }
      const absolute = specifier && imported(specifier);
      if (!absolute) return;
      const dirs = segmentDirs([...base, ...segs]);
      const expected = [layout.routes, ...dirs].join('/');
      const actual = directoryOf(absolute);
      if (actual === expected) return;
      if (what === 'its component' && layout.inLayouts(actual) && isLayoutFile(absolute)) return;
      context.report({
        node: valueNode,
        messageId: 'misplaced',
        data: { route: `/${[...base, ...segs].join('/')}`, what, actual, expected },
      });
    };

    return {
      ObjectExpression(node) {
        if (node.parent?.type !== 'ArrayExpression' || property(node, 'redirectTo')) return;
        const component = property(node, 'component');
        const lazy = property(node, 'loadComponent');
        const children = property(node, 'loadChildren');
        if (component) check(node, component.value, 'its component');
        else if (lazy) check(node, lazy.value, 'its component');
        if (children) check(node, children.value, 'its child routes');
      },
    };
  },
};
