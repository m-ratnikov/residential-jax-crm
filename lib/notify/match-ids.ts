/**
 * The set of parcels a saved search currently matches, small enough to store.
 *
 * "Which parcels newly match your saved search" is a set difference and nothing
 * more. It needs membership, not values: no fingerprint, no snapshot, no score.
 * That is the whole reason this module exists separately from the tracked match
 * snapshots - membership is cheap enough to keep for the entire match set,
 * where a snapshot per parcel is not.
 *
 * The representation is chosen for where it is stored. The CRM store commits
 * JSON documents to a git branch, so a saved search is a file that is rewritten
 * whenever it changes and whose diff a human may read. Two properties follow:
 *
 * 1. **Bytes matter.** 151,856 ids as a JSON array, pretty printed at the
 *    store's two space indent, is 2.8 MB. Grouped by id prefix with the prefix
 *    stored once, it is 1.2 MB.
 * 2. **Diff locality matters.** A sorted array is the worst possible layout: an
 *    id inserted near the front shifts every element after it, so one new
 *    parcel rewrites the whole file. A parcel's group here is a function of the
 *    parcel id alone, so one new parcel touches one line.
 *
 * Both numbers above are measured, on the 75,988 parcel bundled sample, and
 * scaled; the measurement lives in test/match-id-set.test.ts so it stays true.
 *
 * Nothing here talks to a store, a network or a query engine, so the browser
 * matcher and the scheduled runner can both use it.
 */

import { MATCH_ID_GROUP_PREFIX } from "./limits";

/**
 * Every parcel id a saved search matched on one pass.
 *
 * `buckets` maps a leading id fragment to the remainders of the ids that begin
 * with it, sorted and comma joined. `"1089" -> "020000R,030000R"` is
 * `1089020000R` and `1089030000R`. An id shorter than the prefix is its own
 * bucket with an empty remainder.
 */
export interface MatchIdSet {
  /** How many ids the set holds. Stored so a reader of the raw JSON can see it. */
  count: number;
  /**
   * True when the criteria matched more parcels than the pass retrieved, so
   * absence from this set does NOT mean the parcel was not matching.
   */
  truncated: boolean;
  /** Id prefix -> sorted, comma joined remainders. */
  buckets: Record<string, string>;
}

export const EMPTY_MATCH_ID_SET: MatchIdSet = { count: 0, truncated: false, buckets: {} };

/**
 * Group ids by prefix and join each group.
 *
 * Sorted within a group so an unchanged set serialises byte for byte
 * identically. That is not cosmetic: the store skips a write when the document
 * matches what is already there, and the matcher runs every thirty minutes, so
 * a stable ordering is what keeps a quiet pass from producing a commit.
 */
export function encodeMatchIds(ids: Iterable<string>, truncated = false): MatchIdSet {
  const groups = new Map<string, string[]>();
  let count = 0;

  for (const id of ids) {
    if (!id) continue;
    const prefix = id.slice(0, MATCH_ID_GROUP_PREFIX);
    const rest = id.slice(MATCH_ID_GROUP_PREFIX);
    const group = groups.get(prefix);
    if (group) group.push(rest);
    else groups.set(prefix, [rest]);
    count += 1;
  }

  const buckets: Record<string, string> = {};
  for (const [prefix, rest] of groups) buckets[prefix] = rest.sort().join(",");

  return { count, truncated, buckets };
}

/**
 * The ids back out.
 *
 * A missing or malformed set decodes to an empty set rather than throwing.
 * Callers distinguish "no id set stored" from "an empty match set" by checking
 * for the document field itself - see `hasMatchIdSet` - because those two mean
 * very different things and reading one as the other is how a migration alerts
 * on every parcel it has ever seen.
 */
export function decodeMatchIds(set: MatchIdSet | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!set || typeof set !== "object" || !set.buckets) return ids;

  for (const [prefix, joined] of Object.entries(set.buckets)) {
    if (typeof joined !== "string") continue;
    // An empty group is one id that is shorter than the prefix, not zero ids.
    if (joined === "") {
      ids.add(prefix);
      continue;
    }
    for (const rest of joined.split(",")) ids.add(prefix + rest);
  }

  return ids;
}

/**
 * Whether a saved search carries an id set at all.
 *
 * A document written before this existed has none, and its `matches` map only
 * ever held the top `TRACKED_MATCH_CAP`. Treating that absence as "the match
 * set was empty" would announce the entire set as newly matching on the next
 * pass, which is exactly the alert storm the seeding rule exists to prevent.
 */
export function hasMatchIdSet(set: MatchIdSet | null | undefined): boolean {
  return Boolean(set && typeof set === "object" && set.buckets);
}

export function matchIdSetCount(set: MatchIdSet | null | undefined): number {
  return hasMatchIdSet(set) ? decodeMatchIds(set).size : 0;
}

/**
 * The parcels in `current` that `previous` did not hold, in the order given.
 *
 * One implementation, used by the evaluator to decide what to alert on and by
 * the matchers to decide which rows are worth carrying detail for. Those two
 * must agree or a pass fetches detail for parcels the evaluator will not raise
 * and none for the ones it will.
 */
export function newAgainst(previous: ReadonlySet<string>, current: Iterable<string>): string[] {
  const added: string[] = [];
  for (const id of current) if (!previous.has(id)) added.push(id);
  return added;
}

/** The parcels `previous` held that `current` does not. */
export function goneFrom(previous: Iterable<string>, current: ReadonlySet<string>): string[] {
  const removed: string[] = [];
  for (const id of previous) if (!current.has(id)) removed.push(id);
  return removed;
}
