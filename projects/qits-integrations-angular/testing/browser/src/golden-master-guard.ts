/**
 * The golden-master guard (epic qits-112): a browser spec shows backend data from golden masters
 * only, and the run fails when it shows anything else. Only the specs of UI components (by default
 * those under `src/app/ui/`) may use synthetic data.
 *
 * - {@link recorded} (or a reader wrapped with {@link fromGoldenMasters}) deep-freezes a golden
 *   master body and registers it, and every object and array inside it, as a recording.
 * - {@link guardGoldenMasters} makes `TestRequest.flush` (and `event`) refuse a 2xx answer whose
 *   body is not a recording: a literal, a spread copy, a `slice()` or a `map()` all fail. A part of
 *   a recording (`list.entries`) passes, because it was registered with the whole.
 * - A recording is frozen, so changing it in place throws (specs are ES modules, so strict mode).
 *   A spec cannot take a recording and make it say something else.
 * - A text body (ticket qits-2058; an `.html` or `.txt` file a request with `responseType: 'text'`
 *   reads) is registered with {@link recordedText} (or a reader wrapped with
 *   {@link fromGoldenMasterTexts}) by its VALUE: a string has no identity, so a string equal to a
 *   recorded text passes, and any other string is refused.
 *
 * Every error says how to fix it: when no recorded state fits, add one to the provider and a pact
 * interaction for it, so the provider verifies what the spec shows.
 *
 * Identity is set up here, in the browser: a Vitest browser command runs on the Node side and sends
 * JSON, so every call gives a new object. Wrap the command, never the Node-side reader.
 *
 * The guard also notes which route each recorded answer was shown on (ticket qits-1946): a flush of
 * a recording whose source names provider, state and operation, while the TestBed's router has
 * matched a route, is a {@link RouteRecord}. {@link takeRouteRecords} hands them to the Node side
 * (`goldenMasterRoutes` in `@qits/angular/testing`), which keeps them in a ledger the pact specs
 * read, so each interaction names the routes it happens on. A route belongs to the spec file that
 * noted it (ticket qits-2056): the guard forgets them when a file starts, and a file sends only its
 * own.
 *
 * Beside those, it keeps the recorded answers of the current test, router or not (ticket
 * qits-1947): {@link currentTestRecords}, which a screenshot freeze names as what the shot shows.
 */
import { HttpEventType, type HttpEvent } from '@angular/common/http';
import { TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ROUTES, Router } from '@angular/router';
import { matchedRoutePath } from '@qits/angular';
import { beforeAll, expect } from 'vitest';

/** Where a recording came from, as far as the reader knows; it makes error messages exact. */
export interface RecordingSource {
  /** The provider's repository name, such as `qits-projects-service`. */
  readonly provider?: string;
  readonly state?: string;
  readonly operationId?: string;
}

const recordings = new WeakMap<object, RecordingSource>();

/**
 * The recorded text bodies (ticket qits-2058), by value: a primitive has no identity to hold in the
 * `WeakMap`, so the string itself is the key. The last registration of a text names its source.
 */
const textRecordings = new Map<string, RecordingSource>();

/** A browser spec file. Its data must come from golden masters, unless it is a UI component's. */
export const BROWSER_SPECS = /\.browser\.spec\.[cm]?[jt]sx?$/;

/** Browser specs that may use synthetic data: the UI components. As the lint rule's default. */
export const DEFAULT_SYNTHETIC_ALLOWED: readonly string[] = ['src/app/ui/**'];

/**
 * A glob (`**`, `*`, `?`) as a regex that matches a path ending in it at a segment boundary, so
 * `src/app/ui/**` matches `/home/me/app/src/app/ui/card.browser.spec.ts`.
 */
