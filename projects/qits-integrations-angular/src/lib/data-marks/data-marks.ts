import type { QitsOperationIdentity } from '../resources/operation';

/**
 * Data marks (ticket qits-2141): plain attributes that say which backend read a piece of the page
 * shows, so a frozen page can be traced back to the operation, the entity and the field behind each
 * element. Plain attributes survive into a frozen page like `data-qits-outcome` does. The
 * directives `QitsEntityList`, `QitsEntity` and `QitsField` set them; bind them by hand only where
 * none of those fits.
 */

/** The read an element shows: its {@link sourceMark}, `<provider>#<operationId>`. */
export const DATA_QITS_SOURCE = 'data-qits-source';

/** The entity an element shows: its {@link itemMark}, `<key>=<value>`. */
export const DATA_QITS_ITEM = 'data-qits-item';

/** The field of the nearest entity an element shows: a dot path, such as `owner.name`. */
export const DATA_QITS_FIELD = 'data-qits-field';

/**
 * The fields of the nearest entity an element's content is computed from, when it shows none of
 * them as is: dot paths, space-separated.
 */
export const DATA_QITS_DERIVED = 'data-qits-derived';

/** The source mark of an operation: `<provider>#<operationId>`, as `captureAs: true` names it. */
export function sourceMark(
  identity: Pick<QitsOperationIdentity, 'provider' | 'operationId'>,
): string {
  return `${identity.provider}#${identity.operationId}`;
}

/** The item mark of an entity: `<key>=<value>`, or `null` (no attribute) for a nullish value. */
export function itemMark(key: string, value: unknown): string | null {
  return value === null || value === undefined ? null : `${key}=${String(value)}`;
}
