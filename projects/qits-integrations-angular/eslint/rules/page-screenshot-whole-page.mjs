import { basename } from 'node:path';
import { ROUTES_SCHEMA, memberName, routeLayout, unwrap } from '../project.mjs';

/** The members that hold the whole routed page, unless the rule is told otherwise. */
export const DEFAULT_WHOLE_PAGE = ['frame', 'routeNativeElement'];

/** A page or layout screenshot spec: `x.page.browser.spec.ts`, `x.layout.browser.spec.ts`. */
const PAGE_SPEC = /\.(page|layout)\.browser\.spec\.[mc]?[jt]sx?$/;

/** The members that may sit between `expect(...)` and the matcher. */
const MODIFIERS = new Set(['not', 'soft']);

/** The expressions a function returns: an arrow's body expression, or its own `return`s. */
function returned(fn) {
  if (fn.body.type !== 'BlockStatement') return [fn.body];
  const out = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ReturnStatement') {
      out.push(node.argument);
      return;
    }
    // A nested function's returns are its own.
    if (/Function/.test(node.type)) return;
    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child.type === 'string') visit(child);
    }
  };
  fn.body.body.forEach(visit);
  return out;
}

/**
 * A page or layout screenshot spec under the routes directory (the scope of
 * `page-screenshots-through-routes`) screenshots the whole page: a freeze taken there is listed by
 * the UI builder as a state of that route, so a crop would show an action bar as "the page in
 * state X". The subject of `expect.element(<subject>).toMatchScreenshot(...)` (also
 * `expect(<subject>)`, with `.not` / `.soft` between) must be the whole page, after unwrapping
 * `!` / `as` / `satisfies`: a member named in `wholePage` (default `frame`, `routeNativeElement`)
 * that is not chained further; `<x>.elementLocator(<whole page>)`; an identifier bound by a
 * `const` / `let` to a whole page (awaited or not), or destructured under a `wholePage` key
 * (`const { frame } = await shown()`, trusted by name); or a call to a function declared in the
 * file whose every returned expression is a whole page (its arguments are not read). Everything
 * else is reported, once per screenshot, on the subject: locator chains (`getByRole(...)`),
 * `querySelector` / `closest` results, `opened.page` (the routed component without the shell),
 * helper calls, parameters, anything it cannot resolve. A part of the page belongs in its
 * component's own browser spec; a real exception opts out with an `eslint-disable-next-line`
 * comment giving the reason.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A page or layout screenshot spec under the routes directory screenshots the whole page (opened.frame), not a part of it.',
    },
    schema: [
      {
        ...ROUTES_SCHEMA,
        properties: {
          ...ROUTES_SCHEMA.properties,
          wholePage: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        },
      },
    ],
    messages: {
      partOfPage:
        "{{spec}} screenshots part of the page: screenshot the whole page (`opened.frame`). For a part of the page, put the screenshot in that component's own browser spec under `patterns/` or `ui/`, or give the page a provider state that shows it.",
    },
  },
  create(context) {
    const layout = routeLayout(context);
    if (!PAGE_SPEC.test(layout.file) || !layout.under(layout.file)) return {};
    const options = context.options[0] ?? {};
    const wholePage = new Set(options.wholePage ?? DEFAULT_WHOLE_PAGE);
    const spec = basename(layout.file);

    /** The variable `name` names where `node` sits, or undefined. */
    const variable = (node, name) => {
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        const found = scope.set.get(name);
        if (found) return found;
      }
      return undefined;
    };

    /** The function a callee names, when it is declared in this file. */
    const declaredFunction = (callee) => {
      const def = variable(callee, callee.name)?.defs[0];
      if (def?.type === 'FunctionName') return def.node;
      if (def?.type !== 'Variable' || def.node.id !== def.name) return undefined;
      const init = unwrap(def.node.init);
      return ['ArrowFunctionExpression', 'FunctionExpression'].includes(init?.type)
        ? init
        : undefined;
    };

    /** `check()` with `key` on the path in `seen`: false when it is already there (a cycle). */
    const once = (seen, key, check) => {
      if (seen.has(key)) return false;
      seen.add(key);
      try {
        return check();
      } finally {
        seen.delete(key);
      }
    };

    /** Whether `node` is the whole page; `seen` holds the bindings and functions on the path. */
    const isWhole = (node, seen = new Set()) => {
      node = unwrap(node);
      if (!node) return false;
      if (node.type === 'MemberExpression') return wholePage.has(memberName(node));
      if (node.type === 'Identifier') {
        const def = variable(node, node.name)?.defs[0];
        if (def?.type !== 'Variable' || !['const', 'let'].includes(def.parent.kind)) return false;
        if (def.node.id === def.name) {
          let init = unwrap(def.node.init);
          if (init?.type === 'AwaitExpression') init = init.argument;
          return once(seen, def.node, () => isWhole(init, seen));
        }
        // Destructured: `{ frame }`, `{ frame: f }`, `{ frame = x }`, trusted by its key.
        let at = def.name.parent;
        if (at?.type === 'AssignmentPattern') at = at.parent;
        return (
          at?.type === 'Property' && !at.computed && wholePage.has(at.key.name ?? at.key.value)
        );
      }
      if (node.type !== 'CallExpression') return false;
      const callee = unwrap(node.callee);
      if (callee.type === 'MemberExpression' && memberName(callee) === 'elementLocator')
        return isWhole(node.arguments[0], seen);
      if (callee.type !== 'Identifier') return false;
      const fn = declaredFunction(callee);
      if (!fn) return false;
      const results = returned(fn);
      return once(seen, fn, () => results.length > 0 && results.every((r) => isWhole(r, seen)));
    };

    /** The subject of `expect.element(subject)` / `expect(subject)` under a matcher, or undefined. */
    const subjectOf = (object) => {
      object = unwrap(object);
      while (object?.type === 'MemberExpression' && MODIFIERS.has(memberName(object)))
        object = unwrap(object.object);
      if (object?.type !== 'CallExpression') return undefined;
      const callee = unwrap(object.callee);
      const isExpect =
        (callee.type === 'Identifier' && callee.name === 'expect') ||
        (callee.type === 'MemberExpression' &&
          ['element', 'soft'].includes(memberName(callee)) &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'expect');
      return isExpect ? object.arguments[0] : undefined;
    };

    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type !== 'MemberExpression' || memberName(callee) !== 'toMatchScreenshot')
          return;
        const subject = subjectOf(callee.object);
        if (!subject || subject.type === 'SpreadElement' || isWhole(subject)) return;
        context.report({ node: subject, messageId: 'partOfPage', data: { spec } });
      },
    };
  },
};
