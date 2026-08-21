/**
 * The scheduled matcher.
 *
 * One pass: read the current data source, re-evaluate every active saved
 * search, diff the result against the snapshot stored from last time, and raise
 * an alert for each parcel that is new to a search or whose material fields
 * moved. Then deliver those alerts down the channels the search asked for.
 *
 * The shape is the kit's `watchog` pattern ported off AWS: diff each new
 * snapshot against the last stored one, and persist an immutable evidence
 * record for every pass whether or not it fired. A notification history that
 * only records the passes that produced something cannot answer "why did
 * nothing arrive last night", which is the question actually asked.
 *
 * Three properties this has to hold, because a notifier that gets them wrong is
 * worse than none:
 *
 * 1. **A new saved search seeds, it does not shout.** The first pass over a
 *    search records what already matches without alerting. Otherwise saving
 *    "roofs over fifteen years" would fire three hundred thousand alerts about
 *    parcels that have been sitting there for a decade. What the user asked to
 *    be told about is what changes from now on.
 * 2. **Re-running is safe.** Alerts are unique on (search, property, pass), so
 *    a retry after a timeout cannot double notify.
 * 3. **A huge search is capped, and says so.** A criteria set matching forty
 *    thousand parcels is a legitimate thing to save and a terrible thing to be
 *    notified about one row at a time. Each search caps its alerts per pass and
 *    the pass records how many it suppressed.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import { criteriaSetSchema, type CriteriaSet } from "@/lib/criteria/types";
import { changedFields, materialSnapshot } from "@/lib/criteria/score";
import { displayAddress } from "@/lib/data/map";
import { runDelta } from "@/lib/data/runs";
import type { PipelineRun, PropertyDataSource, ScoredProperty } from "@/lib/data/types";
import { loadOverlay } from "@/lib/crm/overlay";
import { db, type CrmDatabase } from "@/lib/crm/db";
import {
  alerts,
  matcherRuns,
  savedSearches,
  searchMatches,
} from "@/lib/crm/schema";
import { deliverAlert } from "./deliver";
import { logEvent } from "./log";

/**
 * The most parcels one search will be evaluated over in a pass. A criteria set
 * broader than this is a browsing query, not a watch list, and the pass says so
 * rather than silently truncating.
 */
export const MATCH_EVALUATION_CAP = 5_000;

export type MatcherTrigger = "cron" | "manual" | "simulation";

export interface MatcherOptions {
  trigger?: MatcherTrigger;
  /** Limit the pass to these saved searches. Used after a simulated update. */
  savedSearchIds?: readonly string[];
  /** Injected for tests. */
  now?: Date;
}

export interface SearchOutcome {
  savedSearchId: string;
  name: string;
  matched: number;
  evaluated: number;
  seeded: boolean;
  newMatches: number;
  updatedMatches: number;
  leftMatches: number;
  alertsCreated: number;
  alertsSuppressed: number;
  truncated: boolean;
  error?: string;
}

export interface MatcherResult {
  matcherRunId: string;
  trigger: MatcherTrigger;
  pipelineRunId: string | null;
  pipelineRunIsNew: boolean;
  searchesEvaluated: number;
  propertiesEvaluated: number;
  alertsCreated: number;
  alertsSuppressed: number;
  notificationsSent: number;
  outcomes: SearchOutcome[];
  startedAt: string;
  finishedAt: string;
  error?: string;
}

/**
 * Which upstream run this pass is evaluating, and whether the CRM has seen it
 * before. "New" is what makes an alert attributable to a county refresh rather
 * than to the matcher simply waking up.
 */
async function resolvePipelineRun(
  database: CrmDatabase,
  source: PropertyDataSource,
  simulatedRunIds: readonly string[],
): Promise<{ run: PipelineRun | null; isNew: boolean; runId: string | null }> {
  // A simulated change is its own run and takes precedence: it is the most
  // recent thing that happened to the data, by construction.
  const simulated = simulatedRunIds.at(-1) ?? null;

  const runs = await source.listRuns(5);
  const latest = runs[0] ?? null;
  const runId = simulated ?? latest?.runId ?? null;
  if (!runId) return { run: null, isNew: false, runId: null };

  const seen = await database
    .select({ id: matcherRuns.id })
    .from(matcherRuns)
    .where(eq(matcherRuns.pipelineRunId, runId))
    .limit(1);

  return { run: latest, isNew: seen.length === 0, runId };
}

