/**
 * Reading one saved search's whole match set, once, for both matchers.
 *
 * The browser evaluates criteria with DuckDB-WASM and the scheduled runner does
 * it with native DuckDB, but they ask the same interface the same question, so
 * they ask it from here. A second copy of this loop is how the two matchers
 * would come to watch different things.
 *
 * What one sweep produces is deliberately three different sizes:
 *
 * - **ids** for the entire match set, up to `MATCH_ID_CAP`. This is what makes
 *   "newly matches" answerable at any rank, and it is eleven bytes a parcel.
 * - **rows** with a fingerprint and a material snapshot for the best
 *   `TRACKED_MATCH_CAP`, which is what "changed underneath you" needs and is
 *   roughly a kilobyte a parcel.
 * - **detail rows** for up to `NEW_MATCH_DETAIL_CAP` parcels ranked below that
 *   cap which the caller has not seen matching before. These cost nothing extra
 *   to produce - the sweep has already materialised the row - and they are what
 *   turns "rank 5,000 newly matches" from a number in the run evidence into an
 *   alert with an address, an owner, a score and a rationale on it.
 *
 * `previousIds` is a hint, not a decision. The evaluator re-derives what is new
 * from the set it has stored, using the same `newAgainst` this module uses; if
 * the hint was stale the pass carries detail it does not need, or misses detail
 * for a parcel it then reports as detected without detail. It never changes
 * what is alerted on.
 */

import type { CriteriaSet } from "@/lib/criteria/types";
import type { Overlay } from "@/lib/data/overlay";
import type { PropertyDataSource } from "@/lib/data/types";

import {
  MATCH_ID_CAP,
  MATCH_ID_PAGE_SIZE,
  NEW_MATCH_DETAIL_CAP,
  TRACKED_MATCH_CAP,
} from "./limits";
import { encodeMatchIds, type MatchIdSet } from "./match-ids";
import { toEvaluatedMatch } from "./snapshot";
import type { EvaluatedMatch } from "./evaluate";

export interface CollectOptions {
  criteria: CriteriaSet;
  overlay?: Overlay;
  /**
   * Parcels the caller already knows this search was matching. Used only to
   * decide which rows below the snapshot cap are worth carrying detail for.
   */
  previousIds?: ReadonlySet<string> | null;
  /** Overridable so a test can exercise paging without a 200,000 row fixture. */
  snapshotLimit?: number;
  idCap?: number;
  pageSize?: number;
  detailCap?: number;
  /** Called after each page, so a slow sweep can show progress. */
  onPage?: (collected: number, matched: number) => void;
}

export interface CollectedMatches {
  /** Everything the criteria select, before any cap. */
  matched: number;
  /** Every matching parcel id the sweep retrieved, in score order. */
  ids: string[];
  /** The same ids in the form that is stored and posted. */
  matchIds: MatchIdSet;
  /**
   * Fingerprinted rows: the best `snapshotLimit` by score, followed by up to
   * `detailCap` lower ranked parcels the caller had not seen matching.
   */
  rows: EvaluatedMatch[];
  /** True when the criteria matched more parcels than the sweep retrieved. */
  truncated: boolean;
  /** How many pages the sweep read. Reported so a slow pass is explainable. */
  pages: number;
}

export async function collectMatches(
  source: PropertyDataSource,
  options: CollectOptions,
): Promise<CollectedMatches> {
  const pageSize = Math.max(1, options.pageSize ?? MATCH_ID_PAGE_SIZE);
  const idCap = Math.max(1, options.idCap ?? MATCH_ID_CAP);
  const snapshotLimit = Math.max(0, options.snapshotLimit ?? TRACKED_MATCH_CAP);
  const detailCap = Math.max(0, options.detailCap ?? NEW_MATCH_DETAIL_CAP);
  const previousIds = options.previousIds ?? null;

  const ids: string[] = [];
  const tracked: EvaluatedMatch[] = [];
  const detail: EvaluatedMatch[] = [];
  let matched = 0;
  let offset = 0;
  let pages = 0;

  for (;;) {
    const page = await source.search({
      criteria: options.criteria,
      limit: pageSize,
      offset,
      orderBy: "score",
      overlay: options.overlay,
    });
    pages += 1;
    matched = page.total;

    if (page.rows.length === 0) break;

    for (const scored of page.rows) {
      if (ids.length >= idCap) break;
      const id = scored.property.propertyId;
      ids.push(id);

      if (tracked.length < snapshotLimit) {
        tracked.push(toEvaluatedMatch(scored));
      } else if (previousIds && detail.length < detailCap && !previousIds.has(id)) {
        detail.push(toEvaluatedMatch(scored));
      }
    }

    offset += page.rows.length;
    options.onPage?.(ids.length, matched);

    // Three separate reasons to stop, and all three are needed: the cap, a
    // short page (the engine had nothing more), and having reached the count.
    // Without the last one a source whose count and rows disagree would page
    // for ever.
    if (ids.length >= idCap) break;
    if (page.rows.length < pageSize) break;
    if (offset >= matched) break;
  }

  const truncated = matched > ids.length;

  return {
    matched,
    ids,
    matchIds: encodeMatchIds(ids, truncated),
    rows: [...tracked, ...detail],
    truncated,
    pages,
  };
}
