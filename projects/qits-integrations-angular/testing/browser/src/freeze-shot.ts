/**
 * The freeze of one screenshot (ticket qits-1947): the screenshotted element as a standalone HTML
 * document, with the stylesheet rules that style it, so the page a test froze can be read, searched
 * and opened as HTML rather than only seen as a PNG.
 *
 * Unlike `freezeElement()` in the main entry (feature capture), which inlines computed-style diffs,
 * this keeps the app's own CSS *rules*, filtered to those that can apply: computed styles depend on
 * the renderer and are heavy, rules do not and are not. The output must be the same bytes on every
 * machine and in every test order, so:
 *
 * - The document is `<!doctype html><html><head><meta charset="utf-8"><style>…</style></head>
 *   <body>…</body></html>`. Between `<body>` and the element its ancestors stay as empty shells
 *   (tag and attributes only), so descendant selectors and `body` styles still apply. A shot of
 *   the page, of `<body>` or of `<html>` freezes `<body>` with everything in it.
 * - Nothing runs: `<script>`, `<noscript>`, `<template>`, preload links, every `on*` attribute,
 *   `srcdoc` and `javascript:` URLs are dropped.
 * - Live state becomes attributes: an input's `value` and `checked`, an option's `selected`, a
 *   textarea's text, `open` on `<details>` and `<dialog>`; a `<canvas>` becomes an `<img>` of its
 *   pixels.
 * - Noise goes: comments (Angular's `<!--container-->`), `ng-reflect-*`, `ng-version`, `<style>`
 *   and stylesheet links in the subtree (their rules are inlined with the others).
 * - Generated names are renamed in order of appearance: `_ngcontent-*` / `_nghost-*` to `c0`, `c1`,
 *   … in the HTML and in the CSS, every `id` to `f0`, `f1`, … with every reference to it (`for`,
 *   `aria-*`, `list`, `href="#…"`, `url(#…)`, `#id` selectors).
 * - A style rule stays when its selector, with pseudo-classes and pseudo-elements stripped, matches
 *   the element, something inside it or one of the shells. `@media`, `@supports`, `@container`,
 *   `@layer` and `@scope` blocks are filtered the same way and stay when anything in them does;
 *   `@layer` statements and `@property` stay; `@font-face` stays for the families the kept
 *   elements use; `@keyframes` and `@starting-style` go (screenshot tests turn animations off).
 *   Vitest's own sheets (`/__vitest…`) and sheets the page may not read (cross-origin) are skipped.
 * - Class names numbered by a page-wide counter (`renameClasses`, by default xterm's
 *   `xterm-dom-renderer-owner-<n>`) are renumbered in order of appearance, in the HTML and the CSS.
 * - A rule whose text (in its at-rule context) was already kept is dropped: a sheet injected again
 *   for every spec file in the shared page would otherwise repeat once per file that ran before.
 * - A `blob:` URL is random per run and dies with the page: a loaded `<img>` from one is inlined as
 *   a PNG data URL, any other becomes `about:blank`, in the HTML and in the CSS.
 * - A same-origin URL in CSS or in `src`/`srcset`/`poster`/an SVG `href` becomes
 *   `qits-freeze-asset:<path>` and is listed in `assets`; the Node side copies the file and points
 *   the URL at the copy. Other URLs (cross-origin, `data:`) stay as they are.
 */

/** What a same-origin URL becomes until the Node side points it at the copied file. */
export const FREEZE_ASSET_PREFIX = 'qits-freeze-asset:';

/** Class names numbered by a page-wide counter: renumbered in order of appearance by default. */
export const DEFAULT_RENAMED_CLASSES: readonly RegExp[] = [/^xterm-dom-renderer-owner-\d+$/];

/** Options for {@link freezeShot}. */
export interface FreezeShotOptions {
  /**
   * Whole class names to renumber (their last number becomes the order in which the freeze first
   * meets one of the same shape). Default {@link DEFAULT_RENAMED_CLASSES}; giving it replaces the
   * default. Match whole names only: a pattern like `/-\d+$/` would renumber Tailwind's `p-4`.
   */
  readonly renameClasses?: readonly RegExp[];
}

