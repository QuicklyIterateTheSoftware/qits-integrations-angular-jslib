import 'fake-indexeddb/auto';
import { ApplicationRef, Component, signal, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { qitsMutation } from '../resources/qits-mutation';
import { qitsOperation } from '../resources/operation';
import { qitsResource } from '../resources/qits-resource';
import { provideQitsOffline, QitsOffline } from './qits-offline';
import type { QitsOfflineOptions } from './offline-types';

/**
 * The offline specs' world (ticket qits-2149): an in-memory backend that keeps qits-2148's
 * conventions, a network switch, and a page with a single resource, a collection resource and
 * create, update and delete mutations over it.
 */

/** A record as qits-2148's `OfflineRecord` answers it. */
export interface Thing {
  id: string;
  name: string;
  version: number;
}

/** An RFC 9457 problem body, as qits-2148's `ProblemResponses` writes it. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  current?: Thing;
  currentVersion?: number;
}

/** qits-2148's `ChangesPage`. */
export interface ChangesPage {
  items: Thing[];
  deleted: { id: string; version: number }[];
  nextCursor: string;
  hasMore: boolean;
}

interface FakeResponse {
  status: number;
  headers: Headers;
}

/** A generated client's answer: it never throws on an error answer. */
export type Answer<T> =
  | { data: T; error: undefined; response: FakeResponse }
  | { data: undefined; error: Problem; response: FakeResponse };

export interface GetOptions {
  path: { id: string };
  headers?: Record<string, string>;
}
export interface ListOptions {
  query?: { since?: string };
  headers?: Record<string, string>;
}
export interface CreateOptions {
  body: { name: string };
  headers?: Record<string, string>;
}
export interface UpdateOptions {
  path: { id: string };
  body: { name: string };
  headers?: Record<string, string>;
}
export interface DeleteOptions {
  path: { id: string };
  headers?: Record<string, string>;
}

/** The problem `type` URNs of qits-2148's `Problems`. */
export const PROBLEM = {
  staleVersion: 'urn:qits:problem:stale-version',
  versionRequired: 'urn:qits:problem:version-required',
  idempotencyKeyReused: 'urn:qits:problem:idempotency-key-reused',
  cursorExpired: 'urn:qits:problem:cursor-expired',
} as const;

/** One request the backend saw, whether or not the network let it through. */
export interface SeenRequest {
  readonly operationId: string;
  readonly path?: { id: string };
  readonly query?: { since?: string };
  readonly body?: unknown;
  readonly headers: Record<string, string>;
}

interface Row extends Thing {
  /** The change counter when the row last changed: what a `since` cursor compares. */
  changed: number;
}

/**
 * The provider of the specs, keeping qits-2148's conventions: versions raised by every write,
 * `If-Match` required on update and delete (428), a stale one refused with the current record
 * (412), `Idempotency-Key` replay of a 2xx answer (422 for the same key on another request),
 * `since` cursors with tombstones and paging, and 410 for an expired cursor.
 */
export class FakeBackend {
  private readonly rows = new Map<string, Row>();
  private readonly tombstones = new Map<string, { version: number; changed: number }>();
  private readonly idempotency = new Map<
    string,
    { fingerprint: string; status: number; data: unknown }
  >();
  private change = 0;
  private nextId = 100;
  private gate: { operationId: string; open: Promise<void> } | undefined;

  /** False: every call rejects with a `TypeError`, as `fetch` does without a network. */
  online = true;
  /** At most this many changes per page; `hasMore` says when one was cut short. */
  pageSize = 100;
  /** A cursor older than this change is answered 410. */
  expiredBefore = 0;
  /** Writes answer 401 while true. */
  unauthorized = false;
  /** This many writes answer 503 before the server takes writes again. */
  failingWrites = 0;
  /** The next write is applied, and then its answer is lost on the way back. */
  loseNextAnswer = false;
  /** Every request, in order. */
  readonly requests: SeenRequest[] = [];
  /** How many writes were applied (a replay is not one). */
  applied = 0;

  /** A record the server already has, at version 1. */
  seed(id: string, name: string): Thing {
    this.change++;
    this.rows.set(id, { id, name, version: 1, changed: this.change });
    return this.thing(id)!;
  }

  /** Someone else changes a record on the server. */
  edit(id: string, name: string): Thing {
    const row = this.rows.get(id)!;
    this.change++;
    this.rows.set(id, { ...row, name, version: row.version + 1, changed: this.change });
    return this.thing(id)!;
  }

  /** Someone else deletes a record on the server; it leaves a tombstone. */
  remove(id: string): void {
    const row = this.rows.get(id)!;
    this.change++;
    this.rows.delete(id);
    this.tombstones.set(id, { version: row.version + 1, changed: this.change });
  }

  /** Purges the tombstones and expires every cursor issued so far, as retention does. */
  expireCursors(): void {
    this.tombstones.clear();
    this.expiredBefore = this.change + 1;
  }

  thing(id: string): Thing | undefined {
    const row = this.rows.get(id);
    return row && { id: row.id, name: row.name, version: row.version };
  }

  /** Holds the next request to `operationId` until the answer is released. */
  hold(operationId: string): () => void {
    let release!: () => void;
    this.gate = { operationId, open: new Promise((resolve) => (release = resolve)) };
    return release;
  }

  /** The requests of one operation. */
  seen(operationId: string): SeenRequest[] {
    return this.requests.filter((r) => r.operationId === operationId);
  }

  async getThing(options: GetOptions): Promise<Answer<Thing>> {
    await this.wire('getThing', options);
    const thing = this.thing(options.path.id);
    if (!thing) return problem(404, 'urn:qits:problem:not-found', 'Not found');
    return ok(200, thing, { ETag: `"${thing.version}"` });
  }

  async listThings(options: ListOptions): Promise<Answer<ChangesPage>> {
    await this.wire('listThings', options);
    const since = options.query?.since;
    let after = 0;
    if (since) {
      after = Number(since.replace(/^c/, ''));
      if (Number.isNaN(after)) return problem(400, 'urn:qits:problem:cursor-invalid', 'Invalid');
      if (after < this.expiredBefore) {
        return problem(410, PROBLEM.cursorExpired, 'The cursor has expired');
      }
    }
    const changes = [
      ...[...this.rows.values()].map((row) => ({ kind: 'item' as const, id: row.id, row })),
      ...(since
        ? [...this.tombstones.entries()].map(([id, t]) => ({ kind: 'gone' as const, id, t }))
        : []),
    ]
      .map((c) => ({ ...c, changed: c.kind === 'item' ? c.row.changed : c.t.changed }))
      .filter((c) => c.changed > after)
      .sort((a, b) => a.changed - b.changed);
    const page = changes.slice(0, this.pageSize);
    const hasMore = changes.length > page.length;
    const last = hasMore ? page[page.length - 1].changed : this.change;
    return ok(200, {
      items: page.flatMap((c) => (c.kind === 'item' ? [this.thing(c.id)!] : [])),
      deleted: page.flatMap((c) => (c.kind === 'gone' ? [{ id: c.id, version: c.t.version }] : [])),
      nextCursor: `c${last}`,
      hasMore,
    });
  }

  async createThing(options: CreateOptions): Promise<Answer<Thing>> {
    await this.wire('createThing', options);
    return this.idempotent('POST', options, () => {
      if (!options.body.name) return problem(400, 'urn:qits:problem:invalid', 'A name is needed');
      const id = `t${this.nextId++}`;
      this.change++;
      this.rows.set(id, { id, name: options.body.name, version: 1, changed: this.change });
      return ok(201, this.thing(id)!);
    });
  }

  async updateThing(options: UpdateOptions): Promise<Answer<Thing>> {
    await this.wire('updateThing', options);
    return this.idempotent('PATCH', options, () => {
      const refused = this.versionCheck(options.path.id, options.headers);
      if (refused) return refused;
      if (!options.body.name) return problem(400, 'urn:qits:problem:invalid', 'A name is needed');
      const row = this.rows.get(options.path.id)!;
      this.change++;
      this.rows.set(row.id, {
        ...row,
        name: options.body.name,
        version: row.version + 1,
        changed: this.change,
      });
      return ok(200, this.thing(row.id)!);
    });
  }

  async deleteThing(options: DeleteOptions): Promise<Answer<undefined>> {
    await this.wire('deleteThing', options);
    return this.idempotent('DELETE', options, () => {
      const refused = this.versionCheck(options.path.id, options.headers);
      if (refused) return refused;
      this.remove(options.path.id);
      return ok(204, undefined);
    }) as Answer<undefined>;
  }

  /** Logs the request, waits for a held gate, and throws when the network is gone. */
  private async wire(operationId: string, options: object): Promise<void> {
    const o = options as Omit<SeenRequest, 'operationId' | 'headers'> & { headers?: object };
    this.requests.push({
      operationId,
      path: o.path,
      query: o.query,
      body: o.body,
      headers: { ...(o.headers as Record<string, string> | undefined) },
    });
    const gate = this.gate;
    if (gate?.operationId === operationId) {
      this.gate = undefined;
      await gate.open;
    }
    if (!this.online) throw new TypeError('Failed to fetch');
  }

  /** `RecordVersions.require`: 404, 428 without a strong `If-Match`, 412 on another version. */
  private versionCheck(id: string, headers?: Record<string, string>): Answer<never> | undefined {
    const row = this.rows.get(id);
    if (!row) return problem(404, 'urn:qits:problem:not-found', 'Not found');
    const ifMatch = header(headers, 'If-Match');
    const named = ifMatch?.match(/^"?(\d{1,18})"?$/);
    if (!named) return problem(428, PROBLEM.versionRequired, 'A record version is required');
    if (Number(named[1]) !== row.version) {
      const current = this.thing(id)!;
      return problem(412, PROBLEM.staleVersion, 'The record has changed', {
        current,
        currentVersion: current.version,
      });
    }
    return undefined;
  }

  /** `IdempotencyInterceptor`: a 2xx answer is kept per key and replayed; anything else frees it. */
  private idempotent<T>(
    method: string,
    options: { path?: object; body?: unknown; headers?: Record<string, string> },
    run: () => Answer<T> | Answer<never>,
  ): Answer<T> | Answer<never> {
    if (this.unauthorized) return problem(401, 'urn:qits:problem:unauthorized', 'Unauthorized');
    if (this.failingWrites > 0) {
      this.failingWrites--;
      return problem(503, 'urn:qits:problem:unavailable', 'Unavailable');
    }
    const key = header(options.headers, 'Idempotency-Key');
    const fingerprint = JSON.stringify([method, options.path, options.body]);
    const stored = key ? this.idempotency.get(key) : undefined;
    let answer: Answer<T> | Answer<never>;
    if (stored) {
      answer =
        stored.fingerprint === fingerprint
          ? ok(stored.status, stored.data as T, { 'Idempotency-Replayed': 'true' })
          : problem(422, PROBLEM.idempotencyKeyReused, 'The key was used for another request');
    } else {
      answer = run();
      if (answer.response.status < 300) {
        this.applied++;
        if (key)
          this.idempotency.set(key, {
            fingerprint,
            status: answer.response.status,
            data: answer.data,
          });
      }
    }
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      throw new TypeError('Failed to fetch');
    }
    return answer;
  }
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === lower)?.[1];
}

