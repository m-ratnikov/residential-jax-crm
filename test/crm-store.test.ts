/**
 * The invariants that used to be unique indexes.
 *
 * When CRM state moved from tables to documents, three constraints stopped
 * being enforced by a database and started being enforced by the document key.
 * That is stronger - a key cannot be raced the way a check-then-write can - but
 * only if the keys are actually derived the way they are supposed to be, which
 * is what these prove.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { setCrmStore, crmStore } from "@/lib/crm/db";
import { MemoryCrmStore } from "@/lib/crm/store-memory";
import { documentId, serialise } from "@/lib/crm/store";
import {
  addNote,
  addTask,
  alertId,
  createOpportunityFromSnapshot,
  createSavedSearch,
  createTeamMember,
  getOpportunity,
  listOpportunities,
  setTaskStatus,
  updateOpportunity,
  updateSavedSearch,
} from "@/lib/crm/repo";
import { DEFAULT_WEIGHTS, type CriteriaSet } from "@/lib/criteria/types";

const criteria: CriteriaSet = {
  name: "Tired landlord",
  filters: { residentialOnly: true, minRoofAge: 15 },
  weights: DEFAULT_WEIGHTS,
};

function parcel(propertyId: string, overrides: Record<string, unknown> = {}) {
  return {
    propertyId,
    addressLine: `${propertyId} SOMEWHERE ST, JACKSONVILLE`,
    ownerName: "SMITH JOHN",
    ownerMailingAddress: "PO BOX 1",
    assessedValue: 180_000,
    matchScore: 88,
    matchRationale: "held 26 years; roof about 52 years old",
    ...overrides,
  };
}

describe("document keys as constraints", () => {
  beforeEach(() => {
    setCrmStore(new MemoryCrmStore());
  });

  it("keys an opportunity by its parcel, so the same house cannot be tracked twice", async () => {
    const first = await createOpportunityFromSnapshot(parcel("1654190105R"));
    const second = await createOpportunityFromSnapshot(parcel("1654190105R"));

    expect(first.created).toBe(true);
    // Two analysts working the same alert feed must not open two records.
    expect(second.created).toBe(false);
    expect(second.opportunity.id).toBe(first.opportunity.id);
    expect(second.opportunity.id).toBe("1654190105R");
    expect(await listOpportunities()).toHaveLength(1);
  });

  it("keys an alert by search, parcel and pass, so a retried matcher cannot double notify", () => {
    const a = alertId("run-1", "search-1", "1654190105R");
    const b = alertId("run-1", "search-1", "1654190105R");
    const other = alertId("run-2", "search-1", "1654190105R");

    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it("makes a document id safe as a file name", () => {
    // Parcel ids and run ids reach the key directly, so anything path-shaped in
    // them has to be neutralised rather than trusted. The property that matters
    // is that no separator survives, so a key can never escape its collection.
    const escaped = documentId("run/1", "search:2", "../etc/passwd");
    expect(escaped).not.toMatch(/[/\\]/);
    expect(escaped).toBe("run-1__search-2__..-etc-passwd");
    expect(documentId("a", "", "b")).toBe("a__b");
  });
});

describe("stable serialisation", () => {
  it("serialises the same document identically whatever order it was built in", () => {
    // This is what lets a backend skip an unchanged write. Insertion order
    // differs between a freshly built object and one parsed from storage, so
    // comparing raw JSON.stringify would report every document as changed.
    const built = { id: "x", b: 2, a: 1, nested: { z: 1, y: 2 } };
    const parsed = JSON.parse('{"a":1,"nested":{"y":2,"z":1},"b":2,"id":"x"}') as unknown;
    expect(serialise(built)).toBe(serialise(parsed));
  });

  it("does not reorder arrays, because their order is meaning", () => {
    const stageHistory = { id: "x", stages: ["identified", "contacted", "negotiating"] };
    expect(serialise(stageHistory)).toContain('"identified",\n    "contacted",\n    "negotiating"');
  });
});

describe("opportunity lifecycle", () => {
  beforeEach(() => {
    setCrmStore(new MemoryCrmStore());
  });

  it("records a stage event on every stage change, and only on a change", async () => {
    const { opportunity } = await createOpportunityFromSnapshot(parcel("1"));
    expect(opportunity.stageEvents).toHaveLength(1);

    const contacted = await updateOpportunity("1", { stage: "contacted" });
    expect(contacted?.stageEvents).toHaveLength(2);
    expect(contacted?.stageEvents.at(-1)?.fromStage).toBe("identified");

    // Writing the same stage again is not a stage change.
    const again = await updateOpportunity("1", { stage: "contacted", nextStep: "call back" });
    expect(again?.stageEvents).toHaveLength(2);
    expect(again?.nextStep).toBe("call back");
  });

  it("stamps closedAt on a terminal stage and clears it when reopened", async () => {
    await createOpportunityFromSnapshot(parcel("1"));

    const closed = await updateOpportunity("1", { stage: "closed" });
    expect(closed?.closedAt).toBeTruthy();

    const reopened = await updateOpportunity("1", { stage: "negotiating" });
    expect(reopened?.closedAt).toBeNull();
  });

  it("keeps notes and tasks on the same document as the deal", async () => {
    await createOpportunityFromSnapshot(parcel("1"));
    await addNote("1", "Owner called back", null);
    const withTask = await addTask({ propertyId: "1", title: "Book inspection" });

    expect(withTask?.notes).toHaveLength(1);
    expect(withTask?.tasks).toHaveLength(1);

    const taskId = withTask?.tasks[0]?.id ?? "";
    const done = await setTaskStatus("1", taskId, "done");
    expect(done?.tasks[0]?.status).toBe("done");
    expect(done?.tasks[0]?.completedAt).toBeTruthy();
  });

  it("reuses one owner document across parcels with the same owner of record", async () => {
    await createOpportunityFromSnapshot(parcel("1"));
    await createOpportunityFromSnapshot(parcel("2"));

    const owners = await crmStore().list("owners");
    expect(owners).toHaveLength(1);

    // A different mailing address is a different owner of record.
    await createOpportunityFromSnapshot(parcel("3", { ownerMailingAddress: "PO BOX 2" }));
    expect(await crmStore().list("owners")).toHaveLength(2);
  });

  it("returns the opportunity unchanged when there is nothing to update", async () => {
    expect(await updateOpportunity("does-not-exist", { stage: "closed" })).toBeNull();
    expect(await getOpportunity("does-not-exist")).toBeNull();
  });
});

describe("saved searches", () => {
  beforeEach(() => {
    setCrmStore(new MemoryCrmStore());
  });

  it("starts with an empty match snapshot, which is what makes the first pass seed", async () => {
    const search = await createSavedSearch({ name: "Tired landlord", criteria });
    expect(Object.keys(search.matches)).toHaveLength(0);
    expect(search.lastEvaluatedAt).toBeNull();
  });

  it("validates criteria on the way in and on the way out", async () => {
    await expect(
      createSavedSearch({
        name: "bad",
        criteria: { name: "bad", filters: { minRoofAge: -5 } } as CriteriaSet,
      }),
    ).rejects.toThrow();
  });

  it("keeps the match snapshot when unrelated fields are patched", async () => {
    const search = await createSavedSearch({ name: "Tired landlord", criteria });
    await crmStore().put("searches", {
      ...search,
      matches: {
        "1": {
          matchHash: "abc",
          snapshot: {},
          score: 1,
          firstSeenAt: "",
          lastSeenAt: "",
          lastRunId: null,
        },
      },
    });

    const renamed = await updateSavedSearch(search.id, { name: "Renamed" });
    expect(renamed?.name).toBe("Renamed");
    // Renaming a search must not throw away what the matcher is diffing against.
    expect(Object.keys(renamed?.matches ?? {})).toEqual(["1"]);
  });
});

describe("team", () => {
  beforeEach(() => {
    setCrmStore(new MemoryCrmStore());
  });

  it("stores members with a default role", async () => {
    const member = await createTeamMember({ name: "Dana", email: "dana@example.invalid" });
    expect(member.role).toBe("acquisitions");
  });
});
