/**
 * The half of the matcher that needs no parcel data.
 *
 * Producing matches and deciding what to alert on are two different jobs with
 * two different dependencies, and separating them is what lets the same
 * decision logic serve both callers:
 *
 * - the **browser**, which evaluates criteria with DuckDB-WASM against the
 *   published parquet and posts what it found;
 * - the **scheduled runner** in GitHub Actions, which does the same with native
 *   DuckDB against the same artifact.
 *
 * Both hand the identical shape to this module, so an alert raised by the cron
 * and an alert raised by pressing a button in the app are produced by exactly
 * the same code. There is no second implementation to drift.
 *
 * Everything here is the `watchog` pattern: diff each new snapshot against the
 * last stored one, and persist an immutable evidence record per pass whether or
 * not it fired.
 */

import { and, eq, inArray } from "drizzle-orm";

import { changedFields } from "@/lib/criteria/score";
import type { CrmDatabase } from "@/lib/crm/db";
import { alerts, matcherRuns, savedSearches, searchMatches } from "@/lib/crm/schema";
import { deliverAlert } from "./deliver";
import { logEvent } from "./log";

/** One matched parcel, as produced by whichever engine evaluated the criteria. */
export interface EvaluatedMatch {
  propertyId: string;
  /** Fingerprint of the material fields, from matchHashOf(). */
  matchHash: string;
  /** The material field values behind that hash, so a diff can name them. */
  snapshot: Record<string, unknown>;
  score: number;
  rationale: string;
  /** Compact record of the parcel as it looked, stored on the alert. */
  propertySnapshot: Record<string, unknown>;
}

/** What one saved search's evaluation produced. */
export interface SearchEvaluation {
  savedSearchId: string;
  /** Total matching before any cap. */
  matched: number;
  /** How many were actually returned and are present in `rows`. */
  rows: EvaluatedMatch[];
  truncated: boolean;
  error?: string;
}

export interface DataSourceStamp {
  kind: string;
  location: string;
  rowCount: number;
  isSample: boolean;
}

