import { basename, dirname, isAbsolute, resolve } from 'node:path';
import {
  DEFAULT_ROUTE_TABLES,
  ROUTES_SCHEMA,
  globRegex,
  literalText,
  pageKind,
  routeLayout,
} from '../project.mjs';

/** The helpers that open a page through the app's routes, unless the rule is told otherwise. */
export const DEFAULT_HELPERS = ['openRoute'];

/** A page or layout screenshot spec: `x.page.browser.spec.ts`, `x.layout.browser.spec.ts`. */
const PAGE_SPEC = /\.(page|layout)\.browser\.spec\.[mc]?[jt]sx?$/;

/** The router providers that take a route table, as `<module>: { <export>: <method or ''> }`. */
const ROUTER_PROVIDERS = {
  '@angular/router': { provideRouter: '', RouterModule: 'forRoot' },
  '@angular/router/testing': { RouterTestingModule: 'withRoutes' },
};

/** `x!`, `x as T`, `x satisfies T`: the expression inside. */
function unwrap(node) {
  while (
    node &&
    ['TSNonNullExpression', 'TSAsExpression', 'TSSatisfiesExpression'].includes(node.type)
  ) {
    node = node.expression;
  }
  return node;
}

/** A member's name when it is plain (`.x`, `['x']`); otherwise undefined. */
function memberName(node) {
  if (!node.computed) return node.property.name;
  return literalText(node.property);
}

/**
 * A page or layout screenshot spec under the routes directory shows the page where the app shows
 * it: through the app's own route table, so the layouts above it render around it and its freezes
 * name the real route. It opens the page with one of the `helpers` (default `openRoute`, the app's
 * own), or hands the router a route table imported from a route-table file (`routeTables`, default
 * `src/app/app.routes.ts`, `src/app/**\/*.routes.ts`): `provideRouter(routes)`. Reported:
 * `TestBed.createComponent(X)` with `X` imported from a `*.page.ts` / `*.layout.ts`; a
 * `provideRouter` / `RouterModule.forRoot` / `RouterTestingModule.withRoutes` given anything but
 * an imported route table (`[]`, an inline table, a local constant); and, when neither of those
 * is reported, a spec that neither calls a helper nor passes an imported table, once, on its first
 * `toMatchScreenshot` call (line 1 without one). Specs elsewhere (a layout under `$layout`, a UI
 * component's) mount stand-ins by design and are not read. A real exception opts out with an
 * `eslint-disable-next-line` (or a file-top `eslint-disable`) comment giving the reason.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        "A page or layout screenshot spec under the routes directory opens the page through the app's routes (openRoute() or provideRouter(routes) from the route table).",
    },
    schema: [
      {
        ...ROUTES_SCHEMA,
        properties: {
          ...ROUTES_SCHEMA.properties,
          helpers: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        },
      },
    ],
    messages: {
      createsPage:
        "{{spec}} renders {{name}} with TestBed.createComponent, outside the app's routes: open the page with {{helpers}} through the app's routes (or provideRouter(routes) with the app's route table), so its screenshots show it where the app shows it.",
      inlineRoutes:
        "{{spec}} gives the router {{what}} instead of the app's route table: open the page with {{helpers}} through the app's routes, or pass the routes imported from a route-table file (provideRouter(routes)).",
      noRoute:
        "{{spec}} takes screenshots without opening the page through the app's routes: open it with {{helpers}}, or provideRouter(routes) with the routes imported from a route-table file.",
    },
  },
  create(context) {
    const layout = routeLayout(context);
    if (!PAGE_SPEC.test(layout.file) || !layout.under(layout.file)) return {};
    const options = context.options[0] ?? {};
    const helpers = new Set(options.helpers ?? DEFAULT_HELPERS);
    const tables = (options.routeTables ?? DEFAULT_ROUTE_TABLES).map(globRegex);
    const spec = basename(layout.file);
    const helperText = [...helpers].map((h) => `${h}()`).join(' / ');

    /** The path an import names: relative to the project root, or as written when bare. */
    const importedPath = (specifier) =>
      specifier.startsWith('.') || isAbsolute(specifier)
        ? layout.toProject(resolve(dirname(layout.absolute), specifier))
        : specifier;
    const isRouteTable = (specifier) => {
      const path = importedPath(specifier);
      return tables.some((g) => g.test(path) || g.test(`${path}.ts`));
    };
    const isPageModule = (specifier) => {
      const path = importedPath(specifier);
      return pageKind(path) !== undefined || /\.(page|layout)$/.test(path);
    };

    /** Local name → specifier of every value import. */
    const imports = new Map();
    /** Local name → the router provider method it is called with (`''`: called itself). */
    const routers = new Map();
    let testBed;
    let routed = false;
    let reported = false;
    let firstShot;

    const report = (node, messageId, data) => {
      reported = true;
      context.report({ node, messageId, data: { spec, helpers: helperText, ...data } });
    };

    /** The arguments a router provider takes its table from, when `node` calls one. */
    const routerCall = (node) => {
      const callee = unwrap(node.callee);
      if (callee.type === 'Identifier') return routers.get(callee.name) === '';
      if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier') return false;
      const method = routers.get(callee.object.name);
      return Boolean(method) && memberName(callee) === method;
    };

    const describeTable = (arg) => {
      if (!arg) return 'no routes';
      if (arg.type === 'ArrayExpression')
        return arg.elements.length === 0 ? 'an empty route table' : 'an inline route table';
      if (arg.type === 'Identifier') return `'${arg.name}' (not imported from a route-table file)`;
      return 'a route table of its own';
    };

    return {
      Program(program) {
        for (const node of program.body) {
          if (node.type !== 'ImportDeclaration' || node.importKind === 'type') continue;
          const from = node.source.value;
          for (const s of node.specifiers) {
            if (s.importKind === 'type') continue;
            imports.set(s.local.name, from);
            if (s.type !== 'ImportSpecifier') continue;
            const imported = s.imported.name ?? s.imported.value;
            const method = ROUTER_PROVIDERS[from]?.[imported];
            if (method !== undefined) routers.set(s.local.name, method);
            if (from === '@angular/core/testing' && imported === 'TestBed') testBed = s.local.name;
          }
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression'
              ? memberName(callee)
              : undefined;
        if (name !== undefined && helpers.has(name)) routed = true;
        if (name === 'toMatchScreenshot' && callee.type === 'MemberExpression' && !firstShot)
          firstShot = node;

        if (
          name === 'createComponent' &&
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === (testBed ?? 'TestBed')
        ) {
          const component = unwrap(node.arguments[0]);
          const from = component?.type === 'Identifier' && imports.get(component.name);
          if (from && isPageModule(from)) report(node, 'createsPage', { name: component.name });
          return;
        }

        if (!routerCall(node)) return;
        const arg = unwrap(node.arguments[0]);
        const from = arg?.type === 'Identifier' && imports.get(arg.name);
        if (from && isRouteTable(from)) {
          routed = true;
          return;
        }
        report(arg ?? node, 'inlineRoutes', { what: describeTable(arg) });
      },
      'Program:exit'(program) {
        // One report per problem: a spec already reported for how it renders is not reported again.
        if (routed || reported) return;
        if (firstShot) report(firstShot, 'noRoute');
        else {
          context.report({
            node: program,
            loc: { line: 1, column: 0 },
            messageId: 'noRoute',
            data: { spec, helpers: helperText },
          });
        }
      },
    };
  },
};
