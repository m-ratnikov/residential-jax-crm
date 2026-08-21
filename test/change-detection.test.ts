/**
 * Change detection decides whether someone is woken up, so its failure modes
 * are asymmetric: a missed change is a lost deal, and a spurious change is a
 * notifier people turn off. Both are tested here.
 */

import { describe, expect, it } from "vitest";

import {
  changedFields,
  humanField,
  matchHashOf,
  materialSnapshot,
  MATERIAL_FIELDS,
  rationaleFor,
} from "@/lib/criteria/score";
import {
  courtDistressScore,
  buildOverlay,
  EMPTY_OVERLAY,
  isEmptyOverlay,
} from "@/lib/data/overlay";
import type { PropertyRecord, ScoreComponent } from "@/lib/data/types";

function property(overrides: Partial<PropertyRecord> = {}): PropertyRecord {
  return {
    propertyId: "1234560000",
    parcelIdentifier: "1234560000",
    propertyCid: null,
    addressStreet: "1665 KENSINGTON GARDENS BLVD",
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
    assessedValue: 184000,
    marketValue: 210000,
    landValue: 45000,
    taxableValue: 184000,
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
    lastSalePrice: 78000,
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
      sourceUrl: "https://example.invalid/nal",
      fetchedAt: "2026-08-21T08:45:00Z",
      runId: "01M0HQYRTKZQAXFG4AZ60ZHS15",
      sourceArtifact: null,
      sourceSha256: null,
    },
    raw: {},
    ...overrides,
  };
}

describe("match fingerprint", () => {
  it("is stable for an unchanged record", () => {
    expect(matchHashOf(property())).toBe(matchHashOf(property()));
  });

  it("moves when a material field moves", () => {
    const before = matchHashOf(property());
    const after = matchHashOf(property({ assessedValue: 210000 }));
    expect(after).not.toBe(before);
  });

  it("ignores a field an acquisitions team would not act on", () => {
    // A re-export that changes only the transit distance is not news.
    const before = matchHashOf(property());
    const after = matchHashOf(property({ nearestTransitStopM: 9999, subdivision: "NEW NAME" }));
    expect(after).toBe(before);
  });

  it("covers every field the snapshot stores, so a diff can always name a change", () => {
    const snapshot = materialSnapshot(property());
    expect(Object.keys(snapshot).sort()).toEqual([...MATERIAL_FIELDS].sort());
  });
});

describe("changed fields", () => {
  it("names exactly what moved", () => {
    const before = materialSnapshot(property());
    const after = property({ assessedValue: 210000, ownerName: "SMITH FAMILY TRUST" });
    expect(changedFields(before, after).sort()).toEqual(["assessedValue", "ownerName"]);
  });

  it("returns nothing when nothing material moved", () => {
    const before = materialSnapshot(property());
    expect(changedFields(before, property({ waterDistM: 12 }))).toEqual([]);
  });

  it("ignores a field absent from the stored snapshot rather than reporting a false change", () => {
    // An older snapshot written before a field existed must not read as a
    // change on every pass forever after.
    const before = materialSnapshot(property());
    delete (before as Record<string, unknown>)["roofPermitCount"];
    expect(changedFields(before, property({ roofPermitCount: 3 }))).toEqual([]);
  });

  it("gives every material field a readable name", () => {
    for (const field of MATERIAL_FIELDS) {
      expect(humanField(field)).not.toBe(field);
    }
  });
});

describe("rationale", () => {
  const components: ScoreComponent[] = [
    { key: "tenure", label: "held long", value: 1, weight: 3, points: 50, matched: true },
    { key: "roofAge", label: "old roof", value: 1, weight: 3, points: 50, matched: true },
  ];

  it("quotes the values behind the score rather than restating the filter", () => {
    const text = rationaleFor(property(), components, false);
    expect(text).toContain("held 32 years");
    expect(text).toContain("38 years old");
  });

  it("says when a roof age is only a proxy", () => {
    expect(rationaleFor(property(), components, false)).toContain("estimated from year built");
  });

  it("explains an unranked result instead of implying an order", () => {
    const text = rationaleFor(property(), [], true);
    expect(text).toContain("no ranking signals");
  });

  it("does not claim a contribution when every component scored zero", () => {
    const zeroed = components.map((component) => ({ ...component, points: 0, value: 0 }));
    expect(rationaleFor(property(), zeroed, false)).toContain("none of the weighted signals");
  });
});

