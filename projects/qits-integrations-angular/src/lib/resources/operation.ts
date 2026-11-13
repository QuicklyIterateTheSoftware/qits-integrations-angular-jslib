import { consume, NOTHING, type ConsumedPaths, type Narrowed } from '../consume';

/**
 * One backend operation, declared once (ticket qits-2145): which provider answers it, its
 * operationId, its method, the generated client function that calls it, and the body paths the
 * app reads from it. {@link qitsResource} reads through a `'read'` operation and
 * {@link qitsMutation} writes through a `'write'` one; the compiler refuses the other way round.
 */

/** The HTTP methods a generated client function can call. */
export type QitsHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A `GET` reads; every other method writes. */
export type QitsOperationKind<M extends QitsHttpMethod> = M extends 'GET' ? 'read' : 'write';

/** What names an operation: enough to find it in the provider's OpenAPI document. */
export interface QitsOperationIdentity {
  /** The provider repository, e.g. `qits-workspaces-service`. */
  readonly provider: string;
  readonly operationId: string;
  readonly method: QitsHttpMethod;
}

/**
 * An answer narrowed the way {@link consume} narrows it, flattened to one shape. A generated client
 * does not throw on an error answer: `error` holds the body and `response` the status.
 */
export interface QitsAnswer<Value, Err> {
  readonly data?: Value;
  readonly error?: Err;
  readonly response?: { readonly status: number };
}

/**
 * An operation: `Params` is the generated function's options, `Value` its `data` narrowed to
 * `consumes`, `Err` its `error` narrowed to `errorConsumes`, `Method` the literal method. `Kind` is
 * in the type so that a read and a write cannot be swapped.
 */
export interface QitsOperation<
  Params,
  Value,
  Kind extends 'read' | 'write',
  Err = unknown,
  Method extends QitsHttpMethod = QitsHttpMethod,
> extends QitsOperationIdentity {
  readonly method: Method;
  readonly kind: Kind;
  readonly consumes: ConsumedPaths;
  readonly errorConsumes: ConsumedPaths;
  /** Calls the generated function through {@link consume} with this operation's paths. */
  fetch(params: Params): Promise<QitsAnswer<Value, Err>>;
}

/** Any generated client function: one options argument, a Promise of the answer. */
type ClientCall = (options: never) => Promise<unknown>;

/** The first argument of `Fn`, without the `undefined` an all-optional options type adds. */
type ParamsOf<Fn extends ClientCall> = NonNullable<Parameters<Fn>[0]>;

type DataOf<N> = N extends { data: infer D } ? D : never;
type ErrorOf<N> = N extends { error: infer X } ? X : never;

/** `data` of the call's answer, narrowed to `P` exactly as {@link consume} narrows it. */
export type QitsOperationValue<
  Fn extends ClientCall,
  P extends ConsumedPaths,
  E extends ConsumedPaths = typeof NOTHING,
> = Exclude<DataOf<Narrowed<Awaited<ReturnType<Fn>>, P, E>>, undefined>;

/** `error` of the call's answer, narrowed to `E`. */
export type QitsOperationError<
  Fn extends ClientCall,
  P extends ConsumedPaths,
  E extends ConsumedPaths = typeof NOTHING,
> = Exclude<ErrorOf<Narrowed<Awaited<ReturnType<Fn>>, P, E>>, undefined>;

/** The arguments of {@link qitsOperation}. */
export interface QitsOperationSpec<
  Fn extends ClientCall,
  M extends QitsHttpMethod,
  P extends ConsumedPaths,
  E extends ConsumedPaths,
> {
  readonly provider: string;
  readonly operationId: string;
  readonly method: M;
  /** The generated client function, e.g. `listAgents`. */
  readonly call: Fn;
  /** The body paths the app reads, as {@link consume} takes them. */
  readonly consumes: P;
  /** The error body paths the app reads; nothing by default. */
  readonly errorConsumes?: E;
}

/**
 * Declares an operation. The result is frozen: it is a declaration, shared by every resource and
 * mutation built on it.
 */
export function qitsOperation<
  Fn extends ClientCall,
  const M extends QitsHttpMethod,
  const P extends ConsumedPaths,
  const E extends ConsumedPaths = typeof NOTHING,
>(
  spec: QitsOperationSpec<Fn, M, P, E>,
): QitsOperation<
  ParamsOf<Fn>,
  QitsOperationValue<Fn, P, E>,
  QitsOperationKind<M>,
  QitsOperationError<Fn, P, E>,
  M
> {
  const { provider, operationId, method, call, consumes } = spec;
  const errorConsumes = spec.errorConsumes ?? NOTHING;
  return Object.freeze({
    provider,
    operationId,
    method,
    kind: (method === 'GET' ? 'read' : 'write') as QitsOperationKind<M>,
    consumes,
    errorConsumes,
    fetch: (params: ParamsOf<Fn>) =>
      consume(call(params as never), consumes, errorConsumes) as Promise<
        QitsAnswer<QitsOperationValue<Fn, P, E>, QitsOperationError<Fn, P, E>>
      >,
  });
}

/** The identity of `op`, without its functions: what a resource or a mutation exposes. */
export function identityOf(op: QitsOperationIdentity): QitsOperationIdentity {
  return Object.freeze({
    provider: op.provider,
    operationId: op.operationId,
    method: op.method,
  });
}
