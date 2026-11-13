/**
 * The data marks a screenshot shows (ticket qits-2141): pages carry the new directives' marks as
 * attributes —
 *
 * - `data-qits-source` (`<provider>#<operationId>`): a list container, detail root, or joined
 *   record.
 * - `data-qits-item` (`<key>=<value>`): one record.
 * - `data-qits-field` (a dot path): an element showing one attribute.
 * - `data-qits-derived` (space-separated input paths): an element showing a computed value; it
 *   carries no `data-qits-field`.
 *
 * `source` and `item` resolve from `element.closest('[data-qits-source]')` /
 * `element.closest('[data-qits-item]')` (`closest` includes the element itself), so a join element
 * carrying its own `data-qits-source` and `data-qits-item` resolves to itself.
 *
 * The attribute names are spelled out, as `visible-triggers.ts` spells out `data-qits-outcome`.
 */
import { isShown, shownIn } from './visible-marks';

const SOURCE_ATTRIBUTE = 'data-qits-source';
const ITEM_ATTRIBUTE = 'data-qits-item';
const FIELD_ATTRIBUTE = 'data-qits-field';
const DERIVED_ATTRIBUTE = 'data-qits-derived';
const MARK = `[${SOURCE_ATTRIBUTE}], [${ITEM_ATTRIBUTE}], [${FIELD_ATTRIBUTE}], [${DERIVED_ATTRIBUTE}]`;

/** One visible element carrying a data mark. */
export interface VisibleDataMark {
  /** `<provider>#<operationId>`, resolved from the closest `data-qits-source` (itself included). */
  readonly source: string | null;
  /** `<key>=<value>`, resolved from the closest `data-qits-item` (itself included). */
  readonly item: string | null;
  /** The element's own `data-qits-field` (a dot path), `null` when it has none. */
  readonly field: string | null;
  /** The element's own `data-qits-derived`, split on whitespace; `[]` when it has none. */
  readonly derived: readonly string[];
}

/**
 * The data marks visible in `target` (the screenshotted element, or `null` for the page), one
 * entry per visible element carrying any of the four `data-qits-*` marks, deduplicated and sorted
 * by source, item, field and derived (nulls first). Visibility is the rule `visible-marks.ts`
 * shares with `visibleTriggers`: `checkVisibility` with CSS visibility, no `hidden` ancestor, a
 * non-zero box meeting the target's box, or the page's scroll area for a page shot.
 */
export function visibleDataMarks(target: Element | null, document: Document): VisibleDataMark[] {
  const marked = target
    ? [...(target.matches(MARK) ? [target] : []), ...target.querySelectorAll(MARK)]
    : [...document.querySelectorAll(MARK)];
  const area = shownIn(target, document);
  const found = new Map<string, VisibleDataMark>();
  for (const element of marked) {
    if (!isShown(element, area)) continue;
    const mark: VisibleDataMark = {
      source: element.closest(`[${SOURCE_ATTRIBUTE}]`)?.getAttribute(SOURCE_ATTRIBUTE) ?? null,
      item: element.closest(`[${ITEM_ATTRIBUTE}]`)?.getAttribute(ITEM_ATTRIBUTE) ?? null,
      field: element.getAttribute(FIELD_ATTRIBUTE),
      derived: (element.getAttribute(DERIVED_ATTRIBUTE) ?? '').split(/\s+/).filter(Boolean),
    };
    found.set(JSON.stringify([mark.source, mark.item, mark.field, mark.derived]), mark);
  }
  return [...found.values()].sort(compareMarks);
}

/** `a` and `b`, with `null` first; otherwise the usual string order. */
const compareNullable = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/** `a` and `b` element-wise, then by length (a shorter list first when it is a prefix). */
const compareDerived = (a: readonly string[], b: readonly string[]): number => {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const c = compareNullable(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
};

const compareMarks = (a: VisibleDataMark, b: VisibleDataMark): number =>
  compareNullable(a.source, b.source) ||
  compareNullable(a.item, b.item) ||
  compareNullable(a.field, b.field) ||
  compareDerived(a.derived, b.derived);
