import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { ROUTES_SCHEMA, isComponentClass, isSpec, pageKind, routeLayout } from '../project.mjs';

/** A spec takes a screenshot when it calls `toMatchScreenshot(…)` (Vitest browser mode). */
const SCREENSHOT = /\btoMatchScreenshot\s*\(/;

/**
 * Every page and layout under the routes directory, and every layout under the `$layout` alias
 * directory, has screenshot tests beside it: `x.page.ts`
 * needs `x.page.browser.spec.ts`, `x.layout.ts` needs `x.layout.browser.spec.ts`, and that spec
 * calls `toMatchScreenshot`. A page with nothing to show (a redirect) opts out with an
 * `eslint-disable-next-line` comment that gives the reason.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every page and layout under the routes directory (and layout under $layout) has a sibling <name>.browser.spec.ts that takes screenshots.',
    },
    schema: [ROUTES_SCHEMA],
    messages: {
      noSpec: 'This {{kind}} has no screenshot tests: add {{spec}} beside it.',
      noScreenshot:
        "{{spec}} takes no screenshot: call expect.element(…).toMatchScreenshot('<name>') in it.",
    },
  },
  create(context) {
    const layout = routeLayout(context);
    if (isSpec(layout.file)) return {};
    const kind = pageKind(layout.file);
    const checked =
      layout.under(layout.file) || (kind === 'Layout' && layout.inLayouts(layout.file));
    if (!kind || !checked) return {};
    const spec = layout.absolute.replace(/\.([mc]?tsx?)$/, '.browser.spec.$1');
    let messageId;
    if (!existsSync(spec)) messageId = 'noSpec';
    else if (!SCREENSHOT.test(readFileSync(spec, 'utf8'))) messageId = 'noScreenshot';
    else return {};

    const data = { kind: kind.toLowerCase(), spec: basename(spec) };
    let component;
    const check = (node) => {
      if (!component && isComponentClass(node)) component = node;
    };
    return {
      ClassDeclaration: check,
      ClassExpression: check,
      'Program:exit'(program) {
        // From its `@Component` on, so a disable comment above the decorator covers it.
        if (component) {
          const from = component.decorators?.[0] ?? component;
          const loc = { start: from.loc.start, end: (component.id ?? component).loc.end };
          context.report({ node: component, loc, messageId, data });
        } else context.report({ node: program, loc: { line: 1, column: 0 }, messageId, data });
      },
    };
  },
};
