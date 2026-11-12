import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  AST,
  BindingType,
  Interpolation,
  LiteralMap,
  LiteralPrimitive,
  ParenthesizedExpression,
  TemplateLiteral,
  TmplAstRecursiveVisitor,
  parseTemplate,
  tmplAstVisitAll,
} from '@angular/compiler';
import { isComponentClass, literalText, nearestPackage, property } from '../project.mjs';

/** The stylesheet the theme is read from, relative to the project root, unless told otherwise. */
export const DEFAULT_THEME = 'src/styles.css';

/** Tailwind v4's default palettes (4.1's mauve, olive, mist and taupe included) and their steps. */
const PALETTES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'mauve',
  'olive',
  'mist',
  'taupe',
];
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const DEFAULT_PALETTE = new Set([
  'white',
  'black',
  ...PALETTES.flatMap((p) => STEPS.map((s) => `${p}-${s}`)),
]);

/** Tailwind's own values for the two palette colours that are not steps. */
const BUILTIN = { '--color-white': '#fff', '--color-black': '#000' };

/** The utility families that take a colour, longest first so `border-x` wins over `border`. */
const FAMILIES = [
  'bg',
  'text',
  'border',
  'border-x',
  'border-y',
  'border-t',
  'border-r',
  'border-b',
  'border-l',
  'border-s',
  'border-e',
  'ring',
  'ring-offset',
  'outline',
  'fill',
  'stroke',
  'from',
  'via',
  'to',
  'divide',
  'placeholder',
  'decoration',
  'shadow',
  'inset-shadow',
  'inset-ring',
  'text-shadow',
  'drop-shadow',
  'accent',
  'caret',
].sort((a, b) => b.length - a.length);

/** Colour words that name no fixed colour. */
const KEYWORDS = new Set(['current', 'currentcolor', 'transparent', 'inherit', 'initial', 'unset']);