/** What a `blob:` URL becomes when it cannot be inlined. */
export const BLOB_PLACEHOLDER = 'about:blank';

/** A frozen screenshot: the HTML, and the same-origin paths it refers to (sorted, unique). */
export interface ShotFreeze {
  readonly html: string;
  readonly assets: string[];
}

const DROPPED = new Set(['script', 'noscript', 'template', 'style']);
const DROPPED_LINKS = /(^|\s)(stylesheet|preload|modulepreload|prefetch)(\s|$)/i;
const URL_ATTRIBUTES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'xlink:href',
  'data',
  'poster',
]);
const ID_LIST_ATTRIBUTES = new Set([
  'for',
  'list',
  'form',
  'headers',
  'anchor',
  'popovertarget',
  'commandfor',
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
  'aria-activedescendant',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
]);
const NG_ATTRIBUTE = /^_ng(content|host)-(.+)$/;
const NG_IN_CSS = /_ng(content|host)-([\w-]+)/g;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/g;

/** Freezes `target` (an element, or the page: anything that is not an element freezes `<body>`). */
export function freezeShot(
  target: Element | null | undefined,
  doc: Document = document,
  options: FreezeShotOptions = {},
): ShotFreeze {
  const body = doc.body;
  const element = target && target !== doc.documentElement && body.contains(target) ? target : body;
  const shells: Element[] = [];
  if (element !== body) {
    for (let at = element.parentElement; at && at !== body; at = at.parentElement) {
      shells.unshift(at);
    }
  }

  const out = doc.implementation.createHTMLDocument('');
  const ctx: Context = {
    doc,
    out,
    assets: new Set(),
    ng: new Map(),
    ids: new Map(),
    renameClasses: options.renameClasses ?? DEFAULT_RENAMED_CLASSES,
    classes: new Map(),
    classShapes: new Map(),
  };

  const html = shell(doc.documentElement, ctx);
  const head = out.createElement('head');
  const meta = out.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  const style = out.createElement('style');
  head.append(meta, style);
  html.append(head);
  let parent = shell(body, ctx);
  html.append(parent);
  for (const ancestor of shells) {
    const next = shell(ancestor, ctx);
    parent.append(next);
    parent = next;
  }
  if (element === body) {
    for (const child of body.childNodes) appendCopy(child, parent, ctx);
  } else {
    appendCopy(element, parent, ctx);
  }

  renameGenerated(html, ctx);
  const kept = [doc.documentElement, body, ...shells, element, ...element.querySelectorAll('*')];
  const css = keptCss(kept, element, ctx);
  style.textContent = css ? `\n${css}\n` : '';

  return { html: `<!doctype html>\n${html.outerHTML}\n`, assets: [...ctx.assets].sort() };
}

interface Context {
  readonly doc: Document;
  readonly out: Document;
  readonly assets: Set<string>;
  /** `_ngcontent-`/`_nghost-` suffix → `c<n>`. */
  readonly ng: Map<string, string>;
  /** id → `f<n>`. */
  readonly ids: Map<string, string>;
  readonly renameClasses: readonly RegExp[];
  /** class name → its renumbered name. */
  readonly classes: Map<string, string>;
  /** a class name's shape (its last number as `#`) → how many of that shape are named. */
  readonly classShapes: Map<string, number>;
}

/** The element alone: its tag and its (cleaned) attributes. */
function shell(element: Element, ctx: Context): Element {
  const copy = ctx.out.importNode(element, false) as Element;
  cleanAttributes(copy, ctx);
  return copy;
}

