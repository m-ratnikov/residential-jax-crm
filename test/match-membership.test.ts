/**
 * "Which parcels newly match your saved search" - the sentence the notifier
 * exists to say, and the one it was answering from 1.3% of the evidence.
 *
 * A pass retrieved the best 2,000 matches and diffed them against the stored
 * best 2,000. Two failures fell straight out of that, and both are here:
 *
 * 1. **Blind.** A thesis matching 151,856 parcels watched 2,000 of them.
 *    Ranking is deterministic and tenure and roof age rise monotonically, so a
 *    parcel at rank 5,000 does not climb 3,000 places on the next refresh. It
 *    was not going to be noticed late; it was never going to be noticed.
 * 2. **Loud about the wrong thing.** `previous` was the stored top 2,000, so a
 *    parcel that sat at rank 2,001 and moved to 1,999 had nothing to compare
 *    against and was delivered as "now matches your saved search" - about a
 *    parcel that had matched for months. Every crossing of the boundary was a
 *    false alert, in both directions.
 *
 * The fix separates membership from field level history. Membership is ids, for
 * the whole match set. Field level history stays capped, where the bytes are.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { setCrmStore, crmStore } from "@/lib/crm/db";
import { MemoryCrmStore } from "@/lib/crm/store-memory";
import { createSavedSearch, listAlerts } from "@/lib/crm/repo";
import type { SavedSearchDoc } from "@/lib/crm/documents";
import { CRITERIA_PRESETS } from "@/lib/criteria/types";
import { evaluateAndAlert, type EvaluatedMatch, type MatcherResult } from "@/lib/notify/evaluate";
import { encodeMatchIds } from "@/lib/notify/match-ids";

/** A parcel id in the shape the county roll actually publishes. */
function parcel(rank: number): string {
  return `${String(1_000_000_000 + rank * 7).padStart(10, "0")}R`;
}

function row(id: string, hash = `hash-${id}`): EvaluatedMatch {
  return {
    propertyId: id,
    matchHash: hash,
    snapshot: { ownerName: "SMITH JOHN", assessedValue: 184_000 },
    score: 90,
    rationale: "held 32 years (+33), roof 38 years old (+30)",
    propertySnapshot: { propertyId: id, address: `${id} SOMEWHERE ST`, ownerName: "SMITH JOHN" },
  };
}

async function newSearch(): Promise<string> {
  const preset = CRITERIA_PRESETS.find((entry) => entry.id === "tired-landlord")!;
  const search = await createSavedSearch({
    name: preset.name,
    description: null,
    criteria: preset.criteria,
    ownerId: null,
    notifyInApp: true,
    notifyEmail: false,
    notifySms: false,
  });
  return search.id;
}

/**
 * One pass over a search that matches `allIds` and carries detail for `rows`.
 *
 * `rows` is deliberately a small slice of `allIds`: that asymmetry - a complete
 * id set and a capped set of fingerprinted rows - is the whole shape of the
 * fix, so every test here exercises it rather than a convenient special case.
 */
function pass(
  searchId: string,
  artifactRunId: string,
  allIds: readonly string[],
  rows: EvaluatedMatch[],
): Promise<MatcherResult> {
  return evaluateAndAlert({
    trigger: "cron",
    pipelineRunId: artifactRunId,
    dataSource: {
      kind: "duckdb-parquet",
      location: "test",
      rowCount: 404_023,
      isSample: false,
      artifactRunId,
    },
    evaluations: [
      {
        savedSearchId: searchId,
        matched: allIds.length,
        rows,
        truncated: allIds.length > rows.length,
        matchIds: encodeMatchIds(allIds),
      },
    ],
  });
}

