import { computed, Directive, input } from '@angular/core';
import type { QitsResourceRef } from '../resources/qits-resource';
import { itemMark, sourceMark } from './data-marks';

/**
 * Marks the element that shows one entity (ticket qits-2141): `data-qits-item` is its
 * {@link itemMark}, `<entityKey>=<value>`, where the value is the entity's `entityKey` field; the
 * attribute is absent while that field is null or undefined. `entityKey` is checked against the
 * entity's type, `entityKey="agentId"` included.
 *
 * - a list row: `<li [qitsEntity]="agent" entityKey="agentId">`, inside a `QitsEntityList`;
 * - a detail root: `entitySource` is the detail resource, so the one element names both the read
 *   and the entity: `<section [qitsEntity]="agent" entityKey="agentId" [entitySource]="detail">`;
 * - a join: `entitySource` is the other read, on the element showing the joined value, such as
 *   the owner's name fetched by a second resource inside an agent's row.
 *
 * With `entitySource`, `data-qits-source` is set on the same element. Only attributes are added: no
 * element wraps the host.
 */
@Directive({
  selector: '[qitsEntity]',
  host: {
    '[attr.data-qits-item]': 'item()',
    '[attr.data-qits-source]': 'source()',
  },
})
export class QitsEntity<T extends object, K extends keyof T & string> {
  /** The entity shown. */
  readonly qitsEntity = input.required<T>();
  /** The field that identifies the entity. */
  readonly entityKey = input.required<K>();
  /** The read the entity comes from, where no enclosing `QitsEntityList` names it. */
  readonly entitySource = input<Pick<QitsResourceRef<unknown>, 'operation'>>();

  protected readonly item = computed(() => {
    const key = this.entityKey();
    return itemMark(key, this.qitsEntity()[key]);
  });

  protected readonly source = computed(() => {
    const source = this.entitySource();
    return source ? sourceMark(source.operation) : null;
  });
}