function appendCopy(node: Node, parent: Element, ctx: Context): void {
  if (node.nodeType === Node.TEXT_NODE) {
    parent.append(ctx.out.importNode(node, false));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return; // comments, processing instructions
  const element = node as Element;
  const tag = element.localName;
  if (DROPPED.has(tag)) return;
  if (tag === 'link' && DROPPED_LINKS.test(element.getAttribute('rel') ?? '')) return;
  if (element instanceof HTMLCanvasElement) {
    parent.append(canvasImage(element, ctx));
    return;
  }
  const copy = shell(element, ctx);
  if (element instanceof HTMLImageElement && /^blob:/i.test(element.currentSrc || element.src)) {
    const inlined = blobImage(element);
    if (inlined) copy.setAttribute('src', inlined);
  }
  reflectState(element, copy);
  parent.append(copy);
  if (element instanceof HTMLTextAreaElement) {
    copy.textContent = element.value;
    return;
  }
  for (const child of element.childNodes) appendCopy(child, copy, ctx);
}

/** A canvas serializes empty: an `<img>` of its pixels instead (a tainted canvas stays empty). */
function canvasImage(canvas: HTMLCanvasElement, ctx: Context): Element {
  let src: string;
  try {
    src = canvas.toDataURL('image/png');
  } catch {
    return shell(canvas, ctx);
  }
  const img = ctx.out.createElement('img');
  for (const { name, value } of canvas.attributes) img.setAttribute(name, value);
  cleanAttributes(img, ctx);
  img.setAttribute('src', src);
  return img;
}

/** A loaded image from a `blob:` URL as a PNG data URL; undefined when it has not loaded. */
function blobImage(img: HTMLImageElement): string | undefined {
  if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) return undefined;
  const canvas = img.ownerDocument.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  try {
    canvas.getContext('2d')?.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

function reflectState(element: Element, copy: Element): void {
  const toggle = (name: string, on: boolean) =>
    on ? copy.setAttribute(name, '') : copy.removeAttribute(name);
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox' || element.type === 'radio') toggle('checked', element.checked);
    else if (element.type !== 'file' && (element.value !== '' || copy.hasAttribute('value'))) {
      copy.setAttribute('value', element.value);
    }
  } else if (element instanceof HTMLOptionElement) {
    toggle('selected', element.selected);
  } else if (element instanceof HTMLDetailsElement || element instanceof HTMLDialogElement) {
    toggle('open', element.open);
  }
}

function cleanAttributes(copy: Element, ctx: Context): void {
  for (const { name, value } of [...copy.attributes]) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith('on') ||
      lower.startsWith('ng-reflect-') ||
      lower === 'ng-version' ||
      lower === 'srcdoc' ||
      (lower === 'style' && value.trim() === '') ||
      (URL_ATTRIBUTES.has(lower) && isJavaScriptUrl(value))
    ) {
      copy.removeAttribute(name);
      continue;
    }
    const rewritten = rewriteAssets(copy, lower, value, ctx);
    if (rewritten !== value) copy.setAttribute(name, rewritten);
  }
}

/** Whether a URL is `javascript:`, as a browser reads it: ignoring whitespace and control characters. */
function isJavaScriptUrl(value: string): boolean {
  const compact = [...value].filter((c) => c.charCodeAt(0) > 0x20).join('');
  return /^javascript:/i.test(compact);
}

function rewriteAssets(copy: Element, name: string, value: string, ctx: Context): string {
  const base = ctx.doc.baseURI;
  if (name === 'style') return rewriteCssUrls(value, base, ctx);
  if (name === 'srcset') {
    return value
      .split(',')
      .map((candidate) => {
        const [url, ...descriptor] = candidate.trim().split(/\s+/);
        return [asset(url, base, ctx), ...descriptor].join(' ');
      })
      .join(', ');
  }
  if (name === 'src' || name === 'poster') return asset(value, base, ctx);
  const svgHref =
    (name === 'href' || name === 'xlink:href') &&
    copy.namespaceURI === 'http://www.w3.org/2000/svg' &&
    ['image', 'use', 'feimage'].includes(copy.localName.toLowerCase());
  return svgHref ? asset(value, base, ctx) : value;
}

