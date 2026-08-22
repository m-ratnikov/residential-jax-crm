/**
 * The note that says why every score is 100, and the window it used to vanish
 * in.
 *
 * On the deployed runtime the default criteria set ranks on nothing, so the
 * engine scores every match a flat 100 and `rationaleFor` gives every row the
 * same sentence. That is meant to be stated once above the list, with each row
 * carrying an "unranked" chip instead of a green hundred.
 *
 * It was not. `unranked` was computed as `!loading && isUnrankedResult(rows)`,
 * and rows are on screen for the whole of a query: `useParcelSearch` sets the
 * rows, then runs a second search for up to four thousand map points, and only
 * clears `loading` after that one returns. For all of that window a hundred
 * rows rendered through the ranked branch - a green 100 on every one, the same
 * explanation repeated underneath each, and no note above the list. Driving
 * https://residential-jax-crm.vercel.app/search reproduced it exactly: 100 rows
 * present, no `unranked-notice` in the document, then both correct three
 * seconds later.
 *
 * So the assertion is about the rows, not about the clock: whatever the list is
 * showing, it describes the rows it is actually showing.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResultList } from "@/components/ResultList";
import { UNRANKED_EXPLANATION } from "@/lib/criteria/score";
import { EMPTY_CRITERIA } from "@/lib/criteria/types";
import type { SearchRow } from "@/lib/client";

function row(overrides: Partial<SearchRow> = {}): SearchRow {
  return {
    propertyId: "1266680000R",
    address: "605 N OCEAN ST, JACKSONVILLE, 32202",
    city: "JACKSONVILLE",
    zip: "32202",
    latitude: 30.33,
    longitude: -81.65,
    ownerName: "CHIU CHARMAINE T M",
    ownerOccupied: false,
    ownerRegionClass: "REGIONAL",
    assessedValue: 233_533,
    marketValue: null,
    builtYear: 1955,
    livableFloorArea: 1_320,
    roofAgeYears: 36,
    roofAgeBasis: "EFF_YR_BLT_PROXY",
    yearsSinceLastSale: 10,
    lastSaleDate: "2016-04-01",
    tenureBasis: "COJ_SALESL",
    waterViewFlag: false,
    nearestTransitStopM: null,
    courtDistressScore: null,
    courtLienCount: null,
    courtForeclosureCount: null,
    simulated: false,
    score: 100,
    rationale: UNRANKED_EXPLANATION,
    components: [],
    provenance: {
      sourceSystem: "duval_appraiser",
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

function render(rows: SearchRow[], loading: boolean): string {
  return renderToStaticMarkup(
    createElement(ResultList, {
      rows,
      total: 337_853,
      loading,
      selectedId: null,
      onSelect: () => undefined,
      hasMore: true,
      sql: "SELECT 1",
      tookMs: 41,
      orderBy: "score" as const,
      onOrderChange: () => undefined,
      criteria: EMPTY_CRITERIA,
    }),
  );
}

const unrankedPage = Array.from({ length: 3 }, (_, index) =>
  row({ propertyId: `parcel-${index}` }),
);

describe("the unranked note survives the query that is still running", () => {
  it("states it above the list while a newer query is in flight", () => {
    const markup = render(unrankedPage, true);
    expect(markup).toContain("unranked-notice");
    expect(markup.split(UNRANKED_EXPLANATION.slice(0, 60)).length - 1).toBe(1);
  });

  it("does not paint a green hundred on those rows in the meantime", () => {
    // The half the reviewer photographed: three identical 100 badges over three
    // rows nothing could tell apart.
    const markup = render(unrankedPage, true);
    expect(markup).not.toContain('data-testid="score"');
  });

  it("says the same thing once the query has settled", () => {
    const settled = render(unrankedPage, false);
    expect(settled).toContain("unranked-notice");
    expect(settled).not.toContain('data-testid="score"');
  });

  it("still refuses to describe a result set that has no rows", () => {
    // Loading with nothing on screen yet is not an unranked search; there is
    // nothing being claimed about, so nothing to explain.
    expect(render([], true)).not.toContain("unranked-notice");
  });

  it("leaves a ranked result alone whether or not a query is running", () => {
    const ranked = [
      row({
        components: [
          { key: "tenure", label: "held", value: 0.8, weight: 3, points: 40, matched: true },
        ],
        score: 84.9,
        rationale: "held 32 years (+27.4)",
      }),
    ];
    for (const loading of [true, false]) {
      const markup = render(ranked, loading);
      expect(markup).not.toContain("unranked-notice");
      expect(markup).toContain('data-testid="score"');
    }
  });
});
