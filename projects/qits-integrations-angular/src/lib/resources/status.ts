import type { ResourceStatus } from '@angular/core';

/**
 * The status of a {@link qitsResource}: Angular's, plus `cached` (a value served from a local copy)
 * and `offline` (no network, nothing cached). Online, `qitsStatus()` mirrors `status()` and never
 * reaches the two extra ones; they exist so that templates and the offline lint rules
 * (qits-2149/qits-2150) are written against the full set now.
 */
export type QitsResourceStatus = ResourceStatus | 'cached' | 'offline';

/**
 * The status of a {@link qitsMutation}'s latest run. Online, a run is `running`, then `done` or
 * `error`; `pending` (queued while offline) and `conflict` (the provider refused a queued write) are
 * never reached, and exist for the same reason as {@link QitsResourceStatus}'s extra states.
 */
export type QitsMutationStatus = 'idle' | 'running' | 'done' | 'error' | 'pending' | 'conflict';