describe("court distress score", () => {
  const now = new Date("2026-08-21T00:00:00Z");

  it("is zero with no filings", () => {
    expect(
      courtDistressScore(
        {
          lienCount: 0,
          foreclosureCount: 0,
          codeEnforcementCount: 0,
          probateCount: 0,
          latestFilingDate: null,
        },
        now,
      ),
    ).toBe(0);
  });

  it("weights a foreclosure above a code enforcement case", () => {
    const foreclosure = courtDistressScore(
      {
        lienCount: 0,
        foreclosureCount: 1,
        codeEnforcementCount: 0,
        probateCount: 0,
        latestFilingDate: "2026-08-01",
      },
      now,
    );
    const code = courtDistressScore(
      {
        lienCount: 0,
        foreclosureCount: 0,
        codeEnforcementCount: 1,
        probateCount: 0,
        latestFilingDate: "2026-08-01",
      },
      now,
    );
    expect(foreclosure).toBeGreaterThan(code);
  });

  it("decays an old filing but never to nothing", () => {
    const recent = courtDistressScore(
      {
        lienCount: 1,
        foreclosureCount: 0,
        codeEnforcementCount: 0,
        probateCount: 0,
        latestFilingDate: "2026-08-01",
      },
      now,
    );
    const old = courtDistressScore(
      {
        lienCount: 1,
        foreclosureCount: 0,
        codeEnforcementCount: 0,
        probateCount: 0,
        latestFilingDate: "2018-01-01",
      },
      now,
    );
    expect(old).toBeLessThan(recent);
    expect(old).toBeGreaterThan(0);
  });

  it("never exceeds one hundred", () => {
    expect(
      courtDistressScore(
        {
          lienCount: 20,
          foreclosureCount: 20,
          codeEnforcementCount: 20,
          probateCount: 20,
          latestFilingDate: "2026-08-01",
        },
        now,
      ),
    ).toBeLessThanOrEqual(100);
  });
});

describe("overlay", () => {
  it("reads the parquet view directly when there is nothing to overlay", () => {
    const built = buildOverlay(EMPTY_OVERLAY);
    expect(isEmptyOverlay(EMPTY_OVERLAY)).toBe(true);
    expect(built.prefix).toBe("");
    expect(built.from).toBe("properties");
    expect(built.courtAvailable).toBe(false);
  });

  it("replaces an overridden column and leaves the rest of the row alone", () => {
    const built = buildOverlay({
      court: [],
      overrides: [
        { propertyId: "123", values: { assessed_value: 210000 }, runId: "sim-20260821-abc" },
      ],
    });
    expect(built.from).toBe("overlaid");
    expect(built.prefix).toContain(
      "coalesce(o.ov_assessed_value, b.assessed_value) AS assessed_value",
    );
    // EXCLUDE keeps every other published column without naming it, so a new
    // pipeline column needs no change here.
    expect(built.prefix).toContain("b.* EXCLUDE");
  });

  it("merges a court aggregate and an override for the same parcel into one row", () => {
    const built = buildOverlay({
      court: [
        {
          propertyId: "123",
          lienCount: 2,
          foreclosureCount: 1,
          codeEnforcementCount: 0,
          probateCount: 0,
          distressScore: 70,
          latestFilingDate: "2026-08-01",
        },
      ],
      overrides: [{ propertyId: "123", values: { owner_name: "TRUST" }, runId: "sim-1" }],
    });
    // One VALUES row, not two: a second row for the same parcel would join
    // twice and double the parcel in every result.
    expect(built.prefix.split("('123',").length - 1).toBe(1);
    // And that single row carries both contributions.
    expect(built.prefix).toContain("'TRUST'");
    expect(built.prefix).toContain("CAST(70 AS DOUBLE)");
    expect(built.courtAvailable).toBe(true);
  });

  it("escapes an overridden string value", () => {
    const built = buildOverlay({
      court: [],
      overrides: [{ propertyId: "1", values: { owner_name: "O'BRIEN" }, runId: "sim-1" }],
    });
    expect(built.prefix).toContain("'O''BRIEN'");
  });

  it("casts a null override so an all null column still binds a type", () => {
    const built = buildOverlay({
      court: [],
      overrides: [{ propertyId: "1", values: {}, runId: "sim-1" }],
    });
    expect(built.prefix).toContain("CAST(NULL AS DOUBLE)");
  });
});
