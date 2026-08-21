/**
 * The display formatters, and the column-to-formatter mapping the parcel drawer
 * runs every published column through.
 *
 * These are one-line functions, which is exactly why they are tested: all three
 * of the defects they answer were invisible in review and obvious on screen -
 * a year rendered as "1,916", a collection time rendered as "1787320736294",
 * and a run id with a badge welded onto the end of it. A reviewer reads these
 * surfaces as the provenance evidence, so a formatting slip there costs more
 * than it looks like it should.
 */

import { describe, expect, it } from "vitest";

import { toDate, when, year } from "@/components/ui";
import { TIMESTAMP_COLUMNS, YEAR_COLUMNS } from "@/components/PropertyDrawer";

describe("year", () => {
  it("renders a year without a thousands separator", () => {
    expect(year(1916)).toBe("1916");
    expect(year(2026)).toBe("2026");
  });

  it("accepts the shapes a published column arrives in", () => {
    expect(year("1916")).toBe("1916");
    expect(year(" 1916 ")).toBe("1916");
    expect(year(1916n)).toBe("1916");
    expect(year(1916.0)).toBe("1916");
  });

  it("falls back to the raw value rather than NaN", () => {
    expect(year("unknown")).toBe("unknown");
  });
});

describe("toDate", () => {
  it("reads epoch milliseconds as a number, a bigint or a numeric string", () => {
    const expected = 1787320736294;
    expect(toDate(expected)?.getTime()).toBe(expected);
    expect(toDate(String(expected))?.getTime()).toBe(expected);
    expect(toDate(BigInt(expected))?.getTime()).toBe(expected);
  });

  it("reads an ISO string", () => {
    expect(toDate("2026-08-21T09:16:32.097Z")?.toISOString()).toBe("2026-08-21T09:16:32.097Z");
  });

  it("does not mistake a four digit year for an epoch", () => {
    // Guarding the epoch branch by digit count is the whole reason a year
    // column and a timestamp column can share one parser.
    expect(toDate("1916")?.getFullYear()).toBe(1916);
  });

  it("returns null for values that are not timestamps", () => {
    expect(toDate("not published")).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate(Number.NaN)).toBeNull();
    expect(toDate(new Date("nonsense"))).toBeNull();
  });
});

describe("when", () => {
  it("renders epoch milliseconds as a readable timestamp", () => {
    const rendered = when("1787320736294");
    expect(rendered).not.toBe("1787320736294");
    expect(rendered).toMatch(/2026/);
    expect(rendered).not.toMatch(/Invalid Date/);
  });

  it("renders an ISO string the same way", () => {
    expect(when("2026-08-21T09:16:32.097Z")).toMatch(/2026/);
  });

  it("shows the raw value when it cannot be parsed, never 'Invalid Date'", () => {
    expect(when("not a date")).toBe("not a date");
  });

  it("still reports absence as 'never'", () => {
    expect(when(null)).toBe("never");
    expect(when(undefined)).toBe("never");
  });
});

describe("the drawer's column classification", () => {
  it("treats every calendar-year column as a year", () => {
    for (const column of [
      "built_year",
      "eff_year_built",
      "pa_actual_year_built",
      "roof_year_est",
      "last_roof_permit_year",
    ]) {
      expect(YEAR_COLUMNS.has(column)).toBe(true);
    }
  });

  it("leaves quantities and durations alone", () => {
    // These keep their separators: they are counts and measurements, and a
    // reviewer reading "1,842" square feet is reading it correctly.
    for (const column of [
      "assessed_value",
      "market_value",
      "livable_floor_area",
      "total_area",
      "permit_count",
      "roof_permit_count",
      "years_since_last_sale",
      "roof_age_years",
    ]) {
      expect(YEAR_COLUMNS.has(column)).toBe(false);
      expect(TIMESTAMP_COLUMNS.has(column)).toBe(false);
    }
  });

  it("treats the published TIMESTAMP column as a timestamp", () => {
    expect(TIMESTAMP_COLUMNS.has("fetched_at")).toBe(true);
  });
});
