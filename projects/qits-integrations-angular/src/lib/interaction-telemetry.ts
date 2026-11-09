import type { Span } from '@opentelemetry/api';

/**
 * Enrichment for interaction spans, wired into UserInteractionInstrumentation's
 * `shouldPreventSpanCreation` seam — despite its name, that hook receives the event target and
 * the just-created span, and anything but `true` keeps the span. NB the target of a submit event
 * is the <form>, so `data-track-event` belongs there (closest() walks up from the target).
 *
 * An outcome mark (`data-qits-outcome`, from `QitsExit`, `QitsTriggers` or `outcomeMark()`) is read
 * the same way: it becomes `app.interaction.outcome` as it stands, and without a `data-track-event`
 * its first mark's interaction names the span. `data-track-event` wins when both are there.
 */
export function enrichInteractionSpan(element: HTMLElement, span: Span): boolean {
  const mark = element.closest('[data-qits-outcome]')?.getAttribute('data-qits-outcome')?.trim();
  const name =
    element.closest('[data-track-event]')?.getAttribute('data-track-event') ||
    (mark ? markedInteraction(mark) : undefined);
  if (name) {
    span.updateName(`interaction ${name}`);
    span.setAttribute('app.interaction.name', name);
  }
  if (mark) {
    span.setAttribute('app.interaction.outcome', mark);
  }
  span.setAttribute('app.interaction.target', describeTarget(element));
  const component = owningComponentName(element);
  if (component) {
    span.setAttribute('app.component', component);
  }
  return false;
}

/** The interaction of a mark's first `<interaction>:<outcome>`; the outcome key has no colon. */
function markedInteraction(mark: string): string | undefined {
  const first = mark.split(/\s+/)[0];
  const colon = first.lastIndexOf(':');
  return colon > 0 ? first.slice(0, colon) : undefined;
}

/** A human hint for unnamed interactions: tag plus id or a little text. */
function describeTarget(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase();
  if (element.id) {
    return `${tag}#${element.id}`;
  }
  const text = element.textContent?.trim().slice(0, 40);
  return text ? `${tag} "${text}"` : tag;
}

/** Dev-mode sugar: ng serve exposes window.ng; production builds don't — attribute simply absent. */
function owningComponentName(element: HTMLElement): string | undefined {
  try {
    const ng = (window as { ng?: { getOwningComponent?(el: Element): object | null } }).ng;
    // esbuild's dev bundling aliases classes with a leading underscore (_Greeting) — strip it.
    return ng?.getOwningComponent?.(element)?.constructor.name.replace(/^_+/, '');
  } catch {
    return undefined;
  }
}
