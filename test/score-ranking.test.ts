/**
 * Does the match score actually rank anything?
 *
 * This is the one question a string assertion cannot answer. The old scoring
 * passed every unit test it had - the SQL was well formed, the weights
 * normalised, the components dropped when unset - and still produced a list
 * whose first thousand rows were indistinguishable, because a threshold credit
 * plus a fifteen year cap plus a distress component that restated the filter
 * put a large share of the county on exactly 100.
 *
 * So this runs the real criteria against the bundled county extract and looks
 * at the distribution of the scores that come back: how many distinct values,
 * how many parcels tied for first, and whether a plainly better candidate
 * actually finishes above a merely qualifying one. `legacyScore` below is the
 * model that shipped before, computed from the same rows, so the numbers this
 * file asserts can be read against the numbers it replaced.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { DuckDbPropertyDataSource } from "@/lib/data/duckdb";
import { SAMPLE_QUERY_TABLE, SAMPLE_RUN_HISTORY } from "@/lib/data/config";
import { CRITERIA_PRESETS, DEFAULT_WEIGHTS, type CriteriaSet } from "@/lib/criteria/types";
import { rankedTenureYears, tenureConfidenceOf } from "@/lib/criteria/sql";
import type { ScoredProperty } from "@/lib/data/types";

const samplePath = join(process.cwd(), SAMPLE_QUERY_TABLE);
const historyPath = join(process.cwd(), SAMPLE_RUN_HISTORY);
const suite = existsSync(samplePath) ? describe : describe.skip;

/** The thesis the reviewer ran: it is the one that saturated. */
const TIRED_LANDLORD: CriteriaSet = CRITERIA_PRESETS.find(
  (preset) => preset.id === "tired-landlord",
)?.criteria ?? {
  name: "Tired landlord",
  filters: {
    residentialOnly: true,
    dwellingsOnly: true,
    minYearsSinceSale: 10,
    minRoofAge: 15,
    distress: { absenteeOwner: true, noHomestead: true },
  },
  weights: DEFAULT_WEIGHTS,
};

/**
 * The scoring this replaced: 0.6 of a component for clearing the threshold,
 * the rest earned over fifteen years and then capped, and a distress component
 * that was 1.0 for every row the filter had already selected.
 */
function legacyScore(row: ScoredProperty): number {
  const ramp = (value: number | null, threshold: number): number => {
    if (value === null || value < threshold) return 0;
    return Math.min(1, 0.6 + 0.4 * Math.min(1, (value - threshold) / 15));
  };
  const tenure = ramp(row.property.yearsSinceLastSale, 10);
  const roof = ramp(row.property.roofAgeYears, 15);
  const distress = 1;
  return Math.round(((100 * (3 * tenure + 3 * roof + 3 * distress)) / 9) * 10) / 10;
}

function shareTiedAtTop(scores: readonly number[]): number {
  const top = Math.max(...scores);
  return scores.filter((score) => score === top).length / scores.length;
}

