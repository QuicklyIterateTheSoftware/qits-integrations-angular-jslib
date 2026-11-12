import { literalText, property } from '../project.mjs';

/** A browser spec; other specs are not checked. */
const BROWSER_SPEC = /\.browser\.spec\.[cm]?[jt]sx?$/;

/**
 * The shot kinds. Mirrors `SCREENSHOT_KINDS` in `testing/browser/src/freeze-screenshots.ts`
 * (ticket qits-2046); hard-coded here because the library's enum is TypeScript and this plugin is
 * plain `.mjs`. Keep the two lists in step.
 */
const KINDS = ['DATA', 'NO_DATA', 'PENDING', 'ERROR'];

/**
 * The viewport widths a shot may be widened to. Mirrors `SCREENSHOT_VIEWPORTS` in
 * `testing/browser/src/freeze-screenshots.ts`; same caveat as `KINDS`.
 */
const VIEWPORTS = ['PHONE', 'TABLET', 'DESKTOP'];

/**
 * The colour schemes a shot may be narrowed to (ticket qits-2083). Mirrors `COLOR_SCHEMES` in
 * `testing/browser/src/screenshot-options.ts`; same caveat as `KINDS`. Keep the two lists in step.
 */
const COLOR_SCHEMES = ['LIGHT', 'DARK'];

const KIND_LIST = KINDS.join(', ');
const VIEWPORT_LIST = VIEWPORTS.join(', ');
const COLOR_SCHEME_LIST = COLOR_SCHEMES.join(', ');

/** A member's plain name (`.x`, `['x']` with a literal), or undefined when it is dynamic. */
const memberName = (node) => (node.computed ? literalText(node.property) : node.property.name);

/** What a value is, for a report: its literal text quoted, its identifier name, or 'an expression'. */
const describe = (node) => {
  const text = literalText(node);
  if (text !== undefined) return `'${text}'`;
  return node.type === 'Identifier' ? node.name : 'an expression';
};

/**
 * Every `.toMatchScreenshot(...)` call in a browser spec (`*.browser.spec.*`) names the kind of
 * state the shot shows, so the UI builder (qits-2047) can order and label freezes without
 * guessing from the shot's name. The call is the same shape `page-screenshots-through-routes`
 * checks: a `CallExpression` whose callee is a `MemberExpression` named `toMatchScreenshot`
 * (`expect.element(loc).toMatchScreenshot(...)`).
 *
 * The options object is the first `ObjectExpression` argument, whichever position it is in:
 * `toMatchScreenshot(name, { kind })` or `toMatchScreenshot({ kind })`. Reported, each with its
 * own messageId: no options object at all; an options object with no `kind`; a `kind` that is not
 * a string literal (a plain string `Literal` or a no-expression `TemplateLiteral`) naming one of
 * `DATA` / `NO_DATA` / `PENDING` / `ERROR`; a `viewports` that is not a non-empty array literal of
 * string literals from `PHONE` / `TABLET` / `DESKTOP`; a `colorSchemes` that is not a non-empty
 * array literal of string literals from `LIGHT` / `DARK` (ticket qits-2083); and a `viewports` or
 * `colorSchemes` given without a `reason` that is a non-empty string literal (one reason covers
 * both, reported once, on the first of the two).
 *
 * A spread element in the options object (`{ ...base, kind: 'DATA' }`) makes the rest of the
 * object unreadable, so `viewports` / `colorSchemes` / `reason` are not checked when one is
 * present; `kind` still
 * is, because it is common to give it as its own literal property beside a spread. Without a
 * literal `kind` to find, the spread case is reported the same as a missing `kind`.
 */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Every toMatchScreenshot(...) in a browser spec names the shot's kind (and, with viewports or colorSchemes, a reason).",
    },
    schema: [],
    messages: {
      noOptions: `toMatchScreenshot(...) needs an options object naming the shot's kind: toMatchScreenshot(name, { kind: 'DATA' }) (or toMatchScreenshot({ kind: 'DATA' })). Allowed kinds: ${KIND_LIST}.`,
      missingKind: `This options object has no kind: add kind: '<one of ${KIND_LIST}>', so the UI builder knows what the shot shows.`,
      invalidKind: `kind must be a string literal naming one of ${KIND_LIST}, not {{given}}.`,
      invalidViewports: `viewports must be a non-empty array literal of ${VIEWPORT_LIST} string literals, not {{given}}.`,
      invalidColorSchemes: `colorSchemes must be a non-empty array literal of ${COLOR_SCHEME_LIST} string literals, not {{given}}.`,
      missingReason:
        "viewports and colorSchemes need a reason: add reason: '<why only these widths or schemes>', a non-empty string literal.",
    },
  },
  create(context) {
    const file = context.physicalFilename ?? context.filename;
    if (!BROWSER_SPEC.test(file)) return {};

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || memberName(callee) !== 'toMatchScreenshot') {
          return;
        }

        const options = node.arguments.find((a) => a.type === 'ObjectExpression');
        if (!options) {
          context.report({ node, messageId: 'noOptions' });
          return;
        }

        const spread = options.properties.some((p) => p.type === 'SpreadElement');
        const kindProp = property(options, 'kind');
        if (!kindProp) {
          context.report({ node: options, messageId: 'missingKind' });
        } else {
          const kind = literalText(kindProp.value);
          if (kind === undefined || !KINDS.includes(kind)) {
            context.report({
              node: kindProp.value,
              messageId: 'invalidKind',
              data: { given: describe(kindProp.value) },
            });
          }
        }

        // A spread makes the rest of the object unreadable: viewports/colorSchemes/reason are not
        // checkable.
        if (spread) return;

        /** An opt-out list: reported unless a non-empty array literal of `allowed` literals. */
        const checkList = (prop, allowed, messageId) => {
          if (!prop) return;
          const value = prop.value;
          const elements =
            value.type === 'ArrayExpression'
              ? value.elements.map((e) => e && literalText(e))
              : undefined;
          const valid =
            elements !== undefined &&
            elements.length > 0 &&
            elements.every((v) => v !== undefined && allowed.includes(v));
          if (!valid) context.report({ node: value, messageId, data: { given: describe(value) } });
        };

        const viewportsProp = property(options, 'viewports');
        const colorSchemesProp = property(options, 'colorSchemes');
        if (!viewportsProp && !colorSchemesProp) return;
        checkList(viewportsProp, VIEWPORTS, 'invalidViewports');
        checkList(colorSchemesProp, COLOR_SCHEMES, 'invalidColorSchemes');

        const reasonProp = property(options, 'reason');
        const reason = reasonProp && literalText(reasonProp.value);
        if (!reason) {
          context.report({ node: viewportsProp ?? colorSchemesProp, messageId: 'missingReason' });
        }
      },
    };
  },
};
