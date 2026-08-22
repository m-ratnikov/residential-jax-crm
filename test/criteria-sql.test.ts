/**
 * The criteria builder is where a silent bug is most expensive: a wrong
 * predicate does not throw, it just quietly returns the wrong houses, and the
 * scheduled matcher then alerts on them for weeks.
 */

import { describe, expect, it } from "vitest";

import {
  buildScore,
  buildSearch,
  buildWhere,
  geometrySql,
  needsCourtData,
  num,
  polygonSql,
  str,
  TIEBREAK_SQL,
} from "@/lib/criteria/sql";
import { criteriaSetSchema, DEFAULT_WEIGHTS, type CriteriaSet } from "@/lib/criteria/types";

function criteria(partial: CriteriaSet["filters"], weights = DEFAULT_WEIGHTS): CriteriaSet {
  return { name: "test", filters: partial, weights };
}

describe("literal encoding", () => {
  it("doubles single quotes so a value cannot terminate its own literal", () => {
    expect(str("O'BRIEN TRUST")).toBe("'O''BRIEN TRUST'");
  });

  it("rejects a non finite number rather than emitting a bare token", () => {
    expect(() => num(Number.NaN)).toThrow();
    expect(() => num(Number.POSITIVE_INFINITY)).toThrow();
    expect(num(-81.65)).toBe("-81.65");
  });

  it("survives an attempt to close the literal and append a statement", () => {
    const encoded = str("x'; DROP TABLE properties; --");
    expect(encoded).toBe("'x''; DROP TABLE properties; --'");
    expect(encoded.startsWith("'")).toBe(true);
    expect(encoded.endsWith("'")).toBe(true);
  });
});

describe("buildWhere", () => {
  it("emits nothing but true for empty criteria", () => {
    expect(buildWhere({}, false).sql).toBe("true");
  });

  it("applies the residential restriction", () => {
    const { clauses } = buildWhere({ residentialOnly: true }, false);
    expect(clauses).toContain("property_type = 'RESIDENTIAL'");
  });

  it("treats roof evidence as excluding the year built proxy", () => {
    const { sql } = buildWhere({ requireRoofEvidence: true }, false);
    expect(sql).toContain("roof_age_basis NOT ILIKE '%PROXY%'");
  });

  it("omits every court predicate when no court source is attached", () => {
    const filters = { distress: { hasLien: true, hasForeclosure: true, absenteeOwner: true } };
    const without = buildWhere(filters, false).sql;
    expect(without).not.toContain("court_lien_count");
    expect(without).not.toContain("court_foreclosure_count");
    // The roll derived signal still applies: it needs no court source.
    expect(without).toContain("owner_occupied");
  });

  it("treats several court signals as alternatives, not a conjunction", () => {
    // A parcel in foreclosure is a candidate whether or not it also has a lien.
    const { sql } = buildWhere({ distress: { hasLien: true, hasForeclosure: true } }, true);
    expect(sql).toContain("OR");
    expect(sql).toContain("court_lien_count");
    expect(sql).toContain("court_foreclosure_count");
  });

  it("reports when criteria need a court source", () => {
    expect(needsCourtData({ distress: { hasLien: true } })).toBe(true);
    expect(needsCourtData({ distress: { absenteeOwner: true } })).toBe(false);
    expect(needsCourtData({})).toBe(false);
  });
});