/** CSS's named colours (`transparent` and `currentColor` are keywords, not fixed colours). */
const NAMED = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet
  brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue
  darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange
  darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise
  darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia
  gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo
  ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue
  lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon
  mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
  mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
  navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen
  paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red
  rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue
  slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white
  whitesmoke yellow yellowgreen`.split(/\s+/),
);

/** Properties whose identifiers are names, never colours (`animation-name: tomato`). */
const NAME_PROPERTIES = new Set([
  'font',
  'font-family',
  'animation',
  'animation-name',
  'grid-area',
  'grid-row',
  'grid-column',
  'grid-template-areas',
  'content',
  'counter-reset',
  'counter-increment',
  'counter-set',
  'list-style',
  'list-style-type',
  'transition',
  'transition-property',
  'will-change',
  'view-transition-name',
  'container',
  'container-name',
  'anchor-name',
  'position-anchor',
]);

const FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/gi;
const HEX = /(?<![\w-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const VAR_COLOR = /var\(\s*--color-([\w-]+)\s*[,)]/g;
const WORD = /(?<![\w#.-])[a-z]+(?![\w(-])/gi;

/** Lower case, whitespace collapsed: how two colour values are compared. */
const norm = (value) => value.trim().replace(/\s+/g, ' ').toLowerCase();

/** The index of the `)` closing the `(` at `open`, or the text's end. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return text.length - 1;
}

/** `text` with the inside of strings and `url(...)` blanked, so offsets stay put. */
function maskValue(text) {
  let out = text.replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/g, (s) => ' '.repeat(s.length));
  for (const m of [...out.matchAll(/(?<![\w-])url\(/gi)]) {
    const end = closing(out, m.index + 3);
    out = out.slice(0, m.index) + ' '.repeat(end + 1 - m.index) + out.slice(end + 1);
  }
  return out;
}

/** The top-level comma-separated arguments of a function's inside. */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * A light CSS scan: declarations (`prop: value`, with the value's offset) and at-rule statements
 * (`@import …;`, `@apply …;`), each with the block preludes it sits in. Comments are blanked first,
 * so every offset is an offset into `text`. Text without blocks (a `style` attribute) is a list of
 * declarations.
 */
export function scanCss(text, { declaration, atRule }, { lineComments = false } = {}) {
  text = text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (c) => c.replace(/[^\n]/g, ' '));
  if (lineComments) text = text.replace(/(^|[\s;{}])\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));
  const stack = [];
  let start = 0;
  let depth = 0;
  let quote;
  const statement = (end) => {
    const raw = text.slice(start, end);
    const body = raw.trim();
    if (!body) return;
    const at = start + raw.length - raw.trimStart().length;
    if (body[0] === '@') {
      const head = /^@([\w-]+)\s*/.exec(body);
      atRule?.({
        name: head?.[1] ?? '',
        params: body.slice(head?.[0].length ?? 1),
        paramsStart: at + (head?.[0].length ?? 1),
        stack,
      });
      return;
    }
    const colon = body.indexOf(':');
    if (colon < 0) return;
    declaration?.({
      prop: body.slice(0, colon).trim().toLowerCase(),
      value: body.slice(colon + 1),
      valueStart: at + colon + 1,
      stack,
    });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth > 0) continue;
    else if (c === '{') {
      stack.push(text.slice(start, i).trim());
      start = i + 1;
    } else if (c === ';' || c === '}') {
      statement(i);
      if (c === '}') stack.pop();
      start = i + 1;
    }
  }
  statement(text.length);
}

/** Whether a block prelude puts what it holds in a dark-only context. */
const isDark = (prelude) => prelude.startsWith('@custom-variant') || /dark/i.test(prelude);

/** The target of a package `exports` entry: `style`, then `default`, nested conditions too. */
function condition(target) {
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.map(condition).find((t) => t);
  if (target && typeof target === 'object') {
    for (const c of ['style', 'default']) {
      const found = condition(target[c]);
      if (found) return found;
    }
  }
  return undefined;
}

/** A bare stylesheet import (`pkg/sub.css`, `@scope/pkg/sub.css`) from `node_modules`. */
function resolveBare(root, specifier) {
  const parts = specifier.split('/');
  const n = specifier.startsWith('@') ? 2 : 1;
  const pkg = parts.slice(0, n).join('/');
  const sub = parts.slice(n).join('/');
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', pkg, 'package.json');
    if (existsSync(manifest)) {
      const base = dirname(manifest);
      let json;
      try {
        json = JSON.parse(readFileSync(manifest, 'utf8'));
      } catch {
        json = {};
      }
      const key = sub ? `./${sub}` : '.';
      const exportsMap = json?.exports;
      let target;
      if (typeof exportsMap === 'string' || Array.isArray(exportsMap))
        target = key === '.' ? condition(exportsMap) : undefined;
      else if (exportsMap && typeof exportsMap === 'object') {
        const conditionsOnly = Object.keys(exportsMap).every((k) => !k.startsWith('.'));
        target = conditionsOnly
          ? key === '.'
            ? condition(exportsMap)
            : undefined
          : condition(exportsMap[key]);
      }
      if (target) return resolve(base, target);
      if (!sub) return typeof json?.style === 'string' ? resolve(base, json.style) : undefined;
      return resolve(base, sub);
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** The specifier of an `@import` statement's params, or undefined. */
function importSpecifier(params) {
  const m = /^(?:url\(\s*(['"]?)(.*?)\1\s*\)|(['"])(.*?)\3)/i.exec(params.trim());
  return m ? (m[2] ?? m[4]) : undefined;
}

const themes = new Map();

/**
 * The app's theme, read from `theme` (relative to the project root) and every stylesheet it
 * `@import`s (Tailwind itself excluded): the colours an `@theme` block declares (`--color-<name>`;
 * a name ending in a numeric step is a palette step, any other a semantic token), and every custom
 * property's light value (declarations outside any dark context, the last one winning). Cached
 * per project root and theme for the process.
 */
export function loadTheme(root, option) {
  const display = option ?? DEFAULT_THEME;
  const path = resolve(root, display);
  const key = `${root}\0${path}`;
  if (themes.has(key)) return themes.get(key);
  const theme = {
    display,
    found: existsSync(path),
    order: [],
    semantic: new Set(),
    steps: new Set(),
    light: new Map(),
    chains: new Map(),
  };
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    scanCss(
      text,
      {
        atRule({ name, params, stack }) {
          if (name !== 'import' || stack.length > 0) return;
          const specifier = importSpecifier(params);
          if (!specifier || /^(?:tailwindcss(?:\/|$)|[a-z]+:)/i.test(specifier)) return;
          const target =
            specifier.startsWith('.') || specifier.startsWith('/')
              ? resolve(dirname(file), specifier)
              : resolveBare(root, specifier);
          if (target) visit(target);
        },
        declaration({ prop, value, stack }) {
          if (!prop.startsWith('--') || stack.some(isDark)) return;
          theme.light.set(prop, value.trim());
          if (!prop.startsWith('--color-') || !stack.some((p) => /^@theme\b/.test(p))) return;
          const name = prop.slice('--color-'.length);
          if (name.includes('*') || theme.semantic.has(name) || theme.steps.has(name)) return;
          if (/-\d+$/.test(name)) theme.steps.add(name);
          else {
            theme.semantic.add(name);
            theme.order.push(name);
          }
        },
      },
      { lineComments: /\.(?:scss|less)$/.test(file) },
    );
  };
  if (theme.found) visit(path);
  themes.set(key, theme);
  return theme;
}

/**
 * Where a value leads through the light declarations: every `--color-<name>` it passes through
 * (`refs`), and the literal it ends at (undefined when it ends at an unknown variable).
 * `var(--x, fallback)` follows `--x` when it is known, the fallback otherwise; `light-dark(a, b)`
 * takes `a`.
 */
function chain(theme, value) {
  const refs = new Set();
  const seen = new Set();
  let v = norm(value);
  for (let i = 0; i < 64; i++) {
    const lightDark = /^light-dark\((.*)\)$/.exec(v);
    if (lightDark) {
      v = norm(splitTop(lightDark[1])[0]);
      continue;
    }
    const ref = /^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/.exec(v);
    if (!ref) break;
    const [, prop, fallback] = ref;
    if (prop.startsWith('--color-')) refs.add(prop.slice('--color-'.length));
    if (theme.light.has(prop) && !seen.has(prop)) {
      seen.add(prop);
      v = norm(theme.light.get(prop));
    } else if (BUILTIN[prop] && !seen.has(prop)) {
      seen.add(prop);
      v = BUILTIN[prop];
    } else if (fallback !== undefined) v = norm(fallback);
    else return { refs, literal: undefined };
  }
  return { refs, literal: v };
}

/** The semantic tokens' chains, in declaration order, computed once per theme. */
function semanticChains(theme) {
  if (!theme.semanticChains)
    theme.semanticChains = theme.order.map((name) => [name, chain(theme, `var(--color-${name})`)]);
  return theme.semanticChains;
}

/** The first semantic token whose light value is the palette colour `name`. */
function semanticForPalette(theme, name) {
  const target = chain(theme, `var(--color-${name})`);
  return semanticChains(theme).find(
    ([, c]) => c.refs.has(name) || (target.literal !== undefined && c.literal === target.literal),
  )?.[0];
}

/** The first semantic token whose light value is the literal colour `literal`. */
function semanticForLiteral(theme, literal) {
  const target = norm(literal);
  return semanticChains(theme).find(([, c]) => c.literal === target)?.[0];
}

const isPalette = (theme, name) => DEFAULT_PALETTE.has(name) || theme.steps.has(name);

/**
 * Every fixed colour in a CSS value: colour functions, hex, `var(--color-<palette step>)` and
 * named colours (not for properties whose identifiers are names). Each is `{ start, end, text,
 * palette | literal }`, offsets into `value`.
 */
function rawColours(theme, value, prop = '') {
  let masked = maskValue(value);
  const found = [];
  for (const m of [...masked.matchAll(FUNCTION)]) {
    if (masked[m.index] === ' ') continue; // inside one already found
    const end = closing(masked, m.index + m[0].length - 1) + 1;
    found.push({ start: m.index, end, literal: value.slice(m.index, end) });
    masked = masked.slice(0, m.index) + ' '.repeat(end - m.index) + masked.slice(end);
  }
  for (const m of masked.matchAll(VAR_COLOR)) {
    const name = m[1];
    if (!isPalette(theme, name)) continue;
    const end = closing(masked, m.index + 3) + 1;
    found.push({ start: m.index, end, palette: name });
  }
  for (const m of masked.matchAll(HEX)) {
    found.push({ start: m.index, end: m.index + m[0].length, literal: m[0] });
  }
  if (!NAME_PROPERTIES.has(prop)) {
    const outsideVar = masked.replace(/var\([^)]*\)/g, (s) => ' '.repeat(s.length));
    for (const m of outsideVar.matchAll(WORD)) {
      if (NAMED.has(m[0].toLowerCase()))
        found.push({ start: m.index, end: m.index + m[0].length, literal: m[0] });
    }
  }
  return found
    .map((f) => ({ ...f, text: value.slice(f.start, f.end) }))
    .sort((a, b) => a.start - b.start);
}

/** The index of the last `ch` outside `[]` / `()`, or -1. */
function lastOutside(text, ch) {
  let depth = 0;
  let found = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ch && depth === 0) found = i;
  }
  return found;
}

/**
 * A class token's verdict: undefined when it names no fixed colour, otherwise
 * `{ replacement }` (undefined when no semantic token has the same light value).
 */
function checkUtility(theme, token) {
  const variants = lastOutside(token, ':') + 1;
  let rest = token.slice(variants);
  let lead = '';
  let tail = '';
  if (rest.startsWith('!')) [lead, rest] = ['!', rest.slice(1)];
  if (rest.startsWith('-')) [lead, rest] = [`${lead}-`, rest.slice(1)];
  if (rest.endsWith('!')) [tail, rest] = ['!', rest.slice(0, -1)];
  const slash = lastOutside(rest, '/');
  if (slash > 0) [tail, rest] = [rest.slice(slash) + tail, rest.slice(0, slash)];
  const family = FAMILIES.find((f) => rest.startsWith(`${f}-`));
  if (!family) return undefined;
  const value = rest.slice(family.length + 1);
  const fix = (semantic) =>
    semantic && `${token.slice(0, variants)}${lead}${family}-${semantic}${tail}`;

  if (value.startsWith('[') && value.endsWith(']')) {
    let inner = value.slice(1, -1).replace(/_/g, ' ');
    const hint = /^([a-z-]+):(?!\/)/.exec(inner);
    if (hint) {
      if (hint[1] !== 'color') return undefined;
      inner = inner.slice(hint[0].length);
    }
    const colours = rawColours(theme, inner);
    if (colours.length === 0) return undefined;
    const whole = colours.length === 1 && colours[0].text === inner.trim() ? colours[0] : undefined;
    if (!whole) return { replacement: undefined };
    return {
      replacement: fix(
        whole.palette
          ? semanticForPalette(theme, whole.palette)
          : semanticForLiteral(theme, whole.literal),
      ),
    };
  }
  if (value.startsWith('(') && value.endsWith(')')) {
    const m = /^(?:color:)?--color-([\w-]+)$/.exec(value.slice(1, -1).trim());
    if (!m || !isPalette(theme, m[1])) return undefined;
    return { replacement: fix(semanticForPalette(theme, m[1])) };
  }
  if (KEYWORDS.has(value.toLowerCase()) || !isPalette(theme, value)) return undefined;
  return { replacement: fix(semanticForPalette(theme, value)) };
}

/**
 * The tokens of a class string, with offsets: split at whitespace, and at a quote outside `[…]`, so
 * an Angular expression held in a TypeScript string (`"cond ? 'bg-white' : ''"`) yields `bg-white`.
 */
function* tokens(text) {
  let start = -1;
  let depth = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    const breaks = c === undefined || /\s/.test(c) || (depth === 0 && /['"`]/.test(c));
    if (breaks) {
      if (start >= 0) yield { token: text.slice(start, i), start };
      start = -1;
      depth = 0;
      continue;
    }
    if (start < 0) start = i;
    if (c === '[') depth++;
    else if (c === ']' && depth > 0) depth--;
  }
}

