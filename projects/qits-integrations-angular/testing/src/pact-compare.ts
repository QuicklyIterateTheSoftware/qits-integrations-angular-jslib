/**
 * What `assertPactFile` and `assertPactPart` share for comparing a pact a run wrote with the
 * committed one. Internal: the public API does not export it.
 *
 * Interactions are compared in no order, each known by its description and provider states.
 *
 * The `qits-via` version label is masked (ticket qits-1284, after the Java
 * `ConsumerPact.compareOrWritePactFile` of ticket qits-1163). An interaction a library makes on behalf of its consumer names the library's version the
 * consumer pins (`comments.references.qits-via.version`). A qits-maintenance bump of that library
 * changes the label and nothing else, so it is no contract change: only the committed label lags
 * until the pact spec runs again. Both comparisons therefore mask it on both sides, and a
 * difference confined to it rewrites the committed file instead of failing.
 */

/** What the comparison reads of an interaction. */
export interface PactInteraction {
  readonly description: string;
  readonly providerStates?: readonly { readonly name: string }[];
}

/** An interaction's identity in a pact file: its description and provider states. */
export function interactionKey(i: PactInteraction): string {
  return `${i.description}\u0000${(i.providerStates ?? []).map((s) => s.name).join('\u0000')}`;
}

/** `interactions` in a fixed order, by {@link interactionKey}. */
export function sortedInteractions<T extends PactInteraction>(interactions: readonly T[]): T[] {
  return [...interactions].sort((a, b) => {
    const [x, y] = [interactionKey(a), interactionKey(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** The placeholder every `qits-via.version` is set to before comparing. */
const MASK = '*';

interface ViaCarrier {
  readonly comments?: { readonly references?: { readonly 'qits-via'?: { version?: unknown } } };
}

/**
 * `interactions`, deep-copied, with every `comments.references.qits-via.version` set to the mask.
 * Interactions without `qits-via` are copied unchanged.
 */
export function maskViaVersions<T>(interactions: readonly T[]): T[] {
  return interactions.map((interaction) => {
    const copy = structuredClone(interaction) as T & ViaCarrier;
    const via = copy.comments?.references?.['qits-via'];
    if (via && typeof via === 'object') via.version = MASK;
    return copy;
  });
}

/** The first `qits-via.version` among `interactions`; `?` when none carries one. */
export function viaVersion(interactions: readonly unknown[]): string {
  for (const interaction of interactions as readonly ViaCarrier[]) {
    const version = interaction.comments?.references?.['qits-via']?.version;
    if (typeof version === 'string') return version;
  }
  return '?';
}

/** Says, on the console, that a version-only difference was written back rather than failed. */
export function reportViaRefresh(
  committed: string,
  before: readonly unknown[],
  after: readonly unknown[],
): void {
  console.info(
    `qits-via version refreshed ${viaVersion(before)} → ${viaVersion(after)} (${committed})`,
  );
}
