import {
  HttpClient,
  HttpErrorResponse,
  provideHttpClient,
  type HttpHeaders,
} from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef, ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideQitsOffline, qitsMutation, qitsOperation, qitsResource } from '@qits/angular';
import { firstValueFrom } from 'rxjs';
import { commands } from 'vitest/browser';
import { freezeScreenshots } from './freeze-screenshots';
import { currentTestRecords, recorded } from './golden-master-guard';
import {
  conflictAnswer,
  goOffline,
  goOnline,
  OFFLINE_OPT_OUT_COMMAND,
  offlineShotsNotTaken,
  SEEDED_CACHED_AT,
  seedOfflineStore,
  shotConnectivity,
  STALE_VERSION_PROBLEM,
  type OfflineOptOutPayload,
} from './offline-shots';

/**
 * Offline shots in a real browser (ticket qits-2151): a real IndexedDB, which outlives a test unless
 * `freezeScreenshots({ offline: true })` empties it, and the page's own `navigator.onLine`.
 */
freezeScreenshots({ offline: true });

interface Note {
  readonly id: string;
  readonly name: string;
  readonly version: number;
}

interface Problem {
  readonly type: string;
  readonly current?: Note;
  readonly currentVersion?: number;
}

type Answer<T> =
  | { data: T; error?: undefined; response: { status: number } }
  | { data?: undefined; error: Problem; response: { status: number } };

/** A generated client's call over `HttpClient`: it answers an error instead of throwing it. */
function answer<T>(request: Promise<T>): Promise<Answer<T>> {
  return request.then(
    (data) => ({ data, response: { status: 200 } }),
    (e: HttpErrorResponse) => ({ error: e.error as Problem, response: { status: e.status } }),
  );
}

const http = () => TestBed.inject(HttpClient);
const PROVIDER = 'qits-notes-service';

const GET_NOTE = qitsOperation({
  provider: PROVIDER,
  operationId: 'getNote',
  method: 'GET',
  call: (o: { path: { id: string } }) =>
    answer(firstValueFrom(http().get<Note>(`/api/notes/${o.path.id}`))),
  consumes: ['id', 'name', 'version'],
});

const RENAME_NOTE = qitsOperation({
  provider: PROVIDER,
  operationId: 'renameNote',
  method: 'PATCH',
  call: (o: {
    path: { id: string };
    body: { name: string };
    headers?: Record<string, string> | HttpHeaders;
  }) =>
    answer(
      firstValueFrom(http().patch<Note>(`/api/notes/${o.path.id}`, o.body, { headers: o.headers })),
    ),
  consumes: ['id', 'name', 'version'],
  errorConsumes: ['type', 'current', 'currentVersion'],
});

const source = (state: string) => ({ provider: PROVIDER, state, operationId: 'getNote' });
/** The golden masters of this spec: a note, and the same note after someone else renamed it. */
const NOTE = recorded<Note>({ id: 'n1', name: 'groceries', version: 1 }, source('a note exists'));
const RENAMED = recorded<Note>(
  { id: 'n1', name: 'groceries, by Bo', version: 2 },
  source('the note was renamed'),
);

@Component({
  selector: 'qits-note-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-testid="name">{{ note.value()?.name ?? 'nothing' }}</p>`,
})
class NotePage {
  readonly note = qitsResource(GET_NOTE, () => ({ path: { id: 'n1' } }), { offline: 'cache' });
  readonly rename = qitsMutation(RENAME_NOTE, {
    offline: 'queue',
    affects: () => [this.note],
    record: (p) => ({ change: 'update', id: p.path.id, fields: p.body }),
  });
}

function configure(): void {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideQitsOffline({ project: 'offline-shots', user: () => 'ada' }),
    ],
  });
}

async function openPage() {
  const fixture = TestBed.createComponent(NotePage);
  await TestBed.inject(ApplicationRef).whenStable();
  return fixture;
}

const shown = (fixture: { nativeElement: HTMLElement }) =>
  fixture.nativeElement.querySelector('[data-testid="name"]')?.textContent;

const offlineDatabases = async () =>
  (await indexedDB.databases()).map((db) => db.name).filter((n) => n?.startsWith('qits-offline:'));

