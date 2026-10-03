/**
 * The golden-master guard (epic qits-112): a screenshot test of a page or layout shows backend data
 * from golden masters only, and the run fails when it shows anything else.
 *
 * - {@link recorded} (or a reader wrapped with {@link fromGoldenMasters}) deep-freezes a golden
 *   master body and registers it, and every object and array inside it, as a recording.
 * - {@link guardGoldenMasters} makes `TestRequest.flush` (and `event`) refuse a 2xx answer whose
 *   body is not a recording: a literal, a spread copy, a `slice()` or a `map()` all fail. A part of
 *   a recording (`list.entries`) passes, because it was registered with the whole.
 * - A recording is frozen, so changing it in place throws (specs are ES modules, so strict mode).
 *   A spec cannot take a recording and make it say something else.
 *
 * Identity is set up here, in the browser: a Vitest browser command runs on the Node side and sends
 * JSON, so every call gives a new object. Wrap the command, never the Node-side reader.
 */
import { HttpEventType, type HttpEvent } from '@angular/common/http';
import { TestRequest } from '@angular/common/http/testing';

const recordings = new WeakSet<object>();

/** A spec file whose data must come from golden masters: a page's or a layout's screenshots. */
export const PAGE_AND_LAYOUT_SPECS = /\.(page|layout)\.browser\.spec\.[cm]?[jt]sx?$/;

/**
 * Registers `body`, a golden master body, as a recording and returns it, deep-frozen. Every object
 * and array inside it is registered too. Only objects and arrays can be recordings: a recording of
 * a bare string, number or boolean throws.
 */
export function recorded<T>(body: T): T {
  if (body === null || typeof body !== 'object') {
    throw new TypeError(
      `golden-master guard: only a JSON object or array can be a recording, not ${describe(body)}`,
    );
  }
  register(body);
  return body;
}

function register(value: object): void {
  if (recordings.has(value)) return;
  recordings.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === 'object') register(child);
  }
  Object.freeze(value);
}

/** Whether `value` is a recording, or an object or array inside one. */
export function isRecorded(value: unknown): boolean {
  return value !== null && typeof value === 'object' && recordings.has(value);
}

/**
 * `value`, when it is a recording; throws otherwise. For data that reaches a page by another way
 * than HTTP, such as an event a fake event stream sends: `send(assertRecorded(payload, 'event'))`.
 */
export function assertRecorded<T>(value: T, what = 'value'): T {
  if (!isRecorded(value)) {
    throw new Error(
      `golden-master guard: the ${what} is not a golden master recording (${describe(value)}). ` +
        'Take it from a recorded body; to show other data, record a new provider state.',
    );
  }
  return value;
}

/**
 * `read` (a golden master reader, such as the `goldenMaster` Vitest browser command), with every
 * body it gives registered as a recording:
 *
 *   export const goldenMaster = fromGoldenMasters(
 *     (state: string, operationId: string) => commands.goldenMaster(state, operationId),
 *   );
 */
export function fromGoldenMasters<A extends unknown[]>(
  read: (...args: A) => unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON by default, as goldenMasters().body
): <T = any>(...args: A) => Promise<T> {
  return async <T>(...args: A) => recorded((await read(...args)) as T);
}

/** Options for {@link guardGoldenMasters}. */
export interface GoldenMasterGuardOptions {
  /**
   * Whether the guard checks the running test. Default: when the running test file (Vitest's
   * `expect.getState().testPath`, with globals on) matches {@link PAGE_AND_LAYOUT_SPECS}, and
   * always when the test file is not known.
   */
  readonly when?: () => boolean;
}

/** The current test file, from Vitest's global `expect`; undefined without one. */
function testFile(): string | undefined {
  const expect = (globalThis as { expect?: { getState?: () => { testPath?: string } } }).expect;
  return expect?.getState?.().testPath;
}

const pagesAndLayouts = (): boolean => {
  const file = testFile();
  return file === undefined || PAGE_AND_LAYOUT_SPECS.test(file);
};

let uninstall: (() => void) | undefined;

/**
 * Makes `TestRequest.flush` and `TestRequest.event` refuse backend data that is not a recording.
 * Call it once in the browser specs' setup file. Returns a function that removes the guard.
 *
 * - A 2xx answer must carry a recording (or a part of one).
 * - A 2xx answer with no body (`null`, `undefined`, `''`) fails too: an empty list is a recorded
 *   state like any other. The one exception is an operation that answers 204 No Content, and the
 *   spec says so: `flush(null, { status: 204 })`. A bare `flush(null)` (which Angular turns into
 *   a 204) fails, so an empty answer is never an accident.
 * - Any other status reaches the app as an error, not as data, and may carry any body:
 *   `flush(null, { status: 500, statusText: 'Server Error' })` is fine. So is `error(…)`.
 * - `event(…)` may send the request's progress events; an `HttpResponse` it sends is checked as
 *   `flush` checks its body, and any other event that carries data fails.
 */
export function guardGoldenMasters(options: GoldenMasterGuardOptions = {}): () => void {
  uninstall?.();
  const when = options.when ?? pagesAndLayouts;
  const proto = TestRequest.prototype;
  const flush = proto.flush;
  const event = proto.event;

  proto.flush = function (this: TestRequest, body, opts = {}) {
    if (when()) checkAnswer(this, body, opts.status);
    return flush.call(this, body, opts);
  };
  proto.event = function (this: TestRequest, sent: HttpEvent<unknown>) {
    if (when()) checkEvent(this, sent);
    return event.call(this, sent);
  };

  const remove = () => {
    proto.flush = flush;
    proto.event = event;
    if (uninstall === remove) uninstall = undefined;
  };
  return (uninstall = remove);
}

function checkAnswer(request: TestRequest, body: unknown, status: number | undefined): void {
  if (status !== undefined && (status < 200 || status >= 300)) return;
  const empty = body === null || body === undefined || body === '';
  if (empty && status === 204) return;
  if (isRecorded(body)) return;
  fail(
    request,
    status ?? (empty ? 204 : 200),
    empty
      ? 'with no body. An empty answer is a recorded state too: flush its recording. Only an ' +
          'operation that answers 204 No Content may flush nothing, and says so: ' +
          'flush(null, { status: 204 }).'
      : `with a body that is not a golden master recording (${describe(body)}). Flush a recorded ` +
          'body or a part of one, never a literal, a copy, a spread or a slice. To show other ' +
          'data, record a new provider state.',
  );
}

function checkEvent(request: TestRequest, sent: HttpEvent<unknown>): void {
  switch (sent.type) {
    case HttpEventType.Sent:
    case HttpEventType.UploadProgress:
    case HttpEventType.ResponseHeader:
      return;
    case HttpEventType.DownloadProgress:
      if (sent.partialText === undefined) return;
      return fail(request, 200, 'with a download progress event that carries text.');
    case HttpEventType.Response:
      return checkAnswer(request, sent.body, sent.status);
    default:
      return fail(request, 200, 'with a user event, which may carry any data.');
  }
}

function fail(request: TestRequest, status: number, why: string): never {
  const { method, urlWithParams } = request.request;
  throw new Error(
    `golden-master guard: ${method} ${urlWithParams} was answered ${status} ${why} ` +
      'A screenshot of a page or layout shows backend data from golden masters only.',
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return value === '' ? 'an empty string' : 'a string';
  return `a ${typeof value}`;
}
