import { InjectionToken } from '@angular/core';
import type { QitsApiError } from '../resources/api-error';
import type { QitsOperation, QitsOperationIdentity } from '../resources/operation';

/**
 * How a {@link qitsResource} behaves without a network. `'online-only'` (the default) is the
 * resource as it always was. `'cache'` answers from the local store first, keeps the stored value
 * while offline and outlives a page reload; it needs `provideQitsOffline`, and is inert without it.
 */
export type QitsResourceOfflinePolicy = 'cache' | 'online-only';

/**
 * How a {@link qitsMutation} behaves without a network. `'online-only'` (the default) sends at once
 * and refuses with {@link QitsOfflineError} `'offline'` while the browser is offline. `'queue'` keeps
 * the write in the outbox and sends it once the network is back; it needs `provideQitsOffline`, and
 * is inert without it.
 */
export type QitsMutationOfflinePolicy = 'queue' | 'online-only';

/** The id of a record: what an `OfflineRecord` answers as `id`. */
export type QitsRecordId = string | number;

/**
 * Which record a write touches, as a mutation's `record(params)` says it: the store applies the
 * change to the `affects` resources while the write waits, and looks up the version an update or a
 * delete sends as `If-Match`.
 */
export type QitsRecordChange =
  | { readonly change: 'create'; readonly fields: Readonly<Record<string, unknown>> }
  | {
      readonly change: 'update';
      readonly id: QitsRecordId;
      readonly fields: Readonly<Record<string, unknown>>;
    }
  | { readonly change: 'delete'; readonly id: QitsRecordId };

/**
 * The params of a queued write as the outbox keeps them: plain JSON, so they survive a page reload.
 * The headers carry the write's `Idempotency-Key` and, for an update or a delete, its `If-Match`.
 */
export interface QitsOutboxParams {
  readonly path?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Where a queued write stands: waiting to be sent (`pending`), on the wire (`sending`), refused
 * because the record changed or is gone on the server (`conflict`), or refused for another reason
 * (`failed`). The last two wait for the person: {@link QitsOffline.retry} or
 * {@link QitsOffline.drop}.
 */
export type QitsOutboxState = 'pending' | 'sending' | 'conflict' | 'failed';

/**
 * A write the server refused because the record moved on: `current` is the record as the server
 * has it now (null when it is gone, a 404), `currentVersion` its version. The server is
 * authoritative, so the local copy already shows `current`; the person decides whether to send
 * the write again on top of it.
 */
export interface QitsConflict {
  /** The outbox entry, when the write was queued; undefined for a direct send. */
  readonly seq?: number;
  readonly recordId: QitsRecordId | null;
  readonly current: unknown;
  readonly currentVersion: number | null;
}

/** One queued write, as {@link QitsOffline.outbox} shows it. */
export interface QitsOutboxEntry {
  /** Its place in the outbox; entries are sent in this order. */
  readonly seq: number;
  /** The `Idempotency-Key` every send of this write carries. */
  readonly key: string;
  readonly operation: QitsOperationIdentity;
  readonly params: QitsOutboxParams;
  /** The record it touches; `local:<key>` for a create until the answer names the real id. */
  readonly recordId: QitsRecordId | null;
  readonly change: QitsRecordChange | null;
  /** The version its `If-Match` names; null for a create, or when no version was known. */
  readonly baseVersion: number | null;
  readonly enqueuedAt: Date;
  readonly state: QitsOutboxState;
  /** Set while `state` is `conflict`. */
  readonly conflict?: QitsConflict;
  /** Set while `state` is `failed`. */
  readonly error?: QitsApiError;
  /**
   * Why a `pending` entry is not being sent: `unknown-operation` until an operation with its
   * identity is registered (`provideQitsOffline({ operations })`, or a `qitsMutation` over it).
   */
  readonly waiting?: 'unknown-operation';
}

/** Why a write was refused before it was sent. */
export type QitsOfflineFailure = 'offline' | 'signed-out';

/**
 * A write refused before it reached the network: an `online-only` run while the browser is
 * offline (`'offline'`), or a `queue` run with nobody signed in, so there is no store to queue in
 * (`'signed-out'`).
 */
export class QitsOfflineError extends Error {
  override readonly name = 'QitsOfflineError';

  constructor(readonly reason: QitsOfflineFailure) {
    super(
      reason === 'offline'
        ? 'The browser is offline, and this write is not queued.'
        : 'Nobody is signed in, so there is no local store to queue this write in.',
    );
  }
}

/**
 * A write operation the outbox may replay. Any `qitsOperation` with a method other than `GET`
 * fits; the params are the outbox's own plain JSON then.
 */
export type QitsOfflineOperation = QitsOperation<never, unknown, 'write', unknown>;

/** Options of {@link provideQitsOffline}. */
export interface QitsOfflineOptions {
  /** The app's project; part of the store's name, `qits-offline:<project>:<user>`. */
  readonly project: string;
  /**
   * Who is signed in. Null means no store: `cache` resources act `online-only` and `queue`
   * mutations refuse with {@link QitsOfflineError} `'signed-out'`. By default `QitsTokens.user()`:
   * the `sub` claim of the access token, or without one the `sub` remembered on this device from
   * the last sign-in (an offline relaunch); null without `provideQitsBearerSignIn`.
   */
  readonly user?: () => string | null;
  /**
   * Every write operation the outbox may replay. After a page reload an entry is sent only through
   * a registered operation; a `qitsMutation` also registers its own when it is created.
   */
  readonly operations?: readonly QitsOfflineOperation[];
}

/** What {@link QitsOffline.signOut} takes. */
export interface QitsSignOutOptions {
  /** Sign out even though the outbox holds writes, which are then lost. */
  readonly discardPending?: boolean;
}

/**
 * What {@link QitsOffline.signOut} did: `signedOut` false means the outbox held `pending` writes
 * and nothing changed, which is the warning to show before asking again with `discardPending`.
 */
export interface QitsSignOutResult {
  readonly signedOut: boolean;
  readonly pending: number;
}

/** The options `provideQitsOffline` was given. */
export const QITS_OFFLINE_OPTIONS = new InjectionToken<QitsOfflineOptions>('QITS_OFFLINE_OPTIONS');
