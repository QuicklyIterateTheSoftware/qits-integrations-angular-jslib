/// <reference types="node" />
/**
 * Golden masters and consumer pacts (epic qits-546), for any consumer of any qits provider.
 *
 * A qits provider records its real answer for each (provider state, operation) and publishes the
 * tree as an npm package: `golden-masters/index.json` plus one JSON file per answer. This file:
 *
 * - reads that package from `node_modules` ({@link goldenMasters}), so plain specs can `flush(...)`
 *   a recorded answer instead of a hand-written one;
 * - adds a Pact V4 interaction for a recorded answer to a `@pact-foundation/pact` `PactV4`
 *   ({@link addGoldenInteraction}), with matchers from the index's `frozen` lists;
 * - compares the pact a run wrote with the committed one ({@link assertPactFile}; one spec's part of
 *   a file several specs write: `assertPactPart` in `pact-part.ts`).
 *
 * THE PACT BINDS ONLY WHAT THE CONSUMER READS. The golden master holds the provider's whole answer;
 * each interaction names the body paths its consumer actually reads (`consumes`), and the pact's
 * body holds those and nothing else. Every other field stays free for the provider to change.
 * `consumes: []` means the consumer relies on the status alone: the pact then has no body and no
 * `Content-Type`. An answer that is not JSON (a blob's bytes) is recorded without a body; its
 * interaction names the media type it expects (`response`), and the pact binds that `Content-Type`
 * and, given example bytes, a body of that media type.
 *
 * A call a LIBRARY makes on the consumer's behalf names the library too (`via`, written as
 * `comments.references.qits-via`); the comparison with the committed pact ignores the library's
 * version label, and refreshes it in place.
 *
 * Pacts name both sides by REPOSITORY name (`qits-landing-app`, `qits-projects-service`), so a
 * component's frontend and backend stay distinct; the committed file is
 * `pacts/<consumer>_<provider>.json`. This file knows no provider, consumer or package by name;
 * the caller passes them. It depends only on
 * Node and `@pact-foundation/pact`.
 *
 * MATCHERS COME FROM THE `frozen` LISTS, NEVER FROM A VALUE'S SHAPE:
 *
 * - `frozen.ids`: a uuid regex;
 * - `frozen.instants`: an ISO-8601 regex;
 * - `frozen.strings` and every other leaf: a type match (`number` for numbers);
 * - a leaf that is null where it was recorded: exactly `null`;
 * - `frozen.listFilteredTo`: `arrayContaining`, one variant per shape: the answer contains the
 *   state's entries, among whatever else the provider holds ("contains", never "every element");
 * - an array whose elements all share one shape: exactly the recorded number of elements, each
 *   matched against the first;
 * - any other array: `arrayContaining` as well, one variant per shape, each variant that shape's
 *   own template: the answer holds at least one element of every recorded shape, in any order.
 *
 * A SHAPE is everything a template binds apart from the values: which keys each object has, which
 * leaves are null, strings, numbers or booleans, and, recursively, every nested array's elements.
 * Elements that differ in any of these cannot share a template: "each like the first" demands the
 * first element's keys of every element (a BACK transition has no `gates`, an APPROVAL criterion's
 * `predicate` is `{}` where an ENTITY_STATUS one's is populated), and Pact has no "type or null"
 * (a PROJECT repository has no `component`). Not positional either: the provider answers some
 * lists in no guaranteed order (its recorder sorts them, and the index does not say which), so
 * matching element `[i]` against recorded element `[i]` would bind an order nobody promised.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MatchersV3, type PactV4 } from '@pact-foundation/pact';
import {
  maskViaVersions,
  reportViaRefresh,
  sortedInteractions,
  type PactInteraction,
} from './pact-compare';

/** pact-js does not export its V4 builder types; this is what `willRespondWith` returns. */
type V4InteractionWithResponse = ReturnType<
  ReturnType<ReturnType<PactV4['addInteraction']>['withRequest']>['willRespondWith']
>;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** One recorded (state, operation), as the index describes it. */
export interface GoldenOperation {
  readonly state: string;
  readonly params: Readonly<Record<string, string>>;
  readonly operationId: string;
  readonly method: string;
  /** The path template, with `{param}` keys of `params`. */
  readonly path: string;
  /** The query the recording was made with (`?limit=20`); empty when it had none. */
  readonly query: Readonly<Record<string, string>>;
  /** The JSON body the recording sent (a write's request); undefined when it sent none. */
  readonly body: Json | undefined;
  readonly status: number;
  /** The recorded body's file; null when the answer has no JSON body (a 204, a blob's bytes). */
  readonly file: string | null;
  /** The response headers the provider recorded because consumers read them, by name. */
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly ids: ReadonlySet<string>;
  readonly instants: ReadonlySet<string>;
  readonly listFilteredTo: string | null;
}

