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
 * Two more kinds cover where an interaction leads outside the app's route table (ticket
 * qits-2044): `returnTo()` goes back to a URL the interaction was handed (the sign-in callback's
 * return path), `external('idp')` leaves the app for another site, named rather than routed. An
 * interaction nobody clicks (a guard, a callback page) says so with `{ triggered: false }`, so no
 * screenshot is asked to show its trigger.
 *
 * The compiler checks the names through {@link QitsApp}, which an app augments: `routePath` with the
 * `RoutePath` union `qits/route-paths` generates from its route tables, `interaction` with its own
 * interaction slugs. An app that augments neither gets `string` for both.
 */
import { DOCUMENT, inject, InjectionToken } from '@angular/core';
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

/** What {@link returnTo} declares: the interaction goes back to a URL it was handed. */
export interface ReturnToSpec {
  readonly kind: 'returnTo';
}

/** What {@link external} declares: the interaction leaves the app for `to`, another site. */
export interface ExternalSpec<W extends string = string> {
  readonly kind: 'external';
  readonly to: W;
}

/** Any declaration {@link outcomes} takes. */
export type OutcomeSpec = ExitSpec | StaySpec | ReturnToSpec | ExternalSpec;

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

/** A return to a URL the interaction was handed. */
export interface ReturnToOutcome {
  readonly interaction: InteractionName;
  readonly outcome: string;
  readonly kind: 'returnTo';
  readonly to: null;
  /**
   * Records the outcome, then navigates to `url` (`router.navigateByUrl`'s Promise). Only a URL of
   * this app is followed: one starting with a single `/` (not `//host`, not `/\host`). Anything
   * else goes to `/` instead, so a return path from storage or a query cannot lead off the site.
   */
  go(url: string, behaviour?: NavigationBehaviorOptions): Promise<boolean>;
}

/** A way out of the app, to the site `to` names. */
export interface ExternalOutcome<W extends string = string> {
  readonly interaction: InteractionName;
  readonly outcome: string;
  readonly kind: 'external';
  /** The site's name as declared (`'idp'`), not a URL. */
  readonly to: W;
  /** Records the outcome, then leaves for `href` through {@link QITS_LEAVE_APP} (`location.assign`). */
  leave(href: string): void;
}

/** Any declared outcome. */
export type Outcome = ExitOutcome | StayOutcome | ReturnToOutcome | ExternalOutcome;

/** What {@link outcomes} gives back: one entry per declared key. */
export type Outcomes<O extends Record<string, OutcomeSpec>> = {
  readonly [K in keyof O]: O[K] extends ExitSpec<infer P>
    ? ExitOutcome<P>
    : O[K] extends ExternalSpec<infer W>
      ? ExternalOutcome<W>
      : O[K] extends ReturnToSpec
        ? ReturnToOutcome
        : StayOutcome;
};

/** What {@link outcomes} takes beside the declarations. */
export interface OutcomesOptions {
  /**
   * `false` for an interaction no element triggers (a guard, a callback page): the screenshot check
   * then asks no screenshot to show its trigger. Read from the source only; default `true`.
   */
  readonly triggered?: boolean;
}

/** Declares that the interaction leaves for `to`, a route path of the app. */
export function exit<const P extends RoutePath>(to: P): ExitSpec<P> {
  return Object.freeze({ kind: 'exit', to });
}

/** Declares that the interaction can end where it started (a refusal, a validation error). */
export function stay(): StaySpec {
  return Object.freeze({ kind: 'stay' });
}

/**
 * How an external outcome's `leave(href)` leaves the app, after it recorded: by default
 * `DOCUMENT.location.assign(href)`. A routed browser test that reaches an external outcome provides
 * its own (a spy), because the real one would navigate the test page away, and overriding the
 * `DOCUMENT` itself breaks rendering.
 */
export const QITS_LEAVE_APP = new InjectionToken<(href: string) => void>('QITS_LEAVE_APP', {
  providedIn: 'root',
  factory: () => {
    const document = inject(DOCUMENT);
    return (href) => document.location.assign(href);
  },
});

/** Declares that the interaction goes back to a URL it is handed, such as a sign-in's return path. */
export function returnTo(): ReturnToSpec {
  return Object.freeze({ kind: 'returnTo' });
}

/**
 * Declares that the interaction leaves the app for another site, named by `what` (`'idp'`): a name
 * for the reader, not a route path and not a URL.
 */
export function external<const W extends string>(what: W): ExternalSpec<W> {
  return Object.freeze({ kind: 'external', to: what });
}

/**
 * The outcomes of `interaction`, one frozen entry per declared key. Runs in an injection context
 * (a field initializer), because the exits navigate with the `Router` and the externals leave
 * through {@link QITS_LEAVE_APP}. `options` is read from the source by the screenshot check
 * and changes nothing here.
 */
export function outcomes<const O extends Record<string, OutcomeSpec>>(
  interaction: InteractionName,
  declared: O,
  _options?: OutcomesOptions,
): Outcomes<O> {
  const router = inject(Router);
  const leaveApp = inject(QITS_LEAVE_APP);
  const entries: Record<string, Outcome> = {};
  for (const [outcome, spec] of Object.entries(declared) as [string, OutcomeSpec][]) {
    switch (spec.kind) {
      case 'exit':
        entries[outcome] = exitEntry(router, interaction, outcome, spec.to);
        break;
      case 'returnTo':
        entries[outcome] = returnToEntry(router, interaction, outcome);
        break;
      case 'external':
        entries[outcome] = externalEntry(leaveApp, interaction, outcome, spec.to);
        break;
      default:
        entries[outcome] = stayEntry(interaction, outcome);
    }
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

function returnToEntry(
  router: Router,
  interaction: InteractionName,
  outcome: string,
): ReturnToOutcome {
  return Object.freeze({
    interaction,
    outcome,
    kind: 'returnTo' as const,
    to: null,
    go(url: string, behaviour?: NavigationBehaviorOptions) {
      const target = isAppUrl(url) ? url : '/';
      recordOutcome({ interaction, outcome, kind: 'returnTo', to: null, url: target });
      return router.navigateByUrl(target, behaviour);
    },
  });
}

function externalEntry(
  leaveApp: (href: string) => void,
  interaction: InteractionName,
  outcome: string,
  to: string,
): ExternalOutcome {
  return Object.freeze({
    interaction,
    outcome,
    kind: 'external' as const,
    to,
    leave(href: string) {
      recordOutcome({ interaction, outcome, kind: 'external', to, url: href });
      leaveApp(href);
    },
  });
}

/**
 * A URL of this app: a single leading `/`. Tabs and line breaks are dropped first, as a browser
 * drops them, so a `/`, a tab and `/host` is the `//host` it would be read as.
 */
function isAppUrl(url: string): boolean {
  const cleaned = url.replace(/[\t\n\r]/g, '');
  return cleaned.startsWith('/') && !/^\/[/\\]/.test(cleaned);
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
