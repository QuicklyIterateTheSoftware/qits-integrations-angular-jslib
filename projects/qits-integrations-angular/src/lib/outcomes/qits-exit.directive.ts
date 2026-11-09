import { LocationStrategy } from '@angular/common';
import { computed, Directive, ElementRef, ErrorHandler, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { outcomeMark } from './outcome-mark';
import type { ExitOutcome, PathParams } from './outcomes';

interface UntypedExit {
  url(params?: object): string;
  go(params?: object): Promise<boolean>;
}

/**
 * A link to a declared exit: `<a [qitsExit]="create.cancelled" [exitParams]="{ slug }">`. It renders
 * a real `href`, so opening it in a new tab, copying it and hovering it all work, and marks the link
 * with the exit (`data-qits-outcome`).
 *
 * A plain primary click is the app's: the directive prevents the browser's navigation and goes
 * through the exit's `go()`, which records the outcome and navigates. A click with a modifier, any
 * other button or a `target` other than `_self` is the browser's, and nothing is recorded, because
 * the app did not navigate. That is `RouterLink`'s rule, and so is the `href`: the router's URL,
 * through the `LocationStrategy`, so a base href is honoured.
 */
@Directive({
  selector: 'a[qitsExit]',
  host: {
    '[attr.href]': 'href()',
    '[attr.data-qits-outcome]': 'mark()',
    '(click)': 'onClick($event)',
  },
})
export class QitsExit<P extends string = string> {
  readonly qitsExit = input.required<ExitOutcome<P>>();
  /** The exit's path params; leave it out when the path has none. */
  readonly exitParams = input<PathParams<P>>();

  private readonly router = inject(Router);
  private readonly locationStrategy = inject(LocationStrategy);
  private readonly errorHandler = inject(ErrorHandler);
  private readonly host: HTMLAnchorElement = inject(ElementRef).nativeElement;

  // The variadic signatures need the params' presence known statically; here it is a run-time
  // value, and a missing param throws as it does for any caller.
  private readonly exit = computed(() => this.qitsExit() as unknown as UntypedExit);
  private readonly url = computed(() => this.exit().url(this.exitParams()));

  protected readonly href = computed(() =>
    this.locationStrategy.prepareExternalUrl(
      this.router.serializeUrl(this.router.parseUrl(this.url())),
    ),
  );
  protected readonly mark = computed(() => outcomeMark(this.qitsExit()));

  protected onClick(event: MouseEvent): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = this.host.getAttribute('target');
    if (target && target !== '_self') return;
    event.preventDefault();
    this.exit()
      .go(this.exitParams())
      .catch((error: unknown) => this.errorHandler.handleError(error));
  }
}