interface Index {
  formatVersion: number;
  provider: string;
  states: {
    name: string;
    params?: Record<string, string>;
    operations: {
      operationId: string;
      method: string;
      path: string;
      query?: Record<string, string>;
      body?: Json;
      status: number;
      responseHeaders?: Record<string, string>;
      file: string | null;
      frozen?: { ids?: string[]; instants?: string[]; listFilteredTo?: string | null };
    }[];
  }[];
}

/** One provider's golden masters, read from its npm package. */
export interface GoldenMasters {
  /** The index entry; throws naming the state and operation when there is none. */
  operation(state: string, operationId: string): GoldenOperation;
  /**
   * The recorded body. A fresh copy every call, so a spec may change it freely. Throws when the
   * answer was recorded without a JSON body (`file: null`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON by default, so specs read fields without casts
  body<T = any>(state: string, operationId: string): T;
}

/**
 * The golden masters in the npm package `packageName` (a devDependency, so qits-maintenance bumps
 * it), looked up in `node_modules` from `from` (default: the cwd) upwards. `provider` is the name
 * the package's index carries; a package for another provider is refused.
 */
export function goldenMasters(
  packageName: string,
  provider: string,
  from: string = process.cwd(),
): GoldenMasters {
  let root: string | undefined;
  let index: Index | undefined;

  const tree = (): string => {
    if (root) return root;
    for (let dir = resolve(from); ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', packageName, 'golden-masters');
      if (existsSync(join(candidate, 'index.json'))) return (root = candidate);
      if (dirname(dir) === dir) {
        throw new Error(`no ${packageName} in any node_modules above ${from}: run npm ci`);
      }
    }
  };

  const read = (): Index => {
    if (index) return index;
    const loaded = JSON.parse(readFileSync(join(tree(), 'index.json'), 'utf8')) as Index;
    if (loaded.formatVersion !== 1) {
      throw new Error(
        `${packageName} is index formatVersion ${loaded.formatVersion}; this reads 1`,
      );
    }
    if (loaded.provider !== provider) {
      throw new Error(
        `${packageName} holds ${loaded.provider}'s golden masters, not ${provider}'s`,
      );
    }
    return (index = loaded);
  };

  const operation = (state: string, operationId: string): GoldenOperation => {
    const node = read().states.find((s) => s.name === state);
    const op = node?.operations.find((o) => o.operationId === operationId);
    if (!node || !op) {
      throw new Error(
        `${provider}'s golden masters record no '${operationId}' in state '${state}'`,
      );
    }
    return {
      state,
      params: { ...(node.params ?? {}) },
      operationId,
      method: op.method,
      path: op.path,
      query: { ...(op.query ?? {}) },
      body: op.body,
      status: op.status,
      file: op.file,
      responseHeaders: { ...(op.responseHeaders ?? {}) },
      ids: new Set(op.frozen?.ids ?? []),
      instants: new Set(op.frozen?.instants ?? []),
      listFilteredTo: op.frozen?.listFilteredTo ?? null,
    };
  };

  return {
    operation,
    body: (state, operationId) => {
      const file = operation(state, operationId).file;
      if (file === null) {
        throw new Error(
          `${provider}'s golden master '${state}' / ${operationId} has no JSON body: the answer is empty or not JSON`,
        );
      }
      return JSON.parse(readFileSync(join(tree(), file), 'utf8'));
    },
  };
}

/** The path with every `{param}` replaced by the state's example value. */
export function examplePath(op: GoldenOperation): string {
  return op.path.replace(/\{(\w+)}/g, (_, name: string) => {
    const value = op.params[name];
    if (value === undefined) throw new Error(`state '${op.state}' has no param '${name}'`);
    return value;
  });
}

/** What caused a call, as `comments.references.qits-trigger` names it. */
export type Trigger =
  | { readonly kind: 'ui'; readonly app: string; readonly interaction: string }
  | { readonly kind: 'operation'; readonly app: string; readonly operationId: string }
  | { readonly kind: 'event'; readonly app: string; readonly event: string }
  | { readonly kind: 'schedule'; readonly app: string; readonly schedule: string };

/** The trigger's own name: the UI interaction, operation, event or schedule. */
function triggerName(trigger: Trigger): string {
  switch (trigger.kind) {
    case 'ui':
      return trigger.interaction;
    case 'operation':
      return trigger.operationId;
    case 'event':
      return trigger.event;
    case 'schedule':
      return trigger.schedule;
  }
}

/**
 * The library a call goes through (ticket qits-1284, the JS side of qits-1163): for a pact of a call
 * a library makes on behalf of the consuming app, which library, and which version of it the app
 * pins. Written as `comments.references.qits-via`, in this key order, all strings, as the Java
 * `eu.wohlben.qits.pact.consumer.Via` writes it.
 */
export interface Via {
  /** The library's repository name, as a pact names it (`qits-ui-components-jslib`). */
  readonly repository: string;
  /** The library's package coordinate: the npm name (`@qits/ui-components`), or maven's `groupId:artifactId`. */
  readonly artifact: string;
  /** The version of `artifact` the consuming app resolves. */
  readonly version: string;
}

/**
 * An answer that is not JSON (a blob's bytes, an image), as the consumer reads it. Its golden master
 * records no body (`file: null`), so the interaction binds the status, the `Content-Type` and, given
 * `body`, that a body of that media type comes back, never the bytes themselves.
 */
export interface NonJsonResponse {
  /**
   * The media type the consumer expects (`image/png`). The pact matches the answer's `Content-Type`
   * as this media type followed by anything; when the recording holds a `Content-Type`, it is the
   * example and must name the same media type.
   */
  readonly contentType: string;
  /**
   * Example bytes the mock server answers with. The pact binds them by media type only (Pact's
   * content-type matcher), so they must be a valid instance of `contentType`. Omitted: the answer
   * binds no body, only the header.
   */
  readonly body?: Uint8Array;
}

/** One interaction to add: which recorded answer, who calls it, and what caused the call. */
export interface GoldenInteraction {
  /** The provider's repository name, as the pact and `qits-call.app` name it. */
  readonly provider: string;
  readonly state: string;
  readonly operationId: string;
  readonly trigger: Trigger;
  /**
   * The body paths the consumer reads, and so the only ones the pact binds. Dot-separated keys;
   * `[]` after a key steps into the elements of an array:
   *
   * - `project.name`: that field (a whole object or array, if that is what it holds);
   * - `entries[].project.id`: that field in every element of `entries`;
   * - `entries[]`: the elements themselves, without any of their fields (the consumer counts them).
   *
   * `[]` (empty): the consumer reads the status only, so the pact has no body. A path that is not
   * in the recorded body throws. Must be `[]` with {@link response}.
   */
  readonly consumes: readonly string[];
  /**
   * The library the call goes through, when a library makes it on the consumer's behalf: the
   * interaction then carries `qits-via` as well. `trigger.app` stays the consumer.
   */
  readonly via?: Via;
  /** Set for an answer that is not JSON; see {@link NonJsonResponse}. */
  readonly response?: NonJsonResponse;
}

/**
 * Adds the interaction for a recorded answer to `pact` and returns it ready for `executeTest`. It
 * carries:
 *
 * - the provider state with its params;
 * - the path, as a provider-state expression only when it has a `{param}` (pact-jvm resolves a
 *   parameterless expression to a path that misses the route);
 * - the recorded status, and the parts of the recorded body named in `consumes`, under matchers
 *   (see the file comment);
 * - `comments.references`: `qits-call` (provider and operation) and `qits-trigger`, which the
 *   provider's verification requires, and `qits-via` (repository, artifact, version) when `via`
 *   is set;
 * - for a `response` that is not JSON: its `Content-Type` and, given example bytes, a body of that
 *   media type, in place of a JSON body.
 *
 * The description is `<trigger>: <operationId>`, so one call made by two triggers is two
 * interactions.
 */
export function addGoldenInteraction(
  pact: PactV4,
  masters: GoldenMasters,
  { provider, state, operationId, trigger, consumes, via, response: nonJson }: GoldenInteraction,
): V4InteractionWithResponse {
  const op = masters.operation(state, operationId);
  if (nonJson && consumes.length) {
    throw new Error(
      `golden master ${state}/${operationId}: a response that is not JSON has no body paths to consume`,
    );
  }
  // Read only when consumed: a status-only interaction may stand on an answer recorded without a body.
  const body = consumes.length
    ? consumed(masters.body<Json>(state, operationId), consumes, op)
    : undefined;
  const contentType = nonJson ? nonJsonContentType(nonJson.contentType, op) : undefined;
  const path = /\{\w+}/.test(op.path)
    ? MatchersV3.fromProviderState(op.path.replace(/\{(\w+)}/g, '$${$1}'), examplePath(op))
    : op.path;
  let interaction = pact
    .addInteraction()
    .given(state, { ...op.params })
    .uponReceiving(`${triggerName(trigger)}: ${operationId}`)
    .reference('qits-call', 'app', provider)
    .reference('qits-call', 'operationId', operationId);
  for (const [key, value] of Object.entries(trigger)) {
    interaction = interaction.reference('qits-trigger', key, value);
  }
  if (via) {
    interaction = interaction
      .reference('qits-via', 'repository', via.repository)
      .reference('qits-via', 'artifact', via.artifact)
      .reference('qits-via', 'version', via.version);
  }
  const query = op.query;
  const sent = op.body;
  // The request as recorded: its query, and a write's JSON body, matched exactly.
  const request =
    Object.keys(query).length || sent !== undefined
      ? interaction.withRequest(op.method, path, (builder) => {
          if (Object.keys(query).length) builder.query({ ...query });
          if (sent !== undefined) builder.jsonBody(sent);
        })
      : interaction.withRequest(op.method, path);
  return request.willRespondWith(op.status, (response) => {
    if (nonJson && contentType) {
      response.headers({ 'Content-Type': contentType });
      if (nonJson.body) response.body(nonJson.contentType, Buffer.from(nonJson.body));
      return;
    }
    if (body === undefined) return;
    response
      .headers({ 'Content-Type': MatchersV3.regex('application/json.*', 'application/json') })
      .jsonBody(matched(body, '$', op));
  });
}

/**
 * The `Content-Type` matcher of an answer that is not JSON: `media` followed by anything (a
 * `; charset=…`), with the recorded header as the example where there is one. Throws when the
 * recording names another media type: the consumer would expect what the provider does not send.
 */
function nonJsonContentType(
  media: string,
  op: GoldenOperation,
): ReturnType<typeof MatchersV3.regex> {
  const name = Object.keys(op.responseHeaders).find((h) => h.toLowerCase() === 'content-type');
  const recorded = name === undefined ? undefined : op.responseHeaders[name];
  if (
    recorded !== undefined &&
    recorded.split(';')[0].trim().toLowerCase() !== media.toLowerCase()
  ) {
    throw new Error(
      `golden master ${op.state}/${op.operationId}: the consumer expects ${media}, the provider recorded ${recorded}`,
    );
  }
  return MatchersV3.regex(`${media.replace(/[^A-Za-z0-9/-]/g, '\\$&')}.*`, recorded ?? media);
}

/** The paths of `consumes` as a tree: which keys to keep, and what to keep in array elements. */
interface Pick {
  /** The whole value here is read. */
  whole: boolean;
  readonly keys: Map<string, Pick>;
  /** Set when the value here is an array whose elements are read. */
  elements?: Pick;
}

const pick = (): Pick => ({ whole: false, keys: new Map() });

/** One path's steps: a key, or `[]` for the elements of an array. */
function steps(path: string): string[] {
  const out: string[] = [];
  for (const segment of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\])*)$/.exec(segment);
    if (!match || (!match[1] && !match[2])) throw new Error(`consumes '${path}' is not a path`);
    if (match[1]) out.push(match[1]);
    for (let i = 0; i < match[2].length / 2; i++) out.push('[]');
  }
  return out;
}

