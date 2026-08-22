/**
 * A rationale is a provenance claim, and a wrong one is worse than none.
 *
 * The reviewer's finding: every row read "absentee owner mailing from out of
 * state, no homestead exemption (+28.3)". `noHomestead` is guaranteed by the
 * WHERE clause and therefore excluded from scoring, so the entire 28.3 was the
 * absentee grade and the sentence credited a signal that scored nothing. The
 * fix is structural - the score generator names the signals that rank, and the
 * rationale renders evidence only for those - so it is tested through the
 * generator rather than by asserting on a hand written string.
 */

import { describe, expect, it } from "vitest";

import { rationaleFor, tenureCaveat } from "@/lib/criteria/score";
import { buildScore } from "@/lib/criteria/sql";
import { DEFAULT_WEIGHTS, type CriteriaSet } from "@/lib/criteria/types";
import type { PropertyRecord, ScoreComponent } from "@/lib/data/types";

function criteria(filters: CriteriaSet["filters"]): CriteriaSet {
  return { name: "test", filters, weights: DEFAULT_WEIGHTS };
}

/**
 * The components the data source would build for these criteria, with the
 * rules the generator actually emitted. Only the points are invented, because
 * the point split is not what is under test here.
 */
function componentsFor(
  filters: CriteriaSet["filters"],
  courtJoinAvailable = false,
): ScoreComponent[] {
  return buildScore(criteria(filters), courtJoinAvailable).components.map((component) => ({
    key: component.key,
    label: component.rule,
    value: 1,
    weight: component.weight,
    points: 28.3,
    matched: true,
  }));
}

function property(overrides: Partial<PropertyRecord> = {}): PropertyRecord {
  return {
    propertyId: "1629740000R",
    parcelIdentifier: "1629740000R",
    propertyCid: null,
    addressStreet: "201 N BROOKVIEW DR",
    addressCity: "JACKSONVILLE",
    addressZip: "32208",
    latitude: 30.38,
    longitude: -81.7,
    subdivision: null,
    neighborhoodCode: null,
    propertyType: "RESIDENTIAL",
    propertyUsageType: "001",
    builtYear: 1986,
    livableFloorArea: 1_240,
    totalArea: 1_500,
    residentialUnits: 1,
    roofYearEst: 1986,
    roofAgeYears: 40,
    roofAgeBasis: "EFF_YR_BLT_PROXY",
    roofCoveringMaterial: null,
    assessedValue: 118_000,
    marketValue: 140_000,
    landValue: 30_000,
    taxableValue: 118_000,
    ownerName: "SMITH JOHN",
    ownerCount: 1,
    ownerOccupied: false,
    ownerRegionClass: "NATIONAL",
    ownerMailingAddress: "PO BOX 1",
    ownerMailingCity: "ATLANTA",
    ownerMailingState: "GA",
    ownerMailingZip: "30301",
    homesteadFlag: false,
    lastSaleDate: "1994-06-01",
    lastSalePrice: 62_000,
    yearsSinceLastSale: 32,
    tenureBasis: "COJ_SALESL",
    waterViewFlag: false,
    waterDistM: null,
    waterBodyName: null,
    nearestTransitStopM: 420,
    nearestTransitStopName: "Moncrief Rd",
    hasPermits: false,
    permitCount: 0,
    roofPermitCount: 0,
    lastPermitDate: null,
    provenance: {
      sourceSystem: "COJ",
      sourceUrl: null,
      fetchedAt: null,
      runId: null,
      sourceArtifact: null,
      sourceSha256: null,
    },
    raw: {},
    ...overrides,
  };
}

describe("the rationale describes only what contributed", () => {
  it("credits the absentee grade and never the homestead exemption", () => {
    const text = rationaleFor(
      property(),
      componentsFor({ distress: { absenteeOwner: true, noHomestead: true } }),
      false,
    );
    expect(text).toContain("absentee owner mailing from out of state (+28.3)");
    expect(text).not.toContain("homestead");
  });

  it("stops crediting the owner grade once the filter pinned the owner class", () => {
    // The owner class is then a constant, so the absentee step is dropped from
    // scoring - and with it from the sentence, because the sentence is built
    // from the signals the generator said it ranked.
    const filters = {
      ownerRegionClasses: ["NATIONAL"],
      distress: { absenteeOwner: true, hasLien: true, hasForeclosure: true },
    };
    const components = componentsFor(filters, true);
    const text = rationaleFor(
      property({ raw: { court_lien_count: 2, court_foreclosure_count: 1 } }),
      components,
      false,
    );
    expect(text).toContain("2 recorded liens");
    expect(text).not.toContain("absentee owner");
  });

  it("still names the filings when court signals are what ranks", () => {
    const text = rationaleFor(
      property({ raw: { court_lien_count: 3, court_foreclosure_count: 1 } }),
      componentsFor({ distress: { hasLien: true, hasForeclosure: true } }, true),
      false,
    );
    expect(text).toContain("3 recorded liens");
    expect(text).toContain("1 foreclosure filing");
  });
});

describe("the rationale says what the roll knows about tenure", () => {
  it("quotes a verified hold with its sale date", () => {
    const text = rationaleFor(property(), componentsFor({ minYearsSinceSale: 10 }), false);
    expect(text).toContain("held 32 years (last sale 1994-06-01)");
  });

  it("says no recorded sale rather than a hundred year hold", () => {
    const placeholder = property({ yearsSinceLastSale: 127, lastSaleDate: null });
    const components = componentsFor({ minYearsSinceSale: 10 }).map((component) =>
      // The guarded ramp scores an unknown tenure at zero, so this is what the
      // data source hands the rationale for this parcel.
      component.key === "tenure"
        ? { ...component, value: 0, points: 0, matched: false }
        : component,
    );
    const text = rationaleFor(placeholder, components, false);
    expect(text).not.toContain("held 127 years");
    expect(text.toLowerCase()).toContain("no recorded sale");
  });

  it("says a placeholder tenure even when nothing was ranking on tenure", () => {
    // The parcel is on screen either way, and the number beside it would
    // otherwise read as a fact.
    const text = rationaleFor(
      property({ yearsSinceLastSale: 127, lastSaleDate: null }),
      componentsFor({ minRoofAge: 15 }),
      false,
    );
    expect(text.toLowerCase()).toContain("no recorded sale");
  });

  it("has nothing to caveat on a parcel the roll actually recorded", () => {
    expect(tenureCaveat({ yearsSinceLastSale: 32, builtYear: 1986 })).toBeNull();
  });
});