/** 1-based line and column of an offset in a text. */
function lineCol(text, offset) {
  const before = text.slice(0, offset).split('\n');
  return `${before.length}:${before[before.length - 1].length + 1}`;
}

/** The `@Component({...})` metadata object of a class, or undefined. */
function componentMeta(node) {
  const decorator = node.decorators?.find((d) => {
    const callee = d.expression?.type === 'CallExpression' ? d.expression.callee : undefined;
    const name = callee?.type === 'MemberExpression' ? callee.property.name : callee?.name;
    return name === 'Component' && d.expression.arguments[0]?.type === 'ObjectExpression';
  });
  return decorator?.expression.arguments[0];
}

/** `(x)`: the expression inside. */
function unparen(ast) {
  while (ast instanceof ParenthesizedExpression) ast = ast.expression;
  return ast;
}

/** Every AST node of an Angular expression, depth first. */
function walkAst(node, visit) {
  if (!(node instanceof AST)) return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const v of value) walkAst(v, visit);
    else walkAst(value, visit);
  }
}

/**
 * In a dark-mode-capable app, colours come from the app's semantic theme tokens, never a palette
 * step or a literal colour. Off in `recommended`: an app turns it on once its theme has the
 * tokens. Reads component templates (inline and `templateUrl`: `class`, `[class.x]`, the string
 * literals of `[class]` / `[ngClass]`, `style`, literal `[style.x]` / `[style]` / `[ngStyle]`
 * values), component styles (inline and `styleUrl(s)`: declaration values and `@apply`), and every
 * other string of the file for colour utilities only. The theme (option `theme`, default
 * `src/styles.css`, relative to the project root) is followed through its `@import`s; its `@theme`
 * blocks say which `--color-*` tokens exist, and its light declarations give each one's value, so
 * a report suggests the semantic token whose light value is the fixed colour's.
 */
