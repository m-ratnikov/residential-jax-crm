/**
 * Where CRM state lives, and why it is not a database.
 *
 * The story's cost criterion is specific: operate the CRM "without requiring
 * Oracle to carry ongoing hosted-database cost beyond the existing Duval
 * pipeline + DuckDB / Elephant IPFS pattern". A free-tier Postgres removes the
 * cost but not the category - it is still a hosted database, still an account,
 * still a credential - and it would be inconsistent with the property side,
 * where 404,023 parcels deliberately touch no database at all.
 *
 * So CRM state is documents, and the default backend commits them to the
 * repository. That is not a dodge into a different kind of database: it is the
 * mechanism the Duval pipeline already uses, which commits `runs/*.json` back to
 * its branch after every run. A git repository is not a database, costs
 * nothing, and GitHub is already in the baseline because that is where the
 * pipeline runs.
 *
 * ## Why documents rather than tables
 *
 * Every invariant the relational schema enforced with a unique index becomes
 * structural here, because the document key IS the constraint:
 *
 * - one live opportunity per parcel -> `opportunities/<propertyId>`
 * - one alert per (search, property, pass) -> `alerts/<pass>__<search>__<parcel>`
 * - one evidence record per matcher pass -> `matcher-runs/<matcherRunId>`
 *
 * That is stronger than a check-then-write, and it means two writers - the
 * scheduled matcher and someone clicking in the app - cannot collide on the same
 * document by accident.
 *
 * Aggregates are stored whole. An opportunity carries its stage history, notes,
 * tasks and outreach thread in one document, so reading a deal is one read and
 * there are no joins to get wrong.
 */

/** The collections. One directory per collection in the git backend. */
export const COLLECTIONS = [
  "team",
  "searches",
  "alerts",
  "matcher-runs",
  "owners",
  "opportunities",
  "court",
  "simulated",
] as const;

export type Collection = (typeof COLLECTIONS)[number];

/**
 * Every stored document carries its own id, so a list read needs no filename
 * parsing and a document is self-describing wherever it ends up.
 */
export interface StoredDocument {
  id: string;
}

export interface CrmStore {
  /** Backend name, shown on the pipeline page so a reviewer can see which is live. */
  readonly kind: string;
  /** Human description of where state is being written. Never a secret. */
  readonly location: string;
  /** False when the backend can read but not write, e.g. no token configured. */
  readonly writable: boolean;

  list<T extends StoredDocument>(collection: Collection): Promise<T[]>;
  get<T extends StoredDocument>(collection: Collection, id: string): Promise<T | null>;
  /**
   * Write a document whole. Idempotent by key, LAST WRITER WINS.
   *
   * A backend MUST skip the write when the document is byte-identical to what is
   * already stored. The matcher runs every thirty minutes and most passes change
   * nothing; committing an unchanged document each time would fill the history
   * with noise and cost a round trip for nothing.
   *
   * Use this only for a BLIND write - a document built from scratch, where the
   * caller genuinely means "this is the state now". For anything that reads a
   * document, changes part of it and writes it back, use `update`: a `put` in
   * that position silently discards whatever another writer did in between.
   */
  put<T extends StoredDocument>(collection: Collection, document: T): Promise<T>;
  /**
   * Read, change, write, with the read repeated if the write raced.
   *
   * `mutate` is handed the CURRENT document and must return the whole next one,
   * or null to leave the store untouched (which is how a caller says "no such
   * document"). It may be called more than once, so it must be pure: derive
   * everything from its argument, and do not capture the result of an earlier
   * read from outside.
   *
   * This exists because the git backend cannot merge. Its conflict path used to
   * re-send the same stale body against the newly fetched blob sha, which is
   * not a retry - it is an overwrite. Two people adding a note to the same
   * opportunity in the same minute lost one of the notes, with nothing in the
   * history to say a note had ever existed. Re-running the mutation against
   * what is actually stored is what makes both survive.
   */
  update<T extends StoredDocument>(
    collection: Collection,
    id: string,
    mutate: (current: T | null) => T | null,
  ): Promise<T | null>;
  remove(collection: Collection, id: string): Promise<void>;
  /** Drop a whole collection. Used by the seed's --reset and by clearing a simulation. */
  clear(collection: Collection): Promise<void>;
}

export class CrmStoreNotWritableError extends Error {
  readonly code = "crm_store_not_writable";
  constructor(detail: string) {
    super(`This deployment cannot write CRM state: ${detail}`);
    this.name = "CrmStoreNotWritableError";
  }
}

/**
 * Stable JSON, so an unchanged document serialises byte-identically and the
 * write can be skipped. Key order from `JSON.stringify` follows insertion order,
 * which differs between a freshly built object and one parsed from storage.
 */
export function serialise(document: unknown): string {
  return `${JSON.stringify(document, sortedReplacer, 2)}\n`;
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(entries);
}

/**
 * How many times a conflicting read-modify-write is re-run before it gives up.
 *
 * Bounded rather than open-ended: a document under genuine contention from two
 * writers settles on the second attempt, and a loop that never stops would turn
 * a broken backend into a hung request instead of an error.
 */
export const MAX_UPDATE_ATTEMPTS = 4;

/** A document id safe to use as a file name in any backend. */
export function documentId(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, "-"))
    .filter(Boolean)
    .join("__");
}
