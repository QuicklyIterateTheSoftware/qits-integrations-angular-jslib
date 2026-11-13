/**
 * The field paths of a value (ticket qits-2141), as `QitsField` takes them: dot-separated keys,
 * checked against the value's type, so a template cannot mark a field the value does not have.
 * Over a `Consumed` value that is a field the app did not consume.
 *
 * - `owner.name`: a field of a field; null and undefined on the way are stepped through;
 * - `tags`: an array is a leaf: the path names the whole value, and there is no stepping into its
 *   elements (mark the element's own entity instead);
 * - primitives, `Date` and functions are leaves as well;
 * - at most five keys deep.
 */

/** What a path ends at: it has no fields of its own to step into. */
type Leaf =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | Date
  | readonly unknown[]
  | ((...args: never[]) => unknown);

/** The paths of `T`; `Depth` counts the keys already taken. */
type PathsOf<T, Depth extends readonly unknown[]> = Depth['length'] extends 5
  ? never
  : T extends Leaf
    ? never
    : T extends object
      ? {
          [K in keyof T & string]-?: K | `${K}.${PathsOf<NonNullable<T[K]>, [...Depth, unknown]>}`;
        }[keyof T & string]
      : never;

/** The dot paths of `T`'s fields, up to five keys deep; see the file comment for the rules. */
export type QitsFieldPath<T> = PathsOf<NonNullable<T>, []>;

/**
 * What `QitsField` marks: a field the element shows as is, or `{ derived: [...] }`, the fields its
 * content is computed from.
 */
export type QitsFieldMark<T> = QitsFieldPath<T> | { readonly derived: readonly QitsFieldPath<T>[] };