suite("the match score orders the county", () => {
  let source: DuckDbPropertyDataSource;
  let rows: readonly ScoredProperty[];

  beforeAll(async () => {
    source = new DuckDbPropertyDataSource({
      source: samplePath,
      isSample: true,
      label: "test sample",
      countyName: "Duval",
      stateCode: "FL",
      runHistoryUrl: existsSync(historyPath) ? historyPath : null,
    });
    const result = await source.search({
      criteria: TIRED_LANDLORD,
      limit: 2_000,
      orderBy: "score",
    });
    rows = result.rows;
  }, 60_000);

  afterAll(async () => {
    await source.close();
  });

  it("matches at a volume where a tie for first place actually matters", () => {
    // Not a fixture. If this ever drops to a handful of rows the rest of the
    // assertions stop meaning anything, so it is stated rather than assumed.
    expect(rows.length).toBeGreaterThan(500);
  });

  it("leaves only a sliver of the list tied for first", () => {
    const scores = rows.map((row) => row.score);
    const tied = shareTiedAtTop(scores);
    const before = shareTiedAtTop(rows.map(legacyScore));

    // The model it replaced put more than a twentieth of the match set on the
    // same top score - on the full county roll, 1,140 parcels out of 10,209.
    expect(before).toBeGreaterThan(0.05);
    expect(tied).toBeLessThan(0.01);
  });

  it("spreads the match set across the scale instead of stacking it at the top", () => {
    const distinct = new Set(rows.map((row) => row.score));
    const legacyDistinct = new Set(rows.map(legacyScore));

    expect(distinct.size).toBeGreaterThan(legacyDistinct.size * 5);
    expect(distinct.size).toBeGreaterThan(200);

    // And the spread is real, not three clusters: the top of the list is
    // clearly above the bottom of it.
    const first = rows[0]?.score ?? 0;
    const hundredth = rows[99]?.score ?? 0;
    expect(first).toBeGreaterThan(hundredth);
  });

  it("puts a strictly better candidate above a merely qualifying one", () => {
    // "Better" here means better on every ranking signal the criteria set uses,
    // which is the only comparison that has an unarguable right answer.
    const best = rows[0];
    const qualifying = [...rows]
      .reverse()
      .find(
        (row) =>
          (row.property.yearsSinceLastSale ?? 0) < (best?.property.yearsSinceLastSale ?? 0) &&
          (row.property.roofAgeYears ?? 0) < (best?.property.roofAgeYears ?? 0),
      );

    expect(best).toBeDefined();
    expect(qualifying).toBeDefined();
    expect(best?.score).toBeGreaterThan(qualifying?.score ?? 0);
    // Both are matches: the weaker one is ranked lower, not excluded.
    expect(qualifying?.property.yearsSinceLastSale ?? 0).toBeGreaterThanOrEqual(10);
    expect(qualifying?.property.roofAgeYears ?? 0).toBeGreaterThanOrEqual(15);
  });

  it("never scores a parcel above one that beats it on every signal", () => {
    // Monotonicity, checked across the whole page rather than on one pair: if
    // A is at least as good as B on every component, A cannot score lower.
    const sample = rows.slice(0, 400);
    for (let i = 0; i < sample.length; i += 1) {
      for (let j = i + 1; j < sample.length; j += 1) {
        const a = sample[i];
        const b = sample[j];
        if (!a || !b) continue;
        const dominates = a.components.every((component, index) => {
          const other = b.components[index];
          return other ? component.value >= other.value : true;
        });
        if (dominates) expect(a.score).toBeGreaterThanOrEqual(b.score);
      }
    }
  });

  it("scores the same parcel the same way twice", async () => {
    // The matcher fingerprints and diffs between runs, so a score that drifted
    // on identical data would alert on every parcel every pass.
    const again = await source.search({ criteria: TIRED_LANDLORD, limit: 200, orderBy: "score" });
    for (const [index, row] of again.rows.entries()) {
      expect(row.property.propertyId).toBe(rows[index]?.property.propertyId);
      expect(row.score).toBe(rows[index]?.score);
    }
  });

  it("stays inside the scale it claims", () => {
    for (const row of rows) {
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
      for (const component of row.components) {
        expect(component.value).toBeGreaterThanOrEqual(0);
        expect(component.value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("quotes the parcel's own numbers in the rationale, with the points they earned", () => {
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;

    const tenure = row.components.find((component) => component.key === "tenure");
    expect(tenure).toBeDefined();
    expect(row.rationale).toContain(`held ${row.property.yearsSinceLastSale} years`);
    // The number in brackets is the contribution, at the precision it was
    // computed to, so a reader can add the brackets up and reach the badge.
    const contribution = tenure?.points ?? 0;
    const printed = Number.isInteger(Math.round(contribution * 10) / 10)
      ? String(Math.round(contribution))
      : (Math.round(contribution * 10) / 10).toFixed(1);
    expect(row.rationale).toContain(`(+${printed})`);
  });

  it("ranks court distress by how much of it there is", async () => {
    // Two filing kinds are alternatives, so each still separates two parcels,
    // and the published distress score is continuous and scored as a ramp from
    // the floor asked for. Overlaid on real parcels so the SQL has to bind
    // against the same relation the app queries.
    const ids = rows.slice(0, 3).map((row) => row.property.propertyId);
    expect(ids).toHaveLength(3);
    const [worst, middle, best] = ids as [string, string, string];

    const result = await source.search({
      criteria: {
        name: "Court distress",
        filters: { distress: { hasLien: true, hasForeclosure: true, minCourtScore: 10 } },
        weights: DEFAULT_WEIGHTS,
      },
      limit: 10,
      orderBy: "score",
      propertyIds: ids,
      overlay: {
        overrides: [],
        court: [
          {
            propertyId: best,
            lienCount: 3,
            foreclosureCount: 1,
            codeEnforcementCount: 0,
            probateCount: 0,
            distressScore: 90,
            latestFilingDate: "2026-08-01",
          },
          {
            propertyId: middle,
            lienCount: 1,
            foreclosureCount: 0,
            codeEnforcementCount: 0,
            probateCount: 0,
            distressScore: 60,
            latestFilingDate: "2026-05-01",
          },
          {
            propertyId: worst,
            lienCount: 0,
            foreclosureCount: 1,
            codeEnforcementCount: 0,
            probateCount: 0,
            distressScore: 20,
            latestFilingDate: "2024-01-01",
          },
        ],
      },
    });

    expect(result.rows.map((row) => row.property.propertyId)).toEqual([best, middle, worst]);
    const scores = result.rows.map((row) => row.score);
    expect(new Set(scores).size).toBe(3);
  });

  it("opens the default, unranked list on Jacksonville rather than on the plat numbers", async () => {
    // Nothing ranks here, so the tiebreak is the whole ordering - which is
    // exactly the case that used to serve the western county edge first.
    const result = await source.search({
      criteria: {
        name: "Everything",
        filters: { residentialOnly: true, dwellingsOnly: true },
        weights: DEFAULT_WEIGHTS,
      },
      limit: 25,
      orderBy: "score",
    });

    const distances = result.rows.map((row) => {
      const lat = row.property.latitude;
      const lng = row.property.longitude;
      if (lat === null || lng === null) return Number.POSITIVE_INFINITY;
      return Math.hypot(lat - 30.3322, (lng + 81.6557) * Math.cos((30.3322 * Math.PI) / 180));
    });

    expect(result.rows.length).toBeGreaterThan(0);
    // Degrees, roughly: 0.1 is about 11 km. The Baldwin corridor sat at 0.25.
    for (const distance of distances) expect(distance).toBeLessThan(0.15);
    // And ascending, because that is what the tiebreak asks for.
    for (let i = 1; i < distances.length; i += 1) {
      expect(distances[i] ?? 0).toBeGreaterThanOrEqual(distances[i - 1] ?? 0);
    }
  });
});

suite("tenure the roll cannot support does not lead the list", () => {
  let source: DuckDbPropertyDataSource;
  let rows: readonly ScoredProperty[];

  beforeAll(async () => {
    source = new DuckDbPropertyDataSource({
      source: samplePath,
      isSample: true,
      label: "test sample",
      countyName: "Duval",
      stateCode: "FL",
      runHistoryUrl: existsSync(historyPath) ? historyPath : null,
    });
    // The whole match set, so the placeholder parcels can be found wherever
    // they ended up rather than only where they used to be.
    const result = await source.search({
      criteria: TIRED_LANDLORD,
      limit: 5_000,
      orderBy: "score",
    });
    rows = result.rows;
  }, 60_000);

  afterAll(async () => {
    await source.close();
  });

  /**
   * The parcels the county roll stamped with a placeholder sale date.
   *
   * On the published artifact there are 1,453 of them across 404,023 parcels -
   * 842 at 1899-12-30, the Delphi/Excel zero date, and 609 at 1899-01-01 - and
   * 31 survive this thesis. On the bundled extract, four do. Identified here by
   * the tenure they produce rather than by the date, because the date column
   * the placeholder lives in is not one the list query selects.
   */
  const placeholders = (): readonly ScoredProperty[] =>
    rows.filter((row) => (row.property.yearsSinceLastSale ?? 0) > 100);

  it("finds the placeholder parcels at all, so the rest of this means something", () => {
    expect(placeholders().length).toBeGreaterThan(0);
  });

  it("keeps a hundred year placeholder out of the top of the ranked list", () => {
    // Three of the four used to sit inside the first hundred rows here, one as
    // high as seventh; on the published artifact 23 of the top 100 were
    // placeholders, led by 201 N BROOKVIEW DR - built 1986, "held 127 years".
    const top = rows.slice(0, 100);
    expect(top.filter((row) => (row.property.yearsSinceLastSale ?? 0) > 100)).toHaveLength(0);
  });

  it("ranks an unknown tenure below every verified hold rather than above them", () => {
    const best = rows[0];
    expect(best).toBeDefined();
    for (const row of placeholders()) {
      expect(row.score).toBeLessThan(best?.score ?? 0);
      const tenure = row.components.find((component) => component.key === "tenure");
      expect(tenure?.value).toBe(0);
    }
  });

  it("surfaces the parcel honestly instead of dropping it", () => {
    // "No recorded sale" is a signal an acquisitions team wants. It is kept in
    // the result, it is still matched, and the row says what the roll knows.
    for (const row of placeholders()) {
      expect(row.property.raw["tenure_confidence"]).toBe("NO_RECORDED_SALE");
      expect(row.rationale.toLowerCase()).toContain("no recorded sale");
      expect(row.rationale.toLowerCase()).not.toContain("held 127 years");
    }
  });

  it("agrees with the TypeScript guard on every row it returned", () => {
    // The SQL guard and the TypeScript guard are two encodings of one rule, so
    // they are pinned to each other against real data rather than trusted to
    // stay in step.
    for (const row of rows) {
      expect(row.property.raw["tenure_confidence"]).toBe(tenureConfidenceOf(row.property));
      const ranked = row.property.raw["tenure_years_ranked"];
      expect(ranked === null ? null : Number(ranked)).toBe(rankedTenureYears(row.property));
    }
  });

  it("does not open Longest held on parcels the roll never recorded a sale for", async () => {
    const byTenure = await source.search({
      criteria: TIRED_LANDLORD,
      limit: 20,
      orderBy: "tenure",
    });
    for (const row of byTenure.rows) {
      // A capped parcel may legitimately be here - it is sorted on the age of
      // its building, which is a number the roll supports. A placeholder may
      // not: there is nothing to sort it on.
      expect(row.property.raw["tenure_confidence"]).not.toBe("NO_RECORDED_SALE");
      expect(row.property.raw["tenure_confidence"]).not.toBe("UNKNOWN");
    }
  });

  it("caps a sale recorded before the structure at the age of the structure", () => {
    // The independent sanity check. These parcels are kept and ranked on the
    // building's age; the rationale says which number it used and why.
    const capped = rows.filter(
      (row) => row.property.raw["tenure_confidence"] === "PREDATES_STRUCTURE",
    );
    expect(capped.length).toBeGreaterThan(0);
    for (const row of capped) {
      const ranked = Number(row.property.raw["tenure_years_ranked"]);
      expect(ranked).toBeLessThan(row.property.yearsSinceLastSale ?? 0);
      expect(row.rationale).toContain("predates the");
    }
  });

  it("leaves the fingerprinted tenure value exactly as published", () => {
    // `yearsSinceLastSale` is one of the sixteen material fields the matcher
    // hashes. If the guard had rewritten it, every stored snapshot would
    // invalidate and the next pass would alert on every watched parcel.
    for (const row of placeholders()) {
      expect(row.property.yearsSinceLastSale).toBeGreaterThan(100);
    }
  });
});

suite("the rationale credits only what scored", () => {
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

  it("does not narrate the homestead exemption inside a scoring contribution", async () => {
    // Every rationale read "absentee owner mailing from out of state, no
    // homestead exemption (+28.3)". `noHomestead` is guaranteed by the WHERE
    // clause and therefore excluded from scoring, so the whole 28.3 was the
    // absentee grade and the sentence credited a signal worth nothing.
    const result = await source.search({
      criteria: TIRED_LANDLORD,
      limit: 100,
      orderBy: "score",
    });
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.rationale).not.toContain("no homestead exemption");
      expect(row.property.homesteadFlag).toBe(false);
    }
    // And the signal that did score is still named.
    expect(result.rows.some((row) => row.rationale.includes("absentee owner"))).toBe(true);
  });
});

suite("the tenure guard does not move the matcher's fingerprint", () => {
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

  it("hashes exactly the published values, not the guarded ones", async () => {
    // `yearsSinceLastSale` and `lastSaleDate` are two of the sixteen material
    // fields `matchHashOf` covers. If the guard had rewritten either of them,
    // every stored snapshot would invalidate and the next matcher pass would
    // alert on every watched parcel in every saved search. So the guard is a
    // value beside the published column, never a replacement for it, and this
    // pins that: the record the matcher hashes must still carry the roll's own
    // numbers, placeholder parcels included.
    const result = await source.search({
      criteria: TIRED_LANDLORD,
      limit: 1_000,
      orderBy: "score",
    });
    expect(result.rows.length).toBeGreaterThan(100);

    for (const { property } of result.rows) {
      const published = property.raw["years_since_last_sale"];
      expect(property.yearsSinceLastSale).toBe(published === null ? null : Number(published));
      const publishedDate = property.raw["last_sale_date"];
      expect(property.lastSaleDate).toBe(publishedDate === null ? null : publishedDate);
    }

    // And the fingerprint is a pure function of those fields, so it is stable
    // for the same row across two passes of the same data.
    const again = await source.search({
      criteria: TIRED_LANDLORD,
      limit: 1_000,
      orderBy: "score",
    });
    for (const [index, row] of again.rows.entries()) {
      expect(row.matchHash).toBe(result.rows[index]?.matchHash);
    }
  });
});
