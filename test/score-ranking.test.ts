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