export default {
  meta: {
    type: 'suggestion',
    hasSuggestions: true,
    docs: {
      description:
        "Colours come from the app's semantic theme tokens, never a palette step or a literal colour.",
    },
    schema: [
      {
        type: 'object',
        properties: { theme: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
    ],
    messages: {
      fixed: '{{name}} is a fixed colour; use a semantic token from the theme{{hint}}{{where}}',
      fixedNoTheme:
        '`{{name}}` is a fixed colour; the theme {{theme}} was not found, so no semantic token is known{{where}}',
      replace: 'Use {{replacement}}',
    },
  },
  create(context) {
    const absolute = context.physicalFilename ?? context.filename;
    const root = nearestPackage(absolute)?.dir ?? context.cwd;
    const theme = loadTheme(root, context.options[0]?.theme);
    const { sourceCode } = context;
    const handled = new Set();
    const strings = [];
    const reported = new Set();

    /**
     * Report one fixed colour at `[start, end)` of a source: an inline one (`base`: where its text
     * starts in this file, undefined when escapes make offsets unreliable) gets a precise location
     * and a suggestion; an external one (`file`) is reported on its property with the location.
     */
    const report = (src, start, end, name, replacement) => {
      const key = `${src.id}:${start}:${end}`;
      if (reported.has(key)) return;
      reported.add(key);
      const data = {
        name,
        hint: replacement ? ` (${replacement})` : '',
        where: src.file ? ` (${src.file}:${lineCol(src.text, start)})` : '',
        theme: theme.display,
      };
      const descriptor = {
        node: src.node,
        messageId: theme.found ? 'fixed' : 'fixedNoTheme',
        data,
      };
      if (src.base !== undefined) {
        const range = [src.base + start, src.base + end];
        descriptor.loc = {
          start: sourceCode.getLocFromIndex(range[0]),
          end: sourceCode.getLocFromIndex(range[1]),
        };
        if (replacement)
          descriptor.suggest = [
            {
              messageId: 'replace',
              data: { replacement },
              fix: (fixer) => fixer.replaceTextRange(range, replacement),
            },
          ];
      }
      context.report(descriptor);
    };

    /** A class string at `offset` of a source; tokens touching a `${}` / `{{}}` edge are skipped. */
    const classes = (src, text, offset, { openStart = false, openEnd = false } = {}) => {
      for (const { token, start } of tokens(text)) {
        if (openStart && start === 0) continue;
        if (openEnd && start + token.length === text.length) continue;
        const verdict = checkUtility(theme, token);
        if (verdict)
          report(src, offset + start, offset + start + token.length, token, verdict.replacement);
      }
    };

    /** A CSS value at `offset` of a source. */
    const cssValue = (src, prop, value, offset) => {
      for (const colour of rawColours(theme, value, prop)) {
        const semantic = colour.palette
          ? semanticForPalette(theme, colour.palette)
          : semanticForLiteral(theme, colour.literal);
        report(
          src,
          offset + colour.start,
          offset + colour.end,
          colour.text,
          semantic && `var(--color-${semantic})`,
        );
      }
    };

    /** CSS (a stylesheet, or a `style` attribute's declarations) at `offset` of a source. */
    const css = (src, text, offset, lineComments = false) => {
      scanCss(
        text,
        {
          declaration: ({ prop, value, valueStart }) =>
            cssValue(src, prop, value, offset + valueStart),
          atRule: ({ name, params, paramsStart }) => {
            if (name === 'apply') classes(src, params, offset + paramsStart);
          },
        },
        { lineComments },
      );
    };

    /**
     * A string literal of an Angular expression: `check(text, offset)` when the template text
     * holds it verbatim, otherwise the whole literal is reported without a suggestion.
     */
    const angularString = (src, ast, check) => {
      const start = ast.sourceSpan.start + 1;
      if (src.text.slice(start, start + ast.value.length) === ast.value) check(ast.value, start);
      else {
        const verdicts = [...tokens(ast.value)].some(({ token }) => checkUtility(theme, token));
        if (verdicts) report(src, ast.sourceSpan.start, ast.sourceSpan.end, ast.value, undefined);
      }
    };

    /** The literal class strings of a `[class]` / `[ngClass]` expression. */
    const boundClasses = (src, ast) => {
      walkAst(ast, (node) => {
        if (node instanceof LiteralPrimitive && typeof node.value === 'string') {
          angularString(src, node, (text, start) => classes(src, text, start));
        } else if (node instanceof LiteralMap) {
          for (const key of node.keys) {
            if (key.isShorthandInitialized || !key.sourceSpan) continue;
            const start = key.sourceSpan.start + (key.quoted ? 1 : 0);
            if (src.text.slice(start, start + key.key.length) === key.key)
              classes(src, key.key, start);
          }
        } else if (node instanceof TemplateLiteral) {
          node.elements.forEach((element, i) => {
            const start = element.sourceSpan.start + 1;
            if (src.text.slice(start, start + element.text.length) !== element.text) return;
            classes(src, element.text, start, {
              openStart: i > 0,
              openEnd: i < node.elements.length - 1,
            });
          });
        } else if (node instanceof Interpolation) {
          let at = node.sourceSpan.start;
          node.strings.forEach((piece, i) => {
            if (src.text.slice(at, at + piece.length) === piece)
              classes(src, piece, at, { openStart: i > 0, openEnd: i < node.strings.length - 1 });
            const expression = node.expressions[i];
            if (expression) {
              const close = src.text.indexOf('}}', expression.sourceSpan.end);
              at = close < 0 ? src.text.length : close + 2;
            }
          });
        }
      });
    };

    /** The literal values of a `[style]` / `[ngStyle]` expression. */
    const boundStyles = (src, ast) => {
      ast = unparen(ast);
      if (ast instanceof Interpolation) return;
      if (ast instanceof LiteralMap) {
        ast.keys.forEach((key, i) => {
          walkAst(ast.values[i], (node) => {
            if (node instanceof LiteralPrimitive && typeof node.value === 'string')
              angularString(src, node, (text, start) =>
                cssValue(src, key.key.toLowerCase(), text, start),
              );
          });
        });
        return;
      }
      walkAst(ast, (node) => {
        if (node instanceof LiteralPrimitive && typeof node.value === 'string')
          angularString(src, node, (text, start) => css(src, text, start));
      });
    };

    /** A component template's text. */
    const template = (src, url) => {
      let nodes;
      try {
        nodes = parseTemplate(src.text, url, { preserveWhitespaces: true }).nodes;
      } catch {
        return;
      }
      const attributes = (attrs) => {
        for (const attr of attrs) {
          const name = attr.name;
          if (attr.value instanceof Object && 'ast' in attr.value) {
            const ast = attr.value.ast;
            if (attr.type === BindingType.Class) {
              const start = attr.keySpan.start.offset + 'class.'.length;
              if (src.text.slice(start, start + name.length) === name) classes(src, name, start);
            } else if (attr.type === BindingType.Style) {
              const literal = unparen(ast);
              if (literal instanceof LiteralPrimitive && typeof literal.value === 'string')
                angularString(src, literal, (text, start) =>
                  cssValue(src, name.toLowerCase(), text, start),
                );
            } else if (attr.type === BindingType.Property) {
              if (name === 'class' || name === 'className' || name === 'ngClass')
                boundClasses(src, ast);
              else if (name === 'style' || name === 'ngStyle') boundStyles(src, ast);
            }
          } else if (typeof attr.value === 'string' && attr.valueSpan) {
            const start = attr.valueSpan.start.offset;
            if (src.text.slice(start, start + attr.value.length) !== attr.value) continue;
            if (name === 'class') classes(src, attr.value, start);
            else if (name === 'style') css(src, attr.value, start);
          }
        }
      };
      class Visitor extends TmplAstRecursiveVisitor {
        visitElement(element) {
          attributes(element.attributes);
          attributes(element.inputs);
          super.visitElement(element);
        }
        visitTemplate(node) {
          attributes(node.attributes);
          attributes(node.inputs);
          super.visitTemplate(node);
        }
      }
      tmplAstVisitAll(new Visitor(), nodes);
    };

    /**
     * A string or template literal as a source: its text and where that starts in this file
     * (undefined when escapes shift the offsets). Each `${}` of a template literal is filled with
     * `_` of the same length, so offsets stay put and a token touching one names no colour.
     */
    const inlineSource = (literal) => {
      const source = { id: literal.range[0], node: literal };
      if (literal.type === 'Literal') {
        if (typeof literal.value !== 'string') return undefined;
        const exact = literal.raw.slice(1, -1) === literal.value;
        return { ...source, text: literal.value, base: exact ? literal.range[0] + 1 : undefined };
      }
      if (literal.type !== 'TemplateLiteral') return undefined;
      const { quasis } = literal;
      if (quasis.every((q) => q.value.raw === q.value.cooked)) {
        const start = literal.range[0] + 1;
        let text = sourceCode.text.slice(start, literal.range[1] - 1);
        for (let i = 0; i < quasis.length - 1; i++) {
          const from = quasis[i].range[1] - 2 - start;
          const to = quasis[i + 1].range[0] + 1 - start;
          text = text.slice(0, from) + '_'.repeat(to - from) + text.slice(to);
        }
        return { ...source, text, base: start };
      }
      return { ...source, text: quasis.map((q) => q.value.cooked ?? '').join('____') };
    };

    /** A file next to the component: its project-relative name and text, or undefined. */
    const externalSource = (node, url) => {
      const path = resolve(dirname(absolute), url);
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        return undefined; // the build reports a missing file
      }
      return { id: path, node, text, file: relative(root, path).split(sep).join('/'), path };
    };

    const component = (node) => {
      if (!isComponentClass(node)) return;
      const meta = componentMeta(node);
      if (!meta) return;

      const inline = property(meta, 'template');
      const inlineTemplate = inline && inlineSource(inline.value);
      if (inlineTemplate) {
        handled.add(inline.value);
        template(inlineTemplate, absolute);
      }
      const url = property(meta, 'templateUrl');
      const urlText = literalText(url?.value);
      if (urlText !== undefined) {
        handled.add(url.value);
        const src = externalSource(url.value, urlText);
        if (src) template(src, src.path);
      }

      const styles = property(meta, 'styles')?.value;
      for (const style of styles?.type === 'ArrayExpression' ? styles.elements : [styles]) {
        if (!style) continue;
        const src = inlineSource(style);
        if (src) {
          handled.add(style);
          css(src, src.text, 0);
        }
      }
      const styleUrls = [property(meta, 'styleUrl')?.value];
      const list = property(meta, 'styleUrls')?.value;
      if (list?.type === 'ArrayExpression') styleUrls.push(...list.elements);
      for (const styleUrl of styleUrls) {
        const text = literalText(styleUrl);
        if (text === undefined) continue;
        handled.add(styleUrl);
        const src = externalSource(styleUrl, text);
        if (src) css(src, src.text, 0, /\.(?:scss|less)$/.test(text));
      }
    };

    /** Whether a string names a module rather than holding text. */
    const isModuleName = (node) => {
      const parent = node.parent;
      return (
        (parent?.source === node &&
          [
            'ImportDeclaration',
            'ExportNamedDeclaration',
            'ExportAllDeclaration',
            'ImportExpression',
          ].includes(parent.type)) ||
        parent?.type === 'TSExternalModuleReference' ||
        (parent?.type === 'TSModuleDeclaration' && parent.id === node)
      );
    };

    return {
      ClassDeclaration: component,
      ClassExpression: component,
      Literal(node) {
        if (typeof node.value === 'string' && !isModuleName(node)) strings.push(node);
      },
      TemplateLiteral(node) {
        strings.push(node);
      },
      'Program:exit'() {
        for (const node of strings) {
          if (handled.has(node)) continue;
          if (node.type === 'Literal') {
            const src = inlineSource(node);
            classes(src, src.text, 0);
            continue;
          }
          node.quasis.forEach((quasi, i) => {
            const text = quasi.value.cooked ?? '';
            const exact = quasi.value.raw === text;
            const src = {
              id: quasi.range[0],
              node: quasi,
              text,
              base: exact ? quasi.range[0] + 1 : undefined,
            };
            classes(src, text, 0, { openStart: i > 0, openEnd: i < node.quasis.length - 1 });
          });
        }
      },
    };
  },
};
