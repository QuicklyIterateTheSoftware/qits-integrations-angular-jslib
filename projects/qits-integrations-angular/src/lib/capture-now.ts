import { nearestAppComponent } from './app-component';
import { captureOptions, captureRelay } from './capture-config';
import { buildCapturePayload, type CaptureSelection } from './capture-payload';
import { CaptureError, postCapture } from './capture-transport';
import { freezeDocument, freezeElement } from './document-freeze';
import { selectorFor } from './element-selector';

export interface CaptureResult {
  /** Browser URL of the created qits workspace — navigate there, or don't; your trigger, your call. */
  url: string;
}

/**
 * Snapshot the running app into qits: freeze the page (its `<body>`), and — when a picked element
 * is supplied — the nearest enclosing `app-*` component's subtree alongside it, then POST both to
 * the capture ingest and resolve the created workspace's URL. Resolves instead of navigating — the
 * shipped button picks an element then navigates the top window on success; custom triggers
 * (withFeatureCapture({renderButton: false})) supply their own target (or none) and follow-through.
 */
export async function captureNow(target?: Element): Promise<CaptureResult> {
  const relay = captureRelay();
  if (!relay) {
    throw new CaptureError(
      'Capture is not active: config.json reported no capture relay (app running standalone?)',
    );
  }
  const maxBytes = captureOptions().maxDomBytes;
  const dom = freezeDocument(document, { maxBytes });
  if (!dom) {
    throw new CaptureError('Could not freeze the document');
  }
  const selection = target ? buildSelection(target, maxBytes) : undefined;
  return postCapture(buildCapturePayload(dom, relay, selection), relay.ingestUrl);
}

/**
 * Freezes the picked element's owning `app-*` component (the pick and everything around it, trimmed
 * to the component boundary) and records the pick's provenance. Best-effort: a subtree that fails to
 * freeze drops the selection, never the whole capture.
 */
function buildSelection(target: Element, maxBytes: number): CaptureSelection | undefined {
  const component = nearestAppComponent(target);
  const frozen = freezeElement(component, { maxBytes });
  if (!frozen) {
    return undefined;
  }
  const componentTag = component.tagName.toLowerCase();
  return {
    html: frozen.html,
    truncated: frozen.truncated,
    bytes: frozen.bytes,
    selector: selectorFor(target),
    tag: target.tagName.toLowerCase(),
    component: componentTag.startsWith('app-') ? componentTag : null,
  };
}
