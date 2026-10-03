import { ROUTES_SCHEMA, isComponentClass, isSpec, pageKind, routeLayout } from '../project.mjs';

/**
 * The routes directory holds the routed components and nothing else that is a component. A
 * `*.page.ts` or `*.layout.ts` lives under it; a component under it lives in a `*.page.ts` or
 * `*.layout.ts`. Other files there (a resolver, a guard, a `*.routes.ts`) are fine, and so are
 * specs. Components that are not routed belong elsewhere (`ui/components/`, `patterns/`).
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Pages and layouts live under the routes directory, and every component there is one.',
    },
    schema: [ROUTES_SCHEMA],
    messages: {
      outsideRoutes:
        "A {{kind}} file lives under '{{routes}}/', in the directory of its route: move {{file}} there.",
      notAPage:
        "'{{name}}' is a component under '{{routes}}/', so it is routed: name the file <name>.page.ts (or <name>.layout.ts for a route with children). A component that is not routed belongs outside '{{routes}}/'.",
    },
  },
  create(context) {
    const layout = routeLayout(context);
    if (isSpec(layout.file)) return {};
    const kind = pageKind(layout.file);
    const inRoutes = layout.under(layout.file);
    if (kind && !inRoutes) {
      return {
        Program(node) {
          context.report({
            node,
            loc: { line: 1, column: 0 },
            messageId: 'outsideRoutes',
            data: { kind: kind.toLowerCase(), routes: layout.routes, file: layout.file },
          });
        },
      };
    }
    if (kind || !inRoutes) return {};
    const check = (node) => {
      if (!isComponentClass(node)) return;
      context.report({
        node: node.id ?? node,
        messageId: 'notAPage',
        data: { name: node.id?.name ?? 'default', routes: layout.routes },
      });
    };
    return { ClassDeclaration: check, ClassExpression: check };
  },
};
