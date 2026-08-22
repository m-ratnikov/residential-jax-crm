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
import { MATCH_ID_CAP, TRACKED_MATCH_CAP } from "./limits";
import {
  decodeMatchIds,
  encodeMatchIds,
  goneFrom,
  hasMatchIdSet,
  newAgainst,
  type MatchIdSet,
} from "./match-ids";
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
  /**
   * Fingerprinted rows, best first: the top `TRACKED_MATCH_CAP` by score, plus
   * detail for a bounded number of lower ranked parcels the caller believed to
   * be new. This is what "changed underneath you" is computed from.
   */
  rows: EvaluatedMatch[];
  truncated: boolean;
  /**
   * Every matching parcel id, which is what "newly matches" is computed from.
   *
   * Optional. A caller that supplies none is taken to have retrieved only what
   * is in `rows`, which is what the tests and any older client do; membership
   * is then as partial as it always was, and is recorded as such rather than
   * being presented as the whole set.
   */
  matchIds?: MatchIdSet | null;
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
  /**
   * Parcels that newly match but arrived with no snapshot to describe them, so
   * they were detected and counted and no alert document was written.
   *
   * Non-zero means more parcels newly matched below the snapshot cap than the
   * pass carried detail for. Reported rather than hidden, because "we know
   * something you were not told" is the exact failure this whole change is
   * about.
   */
  newMatchesWithoutDetail: number;
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
   * How many of `matched` this search FINGERPRINTS, and whether that is all of
   * them. `matched` is what the criteria select; `trackedMatches` is what the
   * next pass can diff FIELD BY FIELD. When they differ, a change to a field of
   * a parcel outside the tracked set raises nothing - which is the cap the UI
   * discloses, unchanged.
   */
  trackedMatches: number;
  matchesTruncated: boolean;
  /**
   * How many of `matched` this search remembers the membership of, and whether
   * that is all of them. This is the set "newly matches" is answered from, and
   * it now runs to `MATCH_ID_CAP` rather than to `TRACKED_MATCH_CAP`.
   */
  knownMatches: number;
  knownMatchesTruncated: boolean;
  /**
   * True when this pass wrote the id set for a search that had none - a brand
   * new search, or one stored before the id set existed. Membership was not
   * knowable, so nothing was announced as newly matching.
   */
  matchIdsSeeded: boolean;
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

      const storedIds = decodeMatchIds(search.matchIds);

      const outcome: SearchOutcome = {
        savedSearchId: search.id,
        name: search.name,
        matched: evaluation.matched,
        evaluated: evaluation.rows.length,
        seeded: false,
        newMatches: 0,
        newMatchesWithoutDetail: 0,
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
        knownMatches: storedIds.size,
        knownMatchesTruncated: search.matchIds?.truncated ?? search.matchesTruncated,
        matchIdsSeeded: false,
        error: evaluation.error,
      };

      if (evaluation.error) {
        outcomes.push(outcome);
        continue;
      }

      try {
        propertiesEvaluated += evaluation.rows.length;

        const previous = search.matches ?? {};

        // Membership and field level history are now two different questions
        // asked of two different stores, and conflating them was the defect.
        //
        // `previous` answers "what did this parcel look like last pass", for the
        // best 2,000 by score. `known` answers "was this parcel matching last
        // pass", for the whole match set. Reading the first as the second is
        // what made a parcel crossing rank 2,000 in either direction either
        // invisible or a false "now matches your saved search".
        const knewMembership = hasMatchIdSet(search.matchIds);
        const known = knewMembership ? storedIds : new Set(Object.keys(previous));

        // A search the matcher has never evaluated is seeded, not announced.
        // Otherwise saving "roofs over fifteen years" fires three hundred
        // thousand alerts about houses that have sat there for a decade.
        //
        // Still keyed on the snapshots rather than on the id set, and
        // deliberately: a pass that writes one always writes the other, so an
        // empty `matches` means this search has no history - never evaluated,
        // or reset by hand - and a stale id set left beside it should not be
        // read as knowledge the search does not have.
        const seeding = Object.keys(previous).length === 0;
        outcome.seeded = seeding;

        // A document written before the id set existed knows only its top
        // 2,000, so "absent from `known`" cannot be read as "newly matching" -
        // it is far more likely to mean "was always matching, below the cap".
        // This pass seeds the id set and announces nothing, which is the same
        // honest answer a brand new search gets. One pass of silence beats one
        // pass of 149,856 wrong alerts.
        const membershipKnowable = knewMembership || seeding;
        outcome.matchIdsSeeded = !knewMembership;

        const currentIds: Set<string> = evaluation.matchIds
          ? decodeMatchIds(evaluation.matchIds)
          : new Set(evaluation.rows.map((row) => row.propertyId));
        const currentTruncated = evaluation.matchIds
          ? evaluation.matchIds.truncated
          : evaluation.truncated;

        // The complete answer, from the complete set, independent of which rows
        // happened to arrive with detail on them.
        const newIds =
          membershipKnowable && !seeding ? newAgainst(known, currentIds) : ([] as string[]);
        outcome.newMatches = newIds.length;

        const pending: {
          match: EvaluatedMatch;
          kind: "new_match" | "updated_match";
          changed: string[];
        }[] = [];

        let describedNew = 0;

        for (const match of evaluation.rows) {
          const before = previous[match.propertyId];
          if (!known.has(match.propertyId)) {
            if (membershipKnowable && !seeding) {
              pending.push({ match, kind: "new_match", changed: [] });
              describedNew += 1;
            }
          } else if (!before) {
            // Matching before, but ranked below the snapshot cap then, so there
            // is no `before` to diff. It is not new and nothing can be said to
            // have changed. Its snapshot is recorded below for next time.
            continue;
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

        // Detected without a snapshot to describe them. Not the same thing as
        // `alertsSuppressed`, which is the search's own per pass alert budget.
        outcome.newMatchesWithoutDetail = Math.max(0, newIds.length - describedNew);

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

        // "Left the set" is a membership question too, and it used to be
        // answered from the top 2,000: a parcel that merely slipped from rank
        // 1,999 to 2,001 counted as having left a search it still matches.
        // With the id set it is the actual difference. When the id set is
        // capped it is still a difference of what was retrieved, which is why
        // `knownMatchesTruncated` travels beside it.
        outcome.leftMatches = knewMembership
          ? goneFrom(known, currentIds).length
          : Object.keys(previous).filter((id) => !matches[id]).length;

        // Two caps sit between "matches" and "watched": the evaluation cap the
        // engine applied before this module saw a row, and TRACKED_MATCH_CAP
        // here. Comparing the tracked set against the full match count covers
        // both, where comparing it against the rows that survived the first cap
        // reported only the second and called a partial watch complete.
        outcome.trackedMatches = tracked.length;
        outcome.matchesTruncated = evaluation.matched > tracked.length;

        // Re-encoded here rather than stored as posted, so a caller cannot put
        // a shape of its own choosing into the document, and so an unchanged
        // set serialises identically and the store skips the write.
        const matchIds: MatchIdSet = encodeMatchIds(currentIds, currentTruncated);
        outcome.knownMatches = matchIds.count;
        outcome.knownMatchesTruncated = matchIds.truncated;

        // Read-modify-write: an analyst renaming this search, or changing its
        // notification preference, while a matcher pass is mid-flight must not
        // have that edit thrown away by the pass writing back what it read.
        await store.update<SavedSearchDoc>("searches", search.id, (current) =>
          current
            ? {
                ...current,
                matches,
                matchesTruncated: outcome.matchesTruncated,
                matchIds,
                lastEvaluatedAt: startedAt,
                lastPipelineRunId: runId,
                lastMatchCount: evaluation.matched,
                updatedAt: startedAt,
              }
            : null,
        );
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

export { MATCH_ID_CAP, TRACKED_MATCH_CAP };