/**
 * The recorded `body` cut down to the paths of `consumes`, or `undefined` when it is empty. Throws
 * when a path is not in the body, naming the state, the operation and the path.
 */
function consumed(body: Json, consumes: readonly string[], op: GoldenOperation): Json | undefined {
  if (consumes.length === 0) return undefined;
  const root = pick();
  for (const path of consumes) {
    const walk = steps(path);
    if (!holds(body, walk)) {
      throw new Error(
        `golden master ${op.state}/${op.operationId}: consumes '${path}', which the recorded body does not hold`,
      );
    }
    let node = root;
    for (const step of walk) {
      node = step === '[]' ? (node.elements ??= pick()) : (node.keys.get(step) ?? set(node, step));
    }
    // `entries[]` reads the elements, not their fields: only a path ending in a key reads it whole.
    if (walk[walk.length - 1] !== '[]') node.whole = true;
  }
  return project(body, root);
}

function set(node: Pick, key: string): Pick {
  const child = pick();
  node.keys.set(key, child);
  return child;
}

/** Whether `value` holds the path `walk`: in at least one element, where it crosses an array. */
function holds(value: Json, walk: readonly string[]): boolean {
  if (walk.length === 0) return true;
  const [step, ...rest] = walk;
  // An empty array holds every path below it: there is nothing recorded there to bind.
  if (step === '[]') {
    return Array.isArray(value) && (value.length === 0 || value.some((v) => holds(v, rest)));
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return step in value && holds(value[step], rest);
}

/** `value` with only what `node` keeps. An object element read without fields becomes `{}`. */
function project(value: Json, node: Pick): Json {
  if (node.whole || value === null) return value;
  if (Array.isArray(value)) {
    const elements = node.elements;
    return elements ? value.map((v) => project(v, elements)) : value;
  }
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, child] of node.keys) {
      if (key in value) out[key] = project(value[key], child);
    }
    return out;
  }
  return value;
}

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ISO_INSTANT =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:?\\d{2})$';

