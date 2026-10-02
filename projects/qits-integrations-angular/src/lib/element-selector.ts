/**
 * A best-effort CSS selector identifying a picked element: an nth-of-type chain climbing until the
 * nearest `data-testid`/`id` anchor (or the document root). A moment-in-time pointer that a re-render
 * may drift — the capture carries it as provenance for the pick, alongside the frozen subtree.
 *
 * Ported from the qits webui's DOM picker (`selectorFor`) so a pick made from inside the app reads
 * the same as one made from qits' own web view.
 */
export function selectorFor(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== node.ownerDocument.documentElement) {
    const testId = node.getAttribute('data-testid');
    if (testId) {
      parts.unshift('[data-testid="' + testId + '"]');
      return parts.join(' > ');
    }
    if (node.id) {
      parts.unshift('#' + node.id);
      return parts.join(' > ');
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const current = node;
    const sameTagSiblings = Array.from(parent.children).filter(
      (c) => c.tagName === current.tagName,
    );
    parts.unshift(tag + ':nth-of-type(' + (sameTagSiblings.indexOf(current) + 1) + ')');
    node = parent;
  }
  return parts.join(' > ');
}
