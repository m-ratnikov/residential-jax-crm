/**
 * The export is the one place the provenance argument can quietly break.
 *
 * Everything inside the app can point at the parcel drawer to say where a row
 * came from. A CSV cannot: once it is on someone's desktop it is only the
 * columns it carries. So these drive the real route handler against a real
 * store and assert on the bytes it returns, rather than on an intention.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/export/route";
import { crmStore, setCrmStore } from "@/lib/crm/db";
import type { AlertDoc } from "@/lib/crm/documents";
import { createOpportunityFromSnapshot } from "@/lib/crm/repo";
import { MemoryCrmStore } from "@/lib/crm/store-memory";

const PROVENANCE = {
  sourceSystem: "Duval County Property Appraiser",
  sourceUrl: "https://paopropodata.coj.net/",
  fetchedAt: "2026-08-19T04:12:07.000Z",
  runId: "run-2026-08-19T04-00-00Z",
};

/**
 * A real RFC 4180 reader, not a split on commas.
 *
 * Half of these rows contain "1 SOMEWHERE RD, JACKSONVILLE" in a quoted cell,
 * so a naive split silently shifts every column after the address and the test
 * would be asserting on the wrong ones.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') cell += character;
      else if (text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
    } else cell += character;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function csvRows(kind: string): Promise<string[][]> {
  const response = await GET(new Request(`http://localhost/api/export?kind=${kind}`));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/csv");
  return parseCsv(await response.text());
}

function column(rows: string[][], name: string): string[] {
  const index = rows[0].indexOf(name);
  expect(index, `${name} is not a column of the export`).toBeGreaterThanOrEqual(0);
  return rows.slice(1).map((row) => row[index]);
}

beforeEach(() => {
  setCrmStore(new MemoryCrmStore());
});

describe("CSV export", () => {
  it("carries the source system and pipeline run on every opportunity row", async () => {
    await createOpportunityFromSnapshot({
      propertyId: "0421-00-0010",
      addressLine: "1 ARLINGTON RD, JACKSONVILLE",
      addressCity: "JACKSONVILLE",
      addressZip: "32211",
      ownerName: "SMITH JOHN",
      ownerMailingAddress: "PO BOX 1",
      ownerMailingCity: "ATLANTA",
      ownerMailingState: "GA",
      ownerMailingZip: "30301",
      sourceSystem: PROVENANCE.sourceSystem,
      sourceUrl: PROVENANCE.sourceUrl,
      propertySnapshot: { ownerOccupied: false, provenance: PROVENANCE },
      matchScore: 88,
      matchRationale: "held 26 years; roof about 52 years old",
    });

    const rows = await csvRows("opportunities");

    expect(rows).toHaveLength(2);
    expect(column(rows, "source_system")).toEqual([PROVENANCE.sourceSystem]);
    expect(column(rows, "source_url")).toEqual([PROVENANCE.sourceUrl]);
    expect(column(rows, "fetched_at")).toEqual([PROVENANCE.fetchedAt]);
    expect(column(rows, "pipeline_run_id")).toEqual([PROVENANCE.runId]);
  });

  it("carries the match lineage when the opportunity came from an alert", async () => {
    const alert: AlertDoc = {
      id: "run7__search1__0421-00-0011",
      savedSearchId: "search1",
      matcherRunId: "run7",
      kind: "new_match",
      propertyId: "0421-00-0011",
      propertySnapshot: {},
      score: 91,
      rationale: "absentee owner; roof about 40 years old",
      changedFields: [],
      pipelineRunId: PROVENANCE.runId,
      readAt: null,
      dismissedAt: null,
      opportunityId: null,
      createdAt: "2026-08-19T05:00:00.000Z",
      notifications: [],
    };
    await crmStore().put("alerts", alert);

    await createOpportunityFromSnapshot({
      propertyId: "0421-00-0011",
      addressLine: "2 ARLINGTON RD, JACKSONVILLE",
      ownerName: "DOE JANE",
      ownerMailingAddress: "PO BOX 2",
      sourceSystem: PROVENANCE.sourceSystem,
      // No provenance in the snapshot: the alert is the only lineage this row
      // has, and it still has to reach the file.
      propertySnapshot: {},
      alertId: alert.id,
      savedSearchId: "search1",
      matchScore: 91,
    });

    const rows = await csvRows("opportunities");

    expect(column(rows, "alert_id")).toEqual([alert.id]);
    expect(column(rows, "matcher_run_id")).toEqual(["run7"]);
    expect(column(rows, "pipeline_run_id")).toEqual([PROVENANCE.runId]);
    // The owner document keeps the source the parcel was read from.
    expect(column(rows, "source_system")).toEqual([PROVENANCE.sourceSystem]);
  });

  it("leaves provenance blank rather than inventing it", async () => {
    await createOpportunityFromSnapshot({
      propertyId: "0421-00-0012",
      addressLine: "3 ARLINGTON RD, JACKSONVILLE",
      ownerName: "ROE RICHARD",
      ownerMailingAddress: "PO BOX 3",
      propertySnapshot: {},
    });

    const rows = await csvRows("opportunities");

    expect(column(rows, "source_system")).toEqual([""]);
    expect(column(rows, "source_url")).toEqual([""]);
    expect(column(rows, "fetched_at")).toEqual([""]);
    expect(column(rows, "pipeline_run_id")).toEqual([""]);
    expect(column(rows, "alert_id")).toEqual([""]);
    expect(column(rows, "matcher_run_id")).toEqual([""]);
  });

  it("carries the source system and pipeline run on the mailing list too", async () => {
    await createOpportunityFromSnapshot({
      propertyId: "0421-00-0013",
      addressLine: "4 ARLINGTON RD, JACKSONVILLE",
      ownerName: "SMITH JOHN",
      ownerMailingAddress: "PO BOX 4",
      ownerMailingCity: "ATLANTA",
      ownerMailingState: "GA",
      ownerMailingZip: "30301",
      sourceSystem: PROVENANCE.sourceSystem,
      propertySnapshot: { provenance: PROVENANCE },
      matchScore: 77,
    });
    // No mailing address, so it must not reach a print run at all.
    await createOpportunityFromSnapshot({
      propertyId: "0421-00-0014",
      addressLine: "5 ARLINGTON RD, JACKSONVILLE",
      ownerName: "NO ADDRESS OWNER",
      propertySnapshot: { provenance: PROVENANCE },
    });

    const rows = await csvRows("mailing");

    expect(rows).toHaveLength(2);
    expect(column(rows, "owner_name")).toEqual(["SMITH JOHN"]);
    expect(column(rows, "source_system")).toEqual([PROVENANCE.sourceSystem]);
    expect(column(rows, "pipeline_run_id")).toEqual([PROVENANCE.runId]);
  });

  it("rejects a kind it does not export", async () => {
    const response = await GET(new Request("http://localhost/api/export?kind=everything"));
    expect(response.status).toBe(400);
  });
});