describe("a parcel crossing the fingerprint cap", () => {
  let searchId: string;
  const set = [parcel(1), parcel(2), parcel(3)];

  beforeEach(async () => {
    setCrmStore(new MemoryCrmStore());
    searchId = await newSearch();
    // Baseline. All three match; only the best two are fingerprinted, which is
    // exactly the relationship a 2,000 row cap has to a 151,856 row match set.
    const seeded = await pass(searchId, "run-A", set, [row(parcel(1)), row(parcel(2))]);
    expect(seeded.outcomes[0]?.seeded).toBe(true);
    expect(seeded.alertsCreated).toBe(0);
  });

  it("is not announced as newly matching when it rises into the tracked set", async () => {
    // parcel(3) was rank 3 and is now rank 2. Nothing about it is new - it has
    // been in the match set the whole time - and the only thing that changed is
    // which parcels the cap happened to reach.
    const moved = await pass(searchId, "run-B", set, [row(parcel(1)), row(parcel(3))]);

    expect(moved.outcomes[0]?.newMatches).toBe(0);
    expect(moved.alertsCreated).toBe(0);
    expect(await listAlerts({ limit: 10 })).toHaveLength(0);
  });

  it("is not reported as having changed either, because there is nothing to diff", async () => {
    // It has no stored snapshot - it was below the cap last pass - so a
    // fingerprint that does not match anything is not evidence of a change.
    const moved = await pass(searchId, "run-B", set, [
      row(parcel(1)),
      row(parcel(3), "a-completely-different-hash"),
    ]);

    expect(moved.outcomes[0]?.updatedMatches).toBe(0);
    expect(moved.outcomes[0]?.newMatches).toBe(0);
    expect(moved.alertsCreated).toBe(0);
  });

  it("is not counted as having left the set when it drops out of the tracked set", async () => {
    // The mirror of the same mistake: rank 2 to rank 3 is not a departure.
    const moved = await pass(searchId, "run-B", set, [row(parcel(1)), row(parcel(3))]);
    expect(moved.outcomes[0]?.leftMatches).toBe(0);
  });

  it("still alerts when a parcel it fingerprints actually changes", async () => {
    const moved = await pass(searchId, "run-B", set, [
      row(parcel(1)),
      { ...row(parcel(2), "moved"), snapshot: { ownerName: "SMITH FAMILY TRUST" } },
    ]);

    expect(moved.outcomes[0]?.updatedMatches).toBe(1);
    const [alert] = await listAlerts({ limit: 10 });
    expect(alert?.kind).toBe("updated_match");
    expect(alert?.changedFields).toContain("ownerName");
  });

  it("still reports a parcel that genuinely left the match set", async () => {
    const shrunk = [parcel(1), parcel(3)];
    const moved = await pass(searchId, "run-B", shrunk, [row(parcel(1)), row(parcel(3))]);
    expect(moved.outcomes[0]?.leftMatches).toBe(1);
  });
});

describe("a parcel that newly matches below the fingerprint cap", () => {
  let searchId: string;

  beforeEach(async () => {
    setCrmStore(new MemoryCrmStore());
    searchId = await newSearch();
    await pass(searchId, "run-A", [parcel(1), parcel(2)], [row(parcel(1)), row(parcel(2))]);
  });

  it("is detected and alerted on, with the detail the sweep carried for it", async () => {
    // Rank 5,000 in a set the pass fingerprints 2 of. Under the old cap this
    // parcel was never retrieved at all, so it could not be alerted on this
    // refresh or any later one.
    const late = parcel(5_000);
    const moved = await pass(
      searchId,
      "run-B",
      [parcel(1), parcel(2), late],
      // The best two by score, plus detail for the one the caller had not seen
      // matching before. This is what collectMatches produces.
      [row(parcel(1)), row(parcel(2)), row(late)],
    );

    expect(moved.outcomes[0]?.newMatches).toBe(1);
    expect(moved.outcomes[0]?.newMatchesWithoutDetail).toBe(0);
    expect(moved.alertsCreated).toBe(1);

    const [alert] = await listAlerts({ limit: 10 });
    expect(alert?.kind).toBe("new_match");
    expect(alert?.propertyId).toBe(late);
    expect(alert?.propertySnapshot["address"]).toBe(`${late} SOMEWHERE ST`);
  });

  it("is counted and disclosed, not silently dropped, when no detail arrived", async () => {
    // A pass that detected it but carried no row for it - a stale hint, or more
    // new parcels than one pass carries detail for. An alert with nothing but
    // an id on it is not worth writing; pretending it did not happen is worse.
    const moved = await pass(
      searchId,
      "run-B",
      [parcel(1), parcel(2), parcel(5_000)],
      [row(parcel(1)), row(parcel(2))],
    );

    expect(moved.outcomes[0]?.newMatches).toBe(1);
    expect(moved.outcomes[0]?.newMatchesWithoutDetail).toBe(1);
    expect(moved.alertsCreated).toBe(0);
  });

  it("keeps the membership set the pass observed, not the fingerprinted slice", async () => {
    await pass(
      searchId,
      "run-B",
      [parcel(1), parcel(2), parcel(5_000)],
      [row(parcel(1)), row(parcel(2))],
    );

    const stored = await crmStore().get<SavedSearchDoc>("searches", searchId);
    expect(stored?.matchIds?.count).toBe(3);
    expect(Object.keys(stored?.matches ?? {})).toHaveLength(2);
  });
});