describe("geometry", () => {
  it("builds a bounded circle predicate", () => {
    const sql = geometrySql({ type: "circle", lat: 30.33, lng: -81.65, radiusM: 1600 });
    expect(sql).toContain("6371000");
    expect(sql).toContain("<= 1600");
  });

  it("expands a polygon into a parity test with one crossing per non horizontal edge", () => {
    // A unit square: four edges, two of them horizontal and therefore skipped.
    const sql = polygonSql([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    expect(sql).toContain("% 2 = 1");
    expect(sql.split("CASE WHEN").length - 1).toBe(2);
  });

  it("refuses to match anything for a degenerate ring", () => {
    expect(polygonSql([[0, 0]])).toBe("false");
  });
});

describe("scoring", () => {
  it("only scores on criteria the user actually set", () => {
    const score = buildScore(criteria({ minRoofAge: 15 }), false);
    expect(score.components.map((component) => component.key)).toEqual(["roofAge"]);
    expect(score.unranked).toBe(false);
  });

  it("says so rather than inventing an order when nothing can rank", () => {
    const score = buildScore(criteria({ residentialOnly: true }), false);
    expect(score.unranked).toBe(true);
    expect(score.selectFragment).toContain("100.0");
  });

  it("drops a component whose weight is zero", () => {
    const score = buildScore(
      criteria({ minRoofAge: 15, minYearsSinceSale: 10 }, { ...DEFAULT_WEIGHTS, roofAge: 0 }),
      false,
    );
    expect(score.components.map((component) => component.key)).toEqual(["tenure"]);
  });

  it("normalises across the participating components only", () => {
    // Two components at weight 3 each: the divisor must be 6, not the sum of
    // every weight in the set.
    const score = buildScore(criteria({ minRoofAge: 15, minYearsSinceSale: 10 }), false);
    expect(score.selectFragment).toContain("/ 6");
  });

  it("prefers a cheaper parcel inside a requested value band", () => {
    const score = buildScore(
      criteria({ minAssessedValue: 100000, maxAssessedValue: 200000 }),
      false,
    );
    const value = score.components.find((component) => component.key === "value");
    // Linear across the band the user asked for: 1.0 at the floor, 0.0 at the
    // ceiling, and the span is the band rather than an invented constant.
    expect(value?.expression).toContain("1.0 - (CAST(assessed_value AS DOUBLE) - 100000) / 100000");
  });

  it("still ranks on value when only a floor was given", () => {
    const score = buildScore(criteria({ minAssessedValue: 100000 }), false);
    const value = score.components.find((component) => component.key === "value");
    expect(value?.expression).toContain("100000 / CAST(assessed_value AS DOUBLE)");
  });

  it("excludes court signals from the distress component when unavailable", () => {
    const filters = { distress: { hasLien: true, hasForeclosure: true, absenteeOwner: true } };
    const withCourt = buildScore(criteria(filters), true);
    const withoutCourt = buildScore(criteria(filters), false);
    expect(withCourt.components[0]?.expression).toContain("court_lien_count");
    expect(withoutCourt.components[0]?.expression).not.toContain("court_lien_count");
  });
});

describe("a score that discriminates", () => {
  it("does not hand out a fixed credit for clearing a threshold", () => {
    // The defect: 0.6 of the component the moment the threshold was cleared, so
    // the whole ranking lived in the remaining 0.4.
    const score = buildScore(criteria({ minYearsSinceSale: 10 }), false);
    expect(score.components[0]?.expression).not.toContain("0.6");
  });

  it("keeps earning past the threshold instead of capping fifteen years later", () => {
    // Held 33 years and held 25 years used to be the same parcel. The linear
    // core now runs to the top of the roll's own range, and past that a tail
    // that approaches but never reaches full marks.
    const tenure = buildScore(criteria({ minYearsSinceSale: 10 }), false).components[0];
    expect(tenure?.expression).toContain("greatest");
    // 10 + 35: the core tops out at the roll's 45 year mark, not at 10 + 15.
    expect(tenure?.expression).toContain("/ 35");
  });

  it("stops the ramp at an upper bound the user actually set", () => {
    // Nothing above the ceiling survived the WHERE clause, so there is nothing
    // up there to order and the tail would only waste range.
    const banded = buildScore(criteria({ minRoofAge: 15, maxRoofAge: 25 }), false).components[0];
    expect(banded?.expression).toContain("/ 10");
    expect(banded?.expression).not.toContain("greatest");
  });

  it("grades an absentee owner by how far away they are rather than repeating the filter", () => {
    const distress = buildScore(criteria({ distress: { absenteeOwner: true } }), false)
      .components[0];
    expect(distress?.expression).toContain("owner_region_class");
  });

  it("leaves out a signal the filter already guarantees on every row", () => {
    // `noHomestead` is both the predicate and the signal, so it is 1.0 for
    // every row in the result. Scoring it only takes weight from the signals
    // that can still tell two matches apart.
    const both = buildScore(
      criteria({ distress: { absenteeOwner: true, noHomestead: true } }),
      false,
    );
    expect(both.components[0]?.expression).not.toContain("homestead_flag");

    const alone = buildScore(criteria({ distress: { noHomestead: true } }), false);
    expect(alone.components).toHaveLength(0);
    expect(alone.unranked).toBe(true);
  });

  it("keeps court signals that are alternatives and drops one that is not", () => {
    // Two requested kinds are ORed, so a parcel may have one and not the other
    // and the component ranks. A single requested kind is on every row.
    const two = buildScore(criteria({ distress: { hasLien: true, hasProbate: true } }), true);
    expect(two.components[0]?.expression).toContain("court_lien_count");
    expect(two.components[0]?.expression).toContain("court_probate_count");

    const one = buildScore(criteria({ distress: { hasForeclosure: true } }), true);
    expect(one.components).toHaveLength(0);
  });

  it("scores a court distress floor as a ramp up the published scale", () => {
    const score = buildScore(criteria({ distress: { minCourtScore: 40 } }), true);
    expect(score.components[0]?.expression).toContain("court_distress_score");
    expect(score.components[0]?.expression).toContain("/ 60");
  });

  it("ranks on distance from the middle of a drawn polygon, not just a circle", () => {
    const ring: [number, number][] = [
      [-81.7, 30.3],
      [-81.6, 30.3],
      [-81.6, 30.4],
      [-81.7, 30.4],
    ];
    const score = buildScore(criteria({ geometry: { type: "polygon", ring } }), false);
    const geography = score.components.find((component) => component.key === "geography");
    expect(geography?.expression).toContain("asin");
  });

  it("carries every component out as a DOUBLE", () => {
    // A decimal typed score reaches the browser as a four element array, which
    // becomes NaN, which paints an empty map. See the note on buildScore.
    const score = buildScore(criteria({ minRoofAge: 15, minYearsSinceSale: 10 }), false);
    for (const component of score.components) {
      expect(score.selectFragment).toContain(`AS DOUBLE) AS ${component.alias}`);
    }
    expect(score.selectFragment).toContain(`AS DOUBLE) AS match_score`);
  });

  it("keeps more than one decimal so the score itself orders the list", () => {
    const score = buildScore(criteria({ minRoofAge: 15 }), false);
    expect(score.selectFragment).toContain(", 2)");
  });
});

describe("buildSearch", () => {
  it("counts against the same predicate it pages over", () => {
    const built = buildSearch({
      criteria: criteria({ minRoofAge: 15, residentialOnly: true }),
      limit: 50,
      offset: 0,
      orderBy: "score",
      courtJoinAvailable: false,
    });
    // The two statements must not drift: a total that does not match the page
    // is worse than no total.
    expect(built.countSql).toContain(built.where.sql);
    expect(built.sql).toContain(built.where.sql);
  });

  it("selects court columns only when the relation carries them", () => {
    const base = {
      criteria: criteria({ minRoofAge: 15 }),
      limit: 10,
      offset: 0,
      orderBy: "score" as const,
    };
    expect(buildSearch({ ...base, courtJoinAvailable: false }).sql).not.toContain(
      "court_distress_score",
    );
    expect(buildSearch({ ...base, courtJoinAvailable: true }).sql).toContain(
      "court_distress_score",
    );
  });

  it("reads from the overlay relation when one is supplied", () => {
    const built = buildSearch({
      criteria: criteria({ minRoofAge: 15 }),
      limit: 10,
      offset: 0,
      orderBy: "score",
      courtJoinAvailable: true,
      prefix: "WITH overlaid AS (SELECT 1) ",
      from: "overlaid",
    });
    expect(built.sql.startsWith("WITH overlaid AS")).toBe(true);
    expect(built.sql).toContain("FROM overlaid");
    expect(built.countSql.startsWith("WITH overlaid AS")).toBe(true);
  });
});

describe("how ties are broken", () => {
  const order = (
    orderBy: "score" | "assessed_value" | "roof_age" | "tenure",
    filters: CriteriaSet["filters"] = {},
  ) => {
    const { sql } = buildSearch({
      criteria: criteria(filters),
      limit: 50,
      offset: 0,
      orderBy,
      courtJoinAvailable: false,
    });
    const start = sql.lastIndexOf("ORDER BY");
    const end = sql.indexOf("LIMIT", start);
    return sql.slice(start, end).trim();
  };

  it("does not fall back to cheapest first when scores tie", () => {
    // The whole defect in one assertion. Nothing ranked means every row scores
    // 100, so the tiebreak WAS the ordering, and cheapest first put fifteen
    // dollar-assessed condominium shells at the top of the default search.
    const unranked = buildScore(criteria({ residentialOnly: true, dwellingsOnly: true }), false);
    expect(unranked.unranked).toBe(true);
    expect(order("score", { residentialOnly: true, dwellingsOnly: true })).not.toContain(
      "assessed_value ASC",
    );
  });

  it("sorts a parcel the roll has not priced as a dwelling behind one it has", () => {
    // A dollar-assessed unit with a real floor area clears `assessed_value > 0`
    // and is still not a price, so the ordering says so even when the filter
    // that would have removed it is switched off.
    expect(TIEBREAK_SQL).toContain("assessed_value >= livable_floor_area");
    expect(order("score")).toContain("assessed_value >= livable_floor_area");
  });

  it("opens on Jacksonville rather than on the plat numbers", () => {
    // `property_id` is an RE number, assigned in the order the county platted
    // the land, so ascending order is the rural western edge first: the first
    // twenty rows of the default search were all on the Baldwin corridor, 28 km
    // out. Distance from downtown comes first now, and the plat number only
    // resolves an exact tie.
    const ordering = order("score");
    expect(ordering).toContain("30.3322");
    expect(ordering).toContain("-81.6557");
    expect(ordering.indexOf("30.3322")).toBeLessThan(ordering.indexOf("property_id"));
  });

  it("puts a parcel with no coordinates last rather than first", () => {
    expect(order("score")).toContain("ASC NULLS LAST, property_id");
  });

  it("breaks a remaining tie on a stable key rather than inventing a ranking", () => {
    // Deterministic ordering is what pagination and the matcher's tracked set
    // both need: without it, LIMIT/OFFSET can repeat or skip a row, and the
    // 2,000 matches a saved search watches can change between passes on
    // identical data.
    expect(TIEBREAK_SQL.trimEnd().endsWith("property_id")).toBe(true);
    for (const key of ["score", "assessed_value", "roof_age", "tenure"] as const) {
      expect(order(key).trimEnd().endsWith("property_id")).toBe(true);
    }
  });

  it("keeps cheapest first as an explicit choice", () => {
    // Choosing "Cheapest" is a deliberate sort, not a tiebreak. It still leads
    // on assessed value, dollar units included: that is the honest answer to
    // the question the button asks.
    const cheapest = order("assessed_value");
    expect(cheapest).toContain("ORDER BY assessed_value ASC NULLS LAST");
    expect(cheapest.indexOf("assessed_value ASC")).toBeLessThan(cheapest.indexOf("property_id"));
  });

  it("leads on the requested column for the other explicit sorts", () => {
    expect(order("roof_age")).toContain("ORDER BY roof_age_years DESC NULLS LAST");
    expect(order("tenure")).toContain("ORDER BY years_since_last_sale DESC NULLS LAST");
  });

  it("still ranks by score first when the criteria can rank", () => {
    const ranked = order("score", { minRoofAge: 15 });
    expect(ranked).toContain("ORDER BY match_score DESC");
    expect(ranked.indexOf("match_score DESC")).toBeLessThan(ranked.indexOf("property_id"));
  });
});

describe("criteria validation", () => {
  it("fills the default weights so a stored set without them still scores", () => {
    const parsed = criteriaSetSchema.parse({ name: "x", filters: {} });
    expect(parsed.weights).toEqual(DEFAULT_WEIGHTS);
  });

  it("rejects a polygon that cannot enclose anything", () => {
    const result = criteriaSetSchema.safeParse({
      name: "x",
      filters: {
        geometry: {
          type: "polygon",
          ring: [
            [0, 0],
            [1, 1],
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an out of range coordinate", () => {
    const result = criteriaSetSchema.safeParse({
      name: "x",
      filters: { geometry: { type: "circle", lat: 200, lng: 0, radiusM: 100 } },
    });
    expect(result.success).toBe(false);
  });
});

describe("a court criterion with no court source", () => {
  it("returns nothing rather than everything", () => {
    // Silently dropping the predicate turned "parcels with a recorded lien"
    // into "every residential dwelling in Duval" - 337,853 of them - under a
    // heading that said court distress.
    const filters = {
      residentialOnly: true,
      distress: { hasLien: true, hasForeclosure: true },
    } as const;

    const withCourt = buildWhere(filters, true);
    expect(withCourt.sql).toContain("court_lien_count");
    expect(withCourt.sql).not.toContain("false /*");

    const without = buildWhere(filters, false);
    expect(without.sql).toContain("false /*");
    expect(without.sql).not.toContain("court_lien_count");
  });

  it("leaves roll-derived distress alone, which needs no court source", () => {
    const without = buildWhere(
      { residentialOnly: true, distress: { absenteeOwner: true, noHomestead: true } },
      false,
    );
    expect(without.sql).not.toContain("false /*");
    expect(without.sql).toContain("homestead_flag");
  });
});