/** The recorded `value` at `path`, wrapped in matchers. */
function matched(value: Json, path: string, op: GoldenOperation): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return matchedArray(value, path, op);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, matched(child, `${path}.${key}`, op)]),
    );
  }
  if (op.ids.has(path)) return MatchersV3.regex(UUID, String(value));
  if (op.instants.has(path)) return MatchersV3.regex(ISO_INSTANT, String(value));
  if (typeof value === 'number') return MatchersV3.number(value);
  return MatchersV3.like(value);
}

/**
 * A recorded array, wrapped in matchers. Elements of one {@link shape} share one template.
 *
 * - An array whose elements all share one shape is "exactly the recorded count, each like the
 *   template".
 * - The `listFilteredTo` array is the state's own entries in a list that also holds whatever else
 *   the provider has: it is matched as "contains an element of each shape" (`arrayContaining`),
 *   never "every element looks like this", because the other entries may look different.
 * - Any other array holds elements of more than one shape, so no single template fits them all:
 *   it is matched the same way, each variant by its own shape's template, nested arrays included.
 */
function matchedArray(values: Json[], path: string, op: GoldenOperation): unknown {
  if (values.length === 0) return [];
  const element = `${path}[*]`;
  const shapes = new Map<string, Json>();
  for (const value of values) {
    const key = shape(value);
    if (!shapes.has(key)) shapes.set(key, value);
  }
  if (path === op.listFilteredTo || shapes.size > 1) {
    return MatchersV3.arrayContaining(...[...shapes.values()].map((v) => matched(v, element, op)));
  }
  const template = matched(values[0], element, op);
  return MatchersV3.constrainedArrayLike(template, values.length, values.length, values.length);
}