function parseCriteria(raw: unknown, fallbackName: string): CriteriaSet | null {
  const parsed = criteriaSetSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logEvent("matcher.criteria_invalid", {
    name: fallbackName,
    issues: parsed.error.issues.map((issue) => issue.message).slice(0, 5),
  });
  return null;
}

/** A compact record of the parcel as it looked when the alert fired. */
function alertSnapshot(scored: ScoredProperty): Record<string, unknown> {
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
    material: materialSnapshot(property),
  };
}

export async function runMatcher(
  source: PropertyDataSource,
  options: MatcherOptions = {},
): Promise<MatcherResult> {
  const database = db();
  const trigger = options.trigger ?? "cron";
  const startedAt = options.now ?? new Date();

  const [info, overlaySummary] = await Promise.all([source.info(), loadOverlay()]);
  const { run, isNew, runId } = await resolvePipelineRun(
    database,
    source,
    overlaySummary.simulatedRunIds,
  );

  const [created] = await database
    .insert(matcherRuns)
    .values({
      startedAt,
      trigger,
      pipelineRunId: runId,
      pipelineRunStartedAt: run?.startedAt ? new Date(run.startedAt) : null,
      pipelineRunIsNew: isNew,
      dataSourceKind: info.kind,
      dataSourceLocation: info.location,
      dataSourceRowCount: info.rowCount,
      dataSourceIsSample: info.isSample,
    })
    .returning({ id: matcherRuns.id });

  const matcherRunId = created?.id;
  if (!matcherRunId) throw new Error("could not open a matcher run");

  const outcomes: SearchOutcome[] = [];
  let alertsCreated = 0;
  let alertsSuppressed = 0;
  let propertiesEvaluated = 0;
  let notificationsSent = 0;
  let fatal: string | undefined;

  try {
    const searches = await database
      .select()
      .from(savedSearches)
      .where(
        options.savedSearchIds?.length
          ? and(eq(savedSearches.active, true), inArray(savedSearches.id, [...options.savedSearchIds]))
          : eq(savedSearches.active, true),
      );

    for (const search of searches) {
      const outcome: SearchOutcome = {
        savedSearchId: search.id,
        name: search.name,
        matched: 0,
        evaluated: 0,
        seeded: false,
        newMatches: 0,
        updatedMatches: 0,
        leftMatches: 0,
        alertsCreated: 0,
        alertsSuppressed: 0,
        truncated: false,
      };

      try {
        const criteria = parseCriteria(search.criteria, search.name);
        if (!criteria) {
          outcome.error = "the stored criteria set failed validation and was skipped";
          outcomes.push(outcome);
          continue;
        }

        const result = await source.search({
          criteria,
          limit: MATCH_EVALUATION_CAP,
          orderBy: "score",
          overlay: overlaySummary.overlay,
        });

        outcome.matched = result.total;
        outcome.evaluated = result.rows.length;
        outcome.truncated = result.total > result.rows.length;
        propertiesEvaluated += result.rows.length;

        const previous = await database
          .select()
          .from(searchMatches)
          .where(eq(searchMatches.savedSearchId, search.id));

        const previousById = new Map(previous.map((row) => [row.propertyId, row]));
        // A search the matcher has never evaluated is seeded, not announced.
        const seeding = previous.length === 0;
        outcome.seeded = seeding;

        const pending: {
          scored: ScoredProperty;
          kind: "new_match" | "updated_match";
          changed: string[];
        }[] = [];

        for (const scored of result.rows) {
          const before = previousById.get(scored.property.propertyId);
          if (!before) {
            if (!seeding) pending.push({ scored, kind: "new_match", changed: [] });
            outcome.newMatches += seeding ? 0 : 1;
          } else if (before.matchHash !== scored.matchHash) {
            const changed = changedFields(
              (before.snapshot ?? {}) as Record<string, unknown>,
              scored.property,
            );
            // A hash that moved on no material field means the fingerprint
            // covers something the diff does not name; alerting on it would be
            // an alert nobody can act on.
            if (changed.length) {
              pending.push({ scored, kind: "updated_match", changed });
              outcome.updatedMatches += 1;
            }
          }
        }

        const cap = search.alertLimitPerRun;
        const toRaise = pending.slice(0, cap);
        outcome.alertsSuppressed = pending.length - toRaise.length;
        alertsSuppressed += outcome.alertsSuppressed;

        for (const item of toRaise) {
          const [alert] = await database
            .insert(alerts)
            .values({
              savedSearchId: search.id,
              matcherRunId,
              kind: item.kind,
              propertyId: item.scored.property.propertyId,
              propertySnapshot: alertSnapshot(item.scored),
              score: item.scored.score,
              rationale: item.scored.rationale,
              changedFields: item.changed,
              pipelineRunId: runId,
            })
            // Unique on (search, property, pass): a retry cannot double notify.
            .onConflictDoNothing()
            .returning({ id: alerts.id });

          if (!alert) continue;
          outcome.alertsCreated += 1;
          alertsCreated += 1;

          notificationsSent += await deliverAlert(database, {
            alertId: alert.id,
            search,
            scored: item.scored,
            kind: item.kind,
            changed: item.changed,
            pipelineRunId: runId,
          });
        }

        // Replace the snapshot with what was just observed.
        const currentIds = new Set(result.rows.map((row) => row.property.propertyId));
        const gone = previous.filter((row) => !currentIds.has(row.propertyId));
        outcome.leftMatches = gone.length;

        if (gone.length) {
          await database.delete(searchMatches).where(
            and(
              eq(searchMatches.savedSearchId, search.id),
              inArray(
                searchMatches.propertyId,
                gone.map((row) => row.propertyId),
              ),
            ),
          );
        }

        for (const scored of result.rows) {
          await database
            .insert(searchMatches)
            .values({
              savedSearchId: search.id,
              propertyId: scored.property.propertyId,
              matchHash: scored.matchHash,
              snapshot: materialSnapshot(scored.property),
              score: scored.score,
              lastSeenAt: startedAt,
              lastRunId: runId,
            })
            .onConflictDoUpdate({
              target: [searchMatches.savedSearchId, searchMatches.propertyId],
              set: {
                matchHash: scored.matchHash,
                snapshot: materialSnapshot(scored.property),
                score: scored.score,
                lastSeenAt: startedAt,
                lastRunId: runId,
              },
            });
        }

        await database
          .update(savedSearches)
          .set({
            lastEvaluatedAt: startedAt,
            lastPipelineRunId: runId,
            lastMatchCount: result.total,
            updatedAt: startedAt,
          })
          .where(eq(savedSearches.id, search.id));
      } catch (error: unknown) {
        outcome.error = error instanceof Error ? error.message : String(error);
        logEvent("matcher.search_failed", { savedSearchId: search.id, error: outcome.error });
      }

      outcomes.push(outcome);
    }
  } catch (error: unknown) {
    fatal = error instanceof Error ? error.message : String(error);
    logEvent("matcher.failed", { error: fatal });
  }

  const finishedAt = new Date();
  const delta = run ? runDelta(run) : null;

  await database
    .update(matcherRuns)
    .set({
      finishedAt,
      searchesEvaluated: outcomes.length,
      propertiesEvaluated,
      alertsCreated,
      alertsSuppressed,
      notificationsSent,
      detail: {
        outcomes,
        upstream: run
          ? {
              runId: run.runId,
              status: run.status,
              startedAt: run.startedAt,
              tracks: run.tracks,
              delta,
              limitations: run.limitations,
            }
          : null,
        overlay: {
          courtProperties: overlaySummary.courtPropertyCount,
          simulatedProperties: overlaySummary.simulatedPropertyCount,
          simulatedRunIds: overlaySummary.simulatedRunIds,
        },
      },
      error: fatal ?? null,
    })
    .where(eq(matcherRuns.id, matcherRunId));

  logEvent("matcher.finished", {
    matcherRunId,
    trigger,
    pipelineRunId: runId,
    searches: outcomes.length,
    alertsCreated,
    alertsSuppressed,
    notificationsSent,
    ms: finishedAt.getTime() - startedAt.getTime(),
  });

  return {
    matcherRunId,
    trigger,
    pipelineRunId: runId,
    pipelineRunIsNew: isNew,
    searchesEvaluated: outcomes.length,
    propertiesEvaluated,
    alertsCreated,
    alertsSuppressed,
    notificationsSent,
    outcomes,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    error: fatal,
  };
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
