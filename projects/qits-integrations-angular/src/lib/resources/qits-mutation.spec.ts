import { HttpHeaders } from '@angular/common/http';
import { Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NOTHING } from '../consume';
import { QitsApiError } from './api-error';
import { qitsOperation } from './operation';
import { qitsMutation } from './qits-mutation';

interface Agent {
  id: string;
  name?: string;
}
type Answer =
  | { data: Agent; error: undefined; response: { status: number } }
  | { data: undefined; error: { title?: string }; response: { status: number } };
interface RenameOptions {
  path: { id: string };
  body: { name: string };
  headers?: Record<string, string> | HttpHeaders;
}

const backend = vi.fn<(options: RenameOptions) => Promise<Answer>>();
const renameAgent = (options: RenameOptions) => backend(options);

const rename = qitsOperation({
  provider: 'qits-agents-service',
  operationId: 'renameAgent',
  method: 'PATCH',
  call: renameAgent,
  consumes: ['name'],
});
const read = qitsOperation({
  provider: 'qits-agents-service',
  operationId: 'getAgent',
  method: 'GET',
  call: renameAgent,
  consumes: NOTHING,
});

const ok = (name: string): Answer => ({
  data: { id: 'a1', name },
  error: undefined,
  response: { status: 200 },
});
const conflict: Answer = { data: undefined, error: { title: 'no' }, response: { status: 409 } };
const params: RenameOptions = { path: { id: 'a1' }, body: { name: 'two' } };

const keyOf = (call: number) => {
  const headers = backend.mock.calls[call][0].headers as Record<string, string>;
  return headers['Idempotency-Key'];
};

describe('qitsMutation', () => {
  beforeEach(() => backend.mockReset());

  it('names its operation, and starts idle', () => {
    const mutation = TestBed.runInInjectionContext(() => qitsMutation(rename));
    expect(mutation.operation).toEqual({
      provider: 'qits-agents-service',
      operationId: 'renameAgent',
      method: 'PATCH',
    });
    expect(mutation.status()).toBe('idle');
  });

  it('refuses a read operation', () => {
    // @ts-expect-error -- a mutation writes; a GET is a resource
    void (() => qitsMutation(read));
  });

  it('sends an Idempotency-Key next to the headers it is given, a new one per run', async () => {
    backend.mockResolvedValue(ok('two'));
    const mutation = TestBed.runInInjectionContext(() => qitsMutation(rename));
    const value = await mutation.run({ ...params, headers: { 'X-Trace': 't' } });
    expectTypeOf(value).toEqualTypeOf<{ name?: string } | undefined>();
    expect(value).toEqual({ id: 'a1', name: 'two' });
    await mutation.run(params);

    const first = backend.mock.calls[0][0];
    expect(first.path).toEqual({ id: 'a1' });
    expect(first.body).toEqual({ name: 'two' });
    expect(first.headers).toMatchObject({ 'X-Trace': 't' });
    expect(keyOf(0)).toMatch(/^[0-9a-f-]{36}$/);
    expect(keyOf(1)).toMatch(/^[0-9a-f-]{36}$/);
    expect(keyOf(1)).not.toBe(keyOf(0));
    expect(params.headers).toBeUndefined();
    expect(mutation.status()).toBe('done');
  });

  it('adds the key to HttpHeaders too', async () => {
    backend.mockResolvedValue(ok('two'));
    const mutation = TestBed.runInInjectionContext(() => qitsMutation(rename));
    await mutation.run({ ...params, headers: new HttpHeaders({ 'X-Trace': 't' }) });
    const headers = backend.mock.calls[0][0].headers as HttpHeaders;
    expect(headers.get('X-Trace')).toBe('t');
    expect(headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reloads what it affects after a success, and not after a failure', async () => {
    const resource = { reload: vi.fn() };
    const later = { reload: vi.fn() };
    const mutation = TestBed.runInInjectionContext(() =>
      qitsMutation(rename, { affects: () => [resource, later] }),
    );

    backend.mockResolvedValueOnce(conflict);
    await expect(mutation.run(params)).rejects.toBeInstanceOf(QitsApiError);
    expect(mutation.status()).toBe('error');
    expect(mutation.error()).toMatchObject({ status: 409, error: { title: 'no' } });
    expect(resource.reload).not.toHaveBeenCalled();

    backend.mockResolvedValueOnce(ok('two'));
    await mutation.run(params);
    expect(mutation.status()).toBe('done');
    expect(mutation.error()).toBeUndefined();
    expect(resource.reload).toHaveBeenCalledTimes(1);
    expect(later.reload).toHaveBeenCalledTimes(1);
  });

  it('reports the latest run, whichever settles last', async () => {
    let settleFirst!: (answer: Answer) => void;
    backend
      .mockReturnValueOnce(new Promise((resolve) => (settleFirst = resolve)))
      .mockResolvedValueOnce(ok('two'));
    const mutation = TestBed.runInInjectionContext(() =>
      qitsMutation(rename, { injector: TestBed.inject(Injector) }),
    );
    const first = mutation.run(params);
    expect(mutation.status()).toBe('running');
    await mutation.run(params);
    expect(mutation.status()).toBe('done');
    settleFirst(conflict);
    await expect(first).rejects.toBeInstanceOf(QitsApiError);
    expect(mutation.status()).toBe('done');
  });

  it('takes an injector outside an injection context', () => {
    expect(() => qitsMutation(rename)).toThrow();
    expect(qitsMutation(rename, { injector: TestBed.inject(Injector) }).status()).toBe('idle');
  });
});
