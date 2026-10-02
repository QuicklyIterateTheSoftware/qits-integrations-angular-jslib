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
 * - compares the pact a run wrote with the committed one ({@link assertPactFile}).
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
 * - `frozen.listFilteredTo`: at least the recorded number of elements ("contains");
 * - every other array: exactly the recorded number of elements, each matched against the first.
 *
 * An array whose elements differ in which fields are null (a PROJECT repository has no
 * `component`, the others have one) cannot be matched against one template: Pact has no "type or
 * null". It becomes `arrayContaining` with one variant per such shape, so the answer must hold at
 * least one element of each shape, in any order.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MatchersV3, type PactV4 } from '@pact-foundation/pact';

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
  readonly status: number;
  readonly file: string;
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
      status: number;
      file: string;
      frozen?: { ids?: string[]; instants?: string[]; listFilteredTo?: string | null };
    }[];
  }[];
}

/** One provider's golden masters, read from its npm package. */
export interface GoldenMasters {
  /** The index entry; throws naming the state and operation when there is none. */
  operation(state: string, operationId: string): GoldenOperation;
  /** The recorded body. A fresh copy every call, so a spec may change it freely. */
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
      status: op.status,
      file: op.file,
      ids: new Set(op.frozen?.ids ?? []),
      instants: new Set(op.frozen?.instants ?? []),
      listFilteredTo: op.frozen?.listFilteredTo ?? null,
    };
  };

  return {
    operation,
    body: (state, operationId) =>
      JSON.parse(readFileSync(join(tree(), operation(state, operationId).file), 'utf8')),
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

/** One interaction to add: which recorded answer, who calls it, and what caused the call. */
export interface GoldenInteraction {
  /** The provider's repository name, as the pact and `qits-call.app` name it. */
  readonly provider: string;
  readonly state: string;
  readonly operationId: string;
  readonly trigger: Trigger;
}

/**
 * Adds the interaction for a recorded answer to `pact` and returns it ready for `executeTest`. It
 * carries:
 *
 * - the provider state with its params;
 * - the path, as a provider-state expression only when it has a `{param}` (pact-jvm resolves a
 *   parameterless expression to a path that misses the route);
 * - the recorded status and body, under matchers (see the file comment);
 * - `comments.references`: `qits-call` (provider and operation) and `qits-trigger`, which the
 *   provider's verification requires.
 *
 * The description is `<trigger>: <operationId>`, so one call made by two triggers is two
 * interactions.
 */
export function addGoldenInteraction(
  pact: PactV4,
  masters: GoldenMasters,
  { provider, state, operationId, trigger }: GoldenInteraction,
): V4InteractionWithResponse {
  const op = masters.operation(state, operationId);
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
  return interaction.withRequest(op.method, path).willRespondWith(op.status, (response) => {
    response
      .headers({ 'Content-Type': MatchersV3.regex('application/json.*', 'application/json') })
      .jsonBody(matched(masters.body<Json>(state, operationId), '$', op));
  });
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

function matchedArray(values: Json[], path: string, op: GoldenOperation): unknown {
  if (values.length === 0) return [];
  const element = `${path}[*]`;
  const shapes = new Map<string, Json>();
  for (const value of values) {
    const shape = nullShape(value);
    if (!shapes.has(shape)) shapes.set(shape, value);
  }
  if (shapes.size > 1) {
    return MatchersV3.arrayContaining(...[...shapes.values()].map((v) => matched(v, element, op)));
  }
  const template = matched(values[0], element, op);
  return path === op.listFilteredTo
    ? MatchersV3.atLeastLike(template, values.length, values.length)
    : MatchersV3.constrainedArrayLike(template, values.length, values.length, values.length);
}

/** Which paths inside `value` are null: elements that agree can share one template. */
function nullShape(value: Json, path = ''): string {
  if (value === null) return `${path}=null;`;
  if (Array.isArray(value)) return value.map((v) => nullShape(v, `${path}[]`)).join('');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, child]) => nullShape(child, `${path}.${key}`))
      .join('');
  }
  return '';
}

/**
 * Compares the pact a run wrote (`generated`) with the committed one (`committed`), ignoring
 * `metadata` (it names library versions) and interaction order. Throws on a difference, so a
 * changed pact is committed in the same change. With `<updateSwitch>=true` in the environment it
 * copies `generated` over `committed` instead.
 */
export function assertPactFile(generated: string, committed: string, updateSwitch: string): void {
  if (!existsSync(generated)) throw new Error(`the run wrote no pact at ${generated}`);
  if (process.env[updateSwitch] === 'true') {
    mkdirSync(dirname(committed), { recursive: true });
    writeFileSync(committed, readFileSync(generated));
    return;
  }
  const normal = (file: string) => {
    const { interactions, ...rest } = JSON.parse(readFileSync(file, 'utf8'));
    delete rest.metadata;
    const key = (i: { description: string; providerStates?: { name: string }[] }) =>
      `${i.description}\u0000${(i.providerStates ?? []).map((s) => s.name).join('\u0000')}`;
    const sorted = [...interactions].sort((a, b) => (key(a) < key(b) ? -1 : 1));
    return JSON.stringify({ ...rest, interactions: sorted });
  };
  if (!existsSync(committed) || normal(generated) !== normal(committed)) {
    throw new Error(
      `${committed} ${existsSync(committed) ? 'differs from what the pact specs generate' : 'does not exist'}. ` +
        `If the change is intended, regenerate it in this change: ${updateSwitch}=true npm test`,
    );
  }
}
