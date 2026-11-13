import { computed, Directive, input } from '@angular/core';
import type { QitsResourceRef } from '../resources/qits-resource';
import { sourceMark } from './data-marks';

/**
 * Marks the element that lists what a read answered (ticket qits-2141): `<ul
 * [qitsEntityList]="agents">` sets `data-qits-source` to the resource's {@link sourceMark},
 * `<provider>#<operationId>`. Each row then marks its own entity with `QitsEntity`. Only an
 * attribute is added: no element wraps the host.
 */
@Directive({
  selector: '[qitsEntityList]',
  host: { '[attr.data-qits-source]': 'source()' },
})
export class QitsEntityList {
  /** The resource listed; only its `operation` is read. */
  readonly qitsEntityList = input.required<Pick<QitsResourceRef<unknown>, 'operation'>>();

  protected readonly source = computed(() => sourceMark(this.qitsEntityList().operation));
}
