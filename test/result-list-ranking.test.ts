/**
 * What the ranked list is allowed to claim.
 *
 * Two things a reviewer reads off the first screen and believes: the number in
 * the badge, and the "held N years" beside it. Both were saying something the
 * data did not support - a flat 100 painted good-green on every row of an
 * unranked search, and a 127 year hold on a house built in 1986 - so both are
 * asserted here against rendered output rather than against intent.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResultList, isUnrankedResult } from "@/components/ResultList";
import { UNRANKED_EXPLANATION } from "@/lib/criteria/score";
import { EMPTY_CRITERIA } from "@/lib/criteria/types";
import type { SearchRow } from "@/lib/client";
import type { ScoreComponent } from "@/lib/data/types";

const TENURE_COMPONENT: ScoreComponent = {
  key: "tenure",
  label: "held at least 10 years on a recorded sale, and every further year scores higher",
  value: 0.8,
  weight: 3,
  points: 40,
  matched: true,
};

function row(overrides: Partial<SearchRow> = {}): SearchRow {
  return {
    propertyId: "1629740000R",
    address: "201 N BROOKVIEW DR, JACKSONVILLE, 32208",
    city: "JACKSONVILLE",
    zip: "32208",
    latitude: 30.38,
    longitude: -81.7,
    ownerName: "SMITH JOHN",
    ownerOccupied: false,
    ownerRegionClass: "NATIONAL",
    assessedValue: 118_000,
    marketValue: 140_000,
    builtYear: 1986,
    livableFloorArea: 1_240,
    roofAgeYears: 40,
    roofAgeBasis: "EFF_YR_BLT_PROXY",
    yearsSinceLastSale: 32,
    lastSaleDate: "1994-06-01",
    tenureBasis: "COJ_SALESL",
    waterViewFlag: false,
    nearestTransitStopM: 420,
    courtDistressScore: null,
    courtLienCount: null,
    courtForeclosureCount: null,
    simulated: false,
    score: 100,
    rationale: "a rationale",
    components: [TENURE_COMPONENT],
    provenance: {
      sourceSystem: "COJ",
      sourceUrl: null,
      fetchedAt: null,
      runId: null,
      sourceArtifact: null,
      sourceSha256: null,
    },
    opportunityId: null,
    ...overrides,
  };
}

function render(rows: SearchRow[]): string {
  return renderToStaticMarkup(
    createElement(ResultList, {
      rows,
      total: rows.length,
      loading: false,
      selectedId: null,
      onSelect: () => undefined,
      hasMore: false,
      sql: "SELECT 1",
      tookMs: 12,
      orderBy: "score" as const,
      onOrderChange: () => undefined,
      criteria: EMPTY_CRITERIA,
    }),
  );
}

describe("an unranked result says so once, not on every row", () => {
  it("recognises an unranked result from the rows the server actually scored", () => {
    expect(isUnrankedResult([{ components: [] }, { components: [] }])).toBe(true);
    expect(isUnrankedResult([{ components: [] }, { components: [TENURE_COMPONENT] }])).toBe(false);
    // An empty result is not an unranked one; there is nothing to explain.
    expect(isUnrankedResult([])).toBe(false);
  });

  it("states the explanation exactly once, above the list", () => {
    // It used to be the per-row rationale, line-clamped to two lines and
    // repeated identically down the page.
    const markup = render([
      row({ components: [], rationale: UNRANKED_EXPLANATION }),
      row({ propertyId: "b", components: [], rationale: UNRANKED_EXPLANATION }),
      row({ propertyId: "c", components: [], rationale: UNRANKED_EXPLANATION }),
    ]);
    const occurrences = markup.split(UNRANKED_EXPLANATION.slice(0, 60)).length - 1;
    expect(occurrences).toBe(1);
    expect(markup).toContain("unranked-notice");
  });

  it("does not paint a green hundred on a row nothing could rank", () => {
    const markup = render([row({ components: [], rationale: UNRANKED_EXPLANATION })]);
    expect(markup).not.toContain('data-testid="score"');
    expect(markup).toContain("unranked");
  });

  it("keeps the badge and the per row rationale once the criteria can rank", () => {
    const markup = render([row({ score: 84.9, rationale: "held 32 years (+27.4)" })]);
    expect(markup).toContain('data-testid="score"');
    expect(markup).toContain("held 32 years (+27.4)");
    expect(markup).not.toContain("unranked-notice");
  });
});

describe("the row says what the roll supports about tenure", () => {
  it("prints a verified hold as published", () => {
    expect(render([row()])).toContain("held 32y");
  });

  it("refuses to print a hundred year hold on a house built in 1986", () => {
    // 201 N BROOKVIEW DR: built 1986, the roll's placeholder sale date, and it
    // reached the reviewer as "held 127 years" at the top of the list.
    const markup = render([row({ yearsSinceLastSale: 127, builtYear: 1986 })]);
    expect(markup).not.toContain("held 127y");
    expect(markup).toContain("tenure unknown");
    expect(markup).toContain("no recorded sale");
  });

  it("prints a sale that predates the structure as an upper bound", () => {
    const markup = render([row({ yearsSinceLastSale: 60, builtYear: 2005 })]);
    expect(markup).not.toContain("held 60y");
    // 2026 - (2005 - 1): the age of the building, with a year of grace.
    expect(markup).toContain("22y");
    expect(markup).toContain("predates the 2005 structure");
  });
});
