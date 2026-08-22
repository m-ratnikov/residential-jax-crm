"use client";

/**
 * Running a matcher pass from the tab.
 *
 * The browser holds the query engine, so it is the browser that evaluates
 * criteria against the published parquet and posts what it found. The server
 * then applies the shared decision logic: diff against the last pass, seed a
 * new search rather than announcing it, cap alerts per search, write the
 * evidence record.
 *
 * This exists so the whole loop can be demonstrated in one sitting - define
 * criteria, simulate an update, watch the alert arrive - without waiting for
 * the half-hourly cron. The cron does exactly the same thing from GitHub
 * Actions with native DuckDB, and its alerts are indistinguishable because the
 * deciding code is the same.
 */

import { criteriaSetSchema } from "@/lib/criteria/types";
import { fetchOverlay, propertySource } from "@/lib/data/client-source";
import { postLarge, type SavedSearch } from "@/lib/client";
import { collectMatches } from "./collect";
import { MATCH_ID_CAP } from "./limits";
import { decodeMatchIds, type MatchIdSet } from "./match-ids";
import type { MatcherResult, SearchEvaluation } from "./evaluate";

/**
 * How many matches the browser evaluates and sends per saved search.
 *
 * Two different weights travel per search, and separating them is the point:
 *
 * - **Ids** for the whole match set, up to `MATCH_ID_CAP`. Grouped by id
 *   prefix, 151,856 ids weigh about 1.2 MB before compression, and `postLarge`
 *   gzips anything over half a megabyte.
 * - **Fingerprinted rows** for the best 2,000 plus detail for up to 500 newly
 *   matching parcels below that. This is the megabyte-scale half, and it is why
 *   the row cap has not moved.
 *
 * The row cap was 5,000 while the server kept the best 2,000, so three fifths
 * of every payload was transferred and discarded - and the payload was the
 * problem: all searches went up in one request and the deployed runtime
 * answered `413 Payload Too Large`, which killed two steps of the demo script.
 * Raising ids rather than rows is what keeps that fixed while making the watch
 * complete.
 */
export const MATCH_EVALUATION_CAP = MATCH_ID_CAP;

export interface RunPassOptions {
  /** Limit the pass to these saved searches. Used right after a simulation. */
  savedSearchIds?: readonly string[];
  trigger?: "manual" | "simulation" | "browser";
  /** Called between searches so the UI can show progress on a slow pass. */
  onProgress?: (done: number, total: number, name: string) => void;
}

/**
 * Evaluate the active saved searches in this tab and post the result.
 *
 * @throws if the CRM store is unreachable. Search itself needs no store, so the
 * caller distinguishes "nothing to match against" from "the query failed".
 */
export async function runMatcherPass(options: RunPassOptions = {}): Promise<MatcherResult> {
  const source = propertySource();

  const [{ searches }, overlay, info, runs] = await Promise.all([
    (await fetch("/api/searches").then((response) => response.json())) as Promise<{
      searches: SavedSearch[];
    }>,
    fetchOverlay(),
    source.info(),
    source.listRuns(1),
  ]);

  const wanted = options.savedSearchIds?.length
    ? searches.filter((search) => options.savedSearchIds?.includes(search.id))
    : searches.filter((search) => search.active);

  // A simulated change is its own run and takes precedence: by construction it
  // is the most recent thing that happened to the data.
  const simulated = overlay.simulatedRunIds.at(-1) ?? null;
  // The artifact's own run_id leads; see the note in matcher.ts. The two
  // matchers must agree on this or a browser pass and a cron pass would stamp
  // the same data with different runs.
  const latest = runs[0] ?? null;
  const pipelineRunId = simulated ?? info.runId ?? latest?.runId ?? null;

  // What the store already believes each of these searches matches.
  //
  // The tab holds the query engine, so only the tab can find what matches now;
  // only the store knows what matched before. An alert for a parcel that newly
  // matches needs an address, an owner and a rationale on it, and none of that
  // is recoverable from an id - so the sweep below keeps the rows it has
  // already materialised for parcels this list does not hold. It decides
  // nothing: the server re-derives what is new from its own stored set when
  // this pass is posted.
  const known = await knownMatchIds(wanted.map((search) => search.id));

  const evaluations: SearchEvaluation[] = [];
  let done = 0;

  for (const search of wanted) {
    options.onProgress?.(done, wanted.length, search.name);
    done += 1;

    const parsed = criteriaSetSchema.safeParse(search.criteria);
    if (!parsed.success) {
      evaluations.push({
        savedSearchId: search.id,
        matched: 0,
        rows: [],
        truncated: false,
        error: "the stored criteria set failed validation and was skipped",
      });
      continue;
    }

    try {
      const previous = known.get(search.id);
      const result = await collectMatches(source, {
        criteria: parsed.data,
        overlay: overlay.overlay,
        previousIds: previous ? decodeMatchIds(previous) : null,
        // A sweep over 151,856 matches is 31 ordered pages, because that is what
        // the data source will answer in one query. Reporting the search again
        // per page is what keeps a long pass from looking like a hung one.
        onPage: () => options.onProgress?.(done - 1, wanted.length, search.name),
      });

      evaluations.push({
        savedSearchId: search.id,
        matched: result.matched,
        truncated: result.truncated,
        rows: result.rows,
        matchIds: result.matchIds,
      });
    } catch (error: unknown) {
      evaluations.push({
        savedSearchId: search.id,
        matched: 0,
        rows: [],
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  options.onProgress?.(wanted.length, wanted.length, "");

  return postLarge<MatcherResult>("/api/matcher/run", {
    trigger: options.trigger ?? "browser",
    pipelineRunId,
    pipelineRunStartedAt: latest?.startedAt ?? null,
    dataSource: {
      kind: info.kind,
      location: info.location,
      rowCount: info.rowCount,
      isSample: info.isSample,
      // The identity of the DATA this pass read, not of the parquet alone: an
      // overlay - a simulated pipeline update, or court records - changes the
      // values without changing the file underneath them. Stamping the parquet
      // alone would make the suppression below swallow a simulated change,
      // which is the one change we know for certain is real.
      artifactRunId: simulated ?? info.runId,
    },
    evaluations,
  });
}

interface KnownResponse {
  known?: { savedSearchId: string; matchIds: MatchIdSet | null }[];
}

/**
 * Ask the matcher endpoint what it already knows each search matches.
 *
 * A failure here is not a failed pass. The worst case is that the sweep carries
 * detail for parcels the server will not raise, or none for parcels it will and
 * then reports them as detected without detail - so this degrades to an empty
 * map rather than taking the pass down with it.
 */
async function knownMatchIds(ids: readonly string[]): Promise<Map<string, MatchIdSet>> {
  const map = new Map<string, MatchIdSet>();
  if (ids.length === 0) return map;

  try {
    const response = await fetch(`/api/matcher/run?knownFor=${encodeURIComponent(ids.join(","))}`, {
      cache: "no-store",
    });
    if (!response.ok) return map;
    const body = (await response.json()) as KnownResponse;
    for (const entry of body.known ?? []) {
      if (entry.matchIds) map.set(entry.savedSearchId, entry.matchIds);
    }
  } catch {
    return map;
  }

  return map;
}
