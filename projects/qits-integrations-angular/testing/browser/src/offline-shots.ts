/**
 * Offline shots (ticket qits-2151): the helpers a browser spec takes a page's offline states with,
 * and what a freeze records of them. The offline layer (qits-2149, `provideQitsOffline`) decides
 * connectivity from `navigator.onLine` and the `online` event, and keeps its answers in a real
 * per-user IndexedDB store, `qits-offline:<project>:<user>`; these flip the one in the page, seed
 * and empty the other, and answer a queued write with the conflict the server sends (qits-2148).
 *
 * - {@link goOffline} / {@link goOnline} emulate the network **in the page**: `navigator.onLine`
 *   overridden on the tester's window, and `offline` / `online` dispatched there. Not Playwright's
 *   `context.setOffline`, which also cuts the Vite module server, so a lazy `loadComponent` would
 *   fail. The real value is back after every test.
 * - {@link seedOfflineStore} stores a recorded answer for a `cache` resource; {@link conflictAnswer}
 *   answers a queued write with the 412 a stale version gets. Both take golden-master recordings
 *   only, as the guard's `flush` does, and name them in the current test's records.
 * - A queued (`pending`) write needs no helper: run the page's own mutation after `goOffline()`.
 * - {@link offlineShotsNotTaken} says, for one spec, why it takes none of the offline shots
 *   `qits-angular screenshots --check` asks of its route.
 *
 * With `freezeScreenshots({ offline: true })` every test starts online, with every `qits-offline:*`
 * database deleted, and every freeze carries the {@link ShotConnectivity} the page had at the shot.
 */
import { ApplicationRef, Injector } from '@angular/core';
import type { TestRequest } from '@angular/common/http/testing';
import { TestBed, getTestBed } from '@angular/core/testing';
import {
  ɵdeleteQitsOfflineStores,
  ɵpinQitsOfflineCacheClock,
  ɵqitsOfflineState,
  type QitsOperationIdentity,
  type ɵQitsOfflineState,
} from '@qits/angular';
import { beforeAll, onTestFinished } from 'vitest';
import { ɵnoteShownRecording } from './golden-master-guard';

/**
 * The browser command a spec's {@link offlineShotsNotTaken} is sent to, once;
 * `screenshotReferences({ freezes })` registers it.
 */
export const OFFLINE_OPT_OUT_COMMAND = 'qitsOfflineOptOut';

/** The problem `type` of qits-2148's 412 to a write on a stale version. */
export const STALE_VERSION_PROBLEM = 'urn:qits:problem:stale-version';

/** What the page's network was at a shot, read from `navigator.onLine`. */
export type ShotNetwork = 'ONLINE' | 'OFFLINE';

/** An outbox entry's state, as a freeze records it (`QitsOutboxState` in upper case). */
export type ShotOutboxState = 'PENDING' | 'SENDING' | 'CONFLICT' | 'FAILED';

/**
 * The instant a {@link seedOfflineStore} entry says it was stored when the spec names none, and
 * the one every cache write stamps under `freezeScreenshots({ offline: true })` (ticket qits-2153):
 * fixed, so a freeze's `cached` list is the same on every run.
 */
export const SEEDED_CACHED_AT = '2026-01-01T00:00:00.000Z';

/** One outbox entry at a shot (ticket qits-2151; `recordId`, `currentVersion` qits-2153). */
export interface ShotOutboxEntry {
  /** `<provider>#<operationId>`. */
  readonly operation: string;
  readonly state: ShotOutboxState;
  /** The record the write touches, as a string; null when it names none. */
  readonly recordId: string | null;
  /**
   * Only on a `CONFLICT` entry: the version the server answered with, as a string; null when it
   * named none (a 404 to an update or a delete).
   */
  readonly currentVersion?: string | null;
}

/** One operation whose shown value came from the local store at a shot (ticket qits-2153). */
export interface ShotCachedRead {
  /** `<provider>#<operationId>`. */
  readonly operation: string;
  /** When the shown value was stored, an ISO instant; the latest when several resources show it. */
  readonly cachedAt: string;
}

/**
 * The page's offline layer at a shot (`freezeScreenshots({ offline: true })`): the network, the
 * outbox, which `cache` resources and `queue` mutations were live, and which operations' shown
 * values came from the store. Operations are named `<provider>#<operationId>`. Without
 * `provideQitsOffline` the lists are empty.
 */
export interface ShotConnectivity {
  readonly network: ShotNetwork;
  readonly outbox: readonly ShotOutboxEntry[];
  readonly cacheResources: readonly string[];
  /** Sorted by operation; empty when no resource shows a stored value. */
  readonly cached: readonly ShotCachedRead[];
  readonly queueMutations: readonly string[];
}

