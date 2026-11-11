import { LocationStrategy } from '@angular/common';
import { computed, Directive, ElementRef, ErrorHandler, inject, input } from '@angular/core';
import { isActive as isUrlActive, Router, type Params } from '@angular/router';
import { outcomeMark } from './outcome-mark';
import { exitUrlTree, type ExitGoOptions, type ExitOutcome, type PathParams } from './outcomes';

interface UntypedExit {
  url(params?: object): string;
  go(params?: object, options?: ExitGoOptions): Promise<boolean>;
}

/**
 * A link to a declared exit: `<a [qitsExit]="create.cancelled" [exitParams]="{ slug }">`. It renders
 * a real `href`, so opening it in a new tab, copying it and hovering it all work, and marks the link
 * with the exit (`data-qits-outcome`). `[exitQueryParams]` and `[exitFragment]` add a query and a
 * fragment to the exit's URL (ticket qits-2038); the `href` and the navigation are the same URL.
 *
 * A plain primary click is the app's: the directive prevents the browser's navigation and goes
 * through the exit's `go()`, which records the outcome and navigates. A click with a modifier, any
 * other button or a `target` other than `_self` is the browser's, and nothing is recorded, because
 * the app did not navigate. That is `RouterLink`'s rule, and so is the `href`: the router's URL,
 * through the `LocationStrategy`, so a base href is honoured.
 *
 * It also knows when its exit is the current route, and so replaces `routerLinkActive` (ticket
 * qits-2038): `isActive()` is true while the router's URL contains the exit's path, a parent route's
 * link staying active on its children (`RouterLinkActive`'s default rule; the query and the
 * fragment do not count), and only on that very path with `[exitActiveExact]="true"`. The link then
 * carries `aria-current="page"`, as `ariaCurrentWhenActive="page"` set it, and
 * `#x="routerLinkActive"` becomes `#x="qitsExit"`, read as `x.isActive()`.
 */
@Directive({
  selector: 'a[qitsExit]',
  exportAs: 'qitsExit',
  host: {
    '[attr.href]': 'href()',
    '[attr.data-qits-outcome]': 'mark()',
    '[attr.aria-current]': "isActive() ? 'page' : null",
    '(click)': 'onClick($event)',
  },
})
export class QitsExit<P extends string = string> {
  readonly qitsExit = input.required<ExitOutcome<P>>();
  /** The exit's path params; leave it out when the path has none. */
  readonly exitParams = input<PathParams<P>>();
  /** The query of the URL the link leads to, as `RouterLink`'s `queryParams`. */
  readonly exitQueryParams = input<Params | null | undefined>();
  /** The fragment of the URL the link leads to, as `RouterLink`'s `fragment`. */
  readonly exitFragment = input<string | undefined>();
  /** Active only on the exit's very path, not on the routes below it (`exact: true`). */
  readonly exitActiveExact = input(false);

  private readonly router = inject(Router);
  private readonly locationStrategy = inject(LocationStrategy);
  private readonly errorHandler = inject(ErrorHandler);
  private readonly host: HTMLAnchorElement = inject(ElementRef).nativeElement;

  // The variadic signatures need the params' presence known statically; here it is a run-time
  // value, and a missing param throws as it does for any caller.
  private readonly exit = computed(() => this.qitsExit() as unknown as UntypedExit);
  private readonly url = computed(() => this.exit().url(this.exitParams()));
  /** The query and fragment `go()` is given: only the keys that are set. */
  private readonly extras = computed(() => {
    const extras: ExitGoOptions = {};
    const queryParams = this.exitQueryParams();
    const fragment = this.exitFragment();
    if (queryParams != null) extras.queryParams = queryParams;
    if (fragment != null) extras.fragment = fragment;
    return extras;
  });

  protected readonly href = computed(() =>
    this.locationStrategy.prepareExternalUrl(
      this.router.serializeUrl(exitUrlTree(this.router, this.url(), this.extras())),
    ),
  );
  protected readonly mark = computed(() => outcomeMark(this.qitsExit()));

  // The router's `isActive()` function, not the deprecated `Router.isActive`: a signal that follows
  // the router's last successful navigation, set just before each `NavigationEnd`. It takes a fixed
  // URL, so a new one is made only when the path or the rule changes.
  private readonly active = computed(() =>
    isUrlActive(this.router.parseUrl(this.url()), this.router, {
      paths: this.exitActiveExact() ? 'exact' : 'subset',
      queryParams: 'ignored',
      matrixParams: 'ignored',
      fragment: 'ignored',
    }),
  );
  /** Whether the router's current URL is (or, unless `exitActiveExact`, is below) the exit's path. */
  readonly isActive = computed(() => this.active()());

  protected onClick(event: MouseEvent): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    const target = this.host.getAttribute('target');
    if (target && target !== '_self') return;
    event.preventDefault();
    const extras = this.extras();
    const go =
      Object.keys(extras).length > 0
        ? this.exit().go(this.exitParams(), extras)
        : this.exit().go(this.exitParams());
    go.catch((error: unknown) => this.errorHandler.handleError(error));
  }
}
