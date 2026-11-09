/**
 * Where an interaction leads, declared once next to it (ticket qits-2001, epic qits-2000).
 *
 * A page declares the outcomes of each interaction in a field initializer:
 *
 *   readonly create = outcomes('create-work-item', {
 *     created: exit('projects/:slug/work/detail/:id'),
 *     cancelled: exit('projects/:slug/work'),
 *     refused: stay(),
 *   });
 *
 * and reaches them through the entries: `this.create.created.go({ slug, id })` navigates,
 * `this.create.refused.reach()` notes that the interaction stayed. Each entry also names itself
 * (`interaction`, `outcome`, `kind`, `to`), so a link, a trigger mark and the test harness can say
 * which outcome an element leads to.
 *
 * The compiler checks the names through {@link QitsApp}, which an app augments: `routePath` with the
 * `RoutePath` union `qits/route-paths` generates from its route tables, `interaction` with its own
 * interaction slugs. An app that augments neither gets `string` for both.
 */
import { inject } from '@angular/core';
import { Router, type NavigationBehaviorOptions } from '@angular/router';
import { recordOutcome } from './outcome-recorder';

/**
 * The typing seam: empty here, augmented by the app.
 *
 *   declare module '@qits/angular' {
 *     interface QitsApp { routePath: RoutePath; interaction: InteractionSlug }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the app augments it
export interface QitsApp {}

/** The app's route paths (`QitsApp.routePath`), without a leading slash; `string` when not augmented. */
export type RoutePath = QitsApp extends { routePath: infer P extends string } ? P : string;

/** The app's interaction names (`QitsApp.interaction`); `string` when not augmented. */
export type InteractionName = QitsApp extends { interaction: infer I extends string } ? I : string;

/** The `:name` segments of a path pattern, as a union of names. */
type ParamNames<P extends string> = P extends `${infer H}/${infer R}`
  ? ParamNames<H> | ParamNames<R>
  : P extends `:${infer N}`
    ? N
    : never;

/**
 * The params a path pattern takes: `{ slug: string | number; id: string | number }` for
 * `projects/:slug/work/detail/:id`, and no field at all for a path without params.
 */
export type PathParams<P extends string> = [ParamNames<P>] extends [never]
  ? Record<never, never>
  : Readonly<Record<ParamNames<P>, string | number>>;

/**
 * What a path without params accepts in their place: nothing, or an object without fields. Not
 * `PathParams`'s empty type, because the compiler checks no excess field against an empty type.
 */
type NoParams = Readonly<Record<string, never>>;

/** `url()`'s arguments: the params, optional (and empty) when the path has none. */
export type UrlArgs<P extends string> = [ParamNames<P>] extends [never]
  ? [params?: NoParams]
  : [params: PathParams<P>];

/** `go()`'s arguments: {@link UrlArgs}, then the router's `replaceUrl` / `state` and friends. */
export type GoArgs<P extends string> = [ParamNames<P>] extends [never]
  ? [params?: NoParams, behaviour?: NavigationBehaviorOptions]
  : [params: PathParams<P>, behaviour?: NavigationBehaviorOptions];

/** What {@link exit} declares: the interaction leaves for `to`. */
export interface ExitSpec<P extends string = string> {
  readonly kind: 'exit';
  readonly to: P;
}

/** What {@link stay} declares: the interaction ends where it started. */
export interface StaySpec {
  readonly kind: 'stay';
}

/** An exit the interaction can reach. */
export interface ExitOutcome<P extends string = string> {
  readonly interaction: InteractionName;
  /** Its key in the declaration. */
  readonly outcome: string;
  readonly kind: 'exit';
  /** The path pattern, without a leading slash, as declared. */
  readonly to: P;
  /**
   * The interpolated URL, absolute (`/projects/demo`, `/` for the root), so a `routerLink` or an
   * `href` built from it never resolves against the current route. Each param is
   * `encodeURIComponent`ed; a missing one throws.
   */
  url(...params: UrlArgs<P>): string;
  /** Records the outcome, then navigates to {@link url} (`router.navigateByUrl`'s Promise). */
  go(...args: GoArgs<P>): Promise<boolean>;
}

/** A stay the interaction can reach. */
export interface StayOutcome {
  readonly interaction: InteractionName;
  readonly outcome: string;
  readonly kind: 'stay';
  readonly to: null;
  /** Records that the interaction stayed. Nothing else happens. */
  reach(): void;
}

/** Any declared outcome. */
export type Outcome = ExitOutcome | StayOutcome;

/** What {@link outcomes} gives back: one entry per declared key. */
export type Outcomes<O extends Record<string, ExitSpec | StaySpec>> = {
  readonly [K in keyof O]: O[K] extends ExitSpec<infer P> ? ExitOutcome<P> : StayOutcome;
};

/** Declares that the interaction leaves for `to`, a route path of the app. */
export function exit<const P extends RoutePath>(to: P): ExitSpec<P> {
  return Object.freeze({ kind: 'exit', to });
}

/** Declares that the interaction can end where it started (a refusal, a validation error). */
export function stay(): StaySpec {
  return Object.freeze({ kind: 'stay' });
}

/**
 * The outcomes of `interaction`, one frozen entry per declared key. Runs in an injection context
 * (a field initializer), because the exits navigate with the `Router`.
 */
export function outcomes<const O extends Record<string, ExitSpec | StaySpec>>(
  interaction: InteractionName,
  declared: O,
): Outcomes<O> {
  const router = inject(Router);
  const entries: Record<string, Outcome> = {};
  for (const [outcome, spec] of Object.entries(declared)) {
    entries[outcome] =
      spec.kind === 'exit'
        ? exitEntry(router, interaction, outcome, spec.to)
        : stayEntry(interaction, outcome);
  }
  return Object.freeze(entries) as Outcomes<O>;
}

function exitEntry(
  router: Router,
  interaction: InteractionName,
  outcome: string,
  to: string,
): ExitOutcome {
  const url = (params?: Readonly<Record<string, string | number>>) => interpolate(to, params);
  return Object.freeze({
    interaction,
    outcome,
    kind: 'exit' as const,
    to,
    url,
    go(params?: Readonly<Record<string, string | number>>, behaviour?: NavigationBehaviorOptions) {
      const target = url(params);
      recordOutcome({ interaction, outcome, kind: 'exit', to, url: target });
      return router.navigateByUrl(target, behaviour);
    },
  });
}

function stayEntry(interaction: InteractionName, outcome: string): StayOutcome {
  return Object.freeze({
    interaction,
    outcome,
    kind: 'stay' as const,
    to: null,
    reach() {
      recordOutcome({ interaction, outcome, kind: 'stay', to: null });
    },
  });
}

/** `/` plus `to` with every `:name` segment replaced by its encoded param. */
function interpolate(to: string, params: Readonly<Record<string, string | number>> = {}): string {
  const segments = to.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment;
    const name = segment.slice(1);
    const value = Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined || value === null) {
      throw new Error(`outcomes: the path '${to}' needs the param '${name}', and none was given.`);
    }
    return encodeURIComponent(String(value));
  });
  return `/${segments.join('/')}`;
}
