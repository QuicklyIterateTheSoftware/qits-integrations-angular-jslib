import type { ResourceStatus } from '@angular/core';

/**
 * The status of a {@link qitsResource}: Angular's, plus two a resource reaches only with
 * `offline: 'cache'` and `provideQitsOffline` (ticket qits-2149), in place of `resolved`:
 *
 * - `cached`: the value shown is the stored one (`cachedAt()` says when it was stored). That is the
 *   case from the start of a load until the fresh answer arrives, for as long as the network is
 *   gone, and while a queued write is laid over the stored value.
 * - `offline`: the network is gone and nothing is stored; the value is undefined and `error()` is
 *   not set.
 *
 * An `online-only` resource, and every resource without `provideQitsOffline`, mirrors `status()`.
 */
export type QitsResourceStatus = ResourceStatus | 'cached' | 'offline';

/**
 * The status of a {@link qitsMutation}'s latest run: `idle` before the first, `running` while it
 * is sent, then `done` or `error`. Two more need `provideQitsOffline` (ticket qits-2149):
 *
 * - `pending`: an `offline: 'queue'` run went to the outbox (offline, behind earlier queued writes,
 *   or after a direct send failed on the network). It moves on to `done`, `conflict` or `error`
 *   when the outbox sends it.
 * - `conflict`: the server refused the write because the record changed (412) or is gone (404 to an
 *   update or a delete); `conflict()` holds the server's record. A queued one waits in the outbox
 *   for `QitsOffline.retry` or `drop`.
 */
export type QitsMutationStatus = 'idle' | 'running' | 'done' | 'error' | 'pending' | 'conflict';
