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
import { materialSnapshot } from "@/lib/criteria/score";
import { displayAddress } from "@/lib/data/map";
import type { PropertyDataSource, ScoredProperty } from "@/lib/data/types";
import { loadOverlay } from "@/lib/crm/overlay";
import { listSavedSearches } from "@/lib/crm/repo";
import {
  evaluateAndAlert,
  TRACKED_MATCH_CAP,
  type MatcherResult,
  type SearchEvaluation,
} from "./evaluate";
import { logEvent } from "./log";

export type { MatcherResult, SearchOutcome } from "./evaluate";

/**
 * The most parcels one search is evaluated over in a pass. A criteria set
 * broader than this is a browsing query rather than a watch list, and the pass
 * records that it was truncated rather than silently narrowing.
 */
export const MATCH_EVALUATION_CAP = TRACKED_MATCH_CAP;

export type MatcherTrigger = "cron" | "manual" | "simulation";

export interface MatcherOptions {
  trigger?: MatcherTrigger;
  /** Limit the pass to these saved searches. Used after a simulated update. */
  savedSearchIds?: readonly string[];
  now?: Date;
}

/** A compact record of the parcel as it looked when the alert fired. */
export function alertSnapshot(scored: ScoredProperty): Record<string, unknown> {
  const property = scored.property;
  return {
    propertyId: property.propertyId,
    address: displayAddress(property),
    addressCity: property.addressCity,
    addressZip: property.addressZip,
    latitude: property.latitude,
    longitude: property.longitude,
    ownerName: property.ownerName,
    assessedValue: property.assessedValue,
    roofAgeYears: property.roofAgeYears,
    roofAgeBasis: property.roofAgeBasis,
    yearsSinceLastSale: property.yearsSinceLastSale,
    lastSaleDate: property.lastSaleDate,
    ownerOccupied: property.ownerOccupied,
    homesteadFlag: property.homesteadFlag,
    waterViewFlag: property.waterViewFlag,
    courtDistressScore: property.raw["court_distress_score"] ?? null,
    provenance: property.provenance,
  };
}

/** Turn a scored row into the shape the shared evaluator consumes. */
export function toEvaluatedMatch(scored: ScoredProperty) {
  return {
    propertyId: scored.property.propertyId,
    matchHash: scored.matchHash,
    snapshot: materialSnapshot(scored.property),
    score: scored.score,
    rationale: scored.rationale,
    propertySnapshot: alertSnapshot(scored),
  };
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
      const result = await source.search({
        criteria,
        limit: MATCH_EVALUATION_CAP,
        orderBy: "score",
        overlay: overlaySummary.overlay,
      });
      evaluations.push({
        savedSearchId: search.id,
        matched: result.total,
        rows: result.rows.map(toEvaluatedMatch),
        truncated: result.total > result.rows.length,
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
