import type { QitsAnswer, QitsOperationIdentity } from './operation';

/**
 * An error answer from a provider. The generated client hands an error back instead of throwing;
 * a resource and a mutation throw this instead, so `error()` and a rejected `run()` carry the
 * status and the narrowed error body.
 */
export class QitsApiError<Err = unknown> extends Error {
  override readonly name = 'QitsApiError';

  constructor(
    /** The HTTP status; undefined when the answer carried no response. */
    readonly status: number | undefined,
    /** The error body, narrowed to the operation's `errorConsumes`. */
    readonly error: Err | undefined,
    readonly operation: QitsOperationIdentity,
  ) {
    super(`${operation.provider}#${operation.operationId} answered ${status ?? 'no status'}`);
  }
}

/**
 * The value of an answer, or a {@link QitsApiError}: an error body, or no data with a status
 * outside 2xx, is a failure.
 */
export function answerValue<Value, Err>(
  answer: QitsAnswer<Value, Err>,
  operation: QitsOperationIdentity,
): Value | undefined {
  const status = answer.response?.status;
  const failed =
    answer.error !== undefined ||
    (answer.data === undefined && status !== undefined && (status < 200 || status > 299));
  if (failed) {
    throw new QitsApiError<Err>(status, answer.error, operation);
  }
  return answer.data;
}
