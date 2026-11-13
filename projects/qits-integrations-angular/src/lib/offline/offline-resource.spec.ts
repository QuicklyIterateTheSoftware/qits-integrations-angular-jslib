import { TestBed } from '@angular/core/testing';
import { QitsApiError } from '../resources/api-error';
import { qitsMutation } from '../resources/qits-mutation';
import {
  backend,
  boot,
  CREATE_THING,
  databases,
  network,
  reloadPage,
  resetWorld,
  settle,
  UPDATE_THING,
  type FakeBackend,
} from './offline.fixture';

describe('offline mode: cache resources', () => {
  let server: FakeBackend;

  beforeEach(() => {
    server = resetWorld();
    server.seed('t1', 'one');
    server.seed('t2', 'two');
  });

  afterEach(() => network(true));

  it('A cache resource answers from the local store first', async () => {
    let { page } = boot();
    await settle();
    expect(page.thing.qitsStatus()).toBe('resolved');
    expect(page.thing.cachedAt()).toBeUndefined();

    // Online: the stored value shows at once, and the fresh answer replaces it.
    server.edit('t1', 'one, edited');
    reloadPage();
    const release = server.hold('getThing');
    ({ page } = boot());
    await vi.waitFor(() => expect(page.thing.qitsStatus()).toBe('cached'));
    expect(page.thing.value()).toEqual({ id: 't1', name: 'one', version: 1 });
    expect(page.thing.cachedAt()).toBeInstanceOf(Date);
    release();
    await settle();
    expect(page.thing.qitsStatus()).toBe('resolved');
    expect(page.thing.value()?.name).toBe('one, edited');
    expect(page.thing.cachedAt()).toBeUndefined();

    // The network cut: the stored value stays, cached, with nothing sent.
    network(false);
    server.edit('t1', 'one, edited again');
    reloadPage();
    const before = server.requests.length;
    ({ page } = boot());
    await settle();
    expect(server.requests.length).toBe(before);
    expect(page.thing.qitsStatus()).toBe('cached');
    expect(page.thing.value()?.name).toBe('one, edited');
    expect(page.thing.error()).toBeUndefined();

    // Restored: the `online` event reloads it.
    network(true);
    await settle();
    expect(page.thing.qitsStatus()).toBe('resolved');
    expect(page.thing.value()?.name).toBe('one, edited again');
  });

  it('keeps the stored value at cached when the fetch fails on the network', async () => {
    boot();
    await settle();
    reloadPage();
    // The browser still says online, but the call fails: a network failure all the same.
    server.online = false;
    const { page } = boot();
    await settle();
    expect(page.thing.qitsStatus()).toBe('cached');
    expect(page.thing.value()?.name).toBe('one');
    expect(page.thing.reloadError()).toBeInstanceOf(TypeError);
    expect(page.thing.error()).toBeUndefined();
    server.online = true;
    page.thing.reload();
    await settle();
    expect(page.thing.qitsStatus()).toBe('resolved');
    expect(page.thing.reloadError()).toBeUndefined();
  });

  it('A cache resource with nothing stored is offline when the network is cut', async () => {
    network(false);
    const { page } = boot();
    await settle();
    expect(page.thing.status()).toBe('resolved');
    expect(page.thing.qitsStatus()).toBe('offline');
    expect(page.thing.value()).toBeUndefined();
    expect(page.thing.error()).toBeUndefined();
    expect(page.things.qitsStatus()).toBe('offline');

    network(true);
    await settle();
    expect(page.thing.qitsStatus()).toBe('resolved');
    expect(page.thing.value()?.name).toBe('one');
    expect(page.things.qitsStatus()).toBe('resolved');
    expect(page.names()).toEqual(['t1:one', 't2:two']);
  });

  it('A QitsApiError behaves as it does online', async () => {
    const { page } = boot();
    page.id.set('missing');
    await settle();
    expect(page.thing.status()).toBe('error');
    expect(page.thing.error()).toBeInstanceOf(QitsApiError);
    expect(page.thing.error()).toMatchObject({ status: 404 });
  });

  it('Stored values survive a page reload', async () => {
    let { page } = boot();
    await settle();
    expect(page.names()).toEqual(['t1:one', 't2:two']);

    network(false);
    reloadPage();
    ({ page } = boot());
    await settle();
    expect(page.thing.qitsStatus()).toBe('cached');
    expect(page.thing.value()).toEqual({ id: 't1', name: 'one', version: 1 });
    expect(page.things.qitsStatus()).toBe('cached');
    expect(page.things.value()).toEqual({
      items: [
        { id: 't1', name: 'one', version: 1 },
        { id: 't2', name: 'two', version: 1 },
      ],
      deleted: [],
      hasMore: false,
      nextCursor: 'c2',
    });

    network(true);
    await settle();
    expect(page.things.qitsStatus()).toBe('resolved');
    expect(page.names()).toEqual(['t1:one', 't2:two']);
  });

  it('A collection syncs by its since cursor and applies tombstones', async () => {
    server.seed('t3', 'three');
    server.pageSize = 2;
    let { page } = boot();
    await settle();
    // The first sync follows hasMore: one read without a cursor, then on from it.
    expect(server.seen('listThings').map((r) => r.query?.since)).toEqual([undefined, 'c2']);
    expect(page.names()).toEqual(['t1:one', 't2:two', 't3:three']);

    network(false);
    server.edit('t2', 'two, edited');
    server.remove('t3');
    server.seed('t4', 'four');
    reloadPage();
    ({ page } = boot());
    await settle();
    expect(page.names()).toEqual(['t1:one', 't2:two', 't3:three']);

    const before = server.seen('listThings').length;
    network(true);
    await settle();
    const reads = server.seen('listThings').slice(before);
    // Only the changes since the stored cursor, paged: t2 and t3's tombstone, then t4.
    expect(reads.map((r) => r.query?.since)).toEqual(['c3', 'c5']);
    expect(page.names()).toEqual(['t1:one', 't2:two, edited', 't4:four']);
    expect(page.things.value()?.nextCursor).toBe('c6');
    expect(page.things.qitsStatus()).toBe('resolved');
  });

  it('An expired cursor resyncs the collection from scratch', async () => {
    boot();
    await settle();
    network(false);
    server.remove('t2');
    // Retention purged the tombstone: only a sync from scratch can tell t2 is gone.
    server.expireCursors();
    reloadPage();
    const { page } = boot();
    await settle();
    expect(page.names()).toEqual(['t1:one', 't2:two']);

    const before = server.seen('listThings').length;
    network(true);
    await settle();
    const reads = server.seen('listThings').slice(before);
    expect(reads.map((r) => r.query?.since)).toEqual(['c2', undefined]);
    expect(page.names()).toEqual(['t1:one']);
    expect(page.things.qitsStatus()).toBe('resolved');
    expect(page.things.error()).toBeUndefined();
  });

  it('Without provideQitsOffline resources and mutations behave as before', async () => {
    const { page } = boot({ offline: false });
    await settle();
    expect(page.thing.qitsStatus()).toBe('resolved');
    expect(page.thing.cachedAt()).toBeUndefined();

    // The network cut: a reload keeps the value in memory only, and never reads cached.
    network(false);
    page.thing.reload();
    await settle();
    expect(page.thing.qitsStatus()).toBe('resolved');
    expect(page.thing.value()?.name).toBe('one');
    expect(page.thing.reloadError()).toBeInstanceOf(TypeError);

    // A `queue` run is sent at once and fails, as every run did.
    await expect(page.rename.run({ path: { id: 't1' }, body: { name: 'x' } })).rejects.toThrow(
      TypeError,
    );
    expect(page.rename.status()).toBe('error');

    network(true);
    await page.create.run({ body: { name: 'three' } });
    await page.create.run({ body: { name: 'four' } });
    expect(page.create.status()).toBe('done');
    const creates = server.seen('createThing');
    expect(creates[0].headers['Idempotency-Key']).not.toBe(creates[1].headers['Idempotency-Key']);
    // No store, so no version: an update goes without If-Match, as before.
    await expect(
      page.rename.run({ path: { id: 't1' }, body: { name: 'x' } }),
    ).rejects.toMatchObject({ status: 428 });
    expect(server.seen('updateThing').at(-1)?.headers['If-Match']).toBeUndefined();
    expect(page.rename.conflict()).toBeUndefined();
    expect(await databases()).toEqual([]);

    // An `online-only` run offline without the provider is sent, as before, not refused.
    network(false);
    const plain = TestBed.runInInjectionContext(() => qitsMutation(UPDATE_THING));
    await expect(plain.run({ path: { id: 't1' }, body: { name: 'y' } })).rejects.toThrow(TypeError);
    const creating = TestBed.runInInjectionContext(() => qitsMutation(CREATE_THING));
    expect(creating.status()).toBe('idle');
    expect(backend()).toBe(server);
  });
});
