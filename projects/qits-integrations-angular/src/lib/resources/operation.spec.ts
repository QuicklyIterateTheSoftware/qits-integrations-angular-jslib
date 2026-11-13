import { NOTHING, type Consumed } from '../consume';
import { qitsOperation, type QitsOperation } from './operation';

interface Agent {
  id: string;
  name?: string;
  secret?: string;
}
interface Problem {
  title?: string;
  detail?: string;
}
type Answer<T> = ({ data: T; error: undefined } | { data: undefined; error: Problem }) & {
  response: { status: number };
};
interface ListOptions {
  path: { project: string };
  headers?: Record<string, string>;
}

/** Shaped like a hey-api generated function: generic over `ThrowOnError`, never throws by default. */
function listAgents<ThrowOnError extends boolean = false>(
  options: ListOptions & { throwOnError?: ThrowOnError },
): Promise<ThrowOnError extends true ? { data: Agent[] } : Answer<Agent[]>> {
  void options;
  return Promise.resolve({
    data: [{ id: 'a1', name: 'one', secret: 's' }],
    error: undefined,
    response: { status: 200 },
  } as never);
}

describe('qitsOperation', () => {
  it('declares a frozen read operation with its identity', () => {
    const op = qitsOperation({
      provider: 'qits-agents-service',
      operationId: 'listAgents',
      method: 'GET',
      call: listAgents,
      consumes: ['[].id'],
    });
    expect(Object.isFrozen(op)).toBe(true);
    expect(op).toMatchObject({
      provider: 'qits-agents-service',
      operationId: 'listAgents',
      method: 'GET',
      kind: 'read',
      consumes: ['[].id'],
      errorConsumes: NOTHING,
    });
    expectTypeOf(op.kind).toEqualTypeOf<'read'>();
    expectTypeOf(op.method).toEqualTypeOf<'GET'>();
  });

  it('calls a write anything but GET', () => {
    const op = qitsOperation({
      provider: 'p',
      operationId: 'o',
      method: 'POST',
      call: listAgents,
      consumes: NOTHING,
    });
    expect(op.kind).toBe('write');
    expectTypeOf(op.kind).toEqualTypeOf<'write'>();
  });

  it('narrows the value as consume() does, and the error to errorConsumes', async () => {
    const op = qitsOperation({
      provider: 'p',
      operationId: 'o',
      method: 'GET',
      call: listAgents,
      consumes: ['[].name'],
      errorConsumes: ['title'],
    });
    expectTypeOf(op).toEqualTypeOf<
      QitsOperation<
        ListOptions & { throwOnError?: boolean },
        Consumed<Agent[], ['[].name']>,
        'read',
        Consumed<Problem, ['title']>,
        'GET'
      >
    >();
    const answer = await op.fetch({ path: { project: 'qits' } });
    expect(answer.data?.[0].name).toBe('one');
    // @ts-expect-error -- secret is not consumed
    void answer.data?.[0].secret;
    void answer.error?.title;
    // @ts-expect-error -- detail is not consumed
    void answer.error?.detail;
  });
});
