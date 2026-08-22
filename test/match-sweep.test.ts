/**
 * What one pass over a saved search actually retrieves.
 *
 * This is the half of the blindness the evaluator could not fix. A pass asked
 * the data source for `limit: 2_000` and stopped, so rank 2,001 was never
 * retrieved, never posted and never diffed: on a thesis matching 151,856
 * parcels the watch covered 1.3% of it, permanently, because ranking is
 * deterministic and a parcel does not climb 3,000 places on a refresh.
 *
 * The sweep now reads the whole match set for ids - through the same
 * `PropertyDataSource` interface, in the pages that interface will answer - and
 * keeps the expensive part, the fingerprint and snapshot, capped where the
 * bytes are. Both matchers call this one function, so the tab and the cron
 * cannot come to watch different sets.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_WEIGHTS, type CriteriaSet } from "@/lib/criteria/types";
import type {
  PropertyDataSource,
  PropertyRecord,
  PropertySearchQuery,
  PropertySearchResult,
  ScoredProperty,
} from "@/lib/data/types";
import { collectMatches } from "@/lib/notify/collect";
import { TRACKED_MATCH_CAP } from "@/lib/notify/limits";

const CRITERIA: CriteriaSet = { name: "everything", filters: {}, weights: DEFAULT_WEIGHTS };

function parcel(rank: number): string {
  return `${String(1_000_000_000 + rank * 7).padStart(10, "0")}R`;
}

function record(id: string): PropertyRecord {
  return {
    propertyId: id,
    parcelIdentifier: id,
    propertyCid: null,
    addressStreet: `${id} SOMEWHERE ST`,
    addressCity: "JACKSONVILLE",
    addressZip: "32246",
    latitude: 30.28,
    longitude: -81.53,
    subdivision: null,
    neighborhoodCode: null,
    propertyType: "RESIDENTIAL",
    propertyUsageType: "001",
    builtYear: 1988,
    livableFloorArea: 1420,
    totalArea: 1820,
    residentialUnits: 1,
    roofYearEst: 1988,
    roofAgeYears: 38,
    roofAgeBasis: "EFF_YR_BLT_PROXY",
    roofCoveringMaterial: null,
    assessedValue: 184_000,
    marketValue: 210_000,
    landValue: 45_000,
    taxableValue: 184_000,
    ownerName: "SMITH JOHN",
    ownerCount: 1,
    ownerOccupied: false,
    ownerRegionClass: "LOCAL",
    ownerMailingAddress: "PO BOX 1",
    ownerMailingCity: "ORLANDO",
    ownerMailingState: "FL",
    ownerMailingZip: "32801",
    homesteadFlag: false,
    lastSaleDate: "1994-06-01",
    lastSalePrice: 78_000,
    yearsSinceLastSale: 32,
    tenureBasis: "COJ_SALESL",
    waterViewFlag: false,
    waterDistM: null,
    waterBodyName: null,
    nearestTransitStopM: 320,
    nearestTransitStopName: "Beach Blvd",
    hasPermits: false,
    permitCount: 0,
    roofPermitCount: 0,
    lastPermitDate: null,
    provenance: {
      sourceSystem: "fdor_nal",
      sourceUrl: null,
      fetchedAt: null,
      runId: null,
      sourceArtifact: null,
      sourceSha256: null,
    },
    raw: {},
  };
}

function scored(rank: number): ScoredProperty {
  return {
    property: record(parcel(rank)),
    score: 100 - rank / 1_000,
    components: [],
    rationale: "held 32 years",
    matchHash: `hash-${rank}`,
  };
}

/**
 * A source that pages exactly the way the real ones do.
 *
 * The 5,000 row ceiling is not invented here: it is `Math.min(..., 5_000)` in
 * both lib/data/browser.ts and lib/data/duckdb.ts, and it is the reason the
 * sweep is a loop rather than one query.
 */
function fakeSource(total: number): PropertyDataSource & { queries: PropertySearchQuery[] } {
  const queries: PropertySearchQuery[] = [];

  const source = {
    queries,
    async search(query: PropertySearchQuery): Promise<PropertySearchResult> {
      queries.push(query);
      const limit = Math.min(Math.max(query.limit ?? 200, 1), 5_000);
      const offset = Math.max(query.offset ?? 0, 0);
      const rows: ScoredProperty[] = [];
      for (let rank = offset; rank < Math.min(offset + limit, total); rank += 1) {
        rows.push(scored(rank));
      }
      return { rows, total, sql: "SELECT 1", tookMs: 1, truncated: total > offset + rows.length };
    },
  } as unknown as PropertyDataSource & { queries: PropertySearchQuery[] };

  return source;
}

