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
 * Every error says how to fix it: when no recorded state fits, add one to the provider and a pact
 * interaction for it, so the provider verifies what the screenshot shows.
 *
 * Identity is set up here, in the browser: a Vitest browser command runs on the Node side and sends
 * JSON, so every call gives a new object. Wrap the command, never the Node-side reader.
 */
import { HttpEventType, type HttpEvent } from '@angular/common/http';
import { TestRequest } from '@angular/common/http/testing';

/** Where a recording came from, as far as the reader knows; it makes error messages exact. */
export interface RecordingSource {
  /** The provider's repository name, such as `qits-projects-service`. */
  readonly provider?: string;
  readonly state?: string;
  readonly operationId?: string;
}

const recordings = new WeakMap<object, RecordingSource>();

/** A spec file whose data must come from golden masters: a page's or a layout's screenshots. */
export const PAGE_AND_LAYOUT_SPECS = /\.(page|layout)\.browser\.spec\.[cm]?[jt]sx?$/;

/**
 * The fix for data no recording holds. `provider` and `operationId` are named when known, and left
 * as placeholders when not.
 */
export function goldenMasterAdvice(source: RecordingSource = {}): string {
  const provider = source.provider ?? '<provider repository>';
  const op = source.operationId ?? '<operationId>';
  return (
    `If no recorded state fits this case, add a provider state to ${provider} (ProviderStates + ` +
    'golden-master recorder), record it, and add a pact interaction for it in the consumer’s pact ' +
    `spec next to the store (provider state '<new state>', operationId '${op}'), so the provider ` +
    `verifies it. Then answer with goldenMaster('<new state>', '${op}').`
  );
}

/**
 * Registers `body`, a golden master body, as a recording and returns it, deep-frozen. Every object
 * and array inside it is registered too. `source` names where it came from, for error messages.
 * Only objects and arrays can be recordings: a bare string, number or boolean throws.
 */
export function recorded<T>(body: T, source: RecordingSource = {}): T {
  if (body === null || typeof body !== 'object') {
    throw new TypeError(
      `golden-master guard: only a JSON object or array can be a recording, not ${describe(body)}. ` +
        'Pass the whole JSON body a golden master holds, as the reader gave it.',
    );
  }
  register(body, source);
  return body;
}

function register(value: object, source: RecordingSource): void {
  if (recordings.has(value)) return;
  recordings.set(value, source);
  for (const key of Reflect.ownKeys(value)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child !== null && typeof child === 'object') register(child, source);
  }
  Object.freeze(value);
}

/** Whether `value` is a recording, or an object or array inside one. */
export function isRecorded(value: unknown): boolean {
  return value !== null && typeof value === 'object' && recordings.has(value);
}

/**
 * The source of the first recording found in `value` (a copy of a recording keeps the recorded
 * objects inside it), searched breadth-first over at most 1000 objects; `{}` when there is none.
 */
function sourceIn(value: unknown): RecordingSource {
  const queue: unknown[] = [value];
  for (let seen = 0; queue.length && seen < 1000; seen++) {
    const next = queue.shift();
    if (next === null || typeof next !== 'object') continue;
    const source = recordings.get(next);
    if (source) return source;
    queue.push(...Object.values(next));
  }
  return {};
}

/** `(copied from '<state>' / <operationId> of <provider>)`, when a copy says where it came from. */
function copiedFrom(source: RecordingSource): string {
  if (!source.state && !source.operationId) return '';
  const what = [source.state && `'${source.state}'`, source.operationId]
    .filter(Boolean)
    .join(' / ');
  return `, copied from ${what}${source.provider ? ` of ${source.provider}` : ''}`;
}

/**
 * `value`, when it is a recording; throws otherwise. For data that reaches a page by another way
 * than HTTP, such as an event a fake event stream sends: `send(assertRecorded(payload, 'event'))`.
 */
export function assertRecorded<T>(value: T, what = 'value'): T {
  if (!isRecorded(value)) {
    const source = sourceIn(value);
    throw new Error(
      `golden-master guard: the ${what} is not a golden master recording (${describe(value)}` +
        `${copiedFrom(source)}). Take it as it is from a body goldenMaster(…) gave, or a part of ` +
        `one, never a literal, a copy or a spread. ${goldenMasterAdvice(source)}`,
    );
  }
  return value;
}

/**
 * `read` (a golden master reader, such as the `goldenMaster` Vitest browser command), with every
 * body it gives registered as a recording. `source` says, from the reader's arguments, which
 * provider, state and operation a body is; the errors then name them:
 *
 *   export const goldenMaster = fromGoldenMasters(
 *     (state: string, operationId: string) => commands.goldenMaster(state, operationId),
 *     (state, operationId) => ({ provider: 'qits-projects-service', state, operationId }),
 *   );
 */
export function fromGoldenMasters<A extends unknown[]>(
  read: (...args: A) => unknown,
  source?: (...args: A) => RecordingSource,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON by default, as goldenMasters().body
): <T = any>(...args: A) => Promise<T> {
  return async <T>(...args: A) => recorded((await read(...args)) as T, source?.(...args));
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
  if (empty) {
    return fail(
      request,
      status ?? 204,
      'with no body. An empty answer is a recorded state too: record an empty state in the ' +
        "provider (for example 'no projects exist') and answer with goldenMaster('<that state>', " +
        "'<operationId>'). " +
        goldenMasterAdvice() +
        ' Only an operation that answers 204 No Content may flush nothing, and says so: ' +
        "flush(null, { status: 204, statusText: 'No Content' }).",
    );
  }
  const source = sourceIn(body);
  fail(
    request,
    status ?? 200,
    `with a body that is not a golden master recording (${describe(body)}${copiedFrom(source)}). ` +
      'Flush a body goldenMaster(…) gave, or a part of one, as it is: never a literal, a copy, a ' +
      `spread or a slice. ${goldenMasterAdvice(source)}`,
  );
}

function checkEvent(request: TestRequest, sent: HttpEvent<unknown>): void {
  const only =
    'Send only Sent, UploadProgress, ResponseHeader or DownloadProgress events without text, and ' +
    'answer with flush(<a body goldenMaster(…) gave>).';
  switch (sent.type) {
    case HttpEventType.Sent:
    case HttpEventType.UploadProgress:
    case HttpEventType.ResponseHeader:
      return;
    case HttpEventType.DownloadProgress:
      if (sent.partialText === undefined) return;
      return fail(request, 200, `with a download progress event that carries text. ${only}`);
    case HttpEventType.Response:
      return checkAnswer(request, sent.body, sent.status);
    default:
      return fail(request, 200, `with a user event, which may carry any data. ${only}`);
  }
}

function fail(request: TestRequest, status: number, why: string): never {
  const { method, urlWithParams } = request.request;
  throw new Error(
    `golden-master guard: ${method} ${urlWithParams} was answered ${status} ${why} ` +
      '(A screenshot of a page or layout shows backend data from golden masters only.)',
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return value === '' ? 'an empty string' : 'a string';
  return `a ${typeof value}`;
}