describe("a saved search stored before the id set existed", () => {
  let searchId: string;
  const set = [parcel(1), parcel(2), parcel(3)];

  beforeEach(async () => {
    setCrmStore(new MemoryCrmStore());
    searchId = await newSearch();
    await pass(searchId, "run-A", set, [row(parcel(1)), row(parcel(2))]);

    // Exactly what is on disk today: a snapshot per tracked parcel and no id
    // set at all.
    const store = crmStore();
    const current = await store.get<SavedSearchDoc>("searches", searchId);
    await store.put<SavedSearchDoc>("searches", { ...current!, matchIds: null });
  });

  it("degrades to silence rather than announcing the whole match set", async () => {
    // Absence of an id set is not evidence of an empty match set. Read as one,
    // this pass would announce every parcel below the old cap as newly
    // matching - which on the live deployment is 149,856 alerts about parcels
    // that have matched for months.
    const migrating = await pass(searchId, "run-B", set, [row(parcel(1)), row(parcel(2))]);

    expect(migrating.outcomes[0]?.matchIdsSeeded).toBe(true);
    expect(migrating.outcomes[0]?.newMatches).toBe(0);
    expect(migrating.alertsCreated).toBe(0);
    expect(await listAlerts({ limit: 50 })).toHaveLength(0);
  });

  it("still says what changed underneath a parcel it does have a snapshot for", async () => {
    // The migration costs one pass of membership answers. It costs nothing at
    // all on the field level diff, which never depended on the id set.
    const migrating = await pass(searchId, "run-B", set, [
      row(parcel(1)),
      { ...row(parcel(2), "moved"), snapshot: { ownerName: "SMITH FAMILY TRUST" } },
    ]);

    expect(migrating.outcomes[0]?.updatedMatches).toBe(1);
    expect(migrating.alertsCreated).toBe(1);
  });

  it("answers membership normally from the very next pass", async () => {
    await pass(searchId, "run-B", set, [row(parcel(1)), row(parcel(2))]);

    const late = parcel(5_000);
    const after = await pass(
      searchId,
      "run-C",
      [...set, late],
      [row(parcel(1)), row(parcel(2)), row(late)],
    );

    expect(after.outcomes[0]?.matchIdsSeeded).toBe(false);
    expect(after.outcomes[0]?.newMatches).toBe(1);
    expect(after.alertsCreated).toBe(1);
  });
});

describe("a saved search whose history has been cleared", () => {
  it("seeds again rather than reading a stale id set as knowledge", async () => {
    // `pnpm verify` resets a search to `matches: {}` to prove the baseline pass
    // seeds rather than shouts, and the demo path does the same. An id set left
    // beside an emptied snapshot map is not history: a pass writes both or
    // neither, so an empty `matches` means there is nothing to compare against.
    setCrmStore(new MemoryCrmStore());
    const searchId = await newSearch();
    const set = [parcel(1), parcel(2), parcel(3)];
    await pass(searchId, "run-A", set, [row(parcel(1)), row(parcel(2))]);

    const store = crmStore();
    const current = await store.get<SavedSearchDoc>("searches", searchId);
    await store.put<SavedSearchDoc>("searches", {
      ...current!,
      matches: {},
      matchesTruncated: false,
    });

    const baseline = await pass(searchId, "run-B", set, [row(parcel(1)), row(parcel(2))]);
    expect(baseline.outcomes[0]?.seeded).toBe(true);
    expect(baseline.alertsCreated).toBe(0);
  });
});

describe("a pass that posts no id set at all", () => {
  it("is taken at its word: membership is what is in the rows, and is recorded as partial", async () => {
    // An older client, or any caller that only sends rows. It must keep working
    // and must not be able to claim a partial set is the whole one, because a
    // later pass reading it as whole would announce everything outside it.
    setCrmStore(new MemoryCrmStore());
    const searchId = await newSearch();

    await evaluateAndAlert({
      trigger: "cron",
      pipelineRunId: "run-A",
      dataSource: {
        kind: "t",
        location: "t",
        rowCount: 1,
        isSample: false,
        artifactRunId: "run-A",
      },
      evaluations: [
        {
          savedSearchId: searchId,
          matched: 151_856,
          rows: [row(parcel(1))],
          truncated: true,
        },
      ],
    });

    const stored = await crmStore().get<SavedSearchDoc>("searches", searchId);
    expect(stored?.matchIds?.count).toBe(1);
    expect(stored?.matchIds?.truncated).toBe(true);
  });
});
