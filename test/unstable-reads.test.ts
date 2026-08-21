/**
 * The invariant that stops the matcher inventing changes.
 *
 * Comparing a parcel across two artifact generations is the whole job. Comparing
 * two reads of the SAME generation and believing the difference is not: the
 * bytes are identical by definition, so a fingerprint that moved means the
 * reader moved, and raising that tells somebody a house changed when a parser
 * did.
 *
 * This is written from a real incident. Four consecutive cron passes alerted on
 * the same 23 Baldwin parcels, every one of them naming `lastSaleDate` and
 * `lastSalePrice`, alternating between a date and null on each pass. The
 * upstream run reported `0 updated`. One IPNS name was resolving to two
 * different pinned generations while `run-history.json` still named an older
 * run, so every pass "saw" the previous pass's values change back.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { setCrmStore, crmStore } from "@/lib/crm/db";
import { MemoryCrmStore } from "@/lib/crm/store-memory";
import { createSavedSearch, listAlerts } from "@/lib/crm/repo";
import { evaluateAndAlert, type EvaluatedMatch } from "@/lib/notify/evaluate";
import { CRITERIA_PRESETS } from "@/lib/criteria/types";
import type { SavedSearchDoc } from "@/lib/crm/documents";

const PARCEL = "0007340010R";

function match(lastSaleDate: string | null, hash: string): EvaluatedMatch {
  return {
    propertyId: PARCEL,
    score: 100,
    rationale: "held 22 years (+33)",
    matchHash: hash,
    snapshot: { lastSaleDate, lastSalePrice: lastSaleDate ? 100 : null },
    propertySnapshot: { address: "274 MAGNOLIA AVE, BALDWIN, 32234", lastSaleDate },
  };
}

async function pass(searchId: string, artifactRunId: string | null, row: EvaluatedMatch) {
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
    evaluations: [{ savedSearchId: searchId, matched: 1, rows: [row], truncated: false }],
  });
}

describe("a fingerprint that moves without the artifact moving", () => {
  let searchId: string;

  beforeEach(async () => {
    setCrmStore(new MemoryCrmStore());
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
    searchId = search.id;
    // Baseline: the first pass records what already matches and says nothing.
    const seeded = await pass(searchId, "run-A", match("2003-11-26", "hash-1"));
    expect(seeded.alertsCreated).toBe(0);
  });

  it("is suppressed, counted, and raises no alert", async () => {
    const again = await pass(searchId, "run-A", match(null, "hash-2"));

    expect(again.alertsCreated).toBe(0);
    expect(again.outcomes[0]?.updatedMatches).toBe(0);
    expect(again.outcomes[0]?.unstableReads).toBe(1);
    expect(await listAlerts({ limit: 10 })).toHaveLength(0);
  });

  it("still alerts when the artifact genuinely moves on", async () => {
    const moved = await pass(searchId, "run-B", match(null, "hash-2"));

    expect(moved.alertsCreated).toBe(1);
    expect(moved.outcomes[0]?.updatedMatches).toBe(1);
    expect(moved.outcomes[0]?.unstableReads).toBe(0);
    const [alert] = await listAlerts({ limit: 10 });
    expect(alert?.changedFields).toContain("lastSaleDate");
  });

  it("does not suppress across generations just because the values match again", async () => {
    // A -> B -> A is exactly what the incident looked like from the outside.
    // Each hop is a real generation change, so each is judged on its own.
    await pass(searchId, "run-B", match(null, "hash-2"));
    const back = await pass(searchId, "run-A2", match("2003-11-26", "hash-1"));
    expect(back.outcomes[0]?.unstableReads).toBe(0);
    expect(back.alertsCreated).toBe(1);
  });

  it("falls back to the fingerprint for snapshots written before this existed", async () => {
    // An older document carries no artifactRunId. Suppressing on a missing
    // value would silence real changes, so the absence must not be treated as
    // "same artifact".
    const store = crmStore();
    const search = await store.get<SavedSearchDoc>("searches", searchId);
    const stripped = Object.fromEntries(
      Object.entries(search!.matches).map(([id, entry]) => [
        id,
        { ...entry, artifactRunId: undefined },
      ]),
    );
    await store.put<SavedSearchDoc>("searches", { ...search!, matches: stripped });

    const after = await pass(searchId, "run-A", match(null, "hash-2"));
    expect(after.outcomes[0]?.unstableReads).toBe(0);
    expect(after.alertsCreated).toBe(1);
  });
});

describe("an overlay is a real change even though the artifact has not moved", () => {
  it("alerts when a simulated update changes the values under the same parquet", async () => {
    setCrmStore(new MemoryCrmStore());
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

    await pass(search.id, "01M0K3B6", match("2003-11-26", "hash-1"));

    // A simulated pipeline update reads the same parquet and overlays values on
    // top, so the matcher stamps the pass with the overlay's own run. Without
    // that, the suppression above would swallow the one change we know is real.
    const simulated = await pass(search.id, "sim-20260821-abc", match(null, "hash-2"));

    expect(simulated.outcomes[0]?.unstableReads).toBe(0);
    expect(simulated.alertsCreated).toBe(1);
  });
});
