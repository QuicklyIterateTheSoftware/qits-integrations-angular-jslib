/**
 * The outcome triggers a screenshot shows (ticket qits-2003): the `data-qits-outcome` marks of the
 * main entry's `QitsExit` / `[qitsTriggers]` / `outcomeMark()` that are visible in the shot.
 * `freezeScreenshots()` reads them on the live DOM after the matcher passed: the frozen HTML keeps
 * every mark, a closed menu's too, and cannot tell a hidden one from a visible one.
 *
 * A mark must also be on top where it is drawn (ticket qits-2225): a menu stacked beneath another
 * layer, or clipped away by an `overflow: hidden` ancestor, passes every CSS check yet nobody sees
 * it, and listing it let the outcome check pass a trigger no screenshot shows. So the mark has to be
 * the topmost element (it or something inside it, by `document.elementFromPoint()`) at the centre of
 * its box clipped to the shot's area and to the viewport. A `pointer-events: none` mark is never hit
 * and so never counts. Hit testing answers only inside the viewport: a mark whose clipped box lies
 * wholly outside it (a page shot's mark below the fold) is not hit-tested and keeps the CSS rule
 * alone. The data marks (`visible-data-marks.ts`) do not take this test.
 *
 * The attribute name is spelled out, as in the main entry's directives.
 */
import { isShown, isTopmost, shownIn } from './visible-marks';

const MARK = '[data-qits-outcome]';

/**
 * The `<interaction>:<outcome>` marks visible in `target` (the screenshotted element, or `null` for
 * the page), deduplicated and sorted. A mark counts when the element passes `checkVisibility` with
 * CSS visibility (no `display: none`, `visibility: hidden` or `content-visibility` hiding it), has
 * no `hidden` attribute on itself or an ancestor, has a box of non-zero width and height, and that
 * box meets the target's box, or the page's scroll area for a page shot (`visible-marks.ts`), and
 * it is topmost at the centre of that box within the area and the viewport (`isTopmost()`, ticket
 * qits-2225; not tested when that part lies outside the viewport).
 */
export function visibleTriggers(target: Element | null, document: Document): string[] {
  const marked = target
    ? [...(target.matches(MARK) ? [target] : []), ...target.querySelectorAll(MARK)]
    : [...document.querySelectorAll(MARK)];
  const area = shownIn(target, document);
  const triggers = new Set<string>();
  for (const element of marked) {
    if (!isShown(element, area) || !isTopmost(element, area, document)) continue;
    for (const mark of (element.getAttribute('data-qits-outcome') ?? '').split(/\s+/)) {
      if (mark) triggers.add(mark);
    }
  }
  return [...triggers].sort();
}
