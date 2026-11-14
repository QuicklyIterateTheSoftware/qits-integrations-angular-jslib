/**
 * The visibility rule shared by `visible-triggers.ts` and `visible-data-marks.ts` (ticket
 * qits-2141): an element counts as shown when it passes `checkVisibility` with CSS visibility (no
 * `display: none`, `visibility: hidden` or `content-visibility` hiding it), has no `hidden`
 * attribute on itself or an ancestor, has a box of non-zero width and height, and that box meets
 * the target's box, or the page's scroll area for a page shot (`target === null`).
 *
 * `visible-triggers.ts` asks one thing more (ticket qits-2225): {@link isTopmost}, that the mark is
 * not covered by another layer or clipped away at its centre. `visible-data-marks.ts` does not.
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

/**
 * Whether `element` is the topmost element at one probe point (ticket qits-2225): the centre of its
 * box clipped to `area` and to the viewport (`0..innerWidth` × `0..innerHeight` of the document's
 * window). It is when `document.elementFromPoint()` there answers the element or something inside
 * it. A layer drawn over it (a higher `z-index`, a later positioned sibling) or an `overflow:
 * hidden` ancestor that clips it away answers something else, so it is not; nor is an element with
 * `pointer-events: none`, which hit testing never finds. Hit testing only answers inside the
 * viewport: when no part of the clipped box lies in it (a page shot's mark below the fold, a
 * target larger than the viewport), the point cannot be probed and the element counts as topmost.
 */
export function isTopmost(element: Element, area: Area, document: Document): boolean {
  const view = document.defaultView;
  if (!view) return true;
  const box = element.getBoundingClientRect();
  const left = Math.max(box.left, area.left, 0);
  const right = Math.min(box.right, area.right, view.innerWidth);
  const top = Math.max(box.top, area.top, 0);
  const bottom = Math.min(box.bottom, area.bottom, view.innerHeight);
  if (left >= right || top >= bottom) return true;
  const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  return hit !== null && element.contains(hit);
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
