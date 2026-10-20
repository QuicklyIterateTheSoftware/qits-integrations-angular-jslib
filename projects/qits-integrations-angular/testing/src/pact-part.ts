/// <reference types="node" />
/**
 * One consumer–provider pact file, written by several pact specs (one per store): each spec owns
 * the interactions for the provider operations its store calls, and checks or rewrites only those.
 * The committed file therefore holds every interaction exactly once, whichever spec made it.
 * Promoted from the copies in qits-landing-app and qits-projects-frontend (ticket qits-1284).
 *
 * A spec's own interactions are told apart by `comments.references.qits-call.operationId`, which
 * `addGoldenInteraction` writes on every interaction. Where two stores call the same operation
 * (`getWork`: the work item page's read and the work list's campaign description), each spec owns
 * that operation's interactions for its own UI interactions only (`qits-trigger.interaction`), and
 * names it as `{ operationId, interactions }`.
 *
 * `assertPactPart` compares the spec's interactions in the committed file with the ones this run
 * generated (ignoring `metadata` and order, as `assertPactFile` does) and fails on a difference.
 * With `<updateSwitch>=true` it replaces them in the committed file instead, under a lock file, so
 * two specs updating at once do not lose each other's part. A difference confined to
 * `qits-via.version` replaces them the same way without the switch, as `assertPactFile` does.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  interactionKey,
  maskViaVersions,
  reportViaRefresh,
  sortedInteractions,
} from './pact-compare';

interface Pact {
  readonly interactions: readonly Interaction[];
  readonly [key: string]: unknown;
}

interface Interaction {
  readonly description: string;
  readonly providerStates?: readonly { readonly name: string }[];
  readonly comments?: {
    readonly references?: {
      readonly 'qits-call'?: { readonly operationId?: string };
      readonly 'qits-trigger'?: { readonly interaction?: string };
    };
  };
}

/**
 * What a spec owns in the file: every interaction of an operation, or only those an operation has
 * for the named UI interactions.
 */
export type OwnedOperation =
  string | { readonly operationId: string; readonly interactions: readonly string[] };

const operationOf = (i: Interaction) => i.comments?.references?.['qits-call']?.operationId;
const triggerOf = (i: Interaction) => i.comments?.references?.['qits-trigger']?.interaction;
const owns = (owned: OwnedOperation, i: Interaction) =>
  typeof owned === 'string'
    ? operationOf(i) === owned
    : operationOf(i) === owned.operationId && owned.interactions.includes(triggerOf(i) ?? '');
const named = (owned: OwnedOperation) =>
  typeof owned === 'string' ? owned : `${owned.operationId} (${owned.interactions.join(', ')})`;

/**
 * Checks this spec's part of the pact file `committed` against the pact the run wrote
 * (`generated`), which must hold only interactions of `operations`. Throws on a difference, or when
 * the run made an interaction for an operation the spec does not own; `<updateSwitch>=true` in the
 * environment replaces the part instead. See the file comment.
 */
export function assertPactPart(
  generated: string,
  committed: string,
  operations: readonly OwnedOperation[],
  updateSwitch: string,
): void {
  if (!existsSync(generated)) throw new Error(`the run wrote no pact at ${generated}`);
  const ours = (i: Interaction) => operations.some((owned) => owns(owned, i));
  const fresh = JSON.parse(readFileSync(generated, 'utf8')) as Pact;
  const strangers = fresh.interactions.filter((i) => !ours(i));
  if (strangers.length) {
    throw new Error(
      `this spec made interactions for operations it does not own: ${strangers.map(interactionKey)}`,
    );
  }

  /** Replaces this spec's part of the committed file with what the run generated. */
  const replace = () =>
    withLock(`${committed}.lock`, () => {
      const current = existsSync(committed)
        ? (JSON.parse(readFileSync(committed, 'utf8')) as Pact)
        : { ...fresh, interactions: [] };
      const kept = current.interactions.filter((i) => !ours(i));
      const next = {
        ...current,
        interactions: sortedInteractions([...kept, ...fresh.interactions]),
      };
      writeFileSync(committed, `${JSON.stringify(next, null, 2)}\n`);
    });

  if (process.env[updateSwitch] === 'true') {
    mkdirSync(dirname(committed), { recursive: true });
    replace();
    return;
  }

  const committedPact = existsSync(committed)
    ? (JSON.parse(readFileSync(committed, 'utf8')) as Pact)
    : undefined;
  const part = committedPact?.interactions.filter(ours) ?? [];
  const normal = (list: readonly Interaction[], mask: boolean) =>
    JSON.stringify(sortedInteractions(mask ? maskViaVersions(list) : list));
  if (committedPact && normal(part, false) === normal(fresh.interactions, false)) return;
  if (committedPact && normal(part, true) === normal(fresh.interactions, true)) {
    replace();
    reportViaRefresh(committed, part, fresh.interactions);
    return;
  }
  throw new Error(
    `${committed} ${committedPact ? `differs from what this spec generates for ${operations.map(named)}` : 'does not exist'}. ` +
      `If the change is intended, regenerate it in this change: ${updateSwitch}=true npm test`,
  );
}

/** Runs `body` while holding an exclusive lock file; waits up to ten seconds for it. */
function withLock(lock: string, body: () => void): void {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`could not take ${lock}`);
      const until = Date.now() + 25;
      while (Date.now() < until) {
        // busy-wait: the test runner gives no sync sleep
      }
    }
  }
  try {
    body();
  } finally {
    rmSync(lock, { force: true });
  }
}
