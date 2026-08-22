/**
 * `simulatedRunIds` is read as "the current simulation" by taking its last
 * element (`.at(-1)`, in lib/notify/matcher.ts). That is only correct if the
 * list is ordered by when a simulation actually ran, not by whatever order
 * the store happens to return its documents in.
 *
 * Found live: the GitHub-documents backend lists a collection in git tree
 * order (alphabetical by property id), not creation order. Two consecutive
 * "Simulate: roll movement" presses on the deployed runtime both resolved to
 * the SAME pipeline run id, because the alphabetically-last property id in
 * the `simulated` collection had not changed between them. The second,
 * genuinely new simulation was evaluated against a stale run id that already
 * had an alert on record, and the retry-safety guard in evaluateAndAlert -
 * correctly, given what it was told - treated it as a repeat and raised
 * nothing. "The matcher raised 0 alerts" every time was that guard reacting
 * to the wrong input, not the matcher failing to find a real change.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { setCrmStore, crmStore } from "@/lib/crm/db";
import { MemoryCrmStore } from "@/lib/crm/store-memory";
import { loadOverlay } from "@/lib/crm/overlay";
import type { SimulatedDoc } from "@/lib/crm/documents";

beforeEach(() => {
  setCrmStore(new MemoryCrmStore());
});

function simulated(id: string, runId: string, createdAt: string): SimulatedDoc {
  return {
    id,
    propertyId: id,
    runId,
    label: "reassessed",
    values: { assessed_value: "150000" },
    createdAt,
  };
}

describe("loadOverlay - which simulation is \"the latest\"", () => {
  it("picks the most recently created run, regardless of the store's own listing order", async () => {
    const store = crmStore();

    // Inserted NEWEST first and OLDEST second - the opposite of creation
    // order - so a fix that trusted the store's listing order (insertion
    // order here, git-tree/alphabetical order on the real backend) would
    // report the OLDER run as "latest". Only sorting by `createdAt` gets
    // this right regardless of how the store happens to hand the documents
    // back, which is the actual defect: the GitHub-documents backend lists a
    // collection in git tree order (alphabetical by property id), and two
    // consecutive simulations on the deployed runtime resolved to the SAME
    // run id because the alphabetically-last property id had not changed
    // between them.
    await store.put("simulated", simulated("a-newer-parcel", "sim-newer", "2026-08-22T07:40:00Z"));
    await store.put("simulated", simulated("z-older-parcel", "sim-older", "2026-08-22T07:33:00Z"));

    const overlay = await loadOverlay();

    expect(overlay.simulatedRunIds.at(-1)).toBe("sim-newer");
  });

  it("stays correct across several simulations inserted out of chronological order", async () => {
    const store = crmStore();

    // Written in an order that matches neither chronological nor alphabetical
    // order, so passing by coincidence is not an option.
    const writes: [id: string, runId: string, hour: string][] = [
      ["m-parcel", "sim-3", "09"],
      ["z-parcel", "sim-1", "07"],
      ["a-parcel", "sim-4", "10"],
      ["b-parcel", "sim-2", "08"],
    ];

    for (const [id, runId, hour] of writes) {
      await store.put("simulated", simulated(id, runId, `2026-08-22T${hour}:00:00Z`));
    }

    const overlay = await loadOverlay();

    expect(overlay.simulatedRunIds.at(-1)).toBe("sim-4");
  });
});
