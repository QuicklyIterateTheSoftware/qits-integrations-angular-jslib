/**
 * The outcome triggers a screenshot shows (ticket qits-2003): the `data-qits-outcome` marks of the
 * main entry's `QitsExit` / `[qitsTriggers]` / `outcomeMark()` that are visible in the shot.
 * `freezeScreenshots()` reads them on the live DOM after the matcher passed: the frozen HTML keeps
 * every mark, a closed menu's too, and cannot tell a hidden one from a visible one.
 *
 * The attribute name is spelled out, as in the main entry's directives.
 */
const MARK = '[data-qits-outcome]';

interface Area {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * The `<interaction>:<outcome>` marks visible in `target` (the screenshotted element, or `null` for
 * the page), deduplicated and sorted. A mark counts when the element passes `checkVisibility` with
 * CSS visibility (no `display: none`, `visibility: hidden` or `content-visibility` hiding it), has
 * no `hidden` attribute on itself or an ancestor, has a box of non-zero width and height, and that
 * box meets the target's box, or the page's scroll area for a page shot.
 */
export function visibleTriggers(target: Element | null, document: Document): string[] {
  const marked = target
    ? [...(target.matches(MARK) ? [target] : []), ...target.querySelectorAll(MARK)]
    : [...document.querySelectorAll(MARK)];
  const area = target ? target.getBoundingClientRect() : pageArea(document);
  const triggers = new Set<string>();
  for (const element of marked) {
    if (!element.checkVisibility({ checkVisibilityCSS: true })) continue;
    if (element.closest('[hidden]')) continue;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    if (!meets(box, area)) continue;
    for (const mark of (element.getAttribute('data-qits-outcome') ?? '').split(/\s+/)) {
      if (mark) triggers.add(mark);
    }
  }
  return [...triggers].sort();
}

/** The page's scroll area (`0..scrollWidth` × `0..scrollHeight`), in viewport coordinates. */
function pageArea(document: Document): Area {
  const root = document.documentElement;
  const x = document.defaultView?.scrollX ?? 0;
  const y = document.defaultView?.scrollY ?? 0;
  return { left: -x, top: -y, right: root.scrollWidth - x, bottom: root.scrollHeight - y };
}

const meets = (a: Area, b: Area): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
