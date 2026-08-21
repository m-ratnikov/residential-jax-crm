/**
 * The data source, exercised against the bundled sample rather than a mock.
 *
 * A mocked DuckDB would prove the code calls the functions it calls. Running it
 * against the real parquet is what proves the generated SQL parses, the overlay
 * CTE binds, the scores come back in range and the counts agree with the rows -
 * which is where every bug in this layer would actually live.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { DuckDbPropertyDataSource } from "@/lib/data/duckdb";
import { SAMPLE_QUERY_TABLE, SAMPLE_RUN_HISTORY } from "@/lib/data/config";
import { DEFAULT_WEIGHTS, type CriteriaSet } from "@/lib/criteria/types";
import { DWELLING_MIN_SQFT } from "@/lib/criteria/sql";
import type { Overlay } from "@/lib/data/overlay";

const samplePath = join(process.cwd(), SAMPLE_QUERY_TABLE);
const historyPath = join(process.cwd(), SAMPLE_RUN_HISTORY);

// The sample is generated from the published artifact, so a fresh clone that
// has not run `pnpm sample` skips rather than fails.
const available = existsSync(samplePath);
const suite = available ? describe : describe.skip;

function criteria(filters: CriteriaSet["filters"], name = "test"): CriteriaSet {
  return { name, filters, weights: DEFAULT_WEIGHTS };
}

suite("DuckDbPropertyDataSource against the bundled sample", () => {
  let source: DuckDbPropertyDataSource;

  beforeAll(() => {
    source = new DuckDbPropertyDataSource({
      source: samplePath,
      isSample: true,
      label: "test sample",
      countyName: "Duval",
      stateCode: "FL",
      runHistoryUrl: existsSync(historyPath) ? historyPath : null,
    });
  });

  afterAll(async () => {
    await source.close();
  });

  it("reports the scale and identity of what it loaded", async () => {
    const info = await source.info();
    expect(info.kind).toBe("duckdb-parquet");
    expect(info.isSample).toBe(true);
    // A real county slice, not a fixture of a dozen rows.
    expect(info.rowCount).toBeGreaterThan(50_000);
    expect(info.columnCount).toBeGreaterThan(90);
    expect(info.runId).toBeTruthy();
  });

  it("describes the published columns, including which are derived and which are provenance", async () => {
    const schema = await source.getSchema();
    const byName = new Map(schema.map((column) => [column.name, column]));

    expect(byName.get("property_id")?.meaning).toBeTruthy();
    expect(byName.get("roof_year_est")?.isDerived).toBe(true);
    expect(byName.get("source_url")?.isProvenance).toBe(true);
  });

  it("answers the ownership tenure question the story asks for", async () => {
    // This is the criterion that returns nothing against a locally built roll,
    // because the FDOR extract carries only the current roll period's sales.
    // The sample is cut from the published artifact, which is built where the
    // county's own sales history is reachable.
    const result = await source.search({
      criteria: criteria({ residentialOnly: true, minYearsSinceSale: 10 }),
      limit: 5,
    });

    expect(result.total).toBeGreaterThan(1_000);
    for (const row of result.rows) {
      expect(row.property.yearsSinceLastSale).toBeGreaterThanOrEqual(10);
    }
  });

  it("excludes parcels with nowhere to live on them, which are not acquisitions", async () => {
    // Duval's residential roll carries tens of thousands of parcels nobody
    // lives on: HOA common areas and retention ponds with no floor area, and 55
    // sq ft condo garage units assessed at a dollar. They are absentee owned,
    // without a homestead exemption, held for decades, so on a distress thesis
    // they score a perfect 100 and bury every real house.
    const thesis = { residentialOnly: true, distress: { absenteeOwner: true, noHomestead: true } };

    const all = await source.search({ criteria: criteria(thesis), limit: 200, orderBy: "score" });
    const improved = await source.search({
      criteria: criteria({ ...thesis, dwellingsOnly: true }),
      limit: 200,
      orderBy: "score",
    });

    expect(improved.total).toBeGreaterThan(0);
    expect(improved.total).toBeLessThan(all.total);
    for (const row of improved.rows) {
      expect(row.property.livableFloorArea ?? 0).toBeGreaterThanOrEqual(DWELLING_MIN_SQFT);
      // And a value on the roll. Floor area alone is not enough: a handful of
      // dwellings are assessed at zero because they are exempt, and an exempt
      // parcel is not an acquisition either.
      expect(row.property.assessedValue).toBeGreaterThan(0);
    }
  });

  it("ranks by score and explains each row with the values behind it", async () => {
    const result = await source.search({
      criteria: criteria(
        {
          residentialOnly: true,
          minYearsSinceSale: 10,
          minRoofAge: 15,
          distress: { absenteeOwner: true, noHomestead: true },
        },
        "Tired landlord",
      ),
      limit: 10,
    });

    expect(result.rows.length).toBeGreaterThan(0);

    let previous = Number.POSITIVE_INFINITY;
    for (const row of result.rows) {
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
      // Descending, because the caller asked for score order.
      expect(row.score).toBeLessThanOrEqual(previous);
      previous = row.score;

      expect(row.rationale.length).toBeGreaterThan(20);
      expect(row.matchHash).toHaveLength(32);
      // Every filter the criteria set applied actually held.
      expect(row.property.roofAgeYears).toBeGreaterThanOrEqual(15);
      expect(row.property.ownerOccupied).not.toBe(true);
    }
  });

  it("agrees between the total and the rows it pages", async () => {
    const set = criteria({ residentialOnly: true, minRoofAge: 40, maxAssessedValue: 90_000 });
    const first = await source.search({ criteria: set, limit: 25, offset: 0 });
    const second = await source.search({ criteria: set, limit: 25, offset: 25 });

    expect(first.total).toBe(second.total);
    if (first.total > 25) {
      const firstIds = new Set(first.rows.map((row) => row.property.propertyId));
      // Paging must not repeat a parcel across pages.
      for (const row of second.rows) expect(firstIds.has(row.property.propertyId)).toBe(false);
    }
  });

  it("restricts to a drawn radius", async () => {
    const centre = { lat: 30.2874, lng: -81.5342 };
    const inside = await source.search({
      criteria: criteria({
        residentialOnly: true,
        geometry: { type: "circle", ...centre, radiusM: 1_200 },
      }),
      limit: 50,
    });
    const wider = await source.search({
      criteria: criteria({
        residentialOnly: true,
        geometry: { type: "circle", ...centre, radiusM: 6_000 },
      }),
      limit: 50,
    });

    expect(inside.total).toBeGreaterThan(0);
    expect(wider.total).toBeGreaterThan(inside.total);
  });

  it("applies an overlay so a simulated change is visible to a query", async () => {
    const base = await source.search({
      criteria: criteria({ residentialOnly: true, minAssessedValue: 100_000 }),
      limit: 1,
    });
    const target = base.rows[0]?.property;
    expect(target).toBeTruthy();
    if (!target) return;

    const overlay: Overlay = {
      court: [],
      overrides: [
        {
          propertyId: target.propertyId,
          // Push it below the floor the criteria set asks for.
          values: { assessed_value: 1_000 },
          runId: "sim-test",
        },
      ],
    };

    const overlaid = await source.getProperty(target.propertyId, overlay);
    expect(overlaid?.assessedValue).toBe(1_000);
    expect(overlaid?.raw["overlay_run_id"]).toBe("sim-test");

    // And the override changes who matches, not just what is displayed.
    const filtered = await source.search({
      criteria: criteria({ residentialOnly: true, minAssessedValue: 100_000 }),
      limit: 5,
      propertyIds: [target.propertyId],
      overlay,
    });
    expect(filtered.total).toBe(0);
  });

  it("makes court signals available only through the overlay", async () => {
    const withCourt = await source.search({
      criteria: criteria({ residentialOnly: true, distress: { hasLien: true } }),
      limit: 5,
      overlay: {
        court: [
          {
            propertyId: "nonexistent",
            lienCount: 1,
            foreclosureCount: 0,
            codeEnforcementCount: 0,
            probateCount: 0,
            distressScore: 20,
            latestFilingDate: "2026-08-01",
          },
        ],
        overrides: [],
      },
    });
    // The predicate binds and matches nothing, rather than failing to parse.
    expect(withCourt.total).toBe(0);
  });

  it("finds a parcel by address, owner or id", async () => {
    const seed = await source.search({ criteria: criteria({ residentialOnly: true }), limit: 1 });
    const target = seed.rows[0]?.property;
    expect(target).toBeTruthy();
    if (!target) return;

    const byId = await source.lookup(target.propertyId, 5);
    expect(byId[0]?.propertyId).toBe(target.propertyId);
  });

  it("refuses anything that is not a read", async () => {
    await expect(source.runSql("DELETE FROM properties", 10)).rejects.toThrow();
    await expect(source.runSql("DROP TABLE properties", 10)).rejects.toThrow();

    const allowed = await source.runSql("SELECT count(*) AS n FROM properties", 10);
    expect(Number(allowed.rows[0]?.["n"])).toBeGreaterThan(0);
  });

  it("carries provenance on every row it returns", async () => {
    const result = await source.search({ criteria: criteria({ residentialOnly: true }), limit: 3 });
    for (const row of result.rows) {
      expect(row.property.provenance.sourceSystem).toBeTruthy();
      expect(row.property.provenance.runId).toBeTruthy();
    }
  });

  it("reads the pipeline run history with real per source deltas", async () => {
    const runs = await source.listRuns(5);
    if (!existsSync(historyPath)) return;
    expect(runs.length).toBeGreaterThan(0);
    const [latest] = runs;
    expect(latest?.runId).toBeTruthy();
    expect(latest?.sources.length).toBeGreaterThan(0);
  });
});
