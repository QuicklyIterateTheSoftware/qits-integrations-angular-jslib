import { ROUTES_SCHEMA, isComponentClass, isSpec, pageKind } from '../project.mjs';

/**
 * A page's class says it is a page, and so does its file: the exported component in `x.page.ts`
 * ends in `Page`, the one in `x.layout.ts` ends in `Layout`, and a component class named
 * `…Page` / `…Layout` lives in such a file.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'The component in a *.page.ts ends in Page, in a *.layout.ts in Layout, and only there.',
    },
    // Takes the route options like its siblings, so one options object fits all three.
    schema: [ROUTES_SCHEMA],
    messages: {
      suffix: "'{{name}}' is the component of a {{file}} file: name it …{{suffix}}.",
      wrongFile:
        "'{{name}}' is named as a {{suffix}}: put it in a <name>.{{extension}}.ts file under the routes directory, or rename it.",
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    if (isSpec(file)) return {};
    const kind = pageKind(file);
    const exported = (node) =>
      node.parent?.type === 'ExportNamedDeclaration' ||
      node.parent?.type === 'ExportDefaultDeclaration';
    const check = (node) => {
      if (!node.id || !isComponentClass(node)) return;
      const name = node.id.name;
      if (kind && exported(node) && !name.endsWith(kind)) {
        context.report({
          node: node.id,
          messageId: 'suffix',
          data: { name, suffix: kind, file: `.${kind.toLowerCase()}.ts` },
        });
        return;
      }
      const named = ['Page', 'Layout'].find((s) => name.endsWith(s) && name !== s);
      if (named && named !== kind) {
        context.report({
          node: node.id,
          messageId: 'wrongFile',
          data: { name, suffix: named.toLowerCase(), extension: named.toLowerCase() },
        });
      }
    };
    return { ClassDeclaration: check, ClassExpression: check };
  },
};
