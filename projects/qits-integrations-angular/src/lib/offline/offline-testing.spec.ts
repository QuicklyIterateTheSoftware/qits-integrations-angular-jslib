import { Component, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { qitsMutation } from '../resources/qits-mutation';
import { qitsResource } from '../resources/qits-resource';
import {
  boot,
  CREATE_THING,
  databases,
  GET_THING,
  network,
  reloadPage,
  resetWorld,
  settle,
  UPDATE_THING,
  type FakeBackend,
} from './offline.fixture';
import { ɵdeleteQitsOfflineStores, ɵqitsOfflineState } from './offline-testing';

/** A page with one mutation of each policy over the same kind of write, and no `cache` resource. */
@Component({ selector: 'qits-policies-fixture', template: '' })
class PoliciesPage {
  readonly queued = qitsMutation(CREATE_THING, { offline: 'queue' });
  readonly direct = qitsMutation(UPDATE_THING);
  readonly online = qitsResource(GET_THING, () => ({ path: { id: 't1' } }));
}

const state = () => ɵqitsOfflineState(TestBed.inject(Injector));

describe('the offline testing hook (qits-2151)', () => {
  let server: FakeBackend;

  beforeEach(() => {
    server = resetWorld();
    server.seed('t1', 'one');
  });

  afterEach(() => network(true));

  it('answers null without provideQitsOffline', () => {
    boot({ offline: false, page: false });
    expect(state()).toBeNull();
  });

  it('lists the live queue mutations only, not the online-only ones, and drops them on destroy', async () => {
    boot({ page: false });
    expect(state()).toMatchObject({ cacheResources: [], queueMutations: [], outbox: [] });
    const fixture = TestBed.createComponent(PoliciesPage);
    await settle();
    // updateThing is registered with the outbox all the same (provideQitsOffline lists it, and
    // every qitsMutation registers its operation), but no queue mutation of it is live.
    expect(state()?.queueMutations).toEqual(['qits-things-service#createThing']);
    // An online-only resource is not a cache resource.
    expect(state()?.cacheResources).toEqual([]);
    fixture.destroy();
    expect(state()?.queueMutations).toEqual([]);
  });

  it('lists the cache resources and the outbox of the fixture page', async () => {
    const { page } = boot();
    await settle();
    expect(state()?.cacheResources).toEqual([
      'qits-things-service#getThing',
      'qits-things-service#listThings',
    ]);
    expect(state()?.queueMutations).toEqual([
      'qits-things-service#createThing',
      'qits-things-service#deleteThing',
      'qits-things-service#updateThing',
    ]);
    network(false);
    await page.rename.run({ path: { id: 't1' }, body: { name: 'renamed' } });
    expect(state()?.outbox).toEqual([
      { operation: 'qits-things-service#updateThing', state: 'pending' },
    ]);
  });

  it('stores an answer a cache resource then shows, offline, without a request', async () => {
    boot({ page: false });
    const stored = { id: 't1', name: 'from the store', version: 3 };
    const key = await state()!.store(GET_THING, { path: { id: 't1' } }, stored);
    expect(key).toBe('qits-things-service#getThing|{"path":{"id":"t1"}}');
    network(false);
    const before = server.requests.length;
    const cached = TestBed.runInInjectionContext(() =>
      qitsResource(GET_THING, () => ({ path: { id: 't1' } }), { offline: 'cache' }),
    );
    await settle();
    expect(cached.qitsStatus()).toBe('cached');
    expect(cached.value()).toEqual(stored);
    expect(server.requests.length).toBe(before);
  });

  it('refuses to store with nobody signed in', async () => {
    boot({ page: false, options: { user: () => null } });
    await expect(state()!.store(GET_THING, {}, { id: 't1' })).rejects.toThrow(
      /nobody is signed in/,
    );
  });

  it('deletes every qits-offline database, and nothing else', async () => {
    boot();
    await settle();
    reloadPage();
    const other = indexedDB.open('another-app');
    await new Promise((resolve) => (other.onsuccess = resolve));
    other.result.close();
    expect(await databases()).toContain('qits-offline:fixture:alice');
    expect(await ɵdeleteQitsOfflineStores()).toEqual(['qits-offline:fixture:alice']);
    expect(await databases()).toEqual(['another-app']);
  });
});