/** `raw` as `qits-freeze-asset:<path>` when it is a same-origin file; otherwise unchanged. */
function asset(raw: string, base: string, ctx: Context): string {
  const value = raw.trim();
  if (/^blob:/i.test(value)) return BLOB_PLACEHOLDER; // random per run, dead after it
  if (value === '' || value.startsWith('#') || /^(data|about):/i.test(value)) return raw;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return raw;
  }
  if (url.origin !== new URL(ctx.doc.baseURI).origin) return raw;
  ctx.assets.add(url.pathname);
  return `${FREEZE_ASSET_PREFIX}${url.pathname}${url.hash}`;
}

function rewriteCssUrls(css: string, base: string, ctx: Context): string {
  return css.replace(CSS_URL, (whole, double?: string, single?: string, bare?: string) => {
    const raw = double ?? single ?? bare ?? '';
    const rewritten = asset(raw, base, ctx);
    return rewritten === raw ? whole : `url("${rewritten}")`;
  });
}

/** Renames `_ngcontent-*`/`_nghost-*` and ids (with what refers to them) in document order. */
function renameGenerated(root: Element, ctx: Context): void {
  const elements = [root, ...root.querySelectorAll('*')];
  for (const element of elements) {
    for (const { name, value } of [...element.attributes]) {
      const ng = NG_ATTRIBUTE.exec(name);
      if (!ng) continue;
      element.removeAttribute(name);
      element.setAttribute(`_ng${ng[1]}-${ngName(ng[2], ctx)}`, value);
    }
    const id = element.getAttribute('id');
    if (id !== null && id !== '') element.setAttribute('id', idName(id, ctx));
    const classes = element.getAttribute('class');
    if (classes) {
      const renamed = classes.replace(/[^\s]+/g, (token) => className(token, ctx));
      if (renamed !== classes) element.setAttribute('class', renamed);
    }
  }
  for (const element of elements) {
    for (const { name, value } of [...element.attributes]) {
      const lower = name.toLowerCase();
      let next = value;
      if (ID_LIST_ATTRIBUTES.has(lower)) {
        next = value
          .split(/(\s+)/)
          .map((token) => (token.trim() === '' ? token : idName(token, ctx)))
          .join('');
      } else if ((lower === 'href' || lower === 'xlink:href') && /^#.+/.test(value)) {
        next = `#${idName(value.slice(1), ctx)}`;
      }
      if (lower !== 'id')
        next = next.replace(
          /url\(\s*(["']?)#([^"')]+)\1\s*\)/g,
          (_, q, ref) => `url(${q}#${idName(ref, ctx)}${q})`,
        );
      if (next !== value) element.setAttribute(name, next);
    }
  }
}

function ngName(suffix: string, ctx: Context): string {
  let name = ctx.ng.get(suffix);
  if (name === undefined) ctx.ng.set(suffix, (name = `c${ctx.ng.size}`));
  return name;
}

/** `token`, renumbered when a `renameClasses` pattern matches it whole; otherwise unchanged. */
function className(token: string, ctx: Context): string {
  if (!ctx.renameClasses.some((pattern) => wholeMatch(pattern, token))) return token;
  let name = ctx.classes.get(token);
  if (name === undefined) {
    const shape = token.replace(/\d+(?=\D*$)/, '#');
    const n = ctx.classShapes.get(shape) ?? 0;
    ctx.classShapes.set(shape, n + 1);
    name = shape.includes('#') ? shape.replace('#', String(n)) : token;
    ctx.classes.set(token, name);
  }
  return name;
}

function wholeMatch(pattern: RegExp, token: string): boolean {
  const match = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).exec(token);
  return match !== null && match[0] === token;
}

function idName(id: string, ctx: Context): string {
  let name = ctx.ids.get(id);
  if (name === undefined) ctx.ids.set(id, (name = `f${ctx.ids.size}`));
  return name;
}

/** The kept rules of every readable stylesheet of the page, in order, one per line. */
function keptCss(kept: Element[], element: Element, ctx: Context): string {
  const filter: Filter = {
    families: usedFamilies(kept),
    ancestors: kept.slice(0, kept.indexOf(element)),
    element,
    matched: new Map(),
    emitted: new Set(),
    ctx,
  };
  const sheets = [...ctx.doc.styleSheets, ...(ctx.doc.adoptedStyleSheets ?? [])];
  const out: string[] = [];
  for (const sheet of sheets) {
    if (sheet.href && new URL(sheet.href).pathname.startsWith('/__vitest')) continue;
    const media = sheet.media?.mediaText ?? '';
    const scope = media && media !== 'all' ? `@media ${media}` : '';
    const rules = filterRules(readRules(sheet), sheet.href ?? ctx.doc.baseURI, filter, scope);
    if (rules.length === 0) continue;
    out.push(
      media && media !== 'all' ? `@media ${media} {\n${rules.join('\n')}\n}` : rules.join('\n'),
    );
  }
  return out
    .join('\n')
    .replace(NG_IN_CSS, (_, kind: string, suffix: string) => `_ng${kind}-${ngName(suffix, ctx)}`)
    .replace(/\.((?:\\.|[\w-])+)/g, (whole, raw: string) => {
      const renamed = className(raw, ctx);
      return renamed === raw ? whole : `.${renamed}`;
    });
}

interface Filter {
  /** Lower-cased, unquoted font families the kept elements use. */
  readonly families: Set<string>;
  /** `<html>`, `<body>` and the shells. */
  readonly ancestors: Element[];
  readonly element: Element;
  /** stripped selector → whether it matches. */
  readonly matched: Map<string, boolean>;
  /** The kept rules so far, each with its at-rule context: a repeat is dropped. */
  readonly emitted: Set<string>;
  readonly ctx: Context;
}

function readRules(sheet: CSSStyleSheet | null | undefined): CSSRule[] {
  try {
    return sheet ? [...sheet.cssRules] : [];
  } catch {
    return []; // a cross-origin sheet the page may not read
  }
}

/** The kept rules of `rules`; `scope` names the at-rules around them, for spotting repeats. */
function filterRules(rules: CSSRule[], base: string, filter: Filter, scope: string): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    const text = filterRule(rule, base, filter, scope);
    if (text) out.push(text);
  }
  return out;
}