describe("sweeping a saved search", () => {
  it("retrieves every matching id, well past the fingerprint cap", async () => {
    const source = fakeSource(12_345);
    const swept = await collectMatches(source, { criteria: CRITERIA });

    expect(swept.matched).toBe(12_345);
    expect(swept.ids).toHaveLength(12_345);
    expect(swept.ids[0]).toBe(parcel(0));
    expect(swept.ids.at(-1)).toBe(parcel(12_344));
    expect(swept.truncated).toBe(false);
    // Three pages, because 5,000 is all one query will answer.
    expect(swept.pages).toBe(3);
  });

  it("still fingerprints only the best TRACKED_MATCH_CAP of them", async () => {
    // The cheap half rises; the expensive half does not. A snapshot per parcel
    // over 12,345 parcels is what made the cap necessary in the first place, and
    // it is still on the saved search document.
    const swept = await collectMatches(fakeSource(12_345), { criteria: CRITERIA });
    expect(swept.rows).toHaveLength(TRACKED_MATCH_CAP);
    expect(swept.rows[0]?.propertyId).toBe(parcel(0));
    expect(swept.rows.at(-1)?.propertyId).toBe(parcel(TRACKED_MATCH_CAP - 1));
  });

  it("carries alert detail for a parcel that newly matches below the cap", async () => {
    // Rank 5,000 in a 12,345 row match set. Detecting it is an id comparison;
    // alerting on it needs an address, an owner, a score and a rationale, and
    // the sweep has already materialised all four - so it keeps them rather
    // than paying for a second query or shipping an alert with nothing on it.
    const known = new Set<string>();
    for (let rank = 0; rank < 12_345; rank += 1) {
      if (rank !== 5_000) known.add(parcel(rank));
    }

    const swept = await collectMatches(fakeSource(12_345), {
      criteria: CRITERIA,
      previousIds: known,
    });

    const ids = swept.rows.map((r) => r.propertyId);
    expect(ids).toContain(parcel(5_000));
    const late = swept.rows.find((r) => r.propertyId === parcel(5_000));
    expect(late?.propertySnapshot["address"]).toContain(`${parcel(5_000)} SOMEWHERE ST`);
    expect(late?.propertySnapshot["ownerName"]).toBe("SMITH JOHN");
    expect(late?.rationale).toContain("held 32 years");
    // And it is extra, not a substitution: the tracked rows are all still there.
    expect(swept.rows).toHaveLength(TRACKED_MATCH_CAP + 1);
  });

  it("carries no extra detail when the caller already knew every parcel", async () => {
    const known = new Set(Array.from({ length: 12_345 }, (_, rank) => parcel(rank)));
    const swept = await collectMatches(fakeSource(12_345), {
      criteria: CRITERIA,
      previousIds: known,
    });
    expect(swept.rows).toHaveLength(TRACKED_MATCH_CAP);
  });

  it("bounds the extra detail, so a criteria change cannot make one pass unbounded", async () => {
    const swept = await collectMatches(fakeSource(12_345), {
      criteria: CRITERIA,
      previousIds: new Set<string>(),
      detailCap: 5,
    });
    expect(swept.rows).toHaveLength(TRACKED_MATCH_CAP + 5);
  });

  it("stops at the id cap and says the set is partial", async () => {
    const swept = await collectMatches(fakeSource(12_345), { criteria: CRITERIA, idCap: 7_500 });

    expect(swept.ids).toHaveLength(7_500);
    expect(swept.matched).toBe(12_345);
    expect(swept.truncated).toBe(true);
    expect(swept.matchIds.truncated).toBe(true);
  });

  it("orders by score and never asks for more than one page at a time", async () => {
    const source = fakeSource(12_345);
    await collectMatches(source, { criteria: CRITERIA });
    for (const query of source.queries) {
      expect(query.orderBy).toBe("score");
      expect(query.limit).toBeLessThanOrEqual(5_000);
    }
    expect(source.queries.map((q) => q.offset)).toEqual([0, 5_000, 10_000]);
  });

  it("reports progress per page rather than once per search", async () => {
    const seen: number[] = [];
    await collectMatches(fakeSource(12_345), {
      criteria: CRITERIA,
      onPage: (collected) => seen.push(collected),
    });
    expect(seen).toEqual([5_000, 10_000, 12_345]);
  });

  it("does not loop when a source reports a count its rows cannot fill", async () => {
    // A count and a page read can disagree - an overlay republishing values
    // between the two queries is enough. A sweep that trusted the count alone
    // would page for ever against it.
    const swept = await collectMatches(fakeSource(0), { criteria: CRITERIA });
    expect(swept.ids).toHaveLength(0);
    expect(swept.pages).toBe(1);
  });
});
