import { TestBed } from '@angular/core/testing';
import type { QitsPwaReloadGuard } from '../../../pwa/src/qits-pwa-updates';
import { QitsApiError } from '../resources/api-error';
import { qitsMutation } from '../resources/qits-mutation';
import {
  boot,
  network,
  PROBLEM,
  reloadPage,
  resetWorld,
  settle,
  UPDATE_THING,
  type FakeBackend,
  type ThingsPage,
} from './offline.fixture';
import { QitsOfflineError } from './offline-types';
import { qitsOfflineReloadGuard, type QitsOffline } from './qits-offline';

const rename = (id: string, name: string) => ({ path: { id }, body: { name } });

describe('offline mode: the outbox', () => {
  let server: FakeBackend;
  let page: ThingsPage;
  let offline: QitsOffline;

  beforeEach(async () => {
    server = resetWorld();
    server.seed('t1', 'one');
    server.seed('t2', 'two');
    ({ page, offline } = boot());
    await settle();
  });

  afterEach(() => network(true));

  it('An offline queue mutation is stored and sent when back online', async () => {
    network(false);
    await expect(page.rename.run(rename('t1', 'one, renamed'))).resolves.toBeUndefined();
    expect(page.rename.status()).toBe('pending');
    expect(offline.outbox()).toMatchObject([
      {
        seq: 1,
        state: 'pending',
        operation: { provider: 'qits-things-service', operationId: 'updateThing' },
        recordId: 't1',
        change: { change: 'update', id: 't1', fields: { name: 'one, renamed' } },
        baseVersion: 1,
        params: { path: { id: 't1' }, body: { name: 'one, renamed' } },
      },
    ]);
    expect(offline.outbox()[0].enqueuedAt).toBeInstanceOf(Date);
    expect(server.seen('updateThing')).toEqual([]);

    network(true);
    await settle();
    expect(server.seen('updateThing')).toHaveLength(1);
    expect(server.thing('t1')).toEqual({ id: 't1', name: 'one, renamed', version: 2 });
    expect(offline.outbox()).toEqual([]);
    expect(page.rename.status()).toBe('done');
    expect(page.thing.qitsStatus()).toBe('resolved');
    expect(page.thing.value()).toEqual({ id: 't1', name: 'one, renamed', version: 2 });
  });

  it('queues behind writes already in the outbox, keeping their order', async () => {
    network(false);
    await page.rename.run(rename('t1', 'first'));
    // Back online, but the outbox is not empty yet when the second write comes.
    const release = server.hold('updateThing');
    network(true);
    await vi.waitFor(() => expect(offline.sending()).toBe(true));
    await expect(page.create.run({ body: { name: 'second' } })).resolves.toBeUndefined();
    expect(page.create.status()).toBe('pending');
    release();
    await settle();
    const writes = server.requests.filter(
      (r) => !['getThing', 'listThings'].includes(r.operationId),
    );
    expect(writes.map((r) => r.operationId)).toEqual(['updateThing', 'createThing']);
    expect(page.create.status()).toBe('done');
  });

  it('replays the outbox after a page reload', async () => {
    network(false);
    await page.rename.run(rename('t1', 'one, renamed'));
    reloadPage();
    ({ page, offline } = boot());
    await settle();
    expect(offline.outbox()).toMatchObject([{ seq: 1, state: 'pending', recordId: 't1' }]);
    // The queued write is still laid over the stored value.
    expect(page.thing.value()?.name).toBe('one, renamed');

    network(true);
    await settle();
    expect(server.thing('t1')?.name).toBe('one, renamed');
    expect(offline.outbox()).toEqual([]);
    expect(page.thing.value()).toEqual({ id: 't1', name: 'one, renamed', version: 2 });
  });

  it('waits with an unknown operation until one registers it', async () => {
    network(false);
    await page.rename.run(rename('t1', 'one, renamed'));
    reloadPage();
    network(true);
    // A start-up with no `operations` and no page: nothing can send the entry.
    ({ offline } = boot({ options: { operations: [] }, page: false }));
    await settle();
    expect(offline.outbox()).toMatchObject([{ state: 'pending', waiting: 'unknown-operation' }]);
    expect(server.seen('updateThing')).toEqual([]);

    // A mutation over the operation registers it, and the outbox goes on.
    TestBed.runInInjectionContext(() => qitsMutation(UPDATE_THING));
    await settle();
    expect(server.seen('updateThing')).toHaveLength(1);
    expect(offline.outbox()).toEqual([]);
  });

  it('A queued mutation is applied to the store as pending', async () => {
    network(false);
    await page.rename.run(rename('t1', 'one, renamed'));
    await page.remove.run({ path: { id: 't2' } });
    await page.create.run({ body: { name: 'three' } });
    await settle();
    const created = offline.outbox()[2];
    expect(created).toMatchObject({ recordId: `local:${created.key}`, baseVersion: null });

    expect(page.thing.qitsStatus()).toBe('cached');
    expect(page.thing.value()).toEqual({ id: 't1', name: 'one, renamed', version: 1 });
    expect(page.things.qitsStatus()).toBe('cached');
    // Ids sort as IndexedDB keys do: `local:…` before `t1`.
    expect(page.names()).toEqual([`local:${created.key}:three`, 't1:one, renamed']);
    expect(offline.outbox().map((e) => e.state)).toEqual(['pending', 'pending', 'pending']);

    // It outlives a page reload, because the outbox does.
    reloadPage();
    ({ page, offline } = boot());
    await settle();
    expect(page.names()).toEqual([`local:${created.key}:three`, 't1:one, renamed']);

    network(true);
    await settle();
    expect(offline.outbox()).toEqual([]);
    expect(page.things.qitsStatus()).toBe('resolved');
    expect(page.names()).toEqual(['t1:one, renamed', 't100:three']);
  });

  it('Every send of one queued write reuses one Idempotency-Key', async () => {
    // Online: the direct send is applied, but its answer is lost on the way back.
    server.loseNextAnswer = true;
    await expect(page.rename.run(rename('t1', 'one, renamed'))).resolves.toBeUndefined();
    await settle();
    let sends = server.seen('updateThing');
    expect(sends).toHaveLength(2);
    expect(sends[1].headers['Idempotency-Key']).toBe(sends[0].headers['Idempotency-Key']);
    expect(server.applied).toBe(1);
    expect(server.thing('t1')).toMatchObject({ name: 'one, renamed', version: 2 });
    expect(page.rename.status()).toBe('done');

    // Queued offline, then lost again on the first send back online.
    network(false);
    await page.rename.run(rename('t1', 'again'));
    server.loseNextAnswer = true;
    network(true);
    await settle();
    expect(offline.outbox()).toMatchObject([{ state: 'pending' }]);
    network(true);
    await settle();
    sends = server.seen('updateThing').slice(2);
    expect(sends).toHaveLength(2);
    expect(sends[1].headers['Idempotency-Key']).toBe(sends[0].headers['Idempotency-Key']);
    expect(server.applied).toBe(2);
    expect(offline.outbox()).toEqual([]);
    expect(page.rename.status()).toBe('done');
  });

  it('sends again after a backoff when the server answers 5xx', async () => {
    network(false);
    await page.rename.run(rename('t1', 'mine'));
    server.failingWrites = 1;
    network(true);
    await settle();
    expect(server.seen('updateThing')).toHaveLength(1);
    expect(offline.outbox()).toMatchObject([{ state: 'pending' }]);
    expect(page.rename.status()).toBe('pending');

    // The backoff starts at a second; no event is needed to send again.
    await vi.waitFor(() => expect(server.seen('updateThing')).toHaveLength(2), { timeout: 3000 });
    await settle();
    const sends = server.seen('updateThing');
    expect(sends[1].headers['Idempotency-Key']).toBe(sends[0].headers['Idempotency-Key']);
    expect(offline.outbox()).toEqual([]);
    expect(page.rename.status()).toBe('done');
  });

  it('Updates and deletes send If-Match with the stored version', async () => {
    await page.rename.run(rename('t1', 'one, renamed'));
    expect(server.seen('updateThing')[0].headers['If-Match']).toBe('"1"');
    await settle();

    network(false);
    await page.remove.run({ path: { id: 't1' } });
    network(true);
    await settle();
    // The store held version 2 by then, from the rename's answer.
    expect(server.seen('deleteThing')[0].headers['If-Match']).toBe('"2"');
    expect(server.thing('t1')).toBeUndefined();
    expect(page.names()).toEqual(['t2:two']);

    // An `online-only` mutation sends it too, and one the params carry is kept.
    const plain = TestBed.runInInjectionContext(() =>
      qitsMutation(UPDATE_THING, {
        affects: [page.things],
        record: (p) => ({ change: 'update', id: p.path.id, fields: p.body }),
      }),
    );
    await plain.run(rename('t2', 'two, renamed'));
    expect(server.seen('updateThing').at(-1)?.headers['If-Match']).toBe('"1"');
    await expect(
      plain.run({ ...rename('t2', 'stale'), headers: { 'if-match': '"1"' } }),
    ).rejects.toMatchObject({ status: 412 });
    expect(server.seen('updateThing').at(-1)?.headers).toMatchObject({ 'if-match': '"1"' });
    expect(server.seen('updateThing').at(-1)?.headers['If-Match']).toBeUndefined();
  });

  it('A 412 puts the entry in conflict with the server record', async () => {
    network(false);
    await page.rename.run(rename('t1', 'mine'));
    const theirs = server.edit('t1', 'theirs');
    network(true);
    await settle();
    expect(server.seen('updateThing')[0].headers['If-Match']).toBe('"1"');
    expect(offline.outbox()).toMatchObject([
      {
        state: 'conflict',
        baseVersion: 1,
        conflict: { seq: 1, recordId: 't1', current: theirs, currentVersion: 2 },
      },
    ]);
    expect(page.rename.status()).toBe('conflict');
    expect(page.rename.conflict()).toEqual({
      seq: 1,
      recordId: 't1',
      current: theirs,
      currentVersion: 2,
    });
    expect(server.thing('t1')).toEqual(theirs);
  });

  it("A conflict reverts the local record to the server's", async () => {
    network(false);
    await page.rename.run(rename('t1', 'mine'));
    await settle();
    expect(page.thing.value()?.name).toBe('mine');
    server.edit('t1', 'theirs');
    network(true);
    await settle();
    expect(page.thing.value()).toEqual({ id: 't1', name: 'theirs', version: 2 });
    expect(page.names()).toEqual(['t1:theirs', 't2:two']);

    // Even with the page reloaded offline, nothing optimistic comes back.
    network(false);
    reloadPage();
    ({ page, offline } = boot());
    await settle();
    expect(page.thing.value()).toEqual({ id: 't1', name: 'theirs', version: 2 });
    expect(page.names()).toEqual(['t1:theirs', 't2:two']);
    expect(offline.outbox()).toMatchObject([{ state: 'conflict' }]);
  });

  it("Retry re-bases a conflict on the server's version", async () => {
    network(false);
    await page.rename.run(rename('t1', 'mine'));
    server.edit('t1', 'theirs');
    network(true);
    await settle();
    const [entry] = offline.outbox();
    expect(entry.state).toBe('conflict');

    network(false);
    await offline.retry(entry.seq);
    expect(offline.outbox()).toMatchObject([
      { seq: entry.seq, state: 'pending', baseVersion: 2, key: entry.key },
    ]);
    expect(offline.outbox()[0].conflict).toBeUndefined();
    expect(page.rename.status()).toBe('pending');
    await settle();
    expect(page.thing.value()?.name).toBe('mine');

    network(true);
    await settle();
    const sends = server.seen('updateThing');
    expect(sends.at(-1)?.headers['If-Match']).toBe('"2"');
    expect(sends.at(-1)?.headers['Idempotency-Key']).toBe(entry.key);
    expect(server.thing('t1')).toEqual({ id: 't1', name: 'mine', version: 3 });
    expect(offline.outbox()).toEqual([]);
    expect(page.rename.status()).toBe('done');
    expect(page.thing.value()).toEqual({ id: 't1', name: 'mine', version: 3 });
  });

  it('Drop removes the entry and keeps the server record', async () => {
    network(false);
    await page.rename.run(rename('t1', 'mine'));
    server.edit('t1', 'theirs');
    network(true);
    await settle();
    const [entry] = offline.outbox();

    await offline.drop(entry.seq);
    await settle();
    expect(offline.outbox()).toEqual([]);
    expect(server.thing('t1')).toEqual({ id: 't1', name: 'theirs', version: 2 });
    expect(server.seen('updateThing')).toHaveLength(1);
    expect(page.thing.value()).toEqual({ id: 't1', name: 'theirs', version: 2 });
    expect(page.thing.qitsStatus()).toBe('resolved');
  });

  it('holds later writes to a record behind its conflict, and sends the others', async () => {
    network(false);
    await page.rename.run(rename('t1', 'mine'));
    await page.rename.run(rename('t1', 'mine, again'));
    await page.rename.run(rename('t2', 'two, renamed'));
    server.edit('t1', 'theirs');
    network(true);
    await settle();
    expect(server.seen('updateThing').map((r) => r.path?.id)).toEqual(['t1', 't2']);
    expect(offline.outbox().map((e) => [e.recordId, e.state])).toEqual([
      ['t1', 'conflict'],
      ['t1', 'pending'],
    ]);
    expect(server.thing('t2')?.name).toBe('two, renamed');

    // Dropping the conflict frees the record; the next write goes, on the version it was made on.
    await offline.drop(offline.outbox()[0].seq);
    await settle();
    expect(offline.outbox()).toMatchObject([{ recordId: 't1', state: 'conflict' }]);
  });

  it('rebases a queued write on the version an earlier write to the record landed at', async () => {
    network(false);
    await page.rename.run(rename('t1', 'first'));
    await page.rename.run(rename('t1', 'second'));
    network(true);
    await settle();
    expect(server.seen('updateThing').map((r) => r.headers['If-Match'])).toEqual(['"1"', '"2"']);
    expect(server.thing('t1')).toEqual({ id: 't1', name: 'second', version: 3 });
    expect(offline.outbox()).toEqual([]);
  });

  it('a 404 to an update is a conflict, and the record goes locally', async () => {
    network(false);
    await page.rename.run(rename('t2', 'mine'));
    server.remove('t2');
    network(true);
    await settle();
    expect(offline.outbox()).toMatchObject([
      { state: 'conflict', conflict: { recordId: 't2', current: null, currentVersion: null } },
    ]);
    expect(page.rename.status()).toBe('conflict');
    expect(page.names()).toEqual(['t1:one']);
  });

  it('another 4xx fails the entry and reverts the queued change', async () => {
    network(false);
    await page.rename.run(rename('t1', ''));
    await settle();
    expect(page.thing.value()?.name).toBe('');
    network(true);
    await settle();
    const [entry] = offline.outbox();
    expect(entry.state).toBe('failed');
    expect(entry.error).toBeInstanceOf(QitsApiError);
    expect(entry.error).toMatchObject({ status: 400, error: { type: 'urn:qits:problem:invalid' } });
    expect(page.rename.status()).toBe('error');
    expect(page.rename.error()).toMatchObject({ status: 400 });
    expect(page.thing.value()?.name).toBe('one');
    expect(page.names()).toEqual(['t1:one', 't2:two']);
  });

  it('a 428 fails an update that names no version', async () => {
    const blind = TestBed.runInInjectionContext(() =>
      qitsMutation(UPDATE_THING, { offline: 'queue' }),
    );
    network(false);
    await blind.run(rename('t1', 'blind'));
    network(true);
    await settle();
    expect(offline.outbox()).toMatchObject([
      { state: 'failed', error: { status: 428, error: { type: PROBLEM.versionRequired } } },
    ]);
    expect(blind.status()).toBe('error');
  });

  it('a direct send that meets a 412 shows the conflict and reverts the record', async () => {
    server.edit('t1', 'theirs');
    await expect(page.rename.run(rename('t1', 'mine'))).rejects.toMatchObject({ status: 412 });
    await settle();
    expect(page.rename.status()).toBe('conflict');
    expect(page.rename.conflict()).toMatchObject({ recordId: 't1', currentVersion: 2 });
    expect(page.thing.value()).toEqual({ id: 't1', name: 'theirs', version: 2 });
    expect(offline.outbox()).toEqual([]);
  });

  it('refuses an online-only run while offline', async () => {
    const plain = TestBed.runInInjectionContext(() => qitsMutation(UPDATE_THING));
    network(false);
    const refused = plain.run(rename('t1', 'x'));
    await expect(refused).rejects.toBeInstanceOf(QitsOfflineError);
    await expect(refused).rejects.toMatchObject({ reason: 'offline' });
    expect(plain.status()).toBe('error');
    expect(plain.error()).toBeInstanceOf(QitsOfflineError);
    expect(server.seen('updateThing')).toEqual([]);
  });

  it('refuses a queue run with nobody signed in', async () => {
    reloadPage();
    ({ page } = boot({ options: { user: () => null } }));
    await settle();
    // No store: the cache resource acts online-only.
    expect(page.thing.qitsStatus()).toBe('resolved');
    network(false);
    await expect(page.rename.run(rename('t1', 'x'))).rejects.toMatchObject({
      reason: 'signed-out',
    });
    expect(page.rename.status()).toBe('error');
  });

  it('The reload guard refuses while the outbox is sending', async () => {
    const guard: QitsPwaReloadGuard = TestBed.runInInjectionContext(qitsOfflineReloadGuard);
    expect(guard()).toBe(true);

    network(false);
    await page.rename.run(rename('t1', 'mine'));
    expect(guard()).toBe(true);
    const release = server.hold('updateThing');
    network(true);
    await vi.waitFor(() => expect(offline.sending()).toBe(true));
    expect(guard()).toBe('the outbox is sending');
    release();
    await settle();
    expect(offline.sending()).toBe(false);
    expect(guard()).toBe(true);
  });
});

describe('qitsOfflineReloadGuard without provideQitsOffline', () => {
  it('lets every reload through', () => {
    const guard = TestBed.runInInjectionContext(qitsOfflineReloadGuard);
    expect(guard()).toBe(true);
  });
});
