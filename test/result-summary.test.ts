/**
 * The result line must not describe a result it does not have yet.
 *
 * The list header had two states that disagreed with each other: the heading
 * and the empty state below the rows both waited for `loading` to clear, and
 * the line between them did not. So every ordinary re-query - tightening a
 * filter, drawing a radius, pressing "Search this view" - rendered "No parcels
 * match these criteria" for as long as the query took, on top of a heading that
 * said "Searching". A reviewer who tightens a filter and reads that has been
 * told the search is broken.
 *
 * `lib/data/use-search.ts` holds the same invariant one level up, in
 * `resultView`; this is the copy that renders underneath it.
 */

import { describe, expect, it } from "vitest";

import { resultSummary } from "@/components/ResultList";

const NO_MATCHES = "No parcels match these criteria";

describe("the line under the result heading", () => {
  it("never claims nothing matched while the query is still running", () => {
    for (const rowCount of [0, 1, 200, 404_023]) {
      for (const tookMs of [0, 412]) {
        expect(resultSummary({ loading: true, rowCount, tookMs })).not.toContain(NO_MATCHES);
      }
    }
  });

  it("says what it is doing instead", () => {
    // The exact shape of the bug: loading, no rows in hand yet.
    expect(resultSummary({ loading: true, rowCount: 0, tookMs: 0 })).toBe(
      "Querying the published parcels",
    );
  });

  it("only says nothing matched once the query it is describing has come back", () => {
    expect(resultSummary({ loading: false, rowCount: 0, tookMs: 12 })).toBe(NO_MATCHES);
  });

  it("counts the rows it actually has, with a thousands separator", () => {
    expect(resultSummary({ loading: false, rowCount: 2_000, tookMs: 0 })).toBe("Showing 2,000");
  });

  it("quotes a timing only for the query that produced it", () => {
    // While a new query is in flight `tookMs` still holds the previous one's
    // elapsed time, so attaching it to the waiting state would be a fiction.
    expect(resultSummary({ loading: false, rowCount: 3, tookMs: 412 })).toBe("Showing 3 - 412 ms");
    expect(resultSummary({ loading: true, rowCount: 3, tookMs: 412 })).not.toContain("412");
  });

  it("is exactly one of searching, results or nothing matched", () => {
    const seen = new Set<string>();
    for (const loading of [true, false]) {
      for (const rowCount of [0, 5]) {
        const line = resultSummary({ loading, rowCount, tookMs: 0 });
        // Searching and empty can never be the same sentence.
        expect(line.startsWith("Querying") && line.includes(NO_MATCHES)).toBe(false);
        seen.add(line);
      }
    }
    expect(seen.size).toBe(3);
  });
});
