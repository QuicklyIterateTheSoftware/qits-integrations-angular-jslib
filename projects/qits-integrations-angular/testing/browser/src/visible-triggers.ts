/**
 * The outcome triggers a screenshot shows (ticket qits-2003): the `data-qits-outcome` marks of the
 * main entry's `QitsExit` / `[qitsTriggers]` / `outcomeMark()` that are visible in the shot.
 * `freezeScreenshots()` reads them on the live DOM after the matcher passed: the frozen HTML keeps
 * every mark, a closed menu's too, and cannot tell a hidden one from a visible one.
 *
 * The attribute name is spelled out, as in the main entry's directives.
 */
import { isShown, shownIn } from './visible-marks';

const MARK = '[data-qits-outcome]';

/**
 * The `<interaction>:<outcome>` marks visible in `target` (the screenshotted element, or `null` for
 * the page), deduplicated and sorted. A mark counts when the element passes `checkVisibility` with
 * CSS visibility (no `display: none`, `visibility: hidden` or `content-visibility` hiding it), has
 * no `hidden` attribute on itself or an ancestor, has a box of non-zero width and height, and that
 * box meets the target's box, or the page's scroll area for a page shot (`visible-marks.ts`).
 */
export function visibleTriggers(target: Element | null, document: Document): string[] {
  const marked = target
    ? [...(target.matches(MARK) ? [target] : []), ...target.querySelectorAll(MARK)]
    : [...document.querySelectorAll(MARK)];
  const area = shownIn(target, document);
  const triggers = new Set<string>();
  for (const element of marked) {
    if (!isShown(element, area)) continue;
    for (const mark of (element.getAttribute('data-qits-outcome') ?? '').split(/\s+/)) {
      if (mark) triggers.add(mark);
    }
  }
  return [...triggers].sort();
}
