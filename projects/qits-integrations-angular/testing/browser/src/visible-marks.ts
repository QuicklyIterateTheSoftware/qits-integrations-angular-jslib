/**
 * The visibility rule shared by `visible-triggers.ts` and `visible-data-marks.ts` (ticket
 * qits-2141): an element counts as shown when it passes `checkVisibility` with CSS visibility (no
 * `display: none`, `visibility: hidden` or `content-visibility` hiding it), has no `hidden`
 * attribute on itself or an ancestor, has a box of non-zero width and height, and that box meets
 * the target's box, or the page's scroll area for a page shot (`target === null`).
 */

export interface Area {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The area `target` is shown in: its bounding box, or the page's scroll area for `null`. */
export function shownIn(target: Element | null, document: Document): Area {
  return target ? target.getBoundingClientRect() : pageArea(document);
}

/** Whether `element` counts as visible within `area` (see the module doc for the rule). */
export function isShown(element: Element, area: Area): boolean {
  if (!element.checkVisibility({ checkVisibilityCSS: true })) return false;
  if (element.closest('[hidden]')) return false;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  return meets(box, area);
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