function ok<T>(status: number, data: T, headers: Record<string, string> = {}): Answer<T> {
  return {
    data,
    error: undefined,
    response: { status, headers: new Headers({ 'content-type': 'application/json', ...headers }) },
  };
}

function problem(
  status: number,
  type: string,
  title: string,
  extra: Partial<Problem> = {},
): Answer<never> {
  const body: Problem = { type, title, status, ...extra };
  const headers = new Headers({ 'content-type': 'application/problem+json' });
  if (extra.currentVersion !== undefined) headers.set('ETag', `"${extra.currentVersion}"`);
  return { data: undefined as never, error: body, response: { status, headers } };
}

let current = new FakeBackend();

/** The backend of the running spec. */
export function backend(): FakeBackend {
  return current;
}

const PROVIDER = 'qits-things-service';

export const GET_THING = qitsOperation({
  provider: PROVIDER,
  operationId: 'getThing',
  method: 'GET',
  call: (options: GetOptions) => current.getThing(options),
  consumes: ['id', 'name', 'version'],
  errorConsumes: ['type', 'current', 'currentVersion'],
});

export const LIST_THINGS = qitsOperation({
  provider: PROVIDER,
  operationId: 'listThings',
  method: 'GET',
  call: (options: ListOptions) => current.listThings(options),
  consumes: [
    'items[].id',
    'items[].name',
    'items[].version',
    'deleted[].id',
    'deleted[].version',
    'nextCursor',
    'hasMore',
  ],
});

