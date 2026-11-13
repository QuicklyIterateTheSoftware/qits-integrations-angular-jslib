import { computed, Directive, input } from '@angular/core';
import type { QitsFieldMark } from './field-path';

/**
 * Marks the element that shows a field of an entity (ticket qits-2141): `<span [fieldOf]="agent"
 * qitsField="owner.name">` sets `data-qits-field` to the path, checked against the type of
 * `fieldOf` (see `QitsFieldPath`), so over a `Consumed` value an unconsumed field does not compile.
 *
 * Content computed from fields rather than showing one takes `[qitsField]="{ derived: ['tags',
 * 'runtimeStatus'] }"`: `data-qits-derived` gets the paths space-separated, in the order given and
 * without duplicates, and `data-qits-field` is left off. Only attributes are added: no element
 * wraps the host.
 */
@Directive({
  selector: '[qitsField]',
  host: {
    '[attr.data-qits-field]': 'field()',
    '[attr.data-qits-derived]': 'derived()',
  },
})
export class QitsField<T extends object> {
  /** The entity whose field is shown; only its type matters. */
  readonly fieldOf = input.required<T>();
  /** The field shown, or `{ derived: [...] }`. */
  readonly qitsField = input.required<QitsFieldMark<T>>();

  protected readonly field = computed(() => {
    const mark = this.qitsField();
    return typeof mark === 'string' ? mark : null;
  });

  protected readonly derived = computed(() => {
    const mark = this.qitsField();
    return typeof mark === 'string' ? null : [...new Set<string>(mark.derived)].join(' ');
  });
}
