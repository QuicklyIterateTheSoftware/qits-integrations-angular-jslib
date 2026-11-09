/**
 * The seam the browser test harness records outcomes through (ticket qits-2001). Module-level and
 * `null` by default, so production records nothing and pays one null check per outcome.
 * `recordOutcomes()` in `@qits/angular/testing/browser` sets it; that entry imports `@qits/angular`
 * by package name, so it reaches this very module instance.
 */

/** One outcome an interaction reached: what `go()`, `reach()` or a handled `QitsExit` click note. */
export interface OutcomeRecord {
  readonly interaction: string;
  readonly outcome: string;
  readonly kind: 'exit' | 'stay';
  /** The exit's path pattern, such as `projects/:slug`; `null` for a stay. */
  readonly to: string | null;
  /** The exit's interpolated URL, as `url()` gives it (`/projects/demo`); absent for a stay. */
  readonly url?: string;
}

export type OutcomeRecorder = (record: OutcomeRecord) => void;

let recorder: OutcomeRecorder | null = null;

/**
 * Internal: installs (or with `null` removes) the outcome recorder. Exported for
 * `@qits/angular/testing/browser` only; an app never calls it. The `ɵ` prefix says so, as Angular's
 * does.
 */
export function ɵsetOutcomeRecorder(fn: OutcomeRecorder | null): void {
  recorder = fn;
}

export function recordOutcome(record: OutcomeRecord): void {
  recorder?.(record);
}