export const CREATE_THING = qitsOperation({
  provider: PROVIDER,
  operationId: 'createThing',
  method: 'POST',
  call: (options: CreateOptions) => current.createThing(options),
  consumes: ['id', 'name', 'version'],
  errorConsumes: ['type'],
});

export const UPDATE_THING = qitsOperation({
  provider: PROVIDER,
  operationId: 'updateThing',
  method: 'PATCH',
  call: (options: UpdateOptions) => current.updateThing(options),
  consumes: ['id', 'name', 'version'],
  errorConsumes: ['type', 'current', 'currentVersion'],
});

export const DELETE_THING = qitsOperation({
  provider: PROVIDER,
  operationId: 'deleteThing',
  method: 'DELETE',
  call: (options: DeleteOptions) => current.deleteThing(options),
  consumes: [],
  errorConsumes: ['type', 'current', 'currentVersion'],
});

/** The page under test: one record, the collection, and the three writes over both. */
@Component({ selector: 'qits-things-fixture', template: '' })
export class ThingsPage {
  readonly id = signal('t1');
  readonly thing = qitsResource(GET_THING, () => ({ path: { id: this.id() } }), {
    offline: 'cache',
  });
  readonly things = qitsResource(LIST_THINGS, () => ({}), { offline: 'cache' });
  readonly create = qitsMutation(CREATE_THING, {
    offline: 'queue',
    affects: () => [this.things],
    record: (p) => ({ change: 'create', fields: p.body }),
  });
  readonly rename = qitsMutation(UPDATE_THING, {
    offline: 'queue',
    affects: () => [this.thing, this.things],
    record: (p) => ({ change: 'update', id: p.path.id, fields: p.body }),
  });
  readonly remove = qitsMutation(DELETE_THING, {
    offline: 'queue',
    affects: () => [this.thing, this.things],
    record: (p) => ({ change: 'delete', id: p.path.id }),
  });