export interface EvaluateInput {
  trigger: "cron" | "manual" | "simulation" | "browser";
  pipelineRunId: string | null;
  pipelineRunStartedAt?: string | null;
  dataSource: DataSourceStamp;
  evaluations: SearchEvaluation[];
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
  trigger: string;
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
 * Diff every supplied evaluation against the stored snapshot, raise alerts, and
 * record the pass.
 */
export async function evaluateAndAlert(
  database: CrmDatabase,
  input: EvaluateInput,
): Promise<MatcherResult> {
  const startedAt = input.now ?? new Date();
  const runId = input.pipelineRunId;

  // "New" is what makes an alert attributable to a county refresh rather than
  // to the matcher simply waking up.
  const seen = runId
    ? await database
        .select({ id: matcherRuns.id })
        .from(matcherRuns)
        .where(eq(matcherRuns.pipelineRunId, runId))
        .limit(1)
    : [];
  const pipelineRunIsNew = Boolean(runId) && seen.length === 0;

  const [created] = await database
    .insert(matcherRuns)
    .values({
      startedAt,
      trigger: input.trigger,
      pipelineRunId: runId,
      pipelineRunStartedAt: input.pipelineRunStartedAt
        ? new Date(input.pipelineRunStartedAt)
        : null,
      pipelineRunIsNew,
      dataSourceKind: input.dataSource.kind,
      dataSourceLocation: input.dataSource.location,
      dataSourceRowCount: input.dataSource.rowCount,
      dataSourceIsSample: input.dataSource.isSample,
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
    const ids = input.evaluations.map((evaluation) => evaluation.savedSearchId);
    const searches = ids.length
      ? await database.select().from(savedSearches).where(inArray(savedSearches.id, ids))
      : [];
    const byId = new Map(searches.map((search) => [search.id, search]));

    for (const evaluation of input.evaluations) {
      const search = byId.get(evaluation.savedSearchId);
      if (!search) continue;

      const outcome: SearchOutcome = {
        savedSearchId: search.id,
        name: search.name,
        matched: evaluation.matched,
        evaluated: evaluation.rows.length,
        seeded: false,
        newMatches: 0,
        updatedMatches: 0,
        leftMatches: 0,
        alertsCreated: 0,
        alertsSuppressed: 0,
        truncated: evaluation.truncated,
        error: evaluation.error,
      };

      if (evaluation.error) {
        outcomes.push(outcome);
        continue;
      }

      try {
        propertiesEvaluated += evaluation.rows.length;

        const previous = await database
          .select()
          .from(searchMatches)
          .where(eq(searchMatches.savedSearchId, search.id));
        const previousById = new Map(previous.map((row) => [row.propertyId, row]));

        // A search the matcher has never evaluated is seeded, not announced.
        // Otherwise saving "roofs over fifteen years" fires three hundred
        // thousand alerts about houses that have sat there for a decade.
        const seeding = previous.length === 0;
        outcome.seeded = seeding;

        const pending: { match: EvaluatedMatch; kind: "new_match" | "updated_match"; changed: string[] }[] =
          [];

        for (const match of evaluation.rows) {
          const before = previousById.get(match.propertyId);
          if (!before) {
            if (!seeding) {
              pending.push({ match, kind: "new_match", changed: [] });
              outcome.newMatches += 1;
            }
          } else if (before.matchHash !== match.matchHash) {
            const changed = changedFieldsBetween(before.snapshot, match.snapshot);
            // A fingerprint that moved on no named field is an alert nobody can
            // act on, so it is counted but not raised.
            if (changed.length) {
              pending.push({ match, kind: "updated_match", changed });
              outcome.updatedMatches += 1;
            }
          }
        }

        const toRaise = pending.slice(0, search.alertLimitPerRun);
        outcome.alertsSuppressed = pending.length - toRaise.length;
        alertsSuppressed += outcome.alertsSuppressed;

        for (const item of toRaise) {
          const [alert] = await database
            .insert(alerts)
            .values({
              savedSearchId: search.id,
              matcherRunId,
              kind: item.kind,
              propertyId: item.match.propertyId,
              propertySnapshot: item.match.propertySnapshot,
              score: item.match.score,
              rationale: item.match.rationale,
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
            kind: item.kind,
            changed: item.changed,
            pipelineRunId: runId,
            score: item.match.score,
            rationale: item.match.rationale,
            propertySnapshot: item.match.propertySnapshot,
          });
        }

        // Replace the snapshot with what was just observed.
        const currentIds = new Set(evaluation.rows.map((row) => row.propertyId));
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

        for (const match of evaluation.rows) {
          await database
            .insert(searchMatches)
            .values({
              savedSearchId: search.id,
              propertyId: match.propertyId,
              matchHash: match.matchHash,
              snapshot: match.snapshot,
              score: match.score,
              lastSeenAt: startedAt,
              lastRunId: runId,
            })
            .onConflictDoUpdate({
              target: [searchMatches.savedSearchId, searchMatches.propertyId],
              set: {
                matchHash: match.matchHash,
                snapshot: match.snapshot,
                score: match.score,
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
            lastMatchCount: evaluation.matched,
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

  await database
    .update(matcherRuns)
    .set({
      finishedAt,
      searchesEvaluated: outcomes.length,
      propertiesEvaluated,
      alertsCreated,
      alertsSuppressed,
      notificationsSent,
      detail: { outcomes, dataSource: input.dataSource },
      error: fatal ?? null,
    })
    .where(eq(matcherRuns.id, matcherRunId));

  logEvent("matcher.finished", {
    matcherRunId,
    trigger: input.trigger,
    pipelineRunId: runId,
    searches: outcomes.length,
    alertsCreated,
    alertsSuppressed,
    notificationsSent,
    ms: finishedAt.getTime() - startedAt.getTime(),
  });

  return {
    matcherRunId,
    trigger: input.trigger,
    pipelineRunId: runId,
    pipelineRunIsNew,
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

/**
 * Which stored material fields differ. Works on the plain snapshot objects
 * rather than a PropertyRecord, because that is what crosses the wire.
 */
function changedFieldsBetween(
  before: unknown,
  after: Record<string, unknown>,
): string[] {
  const previous = (before ?? {}) as Record<string, unknown>;
  return changedFields(previous, after as never);
}
