/**
 * The Node side of the matcher: produce matches, then hand them to the shared
 * decision logic.
 *
 * This is what the scheduled runner in GitHub Actions calls. It reads the
 * published artifact with whatever query engine is available - natively, with
 * range reads, in that environment - evaluates every active saved search, and
 * passes the result to `evaluateAndAlert`, which is the same code the browser's
 * matches go through. The diffing, the seeding rule, the alert cap and the
 * evidence record all live there precisely so that an alert raised by the cron
 * and an alert raised from the app cannot differ.
 */

import { criteriaSetSchema, type CriteriaSet } from "@/lib/criteria/types";
import type { PropertyDataSource } from "@/lib/data/types";
import { loadOverlay } from "@/lib/crm/overlay";
import { listSavedSearches } from "@/lib/crm/repo";
import { collectMatches } from "./collect";
import {
  evaluateAndAlert,
  MATCH_ID_CAP,
  type MatcherResult,
  type SearchEvaluation,
} from "./evaluate";
import { decodeMatchIds, hasMatchIdSet } from "./match-ids";
import { logEvent } from "./log";
// Defined in an isomorphic module so the browser matcher builds the identical
// record; re-exported here because this is where callers expect to find it.
import { alertSnapshot, toEvaluatedMatch } from "./snapshot";

export { alertSnapshot, toEvaluatedMatch };

export type { MatcherResult, SearchOutcome } from "./evaluate";

/**
 * The most parcels one search is evaluated over in a pass. A criteria set
 * broader than this is a browsing query rather than a watch list, and the pass
 * records that it was truncated rather than silently narrowing.
 *
 * It is no longer the same number as `TRACKED_MATCH_CAP`. It was, and that is
 * what made a pass unable to see rank 2,001 at all: see `MATCH_ID_CAP`.
 */
export const MATCH_EVALUATION_CAP = MATCH_ID_CAP;

export type MatcherTrigger = "cron" | "manual" | "simulation";

export interface MatcherOptions {
  trigger?: MatcherTrigger;
  /** Limit the pass to these saved searches. Used after a simulated update. */
  savedSearchIds?: readonly string[];
  now?: Date;
}

function parseCriteria(raw: unknown, name: string): CriteriaSet | null {
  const parsed = criteriaSetSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logEvent("matcher.criteria_invalid", {
    name,
    issues: parsed.error.issues.map((issue) => issue.message).slice(0, 5),
  });
  return null;
}

export async function runMatcher(
  source: PropertyDataSource,
  options: MatcherOptions = {},
): Promise<MatcherResult> {
  const trigger = options.trigger ?? "cron";

  const [info, overlaySummary, runs] = await Promise.all([
    source.info(),
    loadOverlay(),
    source.listRuns(1),
  ]);

  // A simulated change is its own run and takes precedence: by construction it
  // is the most recent thing that happened to the data.
  // The artifact's own run_id leads, and the published run history is only a
  // fallback. They can disagree - the parquet and run-history.json are separate
  // objects behind separate IPNS names, republished at different moments - and
  // when they do, the values being fingerprinted came from the parquet. A pass
  // stamped with a run id that did not produce the numbers it read is an alert
  // that cites the wrong evidence, which is worse than citing none. Observed:
  // four cron passes all citing 01M0HZCK while the parquet they read had moved
  // on to 01M0K3B6.
  const simulated = overlaySummary.simulatedRunIds.at(-1) ?? null;
  const latest = runs[0] ?? null;
  const pipelineRunId = simulated ?? info.runId ?? latest?.runId ?? null;

  const all = await listSavedSearches();
  const searches = options.savedSearchIds?.length
    ? all.filter((search) => options.savedSearchIds?.includes(search.id))
    : all.filter((search) => search.active);

  const evaluations: SearchEvaluation[] = [];

  for (const search of searches) {
    const criteria = parseCriteria(search.criteria, search.name);
    if (!criteria) {
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
      // The whole match set as ids, the best 2,000 as fingerprinted rows, and
      // detail for the parcels the store has not seen matching before. The
      // browser matcher runs the identical sweep against the identical
      // interface; there is no second implementation of what a pass retrieves,
      // any more than there is of what it alerts on.
      const result = await collectMatches(source, {
        criteria,
        overlay: overlaySummary.overlay,
        previousIds: hasMatchIdSet(search.matchIds) ? decodeMatchIds(search.matchIds) : null,
      });
      logEvent("matcher.swept", {
        savedSearchId: search.id,
        matched: result.matched,
        ids: result.ids.length,
        rows: result.rows.length,
        pages: result.pages,
      });
      evaluations.push({
        savedSearchId: search.id,
        matched: result.matched,
        rows: result.rows,
        truncated: result.truncated,
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

  return evaluateAndAlert({
    trigger,
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
    now: options.now,
  });
}

export { unreadAlertCount } from "@/lib/crm/repo";
