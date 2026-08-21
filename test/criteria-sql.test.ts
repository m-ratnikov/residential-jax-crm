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
    expect(value?.expression).toContain("1.0 - (assessed_value - 100000)");
  });

  it("excludes court signals from the distress component when unavailable", () => {
    const withCourt = buildScore(
      criteria({ distress: { hasLien: true, absenteeOwner: true } }),
      true,
    );
    const withoutCourt = buildScore(
      criteria({ distress: { hasLien: true, absenteeOwner: true } }),
      false,
    );
    expect(withCourt.components[0]?.expression).toContain("court_lien_count");
    expect(withoutCourt.components[0]?.expression).not.toContain("court_lien_count");
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