  /** The names in the collection, in id order. */
  names(): string[] {
    return (this.things.value()?.items ?? []).map((t) => `${t.id}:${t.name}`);
  }
}

/** The write operations, as an app lists them for `provideQitsOffline`. */
export const WRITES = [CREATE_THING, UPDATE_THING, DELETE_THING];

/** Waits until Angular has nothing pending: loads, store writes, outbox sends. */
export async function settle(): Promise<void> {
  await TestBed.inject(ApplicationRef).whenStable();
}

/** Switches the network: the backend's calls, `navigator.onLine`, and the window event. */
export function network(online: boolean): void {
  current.online = online;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  window.dispatchEvent(new Event(online ? 'online' : 'offline'));
}

/** A fresh backend, a fresh IndexedDB, the network on. Call it in `beforeEach`. */
export function resetWorld(): FakeBackend {
  current = new FakeBackend();
  globalThis.indexedDB = new IDBFactory();
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  return current;
}

/** What {@link boot} takes. */
export interface BootOptions {
  /** False boots without `provideQitsOffline`. */
  readonly offline?: boolean;
  /** `provideQitsOffline`'s options over the fixture's defaults (user `alice`, the writes). */
  readonly options?: Partial<QitsOfflineOptions>;
  readonly providers?: Provider[];
  /** False configures the testing module and creates no page. */
  readonly page?: boolean;
}

/** Configures the testing module and creates the page; it does not wait for the first load. */
export function boot(options: BootOptions = {}) {
  const offline = options.offline !== false;
  TestBed.configureTestingModule({
    providers: [
      ...(offline
        ? [
            provideQitsOffline({
              project: 'fixture',
              user: () => 'alice',
              operations: WRITES,
              ...options.options,
            }),
          ]
        : []),
      ...(options.providers ?? []),
    ],
  });
  const fixture = options.page === false ? undefined : TestBed.createComponent(ThingsPage);
  return {
    page: fixture?.componentInstance as ThingsPage,
    offline: offline ? TestBed.inject(QitsOffline) : (undefined as unknown as QitsOffline),
  };
}

/** A page reload: the app is torn down; IndexedDB and the backend stay. Boot again after it. */
export function reloadPage(): void {
  TestBed.resetTestingModule();
}

/** The names of the IndexedDB databases that exist now. */
export async function databases(): Promise<string[]> {
  return (await indexedDB.databases()).map((db) => db.name ?? '');
}