describe('offline shots (qits-2151)', () => {
  it('shows a seeded answer offline, and the shot says OFFLINE with the live resources', async () => {
    configure();
    goOffline();
    expect(navigator.onLine).toBe(false);
    await seedOfflineStore(GET_NOTE, { path: { id: 'n1' } }, NOTE);
    const fixture = await openPage();
    TestBed.inject(HttpTestingController).expectNone('/api/notes/n1');
    expect(fixture.componentInstance.note.qitsStatus()).toBe('cached');
    expect(shown(fixture)).toBe('groceries');
    expect(shotConnectivity()).toEqual({
      network: 'OFFLINE',
      outbox: [],
      cacheResources: [`${PROVIDER}#getNote`],
      // A seed without cachedAt is stamped with the fixed instant, so the freeze is stable.
      cached: [{ operation: `${PROVIDER}#getNote`, cachedAt: '2026-01-01T00:00:00.000Z' }],
      queueMutations: [`${PROVIDER}#renameNote`],
    });
    expect(SEEDED_CACHED_AT).toBe('2026-01-01T00:00:00.000Z');
    expect(fixture.componentInstance.note.cachedAt()).toEqual(new Date(SEEDED_CACHED_AT));
    // The seed names its recording, as a flush does: the freeze shows it.
    expect(currentTestRecords()).toEqual([source('a note exists')]);
  });

  it('stamps a seed with the cachedAt the spec gives, an ISO string or a Date (qits-2153)', async () => {
    configure();
    goOffline();
    await seedOfflineStore(GET_NOTE, { path: { id: 'n1' } }, NOTE, {
      cachedAt: '2026-04-02T08:30:00Z',
    });
    const fixture = await openPage();
    expect(fixture.componentInstance.note.cachedAt()).toEqual(new Date('2026-04-02T08:30:00Z'));
    expect(shotConnectivity().cached).toEqual([
      { operation: `${PROVIDER}#getNote`, cachedAt: '2026-04-02T08:30:00.000Z' },
    ]);
    await seedOfflineStore(GET_NOTE, { path: { id: 'n1' } }, NOTE, {
      cachedAt: new Date(Date.UTC(2026, 5, 7, 9)),
    });
    await TestBed.inject(ApplicationRef).whenStable();
    expect(shotConnectivity().cached).toEqual([
      { operation: `${PROVIDER}#getNote`, cachedAt: '2026-06-07T09:00:00.000Z' },
    ]);
    await expect(
      seedOfflineStore(GET_NOTE, { path: { id: 'n1' } }, NOTE, { cachedAt: 'last week' }),
    ).rejects.toThrow(
      /seedOfflineStore: cachedAt must be a Date or an ISO instant, not "last week"/,
    );
  });

  it('starts the next test online with the store empty', async () => {
    expect(navigator.onLine).toBe(true);
    expect(Object.getOwnPropertyDescriptor(navigator, 'onLine')).toBeUndefined();
    expect(await offlineDatabases()).toEqual([]);
    configure();
    goOffline();
    const fixture = await openPage();
    // Nothing stored: an offline cache resource has nothing to show.
    expect(fixture.componentInstance.note.qitsStatus()).toBe('offline');
    expect(shown(fixture)).toBe('nothing');
  });

  it('shows a seed on a page already open', async () => {
    configure();
    goOffline();
    const fixture = await openPage();
    expect(shown(fixture)).toBe('nothing');
    await seedOfflineStore(GET_NOTE, { path: { id: 'n1' } }, NOTE);
    await TestBed.inject(ApplicationRef).whenStable();
    expect(shown(fixture)).toBe('groceries');
    expect(fixture.componentInstance.note.qitsStatus()).toBe('cached');
  });

  it('queues a write offline: the shot holds it PENDING', async () => {
    configure();
    goOffline();
    await seedOfflineStore(GET_NOTE, { path: { id: 'n1' } }, NOTE);
    const fixture = await openPage();
    await fixture.componentInstance.rename.run({ path: { id: 'n1' }, body: { name: 'shopping' } });
    await TestBed.inject(ApplicationRef).whenStable();
    expect(fixture.componentInstance.rename.status()).toBe('pending');
    expect(shown(fixture)).toBe('shopping');
    expect(shotConnectivity()).toMatchObject({
      network: 'OFFLINE',
      // The record the write touches; no currentVersion outside a conflict.
      outbox: [{ operation: `${PROVIDER}#renameNote`, state: 'PENDING', recordId: 'n1' }],
      // The stored answer, the queued write laid over it.
      cached: [{ operation: `${PROVIDER}#getNote`, cachedAt: SEEDED_CACHED_AT }],
    });
    expect(shotConnectivity().outbox[0]).not.toHaveProperty('currentVersion');
  });

  it('sends the queued write once back online; a 412 makes it a CONFLICT', async () => {
    configure();
    goOffline();
    await seedOfflineStore(GET_NOTE, { path: { id: 'n1' } }, NOTE);
    const fixture = await openPage();
    await fixture.componentInstance.rename.run({ path: { id: 'n1' }, body: { name: 'shopping' } });
    const controller = TestBed.inject(HttpTestingController);
    goOnline();
    // The cache resource reloads, and the outbox sends.
    const reload = await vi.waitFor(() =>
      controller.expectOne({ method: 'GET', url: '/api/notes/n1' }),
    );
    reload.flush(RENAMED);
    const write = await vi.waitFor(() =>
      controller.expectOne({ method: 'PATCH', url: '/api/notes/n1' }),
    );
    expect(write.request.headers.get('If-Match')).toBe('"1"');
    conflictAnswer(write, RENAMED);
    await vi.waitFor(() => expect(fixture.componentInstance.rename.status()).toBe('conflict'));
    await TestBed.inject(ApplicationRef).whenStable();
    expect(fixture.componentInstance.rename.conflict()).toMatchObject({
      current: RENAMED,
      currentVersion: 2,
    });
    expect(shotConnectivity()).toMatchObject({
      network: 'ONLINE',
      outbox: [
        {
          operation: `${PROVIDER}#renameNote`,
          state: 'CONFLICT',
          recordId: 'n1',
          // The server's version, as the 412 named it, stringified.
          currentVersion: '2',
        },
      ],
      // The page stored the server's record itself: freezeScreenshots({ offline: true }) pins the
      // instant every cache write stamps, so this is the same on every run.
      cached: [{ operation: `${PROVIDER}#getNote`, cachedAt: SEEDED_CACHED_AT }],
    });
    // The server is authoritative: the page shows its record.
    expect(shown(fixture)).toBe('groceries, by Bo');
    expect(currentTestRecords()).toEqual([source('a note exists'), source('the note was renamed')]);
  });

  it('answers a conflict with the qits-2148 stale-version problem', async () => {
    configure();
    const controller = TestBed.inject(HttpTestingController);
    const seen = firstValueFrom(http().patch('/api/notes/n1', {})).catch(
      (e: HttpErrorResponse) => e,
    );
    conflictAnswer(controller.expectOne('/api/notes/n1'), RENAMED);
    const refused = (await seen) as HttpErrorResponse;
    expect(refused.status).toBe(412);
    expect(refused.headers.get('ETag')).toBe('"2"');
    expect(refused.error).toEqual({
      type: STALE_VERSION_PROBLEM,
      title: 'Precondition Failed',
      status: 412,
      detail: 'The record changed since this write read it.',
      current: RENAMED,
      currentVersion: 2,
    });
    expect(STALE_VERSION_PROBLEM).toBe('urn:qits:problem:stale-version');
  });

  it('refuses a seed or a conflict record that is not a recording', async () => {
    configure();
    await expect(seedOfflineStore(GET_NOTE, { path: { id: 'n1' } }, { ...NOTE })).rejects.toThrow(
      /^golden-master guard: the body seedOfflineStore stores for qits-notes-service#getNote is not a golden master recording \(an object\)/,
    );
    const controller = TestBed.inject(HttpTestingController);
    void firstValueFrom(http().patch('/api/notes/n1', {})).catch(() => undefined);
    expect(() =>
      conflictAnswer(controller.expectOne('/api/notes/n1'), { id: 'n1', version: 2 }),
    ).toThrow(/the current record conflictAnswer answers with is not a golden master recording/);
  });

  it('refuses a seed without provideQitsOffline', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient()] });
    await expect(seedOfflineStore(GET_NOTE, {}, NOTE)).rejects.toThrow(
      /seedOfflineStore: the TestBed has no offline store/,
    );
    // Without it the shot records the network alone.
    expect(shotConnectivity()).toEqual({
      network: 'ONLINE',
      outbox: [],
      cacheResources: [],
      cached: [],
      queueMutations: [],
    });
  });
});

