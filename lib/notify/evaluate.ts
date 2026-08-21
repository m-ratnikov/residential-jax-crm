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

import { changedFields } from "@/lib/criteria/score";
import { crmStore } from "@/lib/crm/db";
import {
  newId,
  nowIso,
  type AlertDoc,
  type MatcherRunDoc,
  type MatchSnapshot,
  type SavedSearchDoc,
} from "@/lib/crm/documents";
import { alertId, hasSeenPipelineRun } from "@/lib/crm/repo";
import { deliverAlert } from "./deliver";
import { logEvent } from "./log";

/**
 * How many matching parcels one saved search tracks between passes.
 *
 * The snapshot is what the diff compares against, so it has a real cost: it is
 * stored on the search document and rewritten whenever it changes. A criteria
 * set matching forty thousand parcels is a browsing query rather than a watch
 * list, and the pass records that it capped rather than silently narrowing.
 */
export const TRACKED_MATCH_CAP = 2_000;

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

export async function evaluateAndAlert(input: EvaluateInput): Promise<MatcherResult> {
  const store = crmStore();
  const startedAt = (input.now ?? new Date()).toISOString();
  const runId = input.pipelineRunId;

  // "New" is what makes an alert attributable to a county refresh rather than to
  // the matcher simply waking up.
  const pipelineRunIsNew = runId ? !(await hasSeenPipelineRun(runId)) : false;

  const matcherRunId = newId();
  const outcomes: SearchOutcome[] = [];
  let alertsCreated = 0;
  let alertsSuppressed = 0;
  let propertiesEvaluated = 0;
  let notificationsSent = 0;
  let fatal: string | undefined;

  try {
    for (const evaluation of input.evaluations) {
      const search = await store.get<SavedSearchDoc>("searches", evaluation.savedSearchId);
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

        const previous = search.matches ?? {};
        // A search the matcher has never evaluated is seeded, not announced.
        // Otherwise saving "roofs over fifteen years" fires three hundred
        // thousand alerts about houses that have sat there for a decade.
        const seeding = Object.keys(previous).length === 0;
        outcome.seeded = seeding;

        const pending: {
          match: EvaluatedMatch;
          kind: "new_match" | "updated_match";
          changed: string[];
        }[] = [];

        for (const match of evaluation.rows) {
          const before = previous[match.propertyId];
          if (!before) {
            if (!seeding) {
              pending.push({ match, kind: "new_match", changed: [] });
              outcome.newMatches += 1;
            }
          } else if (before.matchHash !== match.matchHash) {
            const changed = changedFields(before.snapshot, match.snapshot);
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
          const id = alertId(matcherRunId, search.id, item.match.propertyId);

          // The key is the constraint: a retried pass writes the same document
          // rather than a second alert.
          if (await store.get<AlertDoc>("alerts", id)) continue;

          const notifications = await deliverAlert({
            alertId: id,
            search,
            kind: item.kind,
            changed: item.changed,
            pipelineRunId: runId,
            score: item.match.score,
            rationale: item.match.rationale,
            propertySnapshot: item.match.propertySnapshot,
          });

          await store.put<AlertDoc>("alerts", {
            id,
            savedSearchId: search.id,
            matcherRunId,
            kind: item.kind,
            propertyId: item.match.propertyId,
            propertySnapshot: item.match.propertySnapshot,
            score: item.match.score,
            rationale: item.match.rationale,
            changedFields: item.changed,
            pipelineRunId: runId,
            readAt: null,
            dismissedAt: null,
            opportunityId: null,
            createdAt: startedAt,
            notifications,
          });

          outcome.alertsCreated += 1;
          alertsCreated += 1;
          notificationsSent += notifications.length;
        }

        // Replace the snapshot with what was just observed. Capped, because this
        // is stored on the document and rewritten whenever it changes.
        const tracked = evaluation.rows.slice(0, TRACKED_MATCH_CAP);
        const matches: Record<string, MatchSnapshot> = {};
        for (const match of tracked) {
          const before = previous[match.propertyId];
          matches[match.propertyId] = {
            matchHash: match.matchHash,
            snapshot: match.snapshot,
            score: match.score,
            firstSeenAt: before?.firstSeenAt ?? startedAt,
            lastSeenAt: startedAt,
            lastRunId: runId,
          };
        }

        outcome.leftMatches = Object.keys(previous).filter((id) => !matches[id]).length;

        await store.put<SavedSearchDoc>("searches", {
          ...search,
          matches,
          matchesTruncated: evaluation.rows.length > tracked.length,
          lastEvaluatedAt: startedAt,
          lastPipelineRunId: runId,
          lastMatchCount: evaluation.matched,
          updatedAt: startedAt,
        });
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

  const finishedAt = nowIso();

  // Written last and once, so the evidence row reflects the pass that happened
  // rather than one that was still in progress.
  await store.put<MatcherRunDoc>("matcher-runs", {
    id: matcherRunId,
    startedAt,
    finishedAt,
    trigger: input.trigger,
    pipelineRunId: runId,
    pipelineRunStartedAt: input.pipelineRunStartedAt ?? null,
    pipelineRunIsNew,
    dataSourceKind: input.dataSource.kind,
    dataSourceLocation: input.dataSource.location,
    dataSourceRowCount: input.dataSource.rowCount,
    dataSourceIsSample: input.dataSource.isSample,
    searchesEvaluated: outcomes.length,
    propertiesEvaluated,
    alertsCreated,
    alertsSuppressed,
    notificationsSent,
    detail: { outcomes, dataSource: input.dataSource },
    error: fatal ?? null,
  });

  logEvent("matcher.finished", {
    matcherRunId,
    trigger: input.trigger,
    pipelineRunId: runId,
    searches: outcomes.length,
    alertsCreated,
    alertsSuppressed,
    notificationsSent,
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
    startedAt,
    finishedAt,
    error: fatal,
  };
}
