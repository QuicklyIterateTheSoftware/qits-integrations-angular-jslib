/**
 * What a store reads from a backend answer, stated once and enforced by the compiler (epic
 * qits-546).
 *
 * A store lists the body paths it reads, as an `as const` array, and wraps each generated client
 * call in {@link consume} with that list. The answer's `data` is then typed {@link Consumed}: only
 * the listed paths exist on it, so reading anything else fails `tsc` and Angular's strict
 * templates. The store's pact spec passes the same list as `consumes`, so the pact binds exactly
 * what the code reads, and the two cannot drift. `qits/consume-client-calls` (in
 * `@qits/angular/eslint`) makes every client call in a store go through `consume`.
 *
 * Paths are dot-separated keys; `[]` after a key steps into the elements of an array:
 *
 * - `project.name`: that field (a whole object or array, if that is what it holds);
 * - `entries[].project.id`: that field in every element of `entries`;
 * - `entries[]`: the elements themselves, without any of their fields (the store counts them).
 *
 * An empty list means the store reads nothing from the body (the status, at most).
 */

/** The steps of one segment: `entries[]` is the key, then one `[]` per pair of brackets. */
type Segment<S extends string> = S extends `${infer K}[]`
  ? [...Segment<K>, '[]']
  : S extends ''
    ? []
    : [S];

/**
 * The steps of one path. A path that ends in a key reads that value whole, marked `'*'`; one that
 * ends in `[]` reads the elements without their fields.
 */
type Steps<P extends string> = P extends `${infer H}.${infer R}`
  ? [...Segment<H>, ...Steps<R>]
  : P extends `${string}[]`
    ? Segment<P>
    : [...Segment<P>, '*'];

type Head<S> = S extends readonly [infer H, ...unknown[]] ? H : never;
type Tail<S, K> = S extends readonly [K, ...infer R] ? R : never;

/** `T` cut down to the step lists `S` (a union of tuples). Null and undefined pass through. */
type PickSteps<T, S> = T extends null | undefined
  ? T
  : [Extract<S, readonly ['*']>] extends [never]
    ? T extends readonly (infer E)[]
      ? PickSteps<E, Tail<S, '[]'>>[]
      : T extends object
        ? { [K in keyof T as K extends Head<S> ? K : never]: PickSteps<T[K], Tail<S, K>> }
        : T
    : T;

/**
 * `T` with only the paths in `P`: a deep pick that keeps each field's optional and nullable
 * modifiers. A path `T` does not have adds nothing.
 */
export type Consumed<T, P extends readonly string[]> = PickSteps<T, Steps<P[number]>>;

/** One outcome of a generated client call, narrowed: `data` to `P`, `error` to `E`. */
type Narrowed<R, P extends readonly string[], E extends readonly string[]> = R extends unknown
  ? Omit<R, 'data' | 'error'> &
      (R extends { data: infer D } ? { data: Consumed<D, P> } : unknown) &
      (R extends { error: infer X } ? { error: Consumed<X, E> } : unknown)
  : never;

/** The body paths a store reads from one call. */
export type ConsumedPaths = readonly string[];

/** A store that reads nothing from a body: the status, at most. */
export const NOTHING = [] as const;

/**
 * Awaits a generated client call and hands its answer back with `data` narrowed to `paths` and
 * `error` to `errorPaths` (default: nothing). At run time the answer is unchanged: the narrowing is
 * the compiler's, so the store cannot read what it did not list.
 */
export async function consume<
  R,
  const P extends ConsumedPaths,
  const E extends ConsumedPaths = typeof NOTHING,
>(call: Promise<R>, paths: P, errorPaths?: E): Promise<Narrowed<R, P, E>> {
  void paths;
  void errorPaths;
  return (await call) as Narrowed<R, P, E>;
}
