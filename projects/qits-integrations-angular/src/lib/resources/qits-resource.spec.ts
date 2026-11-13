import { ApplicationRef, Injector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { collectCaptureState, resetCaptureStateForTesting } from '../capture-state';
import type { Consumed } from '../consume';
import { QitsApiError } from './api-error';
import { QITS_DOMAIN_EVENTS, REFRESH_DEBOUNCE_MS, type QitsDomainEvent } from './domain-events';
import { qitsOperation } from './operation';
import { qitsResource } from './qits-resource';

interface Agent {
  id: string;
  name?: string;
  secret?: string;
}
type Answer =
  | { data: Agent; error: undefined; response: { status: number } }
  | { data: undefined; error: { title?: string }; response: { status: number } };

const ok = (agent: Agent): Answer => ({ data: agent, error: undefined, response: { status: 200 } });
const fail = (status: number): Answer => ({
  data: undefined,
  error: { title: `failed ${status}` },
  response: { status },
});

const backend = vi.fn<(options: { path: { id: string } }) => Promise<Answer>>();
const getAgent = (options: { path: { id: string } }) => backend(options);

const read = qitsOperation({
  provider: 'qits-agents-service',
  operationId: 'getAgent',
  method: 'GET',
  call: getAgent,
  consumes: ['name'],
  errorConsumes: ['title'],
});
const write = qitsOperation({
  provider: 'qits-agents-service',
  operationId: 'renameAgent',
  method: 'PUT',
  call: getAgent,
  consumes: ['name'],
});

const stable = () => TestBed.inject(ApplicationRef).whenStable();

/** Creates the resource in the testing injector, as a field initializer would. */
function create<T>(make: () => T): T {
  return TestBed.runInInjectionContext(make);
}

describe('qitsResource', () => {
  beforeEach(() => {
    backend.mockReset();
    resetCaptureStateForTesting();
  });

  afterEach(() => vi.useRealTimers());

  it('stays idle while the params are undefined', async () => {
    const ref = create(() => qitsResource(read, () => undefined));
    await stable();
    expect(ref.status()).toBe('idle');
    expect(ref.qitsStatus()).toBe('idle');
    expect(backend).not.toHaveBeenCalled();
  });

  it('loads through the operation and resolves to the narrowed data', async () => {
    backend.mockResolvedValue(ok({ id: 'a1', name: 'one', secret: 's' }));
    const ref = create(() => qitsResource(read, () => ({ path: { id: 'a1' } })));
    await stable();
    expect(backend).toHaveBeenCalledWith({ path: { id: 'a1' } });
    expect(ref.status()).toBe('resolved');
    expect(ref.qitsStatus()).toBe('resolved');
    expect(ref.value()?.name).toBe('one');
    expect(ref.cachedAt()).toBeUndefined();
    expectTypeOf(ref.value()).toEqualTypeOf<Consumed<Agent, ['name']> | undefined>();
    // @ts-expect-error -- secret is not consumed
    void ref.value()?.secret;
  });

  it('names its operation', () => {
    const ref = create(() => qitsResource(read, () => undefined));
    expect(ref.operation).toEqual({
      provider: 'qits-agents-service',
      operationId: 'getAgent',
      method: 'GET',
    });
  });

  it('refuses a write operation', () => {
    // @ts-expect-error -- a resource reads; a PUT is a mutation
    void (() => qitsResource(write, () => undefined));
  });

  it('turns an error answer into a QitsApiError carrying the status and the error', async () => {
    backend.mockResolvedValue(fail(500));
    const ref = create(() => qitsResource(read, () => ({ path: { id: 'a1' } })));
    await stable();
    expect(ref.status()).toBe('error');
    const error = ref.error();
    expect(error).toBeInstanceOf(QitsApiError);
    expect(error).toMatchObject({
      status: 500,
      error: { title: 'failed 500' },
      operation: { provider: 'qits-agents-service', operationId: 'getAgent', method: 'GET' },
      message: 'qits-agents-service#getAgent answered 500',
    });
  });

  it('keeps the value when a reload fails, and says why', async () => {
    backend.mockResolvedValueOnce(ok({ id: 'a1', name: 'one' }));
    const ref = create(() => qitsResource(read, () => ({ path: { id: 'a1' } })));
    await stable();

    backend.mockResolvedValueOnce(fail(503));
    expect(ref.reload()).toBe(true);
    await stable();
    expect(ref.status()).toBe('resolved');
    expect(ref.value()?.name).toBe('one');
    expect(ref.reloadError()).toMatchObject({ status: 503 });

    backend.mockResolvedValueOnce(ok({ id: 'a1', name: 'two' }));
    ref.reload();
    await stable();
    expect(ref.value()?.name).toBe('two');
    expect(ref.reloadError()).toBeUndefined();
  });

  it('keeps the value when a reload fails on the network', async () => {
    backend.mockResolvedValueOnce(ok({ id: 'a1', name: 'one' }));
    const ref = create(() => qitsResource(read, () => ({ path: { id: 'a1' } })));
    await stable();
    const offline = new TypeError('Failed to fetch');
    backend.mockRejectedValueOnce(offline);
    ref.reload();
    await stable();
    expect(ref.value()?.name).toBe('one');
    expect(ref.reloadError()).toBe(offline);
  });

  it('fails a reload that answers 404: the thing is gone', async () => {
    backend.mockResolvedValueOnce(ok({ id: 'a1', name: 'one' }));
    const ref = create(() => qitsResource(read, () => ({ path: { id: 'a1' } })));
    await stable();
    backend.mockResolvedValueOnce(fail(404));
    ref.reload();
    await stable();
    expect(ref.status()).toBe('error');
    expect(ref.error()).toMatchObject({ status: 404 });
    expect(ref.reloadError()).toBeUndefined();
  });

  it('fails a load for new params: there is no value of theirs to keep', async () => {
    const id = signal('a1');
    backend.mockResolvedValueOnce(ok({ id: 'a1', name: 'one' }));
    const ref = create(() => qitsResource(read, () => ({ path: { id: id() } })));
    await stable();
    backend.mockResolvedValueOnce(fail(500));
    id.set('a2');
    await stable();
    expect(backend).toHaveBeenLastCalledWith({ path: { id: 'a2' } });
    expect(ref.status()).toBe('error');
    expect(ref.error()).toMatchObject({ status: 500 });
  });

  it('takes an injector outside an injection context', async () => {
    backend.mockResolvedValue(ok({ id: 'a1', name: 'one' }));
    expect(() => qitsResource(read, () => undefined)).toThrow();
    const ref = qitsResource(read, () => ({ path: { id: 'a1' } }), {
      injector: TestBed.inject(Injector),
    });
    await stable();
    expect(ref.value()?.name).toBe('one');
  });

  describe('refreshOn', () => {
    let events: Subject<QitsDomainEvent>;
    const on = vi.fn();

    beforeEach(() => {
      events = new Subject();
      on.mockReset().mockImplementation(() => events);
      TestBed.configureTestingModule({
        providers: [{ provide: QITS_DOMAIN_EVENTS, useValue: { on } }],
      });
    });

    function refreshing(when?: (event: QitsDomainEvent) => boolean) {
      // rxjs schedules on setInterval and measures the quiet period with Date.now().
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const ref = create(() =>
        qitsResource(read, () => undefined, {
          refreshOn: { names: ['AgentChanged', 'AgentDeleted'], when },
        }),
      );
      // The subscription calls reload() by name, so a spy sees every call.
      const reload = vi.spyOn(ref, 'reload');
      return { ref, reload };
    }

    it('subscribes once, to the names it is given', () => {
      refreshing();
      expect(on).toHaveBeenCalledTimes(1);
      expect(on).toHaveBeenCalledWith(['AgentChanged', 'AgentDeleted']);
    });

    it('reloads once per burst, after the quiet period', () => {
      const { reload } = refreshing();
      events.next({ name: 'AgentChanged' });
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS / 2);
      events.next({ name: 'AgentChanged' });
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS / 2);
      events.next({ name: 'AgentDeleted' });
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS - 1);
      expect(reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(reload).toHaveBeenCalledTimes(1);

      events.next({ name: 'AgentChanged' });
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
      expect(reload).toHaveBeenCalledTimes(2);
    });

    it('ignores the events `when` refuses', () => {
      const { reload } = refreshing((event) => event.payload === 'a1');
      events.next({ name: 'AgentChanged', payload: 'a2' });
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS * 2);
      expect(reload).not.toHaveBeenCalled();
      events.next({ name: 'AgentChanged', payload: 'a1' });
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reloads after the first load settles when an event comes during it', async () => {
      let answer!: (a: Answer) => void;
      backend.mockImplementationOnce(() => new Promise<Answer>((r) => (answer = r)));
      backend.mockResolvedValueOnce(ok({ id: 'a1', name: 'two' }));
      const ref = create(() =>
        qitsResource(read, () => ({ path: { id: 'a1' } }), {
          refreshOn: { names: ['AgentChanged'], debounceMs: 0 },
        }),
      );
      await vi.waitFor(() => expect(backend).toHaveBeenCalledTimes(1));
      expect(ref.status()).toBe('loading');
      events.next({ name: 'AgentChanged' });
      await new Promise((r) => setTimeout(r, 5));
      answer(ok({ id: 'a1', name: 'one' }));
      await vi.waitFor(() => expect(backend).toHaveBeenCalledTimes(2));
      await stable();
      expect(ref.value()?.name).toBe('two');
    });

    it('reloads again when an event comes during a reload', async () => {
      let answer!: (a: Answer) => void;
      backend.mockResolvedValueOnce(ok({ id: 'a1', name: 'one' }));
      backend.mockImplementationOnce(() => new Promise<Answer>((r) => (answer = r)));
      backend.mockResolvedValueOnce(ok({ id: 'a1', name: 'three' }));
      const ref = create(() =>
        qitsResource(read, () => ({ path: { id: 'a1' } }), {
          refreshOn: { names: ['AgentChanged'], debounceMs: 0 },
        }),
      );
      await stable();
      expect(ref.value()?.name).toBe('one');
      ref.reload();
      await vi.waitFor(() => expect(backend).toHaveBeenCalledTimes(2));
      expect(ref.status()).toBe('reloading');
      events.next({ name: 'AgentChanged' });
      await new Promise((r) => setTimeout(r, 5));
      answer(ok({ id: 'a1', name: 'two' }));
      await vi.waitFor(() => expect(backend).toHaveBeenCalledTimes(3));
      await stable();
      expect(ref.value()?.name).toBe('three');
    });

    it('unsubscribes when its injector is destroyed', () => {
      const { reload } = refreshing();
      expect(events.observed).toBe(true);
      TestBed.resetTestingModule();
      expect(events.observed).toBe(false);
      events.next({ name: 'AgentChanged' });
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
      expect(reload).not.toHaveBeenCalled();
    });
  });

  it('subscribes to nothing without refreshOn, even with events provided', () => {
    const on = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: QITS_DOMAIN_EVENTS, useValue: { on } }],
    });
    create(() => qitsResource(read, () => undefined));
    expect(on).not.toHaveBeenCalled();
  });

  it('throws at creation naming QITS_DOMAIN_EVENTS when refreshOn has none', () => {
    expect(() =>
      create(() => qitsResource(read, () => undefined, { refreshOn: { names: ['AgentChanged'] } })),
    ).toThrow(/QITS_DOMAIN_EVENTS/);
  });

  describe('captureAs', () => {
    it('registers nothing by default', () => {
      create(() => qitsResource(read, () => undefined));
      expect(collectCaptureState()).toBeUndefined();
    });

    it('registers the value under the operation, or the given name, until destroyed', async () => {
      backend.mockResolvedValue(ok({ id: 'a1', name: 'one' }));
      create(() => qitsResource(read, () => ({ path: { id: 'a1' } }), { captureAs: true }));
      create(() => qitsResource(read, () => ({ path: { id: 'a1' } }), { captureAs: 'agent' }));
      await stable();
      expect(collectCaptureState()).toEqual({
        'qits-agents-service#getAgent': { id: 'a1', name: 'one' },
        agent: { id: 'a1', name: 'one' },
      });
      TestBed.resetTestingModule();
      expect(collectCaptureState()).toBeUndefined();
    });
  });
});