/**
 * Everything the template made from `value` binds apart from the values themselves: the object's
 * keys (in a fixed order), each leaf's type or null, and each nested array's elements in order.
 * Two values of one shape are matched by one template; values of different shapes are not.
 */
function shape(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(shape).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${shape(value[key])}`).join(',')}}`;
  }
  return typeof value;
}

/**
 * Compares the pact a run wrote (`generated`) with the committed one (`committed`), ignoring
 * `metadata` (it names library versions) and interaction order. Throws on a difference, so a
 * changed pact is committed in the same change. With `<updateSwitch>=true` in the environment it
 * copies `generated` over `committed` instead.
 *
 * A difference confined to `comments.references.qits-via.version` (see {@link Via}) does not fail:
 * the version is masked on both sides, and when nothing else differs `generated` is copied over
 * `committed` and `qits-via version refreshed <old> → <new>` logged. A library bump is no contract
 * change; only the committed label lagged.
 */
export function assertPactFile(generated: string, committed: string, updateSwitch: string): void {
  if (!existsSync(generated)) throw new Error(`the run wrote no pact at ${generated}`);
  if (process.env[updateSwitch] === 'true') {
    mkdirSync(dirname(committed), { recursive: true });
    writeFileSync(committed, readFileSync(generated));
    return;
  }
  const read = (file: string): { interactions: PactInteraction[]; [key: string]: unknown } =>
    JSON.parse(readFileSync(file, 'utf8'));
  const normal = ({ interactions, ...rest }: ReturnType<typeof read>, mask: boolean): string => {
    delete rest['metadata'];
    const sorted = sortedInteractions(mask ? maskViaVersions(interactions) : interactions);
    return JSON.stringify({ ...rest, interactions: sorted });
  };
  const fresh = read(generated);
  const current = existsSync(committed) ? read(committed) : undefined;
  if (current && normal(fresh, false) === normal(current, false)) return;
  if (current && normal(fresh, true) === normal(current, true)) {
    writeFileSync(committed, readFileSync(generated));
    reportViaRefresh(committed, current.interactions, fresh.interactions);
    return;
  }
  throw new Error(
    `${committed} ${current ? 'differs from what the pact specs generate' : 'does not exist'}. ` +
      `If the change is intended, regenerate it in this change: ${updateSwitch}=true npm test`,
  );
}
