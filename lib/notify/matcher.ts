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

import { and, eq, inArray, sql } from "drizzle-orm";

import { criteriaSetSchema, type CriteriaSet } from "@/lib/criteria/types";
import { materialSnapshot } from "@/lib/criteria/score";
import { displayAddress } from "@/lib/data/map";
import type { PropertyDataSource, ScoredProperty } from "@/lib/data/types";
import { loadOverlay } from "@/lib/crm/overlay";
import { db } from "@/lib/crm/db";
import { alerts, savedSearches } from "@/lib/crm/schema";
import { evaluateAndAlert, type MatcherResult, type SearchEvaluation } from "./evaluate";
import { logEvent } from "./log";

export type { MatcherResult, SearchOutcome } from "./evaluate";

/**
 * The most parcels one search is evaluated over in a pass. A criteria set
 * broader than this is a browsing query rather than a watch list, and the pass
 * records that it was truncated rather than silently narrowing.
 */
export const MATCH_EVALUATION_CAP = 5_000;

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
  const database = db();
  const trigger = options.trigger ?? "cron";

  const [info, overlaySummary, runs] = await Promise.all([
    source.info(),
    loadOverlay(),
    source.listRuns(1),
  ]);

  // A simulated change is its own run and takes precedence: by construction it
  // is the most recent thing that happened to the data.
  const simulated = overlaySummary.simulatedRunIds.at(-1) ?? null;
  const latest = runs[0] ?? null;
  const pipelineRunId = simulated ?? latest?.runId ?? info.runId ?? null;

  const searches = await database
    .select()
    .from(savedSearches)
    .where(
      options.savedSearchIds?.length
        ? and(
            eq(savedSearches.active, true),
            inArray(savedSearches.id, [...options.savedSearchIds]),
          )
        : eq(savedSearches.active, true),
    );

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

  return evaluateAndAlert(database, {
    trigger,
    pipelineRunId,
    pipelineRunStartedAt: latest?.startedAt ?? null,
    dataSource: {
      kind: info.kind,
      location: info.location,
      rowCount: info.rowCount,
      isSample: info.isSample,
    },
    evaluations,
    now: options.now,
  });
}

/** Count of unread alerts, for the header badge. */
export async function unreadAlertCount(): Promise<number> {
  const database = db();
  const [row] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(alerts)
    .where(sql`${alerts.readAt} IS NULL AND ${alerts.dismissedAt} IS NULL`);
  return row?.count ?? 0;
}