/** What {@link seedOfflineStore} takes beside the recording. */
export interface SeedOfflineStoreOptions {
  /**
   * When the entry says it was stored: what the page's `cachedAt()` and the freeze's `cached`
   * show. Default {@link SEEDED_CACHED_AT}.
   */
  readonly cachedAt?: Date | string;
}

/** What {@link offlineShotsNotTaken} takes. */
export interface OfflineShotsOptOut {
  /** Why the spec takes none of these shots; a non-empty string. */
  readonly reason: string;
  /** Covers the offline shot its route's `cache` resources ask for. */
  readonly network?: true;
  /**
   * Covers the pending and conflict shots of these `queue` mutations' operations, named
   * `<provider>#<operationId>`.
   */
  readonly operations?: readonly string[];
}

/** One opt-out as the Node side gets it; the spec is the command's own test path. */
export interface OfflineOptOutPayload {
  readonly reason: string;
  readonly network: boolean;
  readonly operations: string[];
}

let overridden = false;

/** Overrides `navigator.onLine` on this window, and restores it when the test finishes. */
function emulateNetwork(online: boolean): void {
  if (!overridden) {
    overridden = true;
    try {
      onTestFinished(() => restoreNetwork());
    } catch {
      // Outside a test (a beforeAll): freezeScreenshots({ offline: true }) restores it per test.
    }
  }
  // An own property shadows `Navigator.prototype.onLine`; deleting it brings the real one back.
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

/**
 * Takes the page offline: `navigator.onLine` answers `false`, and `offline` is dispatched on the
 * window. `cache` resources then answer from the store, and `queue` mutations queue their writes.
 * The real value is restored when the test finishes.
 */
export function goOffline(): void {
  emulateNetwork(false);
}

/**
 * Brings the page back online: `navigator.onLine` answers `true`, and `online` is dispatched, on
 * which the outbox sends what it holds and the `cache` resources reload. Answer the requests that
 * follow as any other (`flush`, or {@link conflictAnswer}).
 */
export function goOnline(): void {
  emulateNetwork(true);
}

/** Puts the real `navigator.onLine` back, without an event. */
export function restoreNetwork(): void {
  if (!overridden) return;
  overridden = false;
  delete (navigator as unknown as Record<string, unknown>)['onLine'];
}

/**
 * Deletes every `qits-offline:*` database, puts the real network back and pins the instant cache
 * writes stamp to {@link SEEDED_CACHED_AT}: what `freezeScreenshots({ offline: true })` does before
 * every test. The pin keeps a freeze's `cached` the same on every run when the page stored an
 * answer itself (a flushed read, a conflict's record), not only through {@link seedOfflineStore}.
 */
export async function resetOfflineState(): Promise<void> {
  restoreNetwork();
  ɵpinQitsOfflineCacheClock(new Date(SEEDED_CACHED_AT));
  await ɵdeleteQitsOfflineStores();
}

/** The TestBed's offline layer, or `null` without `provideQitsOffline`; creates the module. */
function testBedOffline(what: string): ɵQitsOfflineState {
  const state = ɵqitsOfflineState(TestBed.inject(Injector));
  if (!state) {
    throw new Error(
      `${what}: the TestBed has no offline store. Provide it as the app does: ` +
        "TestBed.configureTestingModule({ providers: [provideQitsOffline({ project: '…', user: () => '…' })] }).",
    );
  }
  return state;
}

/** `<provider>#<operationId>`. */
const operationName = (op: QitsOperationIdentity) => `${op.provider}#${op.operationId}`;

/**
 * Stores `body`, a golden-master recording, as the answer of `operation` for `params`: the entry a
 * `cache` resource reading `operation` with those params shows, offline at once, online until its
 * fresh answer comes. A body that is not a recording is refused as the guard refuses a `flush`, and
 * a recording is named in the current test's records, so the freeze names it as it names a flushed
 * one. Needs `provideQitsOffline` in the TestBed (it creates the test module) and a signed-in user.
 *
 * `options.cachedAt` (a `Date` or an ISO string) is when the entry says it was stored, what the
 * page's `cachedAt()` and the freeze's `cached` show; without it the fixed
 * {@link SEEDED_CACHED_AT}, so the freeze is the same on every run.
 *
 * Seeding by flushing the recordings online and then calling {@link goOffline} works as well.
 */
export async function seedOfflineStore(
  operation: QitsOperationIdentity,
  params: unknown,
  body: unknown,
  options: SeedOfflineStoreOptions = {},
): Promise<void> {
  const given = options.cachedAt ?? SEEDED_CACHED_AT;
  const cachedAt = given instanceof Date ? new Date(given.getTime()) : new Date(given);
  if (Number.isNaN(cachedAt.getTime())) {
    throw new Error(
      `seedOfflineStore: cachedAt must be a Date or an ISO instant, not ${JSON.stringify(given)}.`,
    );
  }
  ɵnoteShownRecording(body, `body seedOfflineStore stores for ${operationName(operation)}`);
  await testBedOffline('seedOfflineStore').store(operation, params, body, cachedAt);
}

/**
 * Answers `request`, a queued write the outbox sent, with qits-2148's 412: the problem
 * `urn:qits:problem:stale-version` with `current`, the record as the server has it, and
 * `currentVersion`, its `version`. The 412 itself is never recorded (pacts record 2xx answers only),
 * so `current` must be a golden-master recording (the record a read answers) and is named in the
 * current test's records; the outbox entry goes to `conflict`, and the page shows `current`.
 */
export function conflictAnswer(request: TestRequest, current: unknown): void {
  ɵnoteShownRecording(current, 'current record conflictAnswer answers with');
  const version = (current as { version?: unknown }).version;
  if (typeof version !== 'number') {
    throw new Error(
      `conflictAnswer: the current record has no numeric version (${JSON.stringify(version)}). ` +
        "A 412 names the server's version: answer with a record of an offline resource, which " +
        'carries one (qits-2148).',
    );
  }
  request.flush(
    {
      type: STALE_VERSION_PROBLEM,
      title: 'Precondition Failed',
      status: 412,
      detail: 'The record changed since this write read it.',
      current,
      currentVersion: version,
    },
    {
      status: 412,
      statusText: 'Precondition Failed',
      headers: { 'Content-Type': 'application/problem+json', ETag: `"${version}"` },
    },
  );
}

type Command = (...args: unknown[]) => Promise<unknown>;

/** A browser command by name, or undefined when no plugin registered it (this library's own run). */
async function optionalCommand(name: string): Promise<Command | undefined> {
  try {
    const { commands } = await import('vitest/browser');
    return (commands as unknown as Record<string, Command | undefined>)[name];
  } catch {
    return undefined;
  }
}

/**
 * The opt-out a spec gives for the offline shots `qits-angular screenshots --check` asks of the
 * route its shots show (in an app with `freezeScreenshots({ offline: true })`): `network` covers the
 * offline shot, `operations` the pending and conflict shots of those operations, and neither covers
 * every one. Call it once at the top of the spec file; it is sent once, before the spec's first test,
 * and throws at once on a missing reason or a malformed list.
 *
 *   offlineShotsNotTaken({ reason: 'the board is read live; it has no offline view', network: true });
 */
export function offlineShotsNotTaken(optOut: OfflineShotsOptOut): void {
  const reason = optOut?.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(
      'offlineShotsNotTaken: give the reason the spec takes none of these shots: ' +
        "offlineShotsNotTaken({ reason: '…', network: true, operations: ['<provider>#<operationId>'] }).",
    );
  }
  const operations = optOut.operations ?? [];
  if (
    !Array.isArray(operations) ||
    !operations.every((op) => typeof op === 'string' && /^[^#\s]+#[^#\s]+$/.test(op))
  ) {
    throw new Error(
      `offlineShotsNotTaken: operations must name operations as '<provider>#<operationId>', not ` +
        `${JSON.stringify(operations)}.`,
    );
  }
  const payload: OfflineOptOutPayload = {
    reason,
    network: optOut.network === true,
    operations: [...new Set(operations)].sort(),
  };
  let sent = false;
  beforeAll(async () => {
    if (sent) return;
    sent = true;
    await (
      await optionalCommand(OFFLINE_OPT_OUT_COMMAND)
    )?.(payload);
  });
}

/** The TestBed's injector when a test module exists, else undefined (never creates one). */
function testBedInjector(): Injector | undefined {
  try {
    const testBed = getTestBed() as unknown as { _testModuleRef?: unknown };
    if (!testBed._testModuleRef) return undefined;
    // Through the ApplicationRef, so a destroyed module answers nothing rather than throwing.
    return TestBed.inject(ApplicationRef, null)?.injector ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The page's offline layer now, as a freeze records it: the network from `navigator.onLine` (not
 * declared by the spec, so it cannot say otherwise than the page), and the TestBed's outbox, live
 * `cache` resources and `queue` mutations, and the operations whose shown value the store answered
 * (`cached`); empty lists without a test module or without `provideQitsOffline`.
 */
export function shotConnectivity(): ShotConnectivity {
  const injector = testBedInjector();
  const state = injector ? ɵqitsOfflineState(injector) : null;
  return {
    network: navigator.onLine === false ? 'OFFLINE' : 'ONLINE',
    outbox: (state?.outbox ?? []).map(({ operation, state: s, recordId, currentVersion }) => ({
      operation,
      state: s.toUpperCase() as ShotOutboxState,
      recordId,
      ...(s === 'conflict' ? { currentVersion: currentVersion ?? null } : {}),
    })),
    cacheResources: [...(state?.cacheResources ?? [])],
    cached: (state?.cached ?? []).map(({ operation, cachedAt }) => ({
      operation,
      cachedAt: cachedAt.toISOString(),
    })),
    queueMutations: [...(state?.queueMutations ?? [])],
  };
}