/** `text`, unless the same rule was kept already in the same at-rule context. */
function once(text: string | undefined, filter: Filter, scope: string): string | undefined {
  if (text === undefined) return undefined;
  const key = `${scope}\u0000${text}`;
  if (filter.emitted.has(key)) return undefined;
  filter.emitted.add(key);
  return text;
}

function filterRule(
  rule: CSSRule,
  base: string,
  filter: Filter,
  scope: string,
): string | undefined {
  if (rule instanceof CSSStyleRule) {
    if (!splitSelectors(rule.selectorText).some((s) => matches(s, filter))) return undefined;
    let text = rule.cssText;
    if (text.startsWith(rule.selectorText)) {
      text =
        renameSelectorIds(rule.selectorText, filter.ctx) + text.slice(rule.selectorText.length);
    }
    return once(rewriteCssUrls(text, base, filter.ctx), filter, scope);
  }
  if (rule instanceof CSSImportRule) {
    const layer =
      rule.layerName !== null ? `@layer${rule.layerName ? ` ${rule.layerName}` : ''}` : '';
    const importMedia = rule.media.mediaText;
    const wrap = [importMedia && importMedia !== 'all' ? `@media ${importMedia}` : '', layer];
    const inner = filterRules(
      readRules(rule.styleSheet),
      rule.styleSheet?.href ?? base,
      filter,
      [scope, ...wrap].filter(Boolean).join(' / '),
    );
    if (inner.length === 0) return undefined;
    let text = inner.join('\n');
    if (layer) text = `${layer} {\n${text}\n}`;
    return wrap[0] ? `${wrap[0]} {\n${text}\n}` : text;
  }
  if (
    rule instanceof CSSMediaRule ||
    rule instanceof CSSSupportsRule ||
    rule instanceof CSSContainerRule ||
    rule instanceof CSSLayerBlockRule ||
    (typeof CSSScopeRule !== 'undefined' && rule instanceof CSSScopeRule)
  ) {
    const header = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
    const inner = filterRules([...rule.cssRules], base, filter, `${scope} / ${header}`);
    if (inner.length === 0) return undefined;
    return `${header} {\n${inner.join('\n')}\n}`;
  }
  if (rule instanceof CSSLayerStatementRule || rule instanceof CSSPropertyRule) {
    return once(rule.cssText, filter, scope);
  }
  if (rule instanceof CSSFontFaceRule) {
    const family = unquote(rule.style.getPropertyValue('font-family'));
    if (!filter.families.has(family)) return undefined;
    return once(rewriteCssUrls(rule.cssText, base, filter.ctx), filter, scope);
  }
  return undefined; // @keyframes, @starting-style, @page, @namespace, …
}