describe('offlineShotsNotTaken', () => {
  const sent: OfflineOptOutPayload[] = [];
  const registry = commands as unknown as Record<string, unknown>;

  // The command `screenshotReferences({ freezes })` registers in an app's run; this run has none.
  beforeAll(() => {
    registry[OFFLINE_OPT_OUT_COMMAND] = async (payload: OfflineOptOutPayload) => {
      sent.push(payload);
      return null;
    };
  });
  afterAll(() => {
    delete registry[OFFLINE_OPT_OUT_COMMAND];
  });

  offlineShotsNotTaken({
    reason: 'the note is read live here',
    network: true,
    operations: [`${PROVIDER}#renameNote`, `${PROVIDER}#renameNote`],
  });

  it('sends the opt-out once, before the first test', () => {
    expect(OFFLINE_OPT_OUT_COMMAND).toBe('qitsOfflineOptOut');
    expect(sent).toEqual([
      {
        reason: 'the note is read live here',
        network: true,
        operations: [`${PROVIDER}#renameNote`],
      },
    ]);
  });

  it('is not sent again for the next test', () => {
    expect(sent).toHaveLength(1);
  });

  it('refuses an opt-out without a reason, or with an operation not named <provider>#<operationId>', () => {
    expect(() => offlineShotsNotTaken({ reason: ' ' })).toThrow(/give the reason/);
    expect(() => offlineShotsNotTaken({ reason: 'r', operations: ['renameNote'] })).toThrow(
      /operations must name operations as '<provider>#<operationId>'/,
    );
  });
});
