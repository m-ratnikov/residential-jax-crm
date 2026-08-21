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
import { TRACKED_MATCH_CAP } from "./limits";
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
  /**
   * The run that produced the artifact this pass read, taken from the parquet
   * itself rather than from the published run history. Two passes that read the
   * same generation are reading the same bytes.
   */
  artifactRunId?: string | null;
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
  /**
   * Fingerprints that moved without the artifact moving. Always zero on a
   * healthy source; a non-zero count means one name resolved to two different
   * generations, and is recorded rather than alerted on.
   */
  unstableReads: number;
  alertsCreated: number;
  alertsSuppressed: number;
  truncated: boolean;
  /**
   * How many of `matched` this search now watches, and whether that is all of
   * them. `matched` is what the criteria select; `trackedMatches` is what the
   * next pass can diff against. When they differ, a change to anything outside
   * the tracked set raises nothing, and a screen showing `matched` on its own
   * is describing a watch that is not happening.
   */
  trackedMatches: number;
  matchesTruncated: boolean;
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
 * The identity of the logical pass, as distinct from the identity of this
 * attempt at it.
 *
 * `matcherRunId` is minted per attempt, which is right for the evidence record -
 * a retry is a second run and gets its own row - and wrong for the alert key.
 * With the attempt id in the key, a pass that delivered some alerts and then
 * timed out before writing the search snapshot would, on retry, mint new ids for
 * the same findings and notify a second time. The alert key has to name the pass
 * the alert is evidence OF.
 *
 * A logical pass is one trigger reading one generation of the data, so that is
 * the key: the artifact run id, which already accounts for an overlay
 * republishing values under an unchanged parquet, falling back to the pipeline
 * run id. Retrying a cron pass over the same artifact therefore recomputes the
 * same alert ids, and the existing-document check ahead of `deliverAlert` turns
 * the retry into a no-op.
 *
 * What this does NOT guarantee, stated plainly because the previous comment
 * overstated it:
 *
 * - A pass with no run id to name - a manual or browser pass against a source
 *   that publishes none - has no stable identity, so it falls back to the
 *   attempt id and a retry of it CAN notify twice. There is nothing to key on;
 *   inventing one from the clock would only make the duplicate harder to see.
 * - Delivery itself is at-least-once. A crash between `deliverAlert` returning
 *   and the alert document being written loses the record of a notification that
 *   was already sent, and the retry will send it again.
 * The trigger is deliberately NOT part of the key. It was, on the reasoning that
 * a manual "check now" after a cron pass is a different logical pass - but a
 * second pass over an unchanged artifact can only differ if the read was
 * unstable, and that case is already suppressed above. So including the trigger
 * bought nothing and cost the guarantee: it meant a cron pass and a browser pass
 * racing over the same generation could each raise the same change under
 * different ids. Keyed on the generation alone, any pass repeating any other
 * pass's work over the same data is a no-op, whoever started it.
 */
function logicalPassId(input: EvaluateInput, attemptId: string): string {
  const generation = input.dataSource.artifactRunId ?? input.pipelineRunId;
  return generation ?? attemptId;
}

export async function evaluateAndAlert(input: EvaluateInput): Promise<MatcherResult> {
  const store = crmStore();
  const startedAt = (input.now ?? new Date()).toISOString();
  const runId = input.pipelineRunId;
  const artifactRunId = input.dataSource.artifactRunId ?? null;

  // "New" is what makes an alert attributable to a county refresh rather than to
  // the matcher simply waking up.
  const pipelineRunIsNew = runId ? !(await hasSeenPipelineRun(runId)) : false;

  const matcherRunId = newId();
  const passId = logicalPassId(input, matcherRunId);
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
        unstableReads: 0,
        alertsCreated: 0,
        alertsSuppressed: 0,
        truncated: evaluation.truncated,
        // Carried from the last pass until this one replaces them, so a search
        // that errored still reports the watch it currently has.
        trackedMatches: Object.keys(search.matches ?? {}).length,
        matchesTruncated: search.matchesTruncated,
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
            // Same artifact, different fingerprint, is not a change in the
            // world - it is a bug in the reader, and raising it would be
            // telling somebody a house moved when a parser did.
            //
            // This is not hypothetical. Four consecutive cron passes alerted on
            // the same 23 parcels, alternating `lastSaleDate` between a date and
            // null, because a gateway resolved one IPNS name to two different
            // pinned generations while `run-history.json` still named an older
            // run. Comparing across generations is the job; comparing two reads
            // of the same generation and believing the difference is not.
            const sameArtifact =
              Boolean(before.artifactRunId) && before.artifactRunId === artifactRunId;
            if (sameArtifact) {
              outcome.unstableReads += 1;
              continue;
            }

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
          const id = alertId(passId, search.id, item.match.propertyId);

          // The key is the constraint: a retry of this logical pass recomputes
          // the same id, finds the document already there and delivers nothing.
          // See logicalPassId() for what that does and does not cover.
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
        // is stored on the document and rewritten whenever it changes, and the
        // cap is reported rather than applied quietly: see TRACKED_MATCH_CAP.
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
            artifactRunId,
          };
        }

        outcome.leftMatches = Object.keys(previous).filter((id) => !matches[id]).length;

        // Two caps sit between "matches" and "watched": the evaluation cap the
        // engine applied before this module saw a row, and TRACKED_MATCH_CAP
        // here. Comparing the tracked set against the full match count covers
        // both, where comparing it against the rows that survived the first cap
        // reported only the second and called a partial watch complete.
        outcome.trackedMatches = tracked.length;
        outcome.matchesTruncated = evaluation.matched > tracked.length;

        await store.put<SavedSearchDoc>("searches", {
          ...search,
          matches,
          matchesTruncated: outcome.matchesTruncated,
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

export { TRACKED_MATCH_CAP };
