import { computed, Directive, input } from '@angular/core';
import { outcomeMark } from './outcome-mark';
import type { Outcome } from './outcomes';

/**
 * Marks any element with the outcomes it can trigger: `<button [qitsTriggers]="[create.created,
 * create.refused]">` sets `data-qits-outcome` to their {@link outcomeMark}, in the order given.
 * Recording is the outcomes' own business (`go()`, `reach()`); the mark only names them.
 */
@Directive({
  selector: '[qitsTriggers]',
  host: { '[attr.data-qits-outcome]': 'mark()' },
})
export class QitsTriggers {
  readonly qitsTriggers = input.required<readonly Pick<Outcome, 'interaction' | 'outcome'>[]>();

  protected readonly mark = computed(() => outcomeMark(...this.qitsTriggers()));
}