function matches(selector: string, filter: Filter): boolean {
  const stripped = stripPseudo(selector);
  let hit = filter.matched.get(stripped);
  if (hit === undefined) {
    try {
      hit =
        filter.element.matches(stripped) ||
        filter.element.querySelector(stripped) !== null ||
        filter.ancestors.some((a) => a.matches(stripped));
    } catch {
      hit = true; // a selector this engine cannot read: keep the rule rather than lose a style
    }
    filter.matched.set(stripped, hit);
  }
  return hit;
}

/** The selectors of a selector list (commas outside parentheses, brackets and escapes). */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '\\') i++;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter((s) => s !== '');
}

/**
 * `selector` without its pseudo-classes and pseudo-elements (`:hover`, `::before`, `:not(…)`, …),
 * with `*` where that leaves a compound empty: `.a > :first-child:hover` is `.a > *`. Escapes
 * (`.md\:flex`) and attribute selectors are kept as they are.
 */
export function stripPseudo(selector: string): string {
  let out = '';
  let compound = false;
  let i = 0;
  const s = selector.trim();
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      out += s.slice(i, i + 2);
      i += 2;
      compound = true;
    } else if (c === '[') {
      const end = closing(s, i, '[', ']');
      out += s.slice(i, end + 1);
      i = end + 1;
      compound = true;
    } else if (c === ':') {
      i += s[i + 1] === ':' ? 2 : 1;
      while (i < s.length && /[\w-]/.test(s[i])) i++;
      if (s[i] === '(') i = closing(s, i, '(', ')') + 1;
    } else if (/[\s>+~]/.test(c)) {
      let combinator = '';
      while (i < s.length && /[\s>+~]/.test(s[i])) {
        if (s[i] !== ' ' && !/\s/.test(s[i])) combinator += s[i];
        i++;
      }
      if (!compound) out += '*';
      out += combinator ? ` ${combinator} ` : ' ';
      compound = false;
    } else {
      out += c;
      i++;
      compound = true;
    }
  }
  if (!compound) out += '*';
  return out;
}

function closing(s: string, at: number, open: string, close: string): number {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"' || s[i] === "'") {
      const quote = s[i];
      for (i++; i < s.length && s[i] !== quote; i++) if (s[i] === '\\') i++;
    } else if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i;
  }
  return s.length - 1;
}

/** `#id` in a selector, renamed as the HTML's ids were; ids the freeze does not hold stay. */
function renameSelectorIds(selector: string, ctx: Context): string {
  return selector.replace(/#((?:\\.|[\w-])+)/g, (whole, raw: string) => {
    const id = raw.replace(/\\(.)/g, '$1');
    const name = ctx.ids.get(id);
    return name === undefined ? whole : `#${name}`;
  });
}

/** The font families the elements use (computed `font-family`), lower-cased and unquoted. */
function usedFamilies(elements: Element[]): Set<string> {
  const families = new Set<string>();
  for (const element of elements) {
    const view = element.ownerDocument.defaultView;
    const value = view?.getComputedStyle(element).fontFamily ?? '';
    for (const family of value.split(',')) families.add(unquote(family));
  }
  return families;
}

function unquote(family: string): string {
  return family
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2')
    .toLowerCase();
}