function globTail(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out += '(?:.*/)?';
      } else {
        out += '.*';
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(?:^|/)${out}$`);
}

/**
 * Whether the spec at `file` must take its backend data from golden masters: a browser spec that
 * no glob in `syntheticAllowed` matches. A glob matches the end of the path at a `/`, so a
 * project-relative glob works on an absolute path.
 */
export function goldenMastersRequired(
  file: string,
  syntheticAllowed: readonly string[] = DEFAULT_SYNTHETIC_ALLOWED,
): boolean {
  const path = file.split('\\').join('/');
  return BROWSER_SPECS.test(path) && !syntheticAllowed.some((glob) => globTail(glob).test(path));
}

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
 * Only objects and arrays can be recordings here: a bare string, number or boolean throws. A text
 * body (a string) is registered with {@link recordedText} instead.
 */
export function recorded<T>(body: T, source: RecordingSource = {}): T {
  if (body === null || typeof body !== 'object') {
    throw new TypeError(
      `golden-master guard: only a JSON object or array can be a recording, not ${describe(body)}. ` +
        'Pass the whole JSON body a golden master holds, as the reader gave it. For a text body ' +
        "(a request with responseType: 'text'), register the string with recordedText(…) or wrap " +
        'the text reader with fromGoldenMasterTexts(…).',
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

/**
 * Registers `text`, a golden master's text body (ticket qits-2058: a recorded `.html` or `.txt` file,
 * for a request with `responseType: 'text'`), as a recording and returns it unchanged. `source`
 * names where it came from, for error messages and route records.
 *
 * A string is a primitive and has no identity, so it is registered by VALUE: from then on, any
 * string equal to it counts as recorded, and every other string is refused. That is weaker than an
 * object recording (a spec that types out the recorded text passes), but a string the provider never
 * recorded still fails. `''` may be registered, yet the guard still treats it as an empty answer.
 * Anything but a string throws: a JSON body is registered with {@link recorded}.
 */
export function recordedText(text: string, source: RecordingSource = {}): string {
  if (typeof text !== 'string') {
    throw new TypeError(
      `golden-master guard: only a string can be a text recording, not ${describe(text)}. Pass ` +
        'the text body a golden master holds, as the text reader gave it; a JSON body is ' +
        'registered with recorded(…) or fromGoldenMasters(…).',
    );
  }
  textRecordings.set(text, source);
  return text;
}

/**
 * Whether `value` is a recording, or an object or array inside one, or a string equal to a recorded
 * text ({@link recordedText}; by value, as a string has no identity).
 */
export function isRecorded(value: unknown): boolean {
  if (typeof value === 'string') return textRecordings.has(value);
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
 * `value`, when it is a recording (or a string equal to a recorded text); throws otherwise. For
 * data that reaches a page by another way than HTTP, such as an event a fake event stream sends:
 * `send(assertRecorded(payload, 'event'))`.
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

/**
 * The text twin of {@link fromGoldenMasters} (ticket qits-2058): `read` (a golden master text
 * reader, such as a Vitest browser command calling `goldenMasters(…).text(…)` on the Node side),
 * with every text it gives registered with {@link recordedText}. A reader that gives anything but a
 * string throws. Flush the text as it is, to a request with `responseType: 'text'`:
 *
 *   export const goldenMasterText = fromGoldenMasterTexts(
 *     (state: string, operationId: string) => commands.goldenMasterText(state, operationId),
 *     (state, operationId) => ({ provider: 'qits-docs-service', state, operationId }),
 *   );
 *
 * A text is registered by value, so a string equal to a recorded one passes the guard too.
 */
export function fromGoldenMasterTexts<A extends unknown[]>(
  read: (...args: A) => unknown,
  source?: (...args: A) => RecordingSource,
): (...args: A) => Promise<string> {
  return async (...args: A) => recordedText((await read(...args)) as string, source?.(...args));
}

/** Options for {@link guardGoldenMasters}. */
export interface GoldenMasterGuardOptions {
  /**
   * Whether the guard checks the running test. Default: when the running test file (Vitest's
   * `expect.getState().testPath`, with globals on) is a browser spec that `syntheticAllowed` does
   * not name ({@link goldenMastersRequired}), and always when the test file is not known.
   */
  readonly when?: () => boolean;
  /**
   * Globs for the browser specs that may use synthetic data, relative to the project root (as the
   * lint rule's option of the same name). Default {@link DEFAULT_SYNTHETIC_ALLOWED},
   * `['src/app/ui/**']`. Ignored when `when` is given.
   */
  readonly syntheticAllowed?: readonly string[];
}

/** The current test file, from Vitest's global `expect`; undefined without one. */
function testFile(): string | undefined {
  const expect = (globalThis as { expect?: { getState?: () => { testPath?: string } } }).expect;
  return expect?.getState?.().testPath;
}

const requiredFor = (syntheticAllowed?: readonly string[]) => (): boolean => {
  const file = testFile();
  return file === undefined || goldenMastersRequired(file, syntheticAllowed);
};

let uninstall: (() => void) | undefined;

/** Whether the installed guard checks the running test; undefined without a guard. */
let guardWhen: (() => boolean) | undefined;

/**
 * Makes `TestRequest.flush` and `TestRequest.event` refuse backend data that is not a recording.
 * Call it once in the browser specs' setup file. Returns a function that removes the guard. It also
 * forgets the routes noted so far in a `beforeAll` ({@link clearRouteRecords}), so every spec file
 * starts with none (ticket qits-2056): the spec files share one page, and a route an earlier file
 * left behind must not reach this one's ledger section.
 *
 * - A 2xx answer must carry a recording (or a part of one), or a string equal to a recorded text
 *   ({@link recordedText}, ticket qits-2058).
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
  const when = options.when ?? requiredFor(options.syntheticAllowed);
  guardWhen = when;
  const proto = TestRequest.prototype;
  const flush = proto.flush;
  const event = proto.event;
  beforeAll(() => clearRouteRecords());

  proto.flush = function (this: TestRequest, body, opts = {}) {
    if (when()) checkAnswer(this, body, opts.status);
    noteRoute(body, opts.status);
    return flush.call(this, body, opts);
  };
  proto.event = function (this: TestRequest, sent: HttpEvent<unknown>) {
    if (when()) checkEvent(this, sent);
    if (sent.type === HttpEventType.Response) noteRoute(sent.body, sent.status);
    return event.call(this, sent);
  };

  const remove = () => {
    proto.flush = flush;
    proto.event = event;
    if (uninstall === remove) {
      uninstall = undefined;
      guardWhen = undefined;
    }
  };
  return (uninstall = remove);
}

/**
 * Data a page shows by another way than a 2xx `flush` (ticket qits-2151: an answer seeded into the
 * offline store, the record a 412 conflict carries) is held to the guard's rule and noted as a
 * flushed answer is: refused with the guard's message when it is not a recording and the running
 * test is checked (the installed guard's `when`, or {@link goldenMastersRequired} without one), and
 * otherwise added to the current test's records and the route's. For `@qits/angular/testing/browser`
 * itself; `what` names the data in the message.
 */
export function ɵnoteShownRecording(value: unknown, what: string): void {
  if ((guardWhen ?? requiredFor())()) assertRecorded(value, what);
  noteRoute(value, 200);
}

/**
 * One recorded answer shown on one route: the route pattern the router matched (`matchedRoutePath`
 * from `@qits/angular`, as `app.route.path` names it), such as `projects/:slug/repositories`.
 */
export interface RouteRecord {
  /** The provider's repository name, as the recording's source names it. */
  readonly provider: string;
  readonly state: string;
  readonly operationId: string;
  readonly route: string;
}

/** A noted route and the spec file it was noted in (ticket qits-2056); undefined outside one. */
interface NotedRoute {
  readonly record: RouteRecord;
  readonly testPath: string | undefined;
}

/** By spec file and record, so one noted in two files is two entries. */
const routeRecords = new Map<string, NotedRoute>();

const recordKey = (r: RouteRecord) => [r.provider, r.state, r.operationId, r.route].join('\u0000');

/**
 * The running spec file, from the `expect` Vitest exports, so it is known with globals off too;
 * undefined outside one.
 */
function runningFile(): string | undefined {
  return expect.getState().testPath;
}

/**
 * Notes the route a 2xx answer carrying a recording, or a recorded text (ticket qits-2058), is shown
 * on. Whether the guard checks the test makes no difference; nothing is noted for an answer without a
 * body (a 204), a body that is not a recording, a source that does not name provider, state and
 * operation, or a TestBed without a router that has matched a route.
 */
function noteRoute(body: unknown, status: number | undefined): void {
  if (status !== undefined && (status < 200 || status >= 300)) return;
  const source =
    typeof body === 'string'
      ? body === ''
        ? undefined
        : textRecordings.get(body)
      : body !== null && typeof body === 'object'
        ? recordings.get(body)
        : undefined;
  if (!source?.provider || !source.state || !source.operationId) return;
  const shown: TestRecord = {
    provider: source.provider,
    state: source.state,
    operationId: source.operationId,
  };
  testRecords.set(testRecordKey(shown), shown);
  const route = currentRoute();
  if (!route) return;
  const record: RouteRecord = {
    provider: source.provider,
    state: source.state,
    operationId: source.operationId,
    route,
  };
  const testPath = runningFile();
  routeRecords.set(`${testPath ?? ''}\u0000${recordKey(record)}`, { record, testPath });
}

/**
 * One recorded answer the current test showed, with or without a router (ticket qits-1947): what a
 * screenshot taken now shows, as {@link currentTestRecords} lists it.
 */
export interface TestRecord {
  /** The provider's repository name, as the recording's source names it. */
  readonly provider: string;
  readonly state: string;
  readonly operationId: string;
}

const testRecords = new Map<string, TestRecord>();

const testRecordKey = (r: TestRecord) => [r.provider, r.state, r.operationId].join('\u0000');

/**
 * The recorded answers flushed since the current test started (or since {@link clearTestRecords}),
 * sorted and without duplicates: the same answers {@link takeRouteRecords} notes, but per test and
 * whether or not a router matched a route. It does not forget them; `freezeScreenshots()` clears
 * them before every test.
 */
export function currentTestRecords(): TestRecord[] {
  return [...testRecords.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, record]) => record);
}

/** Forgets the current test's recorded answers. `freezeScreenshots()` calls it before every test. */
export function clearTestRecords(): void {
  testRecords.clear();
}

/**
 * The route pattern the TestBed's router has matched (`matchedRoutePath`, as a {@link RouteRecord}
 * names it), or `null` without a router or a matched route.
 */
export function currentRoutePattern(): string | null {
  return currentRoute() ?? null;
}

/**
 * The route pattern the TestBed's router has matched; undefined without one. `ROUTES` is asked
 * first because `Router` is `providedIn: 'root'`: injecting it would make a router for a spec that
 * has none.
 */
function currentRoute(): string | undefined {
  try {
    if (!TestBed.inject(ROUTES, null)) return undefined;
    const router = TestBed.inject(Router, null);
    return router ? matchedRoutePath(router.routerState.snapshot) || undefined : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The routes the running spec file noted since the last call (or {@link clearRouteRecords}),
 * sorted and without duplicates, and forgets them. Call it in the browser specs' setup file, after
 * each spec file, and send the list to the Node side:
 * `afterAll(() => commands.goldenMasterRoutes(takeRouteRecords()))`. The command only stages the
 * list; the ledger is written at the end of the run, and only for the spec files that ran
 * completely, by the reporter `goldenMasterRoutes(...).plugin` adds, so put that plugin in the
 * Vitest config's `plugins`.
 *
 * Every route is stamped with the spec file it was noted in (ticket qits-2056). One noted in
 * another file, or outside any, is not this file's to send: it is dropped, and a `console.warn`
 * names the file it was noted in and the record.
 */
export function takeRouteRecords(): RouteRecord[] {
  const file = runningFile();
  const out = new Map<string, RouteRecord>();
  for (const { record, testPath } of routeRecords.values()) {
    if (testPath !== undefined && testPath === file) {
      out.set(recordKey(record), record);
      continue;
    }
    console.warn(
      `golden-master guard: dropped a route noted in ${testPath ?? 'no spec file'}, not in ` +
        `${file ?? 'a spec file'}: ${record.provider} '${record.state}' / ${record.operationId} ` +
        `on ${record.route}. Only the spec file that noted a route sends it to the route ledger.`,
    );
  }
  routeRecords.clear();
  return [...out.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, record]) => record);
}

/**
 * Forgets the routes noted so far. {@link guardGoldenMasters} calls it in a `beforeAll`, so each
 * spec file starts with none.
 */
export function clearRouteRecords(): void {
  routeRecords.clear();
}

function checkAnswer(request: TestRequest, body: unknown, status: number | undefined): void {
  if (status !== undefined && (status < 200 || status >= 300)) return;
  const empty = body === null || body === undefined || body === '';
  if (empty && status === 204) return;
  // A recorded text passes by value (ticket qits-2058); `''` stays an empty answer, registered or not.
  if (!empty && isRecorded(body)) return;
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
      '(A browser spec shows backend data from golden masters only; only UI components may use ' +
      'synthetic data.)',
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return value === '' ? 'an empty string' : 'a string';
  return `a ${typeof value}`;
}
